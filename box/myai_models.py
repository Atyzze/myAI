#!/usr/bin/env python3
"""myai-models: fetch the models myai-probe planned for, once.

Reads models.env (written by myai-probe at boot) and makes sure that

    <model root>/whisper/<name>/   holds the planned faster-whisper model,
    <model root>/embed/            holds the speaker-embedding model (if planned),
    Ollama                         has the planned AI model pulled.

Everything already present is left alone, so later boots cost nothing; a box
that moves to a bigger GPU simply fetches the bigger rung next boot. Progress
and the outcome go to the journal and to <state dir>/models.json, which
`myai-status` shows. A failure exits non-zero so systemd retries it later
(typically: no network yet on first boot).
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

WHISPER_FILES = ["config.json", "model.bin", "tokenizer.json", "vocabulary.*", "preprocessor_config.json"]
WHISPER_REQUIRED = ("config.json", "model.bin", "tokenizer.json")
EMBED_FILES = ["*.yaml", "*.ckpt", "*.txt", "*.json"]
EMBED_REQUIRED = ("hyperparams.yaml", "embedding_model.ckpt")


def read_env(path: Path) -> dict[str, str]:
    values = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            key, _, value = line.partition("=")
            values[key.strip()] = value.strip()
    return values


def complete(folder: Path, required: tuple[str, ...]) -> bool:
    return all((folder / name).is_file() for name in required)


def fetch_hf(repo: str, dest: Path, patterns: list[str], required: tuple[str, ...]) -> str:
    if complete(dest, required) and (dest / "SOURCE.json").is_file():
        return "present"
    from huggingface_hub import snapshot_download  # imported late: only needed on a fetch

    staging = dest.with_name(dest.name + ".partial")
    shutil.rmtree(staging, ignore_errors=True)
    staging.mkdir(parents=True)
    print(f"downloading {repo} into {dest}", flush=True)
    snapshot_download(repo_id=repo, local_dir=staging, allow_patterns=patterns)
    if not complete(staging, required):
        missing = [n for n in required if not (staging / n).is_file()]
        raise RuntimeError(f"{repo} is missing {', '.join(missing)}")
    (staging / "SOURCE.json").write_text(json.dumps({"repo": repo, "fetched": int(time.time())}) + "\n")
    shutil.rmtree(staging / ".cache", ignore_errors=True)
    shutil.rmtree(dest, ignore_errors=True)
    staging.rename(dest)
    return "downloaded"


def ollama_has(model: str, ollama: str) -> bool:
    out = subprocess.run([ollama, "list"], capture_output=True, text=True, timeout=60)
    if out.returncode != 0:
        raise RuntimeError(f"ollama list failed: {out.stderr.strip()[:200]}")
    names = {line.split()[0] for line in out.stdout.splitlines()[1:] if line.strip()}
    wanted = model if ":" in model else f"{model}:latest"
    return wanted in names


def pull_llm(model: str, ollama: str) -> str:
    deadline = time.monotonic() + 120
    while True:                                   # Ollama may still be starting
        try:
            if ollama_has(model, ollama):
                return "present"
            break
        except (RuntimeError, OSError, subprocess.SubprocessError):
            if time.monotonic() > deadline:
                raise
            time.sleep(3)
    print(f"pulling {model} through Ollama", flush=True)
    subprocess.run([ollama, "pull", model], check=True)
    return "downloaded"


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--plan", type=Path, default=Path("/run/myai/models.env"))
    ap.add_argument("--model-root", type=Path, default=Path("/var/lib/myai/models"))
    ap.add_argument("--state", type=Path, default=Path("/run/myai/models.json"))
    ap.add_argument("--ollama", default=os.environ.get("OLLAMA_BIN", "ollama"))
    args = ap.parse_args(argv)

    plan = read_env(args.plan)
    state: dict[str, str] = {}
    failed = False

    def record(key: str, value: str) -> None:
        state[key] = value
        args.state.parent.mkdir(parents=True, exist_ok=True)
        args.state.write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")
        args.state.chmod(0o644)

    jobs = [("whisper", lambda: fetch_hf(plan["WHISPER_REPO"], args.model_root / "whisper" / plan["WHISPER_NAME"],
                                         WHISPER_FILES, WHISPER_REQUIRED))]
    if plan.get("EMBED_REPO"):
        jobs.append(("speaker embeddings", lambda: fetch_hf(plan["EMBED_REPO"], args.model_root / "embed",
                                                            EMBED_FILES, EMBED_REQUIRED)))
    if plan.get("LLM_MODEL"):
        jobs.append((f"AI model {plan['LLM_MODEL']}", lambda: pull_llm(plan["LLM_MODEL"], args.ollama)))

    for name, job in jobs:
        record(name, "fetching")
        try:
            record(name, job())
        except Exception as exc:                  # report, keep going, fail at the end
            failed = True
            record(name, f"failed: {type(exc).__name__}: {str(exc)[:200]}")
            print(f"{name}: {state[name]}", file=sys.stderr, flush=True)
    print(json.dumps(state), flush=True)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
