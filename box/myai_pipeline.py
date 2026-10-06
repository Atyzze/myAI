#!/usr/bin/env python3
"""myai-pipeline: run one pipeline over its input folder, once.

A box has three folders and every pipeline is described by a data file:

    app/pipelines/<name>.json   what it tunes into and how (written only by the
                                update manager)
    input/<input>/              where people and devices put files (a pipeline
                                only ever reads here)
    output/<name>/              the only place this pipeline may write; nobody
                                else writes here

Each run looks at every file under input/<input>/, skips what is already done
for that exact file (same size and modification time), waits for files that
are still being written, and hands the rest to the pipeline's processor. Each
result is written next to nothing but itself, atomically, and every outcome is
appended to output/<name>/events.jsonl, which the feeds and the email notifier
read. A file that keeps failing is tried three times and then reported once.

Per-file options sit beside the input as "<file>.json" (for example
{"language": "nl"}); they are data like everything else.

systemd runs this on a timer and on changes, as the pipeline's own user, with
the filesystem read-only except output/<name>/. The rules are enforced there,
by ownership and sandboxing, not by this code.
"""

from __future__ import annotations

import argparse
import fcntl
import io
import json
import math
import os
import ssl
import struct
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid
import wave
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Iterator

SAMPLE_RATE = 16000
MAX_ATTEMPTS = 3

AUDIO_EXTENSIONS = [
    ".wav", ".mp3", ".m4a", ".aac", ".flac", ".ogg", ".oga", ".opus", ".webm",
    ".mka", ".mkv", ".mp4", ".mov", ".wma", ".amr", ".3gp", ".caf", ".aiff", ".aif",
]


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


# --------------------------------------------------------------------------
# Writing results: atomic, and only ever inside output/<name>/
# --------------------------------------------------------------------------

class Output:
    def __init__(self, folder: Path):
        self.folder = folder.resolve()

    def path(self, rel: str) -> Path:
        target = (self.folder / rel).resolve()
        if self.folder not in target.parents and target != self.folder:
            raise ValueError(f"refusing to write outside {self.folder}: {rel}")
        return target

    def write(self, rel: str, data: bytes | str) -> Path:
        target = self.path(rel)
        target.parent.mkdir(parents=True, exist_ok=True)
        tmp = target.with_name(f".{target.name}.{uuid.uuid4().hex[:8]}.partial")
        with open(tmp, "wb") as handle:
            handle.write(data.encode("utf-8") if isinstance(data, str) else data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, target)
        return target

    def event(self, pipeline: str, kind: str, rel_input: str, message: str, outputs: list[str] | None = None) -> dict:
        event = {
            "id": str(uuid.uuid4()),
            "time": now_iso(),
            "pipeline": pipeline,
            "kind": kind,
            "input": rel_input,
            "outputs": outputs or [],
            "message": message,
        }
        line = json.dumps(event, ensure_ascii=False) + "\n"
        with open(self.folder / "events.jsonl", "a", encoding="utf-8") as handle:
            fcntl.flock(handle, fcntl.LOCK_EX)
            handle.write(line)
        print(f"{kind}: {rel_input}: {message}", flush=True)
        return event


# --------------------------------------------------------------------------
# Finding work
# --------------------------------------------------------------------------

def fingerprint(path: Path) -> dict:
    st = path.stat()
    return {"size": st.st_size, "mtime_ns": st.st_mtime_ns}


def candidates(folder: Path, extensions: list[str]) -> Iterator[Path]:
    if not folder.is_dir():
        return
    wanted = {e.lower() for e in extensions}
    for path in sorted(folder.rglob("*")):
        rel_parts = path.relative_to(folder).parts
        if any(part.startswith(".") for part in rel_parts):
            continue
        if path.is_file() and not path.is_symlink() and path.suffix.lower() in wanted:
            yield path


def sidecar_options(path: Path) -> dict:
    side = path.with_name(path.name + ".json")
    if not side.is_file():
        return {}
    try:
        data = json.loads(side.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def state_of(out: Output, rel: str) -> dict:
    try:
        return json.loads(out.path(f".state/{rel}.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


# --------------------------------------------------------------------------
# Audio: any format and any length, streamed, cut where it is quiet
# --------------------------------------------------------------------------

def ffmpeg_pcm(path: Path, ffmpeg: str = "ffmpeg") -> Iterator[bytes]:
    """Decode anything ffmpeg reads into 16 kHz mono s16le, a block at a time."""
    proc = subprocess.Popen(
        [ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error", "-i", str(path),
         "-vn", "-sn", "-dn", "-ac", "1", "-ar", str(SAMPLE_RATE), "-f", "s16le", "-"],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    assert proc.stdout is not None
    try:
        while True:
            block = proc.stdout.read(SAMPLE_RATE * 2 * 4)
            if not block:
                break
            yield block
    finally:
        proc.stdout.close()
        err = proc.stderr.read().decode("utf-8", "replace").strip() if proc.stderr else ""
        code = proc.wait()
        if code != 0:
            raise RuntimeError(f"ffmpeg could not decode the file ({err[-300:] or f'exit {code}'})")


def _rms(pcm: memoryview) -> float:
    count = len(pcm) // 2
    if count == 0:
        return 0.0
    samples = struct.unpack(f"<{count}h", pcm[: count * 2])
    return math.sqrt(sum(s * s for s in samples) / count)


def quiet_cut(pcm: bytes, earliest: int, latest: int, frame: int = 320) -> int:
    """Sample index of the quietest 20 ms frame between earliest and latest."""
    view = memoryview(pcm)
    best, best_level = latest, float("inf")
    start = max(0, earliest - earliest % frame)
    for pos in range(start, max(start, latest - frame) + 1, frame):
        level = _rms(view[pos * 2:(pos + frame) * 2])
        if level < best_level:
            best, best_level = pos + frame // 2, level
    return best


def windows(blocks: Iterator[bytes], window_s: float, search_s: float) -> Iterator[tuple[int, bytes]]:
    """Yield (start sample, pcm) windows of about window_s, cut at a quiet moment."""
    target = int(window_s * SAMPLE_RATE)
    search = int(search_s * SAMPLE_RATE)
    buf = bytearray()
    offset = 0
    for block in blocks:
        buf += block
        while len(buf) // 2 >= target + search:
            cut = quiet_cut(bytes(buf), target - search, target + search)
            yield offset, bytes(buf[: cut * 2])
            del buf[: cut * 2]
            offset += cut
    if len(buf) // 2 >= SAMPLE_RATE // 5:
        yield offset, bytes(buf)


def wav_bytes(pcm: bytes) -> bytes:
    out = io.BytesIO()
    with wave.open(out, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SAMPLE_RATE)
        w.writeframes(pcm)
    return out.getvalue()


# --------------------------------------------------------------------------
# VTS client
# --------------------------------------------------------------------------

class ServiceUnavailable(RuntimeError):
    """The service a processor needs is not there (yet). Not the file's fault:
    the run stops, nothing counts as an attempt, the next run tries again.
    On a first boot VTS waits for its model download, which can take a while."""


def vts_transcribe(settings: dict) -> Callable[[bytes, str | None], dict]:
    url = settings.get("vts_url", "https://127.0.0.1:4444/transcribe")
    cafile = settings.get("ca_file")
    context = ssl.create_default_context(cafile=cafile) if url.startswith("https") else None
    retries = int(settings.get("retries", 6))

    def call(wav: bytes, language: str | None) -> dict:
        headers = {"Content-Type": "audio/wav"}
        if language and language != "auto":
            headers["X-Transcription-Language"] = language
        delay = 2.0
        for attempt in range(retries + 1):
            request = urllib.request.Request(url, data=wav, headers=headers, method="POST")
            try:
                with urllib.request.urlopen(request, timeout=600, context=context) as response:
                    return json.loads(response.read().decode("utf-8"))
            except urllib.error.HTTPError as exc:
                if exc.code not in (429, 500, 502, 503, 504):
                    raise RuntimeError(f"transcription server answered {exc.code}") from None
                if attempt == retries:
                    if exc.code == 500:
                        raise RuntimeError("transcription server failed on this audio (500)") from None
                    raise ServiceUnavailable(f"transcription server busy or starting ({exc.code})") from None
            except (urllib.error.URLError, TimeoutError, ConnectionError) as exc:
                if attempt == retries:
                    raise ServiceUnavailable(f"transcription server unreachable ({exc})") from None
            time.sleep(delay)
            delay = min(delay * 2, 60)
        raise RuntimeError("unreachable")

    return call


# --------------------------------------------------------------------------
# Speakers: who spoke when, from the per-segment voice vectors VTS returns.
# Vectors are used in memory only and never written to output: a voiceprint
# is biometric data, and the transcript only needs the numbers.
# --------------------------------------------------------------------------

def _unit(vec: list[float]) -> list[float]:
    norm = math.sqrt(sum(v * v for v in vec)) or 1.0
    return [v / norm for v in vec]


def assign_speakers(segments: list[dict], threshold: float = 0.45, max_speakers: int = 8) -> int:
    centroids: list[list[float]] = []
    counts: list[int] = []
    last = None
    for seg in segments:
        vec = seg.pop("embedding", None)
        if not vec:
            seg["speaker"] = last
            continue
        v = _unit(vec)
        sims = [sum(a * b for a, b in zip(v, c)) for c in centroids]
        best = max(range(len(sims)), key=sims.__getitem__) if sims else None
        if best is not None and (sims[best] >= threshold or len(centroids) >= max_speakers):
            n = counts[best]
            centroids[best] = _unit([(c * n + x) / (n + 1) for c, x in zip(centroids[best], v)])
            counts[best] += 1
            last = best + 1
        else:
            centroids.append(v)
            counts.append(1)
            last = len(centroids)
        seg["speaker"] = last
    if not centroids:
        for seg in segments:
            seg["speaker"] = None
    return len(centroids)


# --------------------------------------------------------------------------
# Transcript formats
# --------------------------------------------------------------------------

def clock(sec: float, sep: str = ".") -> str:
    ms = int(round(sec * 1000))
    h, rem = divmod(ms, 3_600_000)
    m, rem = divmod(rem, 60_000)
    s, ms = divmod(rem, 1000)
    return f"{h:02d}:{m:02d}:{s:02d}{sep}{ms:03d}"


def to_text(segments: list[dict]) -> str:
    lines, current, speaker, start = [], [], object(), 0.0
    for seg in segments:
        if seg["speaker"] != speaker and current:
            lines.append(_paragraph(start, speaker, current))
            current = []
        if not current:
            start, speaker = seg["start"], seg["speaker"]
        current.append(seg["text"].strip())
    if current:
        lines.append(_paragraph(start, speaker, current))
    return "\n\n".join(lines) + ("\n" if lines else "")


def _paragraph(start: float, speaker, texts: list[str]) -> str:
    who = f"Speaker {speaker}: " if speaker else ""
    return f"[{clock(start)[:8]}] {who}{' '.join(t for t in texts if t)}"


def to_srt(segments: list[dict]) -> str:
    blocks = []
    for i, seg in enumerate(segments, 1):
        who = f"Speaker {seg['speaker']}: " if seg["speaker"] else ""
        blocks.append(f"{i}\n{clock(seg['start'], ',')} --> {clock(seg['end'], ',')}\n{who}{seg['text'].strip()}\n")
    return "\n".join(blocks)


# --------------------------------------------------------------------------
# Processors
# --------------------------------------------------------------------------

def process_transcribe(path: Path, options: dict, settings: dict, *,
                       decode: Callable[[Path], Iterator[bytes]] | None = None,
                       transcribe: Callable[[bytes, str | None], dict] | None = None) -> tuple[dict[str, str], str]:
    decode = decode or (lambda p: ffmpeg_pcm(p, settings.get("ffmpeg", "ffmpeg")))
    transcribe = transcribe or vts_transcribe(settings)
    language = options.get("language", settings.get("language", "auto"))
    window_s = min(float(settings.get("window_seconds", 120)), 240.0)
    search_s = float(settings.get("search_seconds", 6))

    segments: list[dict] = []
    seconds_by_language: Counter = Counter()
    total = 0
    for start, pcm in windows(decode(path), window_s, search_s):
        result = transcribe(wav_bytes(pcm), language)
        base = start / SAMPLE_RATE
        length = len(pcm) / 2 / SAMPLE_RATE
        total = start + len(pcm) // 2
        if result.get("language"):
            seconds_by_language[result["language"]] += length
        for seg in result.get("segments", []):
            text = str(seg.get("text", "")).strip()
            if not text:
                continue
            segments.append({
                "start": round(base + float(seg.get("start", 0)), 3),
                "end": round(base + float(seg.get("end", 0)), 3),
                "text": text,
                **({"embedding": seg["embedding"]} if seg.get("embedding") else {}),
            })

    speakers = assign_speakers(segments, float(settings.get("speaker_threshold", 0.45)),
                               int(options.get("max_speakers", settings.get("max_speakers", 8))))
    duration = round(total / SAMPLE_RATE, 3)
    detected = seconds_by_language.most_common(1)[0][0] if seconds_by_language else None
    doc = {
        "language": detected,
        "requested_language": language,
        "duration": duration,
        "speakers": speakers,
        "segments": segments,
    }
    files = {
        ".txt": to_text(segments),
        ".srt": to_srt(segments),
        ".json": doc,
    }
    plural = lambda n, word: f"{n} {word}{'' if n == 1 else 's'}"
    summary = f"{clock(duration)[:8]} of audio, {plural(len(segments), 'segment')}" + (
        f", {plural(speakers, 'speaker')}" if speakers else "")
    return files, summary


PROCESSORS = {"transcribe": process_transcribe}


# --------------------------------------------------------------------------
# The run
# --------------------------------------------------------------------------

def run(definition: dict, root: Path, *, settle_seconds: float = 10.0,
        processor: Callable | None = None, now: Callable[[], float] = time.time) -> dict:
    name = definition["name"]
    input_dir = root / "input" / definition.get("input", name)
    out = Output(root / "output" / name)
    out.folder.mkdir(parents=True, exist_ok=True)
    proc = processor or PROCESSORS[definition.get("processor", name)]
    settings = definition.get("settings", {})
    extensions = definition.get("extensions", AUDIO_EXTENSIONS)
    stats = Counter()

    lock = open(out.folder / ".lock", "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        lock.close()
        print("another run is busy; leaving it to that one", flush=True)
        return {"busy": 1}

    try:
        for path in candidates(input_dir, extensions):
            rel = path.relative_to(input_dir).as_posix()
            try:
                fp = fingerprint(path)
            except OSError:
                continue
            if now() - fp["mtime_ns"] / 1e9 < settle_seconds:
                stats["settling"] += 1          # probably still being copied in
                continue
            state = state_of(out, rel)
            if state.get("source") == fp and state.get("status") == "done":
                stats["done_before"] += 1
                continue
            if state.get("source") == fp and state.get("attempts", 0) >= MAX_ATTEMPTS:
                stats["given_up"] += 1
                continue
            attempts = state.get("attempts", 0) + 1 if state.get("source") == fp else 1
            try:
                files, summary = proc(path, sidecar_options(path), settings)
            except ServiceUnavailable as exc:
                print(f"waiting: {exc}; trying again next run", flush=True)
                stats["waiting"] += 1
                break
            except Exception as exc:  # noqa: BLE001 - one bad file must not stop the run
                message = f"{type(exc).__name__}: {exc}"[:500]
                out.write(f".state/{rel}.json", json.dumps({"source": fp, "status": "failed", "attempts": attempts,
                                                            "error": message, "time": now_iso()}))
                if attempts >= MAX_ATTEMPTS:
                    out.event(name, "failed", rel, f"gave up after {attempts} attempts: {message}")
                stats["failed"] += 1
                continue
            written = []
            for suffix, content in files.items():
                if isinstance(content, dict):
                    content = json.dumps({"source": {"path": rel, **fp}, "pipeline": name,
                                          "created": now_iso(), **content}, ensure_ascii=False, indent=2) + "\n"
                out.write(rel + suffix, content)
                written.append(rel + suffix)
            out.write(f".state/{rel}.json", json.dumps({"source": fp, "status": "done", "attempts": attempts,
                                                        "outputs": written, "time": now_iso()}))
            out.event(name, "done", rel, summary, written)
            stats["processed"] += 1
    finally:
        fcntl.flock(lock, fcntl.LOCK_UN)
        lock.close()
    return dict(stats)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("definition", type=Path, help="app/pipelines/<name>.json")
    ap.add_argument("--root", type=Path, default=Path("/srv/myai"))
    ap.add_argument("--settle-seconds", type=float, default=10.0)
    args = ap.parse_args(argv)
    definition = json.loads(args.definition.read_text(encoding="utf-8"))
    stats = run(definition, args.root, settle_seconds=args.settle_seconds)
    print(json.dumps(stats), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
