#!/usr/bin/env python3
"""myai-probe: look at the hardware this box has and plan the stack to fit it.

One box image runs everywhere, from a workstation with a big NVIDIA card down to
an old laptop with integrated graphics (or, in principle, a fridge). Nothing in
the stack is hard-wired to a GPU; instead this probe runs at boot, measures what
is there, and writes a plan that every other piece reads:

    profile.json       full plan + measured hardware (for `myai-status`)
    capabilities.json  the part the browser client reads at /capabilities
    vts.env            Whisper model, device and compute type for VTS
    ollama.env         which Ollama backend to run and how much in parallel
    models.env         which models the first-boot download should fetch

The planner is a pure function (`plan(hardware, overrides)`) so the tiers can be
tested without the hardware. Only the standard library is used: the probe has
to run before anything else is installed or downloaded.

Rule of thumb throughout: never refuse to run. When the box is small, pick
smaller models, lower parallelism, and say so in plain words.
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import re
import shutil
import subprocess
import sys
from dataclasses import asdict, dataclass, field
from pathlib import Path

GIB = 1024 ** 3

# --------------------------------------------------------------------------
# Model ladders. Sizes are what the model needs resident, in GiB, measured
# loosely from typical Q4 (LLM) and int8/fp16 (Whisper) footprints. They only
# have to be good enough to choose a rung; Ollama itself does the real fitting
# and splits layers between GPU and CPU when a model does not fit in VRAM.
# --------------------------------------------------------------------------

# (ollama tag, resident GiB at default context)
LLM_LADDER: list[tuple[str, float]] = [
    ("qwen3:0.6b", 0.6),
    ("qwen3:1.7b", 1.4),
    ("qwen3:4b", 2.6),
    ("qwen3:8b", 5.2),
    ("qwen3:14b", 9.3),
    ("qwen3.8:27b", 17.5),
]
LLM_CONTEXT_OVERHEAD_GIB = 1.0

# name -> (huggingface repo, cpu int8 GiB, gpu GiB)
WHISPER_MODELS: dict[str, tuple[str, float, float]] = {
    "tiny": ("Systran/faster-whisper-tiny", 0.3, 0.4),
    "base": ("Systran/faster-whisper-base", 0.4, 0.6),
    "small": ("Systran/faster-whisper-small", 0.8, 1.0),
    "medium": ("Systran/faster-whisper-medium", 1.8, 2.2),
    "large-v3-turbo": ("dropbox-dash/faster-whisper-large-v3-turbo", 2.0, 2.6),
}

EMBED_REPO = "speechbrain/spkrec-ecapa-voxceleb"

OS_RESERVE_GIB = 1.5          # kernel, nginx, tailscale, page cache headroom
DIARIZATION_RAM_GIB = 1.2     # CPU torch + ECAPA
MIN_DGPU_VRAM_GIB = 2.5       # below this a "discrete" GPU is not worth using

VENDORS = {"0x10de": "nvidia", "0x1002": "amd", "0x8086": "intel"}


# --------------------------------------------------------------------------
# Hardware model
# --------------------------------------------------------------------------

@dataclass
class Gpu:
    vendor: str                 # nvidia | amd | intel | other
    name: str = ""
    vram_gib: float = 0.0       # dedicated memory; 0 for integrated graphics
    integrated: bool = False


@dataclass
class Hardware:
    arch: str
    cpu_model: str
    cores: int
    ram_gib: float
    gpus: list[Gpu] = field(default_factory=list)

    @classmethod
    def from_dict(cls, data: dict) -> "Hardware":
        gpus = [Gpu(**g) for g in data.get("gpus", [])]
        return cls(
            arch=data.get("arch", "x86_64"),
            cpu_model=data.get("cpu_model", ""),
            cores=int(data.get("cores", 1)),
            ram_gib=float(data.get("ram_gib", 0)),
            gpus=gpus,
        )


def _read(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8", errors="replace").strip()
    except OSError:
        return ""


def _meminfo_gib(root: Path) -> float:
    match = re.search(r"^MemTotal:\s+(\d+)\s+kB", _read(root / "proc/meminfo"), re.M)
    return round(int(match.group(1)) * 1024 / GIB, 1) if match else 0.0


def _cpu_model(root: Path) -> str:
    text = _read(root / "proc/cpuinfo")
    for key in ("model name", "Hardware", "Model", "cpu model"):
        match = re.search(rf"^{key}\s*:\s*(.+)$", text, re.M)
        if match:
            return match.group(1).strip()
    return platform.processor() or "unknown CPU"


def _nvidia_smi() -> list[Gpu]:
    exe = shutil.which("nvidia-smi") or ("/run/current-system/sw/bin/nvidia-smi"
                                         if Path("/run/current-system/sw/bin/nvidia-smi").exists() else None)
    if not exe:
        return []
    try:
        out = subprocess.run(
            [exe, "--query-gpu=name,memory.total", "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=15, check=True,
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return []
    gpus = []
    for line in out.splitlines():
        parts = [p.strip() for p in line.split(",")]
        if len(parts) == 2 and parts[1].replace(".", "", 1).isdigit():
            gpus.append(Gpu("nvidia", parts[0], round(float(parts[1]) / 1024, 1)))
    return gpus


def _drm_gpus(root: Path) -> list[Gpu]:
    """Every display controller the kernel knows about, from sysfs."""
    gpus = []
    seen = set()
    for card in sorted((root / "sys/class/drm").glob("card[0-9]*")):
        if "-" in card.name:            # connectors such as card0-HDMI-A-1
            continue
        dev = card / "device"
        real = str(dev.resolve()) if dev.exists() else str(card)
        if real in seen:
            continue
        seen.add(real)
        vendor = VENDORS.get(_read(dev / "vendor").lower(), "other")
        vram = 0.0
        raw = _read(dev / "mem_info_vram_total")          # amdgpu
        if raw.isdigit():
            vram = round(int(raw) / GIB, 1)
        name = _read(dev / "label") or _read(dev / "product_name") or f"{vendor} GPU"
        # Intel graphics share system RAM; an AMD part reporting a small VRAM
        # carve-out (APU) is integrated as well. Intel Arc reports lmem.
        lmem = _read(dev / "lmem_total_bytes")
        if vendor == "intel" and lmem.isdigit() and int(lmem) > 0:
            vram = round(int(lmem) / GIB, 1)
        integrated = (vendor == "intel" and vram == 0) or (vendor == "amd" and vram < 2)
        gpus.append(Gpu(vendor, name, vram, integrated))
    return gpus


def detect(root: Path = Path("/")) -> Hardware:
    gpus = _drm_gpus(root)
    smi = _nvidia_smi() if root == Path("/") else []
    if smi:
        # nvidia-smi knows names and VRAM; sysfs does not. Replace those entries.
        gpus = [g for g in gpus if g.vendor != "nvidia"] + smi
    return Hardware(
        arch=platform.machine() or "unknown",
        cpu_model=_cpu_model(root),
        cores=os.cpu_count() or 1,
        ram_gib=_meminfo_gib(root),
        gpus=gpus,
    )


# --------------------------------------------------------------------------
# Planner (pure)
# --------------------------------------------------------------------------

def _best_gpu(hw: Hardware, available: set[str]) -> tuple[Gpu | None, str]:
    """Pick the GPU the LLM should run on and the Ollama backend to drive it."""
    ranked = sorted(hw.gpus, key=lambda g: (not g.integrated, g.vram_gib), reverse=True)
    for gpu in ranked:
        if gpu.integrated or gpu.vram_gib < MIN_DGPU_VRAM_GIB:
            continue
        if gpu.vendor == "nvidia" and "cuda" in available:
            return gpu, "cuda"
        if gpu.vendor == "amd" and "rocm" in available:
            return gpu, "rocm"
        if "vulkan" in available:
            return gpu, "vulkan"
    if "vulkan" in available and "igpu" in available:
        for gpu in ranked:
            if gpu.integrated:
                return gpu, "vulkan"
    return None, "cpu"


def _pick_llm(budget_gib: float, cap: str | None = None) -> tuple[str, float] | None:
    best = None
    for tag, size in LLM_LADDER:
        if size + LLM_CONTEXT_OVERHEAD_GIB <= budget_gib:
            best = (tag, size)
        if cap and tag == cap:
            break
    return best


def _llm_size(tag: str) -> float:
    return dict(LLM_LADDER).get(tag, 0.0)


def plan(hw: Hardware, overrides: dict | None = None) -> dict:
    o = dict(overrides or {})
    available = set(o.get("accelerators", ["cuda", "vulkan"]))
    warnings: list[str] = []
    notes: list[str] = []

    nvidia = max((g for g in hw.gpus if g.vendor == "nvidia" and not g.integrated),
                 key=lambda g: g.vram_gib, default=None)
    whisper_on_cuda = nvidia is not None and "cuda" in available and nvidia.vram_gib >= MIN_DGPU_VRAM_GIB

    # ---- Whisper ---------------------------------------------------------
    if whisper_on_cuda:
        vram = nvidia.vram_gib
        if vram >= 6:
            w_name, w_compute = "large-v3-turbo", "float16"
        elif vram >= 4:
            w_name, w_compute = "large-v3-turbo", "int8_float16"
        else:
            w_name, w_compute = "small", "int8_float16"
        w_device = "cuda"
    else:
        w_device, w_compute = "cpu", "int8"
        if hw.ram_gib < 3:
            w_name = "tiny"
        elif hw.ram_gib < 6 or hw.cores < 4:
            w_name = "base"
        elif hw.cores >= 12 and hw.ram_gib >= 16:
            w_name = "large-v3-turbo"
        else:
            w_name = "small"
    w_name = o.get("whisper_model") or w_name
    if w_name not in WHISPER_MODELS:
        warnings.append(f"Unknown Whisper model '{w_name}' requested; using small.")
        w_name = "small"
    w_repo, w_cpu_gib, w_gpu_gib = WHISPER_MODELS[w_name]
    w_ram = w_cpu_gib if w_device == "cpu" else 0.5
    w_vram = w_gpu_gib if w_device == "cuda" else 0.0

    diarization = bool(o.get("diarization", hw.ram_gib >= 6))
    d_ram = DIARIZATION_RAM_GIB if diarization else 0.0

    # ---- LLM -------------------------------------------------------------
    gpu, backend = _best_gpu(hw, available)
    ram_left = hw.ram_gib - OS_RESERVE_GIB - w_ram - d_ram
    offload = 0.0
    llm: tuple[str, float] | None

    if gpu is not None and backend != "cpu" and not gpu.integrated:
        vram_budget = gpu.vram_gib * 0.92 - (w_vram if (gpu is nvidia and w_device == "cuda") else 0)
        llm = _pick_llm(vram_budget)
        if llm is None:
            # Nothing fits fully on the card: split it between GPU and CPU.
            llm = _pick_llm(max(0.0, vram_budget) + max(0.0, ram_left) * 0.8, cap="qwen3:4b")
            if llm:
                need = llm[1] + LLM_CONTEXT_OVERHEAD_GIB
                offload = max(0.0, min(1.0, 1 - max(0.0, vram_budget) / need))
        placement = "gpu"
    else:
        # CPU (or integrated graphics sharing RAM): budget is RAM, and speed
        # matters as much as fit, so weak CPUs get capped to smaller models.
        cap = "qwen3:8b" if (hw.cores >= 8 and hw.ram_gib >= 16) else \
              "qwen3:4b" if (hw.cores >= 4 and hw.ram_gib >= 8) else "qwen3:1.7b"
        llm = _pick_llm(ram_left * 0.85, cap=cap)
        placement = "igpu" if gpu is not None else "cpu"

    forced = o.get("llm_model")
    if forced:
        need = _llm_size(forced)
        llm = (forced, need)
        if need and placement == "gpu" and gpu is not None and need + LLM_CONTEXT_OVERHEAD_GIB > gpu.vram_gib:
            offload = max(offload, 1 - gpu.vram_gib / (need + LLM_CONTEXT_OVERHEAD_GIB))

    # ---- Warnings in plain words ----------------------------------------
    if hw.ram_gib < 4:
        warnings.append(
            f"Only {hw.ram_gib:g} GiB of RAM. Transcription runs with the '{w_name}' Whisper model; "
            + ("an AI model does not fit, so replies and translation are off." if llm is None
               else f"replies use the small '{llm[0]}' model. 8 GiB or more makes a real difference.")
        )
    elif llm is None:
        warnings.append("Not enough free memory for an AI model; replies and translation are off, transcription works.")
    if offload > 0.05 and llm:
        warnings.append(
            f"Insufficient VRAM: '{llm[0]}' needs about {llm[1] + LLM_CONTEXT_OVERHEAD_GIB:.1f} GiB, "
            f"the GPU has {gpu.vram_gib:g} GiB. It will still run: Ollama splits it, "
            f"about {offload:.0%} on the CPU, so replies are slower."
        )
    if w_device == "cpu" and nvidia is not None and not whisper_on_cuda:
        warnings.append("An NVIDIA GPU is present but CUDA is not available in this image; Whisper runs on the CPU.")
    if w_device == "cpu":
        notes.append(f"Whisper runs on the CPU ({w_name}, int8). Live transcription keeps up, but with less headroom.")
    if any(g.vendor == "amd" and not g.integrated for g in hw.gpus) and backend == "vulkan":
        notes.append("AMD GPU: the AI model runs through Vulkan; Whisper stays on the CPU (CTranslate2 is CUDA-only).")
    if placement == "igpu":
        notes.append("Integrated graphics share system RAM; the AI model is sized to RAM.")
    if hw.arch not in ("x86_64", "aarch64", "arm64"):
        warnings.append(f"Untested CPU architecture {hw.arch}; expect missing prebuilt models.")

    # ---- What the browser should ask of this box -------------------------
    fast_llm = llm is not None and placement == "gpu" and offload <= 0.05
    if llm is None:
        panels, in_flight = 0, 0
    elif fast_llm:
        panels, in_flight = 4, 4
    elif placement == "gpu" or hw.cores >= 8:
        panels, in_flight = 3 if hw.cores >= 8 else 2, 2
    else:
        panels, in_flight = 2, 1
    transcribe_concurrency = 10 if w_device == "cuda" else max(1, min(4, hw.cores // 4))

    tier = (
        "minimal" if hw.ram_gib < 4 or llm is None else
        "workstation" if fast_llm and llm and _llm_size(llm[0]) >= 9 else
        "strong" if fast_llm else
        "standard" if hw.ram_gib >= 12 or placement == "gpu" else
        "basic"
    )

    accel_desc = (f"{gpu.name} ({gpu.vram_gib:g} GiB, {backend})" if gpu is not None and placement == "gpu"
                  else f"{gpu.name} (integrated, {backend})" if gpu is not None
                  else "CPU only")

    return {
        "schema": 1,
        "tier": tier,
        "summary": f"{tier} - {hw.cores} cores, {hw.ram_gib:g} GiB RAM, {accel_desc}",
        "hardware": asdict(hw),
        "whisper": {
            "model": w_name, "repo": w_repo, "device": w_device, "compute_type": w_compute,
            "cpu_threads": 0 if w_device == "cuda" else max(1, hw.cores - 1),
        },
        "diarization": diarization,
        "llm": None if llm is None else {
            "model": llm[0], "est_gib": round(llm[1] + LLM_CONTEXT_OVERHEAD_GIB, 1),
            "backend": backend if placement != "cpu" else "cpu",
            "placement": placement, "cpu_offload": round(offload, 2),
        },
        "client": {
            "maxPanels": panels,
            "translateInFlight": in_flight,
            "transcribeConcurrency": transcribe_concurrency,
            "recommendedModel": llm[0] if llm else None,
        },
        "warnings": warnings,
        "notes": notes,
    }


# --------------------------------------------------------------------------
# Outputs
# --------------------------------------------------------------------------

def capabilities(p: dict) -> dict:
    """The browser-facing subset: limits and plain-language messages, no serials."""
    return {
        "schema": 1,
        "tier": p["tier"],
        "summary": p["summary"],
        "llm": p["llm"]["model"] if p["llm"] else None,
        "whisper": f'{p["whisper"]["model"]} on {p["whisper"]["device"]}',
        "diarization": p["diarization"],
        **p["client"],
        "warnings": p["warnings"],
        "notes": p["notes"],
    }


def env_files(p: dict, model_root: str) -> dict[str, str]:
    w = p["whisper"]
    vts = {
        "DEVICE": w["device"],
        "COMPUTE_TYPE": w["compute_type"],
        "CPU_THREADS": str(w["cpu_threads"]),
        "MODEL_DIR": f"{model_root}/whisper/{w['model']}",
        "EMBED_DIR": f"{model_root}/embed",
        "DIARIZE": "auto" if p["diarization"] else "0",
    }
    llm = p["llm"]
    ollama = {
        "MYAI_OLLAMA_BACKEND": llm["backend"] if llm else "cpu",
        "OLLAMA_MAX_LOADED_MODELS": "1",
        "OLLAMA_NUM_PARALLEL": str(max(1, p["client"]["translateInFlight"])),
        "OLLAMA_KEEP_ALIVE": "30m",
    }
    models = {
        "WHISPER_NAME": w["model"],
        "WHISPER_REPO": w["repo"],
        "EMBED_REPO": EMBED_REPO if p["diarization"] else "",
        "LLM_MODEL": llm["model"] if llm else "",
    }
    fmt = lambda d: "".join(f"{k}={v}\n" for k, v in d.items())
    return {"vts.env": fmt(vts), "ollama.env": fmt(ollama), "models.env": fmt(models)}


def report(p: dict) -> str:
    hw = p["hardware"]
    lines = [
        f"myAI box: {p['summary']}",
        f"  CPU      {hw['cpu_model']} ({hw['arch']}, {hw['cores']} cores)",
        f"  RAM      {hw['ram_gib']:g} GiB",
    ]
    for g in hw["gpus"]:
        kind = "integrated" if g["integrated"] else f"{g['vram_gib']:g} GiB VRAM"
        lines.append(f"  GPU      {g['name']} ({g['vendor']}, {kind})")
    if not hw["gpus"]:
        lines.append("  GPU      none detected")
    w = p["whisper"]
    lines.append(f"  Whisper  {w['model']} on {w['device']} ({w['compute_type']})")
    if p["llm"]:
        l = p["llm"]
        where = l["backend"] + (f", {l['cpu_offload']:.0%} on CPU" if l["cpu_offload"] else "")
        lines.append(f"  AI model {l['model']} (~{l['est_gib']} GiB, {where})")
    else:
        lines.append("  AI model none (not enough memory)")
    c = p["client"]
    lines.append(f"  Client   up to {c['maxPanels']} translation boxes, "
                 f"{c['transcribeConcurrency']} parallel transcriptions")
    for msg in p["warnings"]:
        lines.append(f"  WARNING  {msg}")
    for msg in p["notes"]:
        lines.append(f"  note     {msg}")
    return "\n".join(lines)


def write_outputs(p: dict, out_dir: Path, model_root: str) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    files = {
        "profile.json": json.dumps(p, indent=2) + "\n",
        "capabilities.json": json.dumps(capabilities(p), indent=2) + "\n",
        **env_files(p, model_root),
    }
    for name, text in files.items():
        tmp = out_dir / f".{name}.tmp"
        tmp.write_text(text, encoding="utf-8")
        tmp.chmod(0o644)
        tmp.replace(out_dir / name)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--write", type=Path, metavar="DIR", help="write plan files into DIR")
    ap.add_argument("--overrides", type=Path, action="append", default=[],
                    help="JSON file with operator overrides; repeatable, later files win, missing files are skipped")
    ap.add_argument("--model-root", default="/var/lib/myai/models")
    ap.add_argument("--hardware", type=Path, help="plan for a hardware JSON instead of this machine")
    ap.add_argument("--json", action="store_true", help="print the plan as JSON")
    args = ap.parse_args(argv)

    overrides: dict = {}
    for path in args.overrides:
        if path.is_file():
            try:
                overrides.update(json.loads(path.read_text(encoding="utf-8")))
            except (OSError, ValueError) as exc:
                print(f"myai-probe: ignoring {path}: {exc}", file=sys.stderr)
    hw = Hardware.from_dict(json.loads(args.hardware.read_text())) if args.hardware else detect()
    p = plan(hw, overrides)
    text = json.dumps(p, indent=2) if args.json else report(p)
    if args.write:
        write_outputs(p, args.write, args.model_root)
        (args.write / "report.txt").write_text(report(p) + "\n", encoding="utf-8")
    print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
