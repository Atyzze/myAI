#!/usr/bin/env python3
"""Build and package the next release of the calendar app as one zip.

The zip holds exactly what a web server serves: index.html, manifest.webmanifest, sw.js,
BUILD_NUMBER, assets/ and src/, at its top level, so it is unpacked straight into the folder the
app is served from (on the box that is done by Nix; anywhere else: unzip into a new folder next to
a CalDAV server reachable at /dav/ on the same site).

The tree carries the last released build; packaging moves it to the next one, runs the full gate
(npm test, or --portable-gate), writes the gate's result into docs/build_notes/BUILD<N>_NOTES.md in
place of the literal GATE_RESULT, builds the zip with this build's own file times, verifies it
against the tree, and writes its sha256. Anything that fails puts the tree back as it was. Build
numbers are never reused.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import zipfile
from pathlib import Path, PurePosixPath

ROOT = Path(__file__).resolve().parents[1]
BUILD_FILE = ROOT / "BUILD_NUMBER"
JOURNAL = ROOT / ".release_journal.json"
PROJECT_ID = "myAI-calendar"
RELEASE_EPOCH = 1735689600  # 2025-01-01; build N carries this plus N days as its file times
SERVED = ["index.html", "manifest.webmanifest", "sw.js", "BUILD_NUMBER"]
SERVED_DIRS = ["assets", "src"]
EXCLUDED_SUFFIXES = {".swp", ".tmp", ".pyc"}
EXCLUDED_NAMES = {".DS_Store", "__pycache__"}


class ReleaseError(RuntimeError):
    pass


def read_build() -> int:
    try:
        build = int(BUILD_FILE.read_text(encoding="ascii").strip())
    except Exception as exc:
        raise ReleaseError(f"invalid or missing BUILD_NUMBER: {exc}") from exc
    if build < 0:
        raise ReleaseError("BUILD_NUMBER cannot be negative")
    return build


def identity_values() -> tuple[int, int, int, int]:
    build = read_build()
    package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    try:
        package_build = int(str(package["version"]).split(".", 1)[0])
    except Exception as exc:
        raise ReleaseError(f"invalid package.json version: {exc}") from exc
    sw = (ROOT / "sw.js").read_text(encoding="utf-8")
    match = re.search(r"(?m)^const VERSION\s*=\s*'v(\d+)';", sw)
    if not match:
        raise ReleaseError("sw.js has no VERSION declaration")
    index = (ROOT / "index.html").read_text(encoding="utf-8")
    stamp = re.search(r'<meta name="myai-calendar-build" content="(\d+)">', index)
    if not stamp:
        raise ReleaseError("index.html has no myai-calendar-build stamp")
    return build, package_build, int(match.group(1)), int(stamp.group(1))


def validate_identity(expected: int | None = None) -> None:
    build, package_build, sw_build, index_build = identity_values()
    if expected is not None and build != expected:
        raise ReleaseError(f"BUILD_NUMBER is {build}, expected {expected}")
    if len({build, package_build, sw_build, index_build}) != 1:
        raise ReleaseError(f"build identity drift: BUILD_NUMBER={build}, package={package_build}, sw={sw_build}, index={index_build}")


def replace_once(path: Path, pattern: str, replacement: str) -> None:
    text = path.read_text(encoding="utf-8")
    updated, count = re.subn(pattern, replacement, text, count=1, flags=re.M)
    if count != 1:
        raise ReleaseError(f"{path.name}: expected exactly one build stamp")
    path.write_text(updated, encoding="utf-8")


def write_build(value: int) -> None:
    BUILD_FILE.write_text(f"{value}\n", encoding="ascii")
    package_path = ROOT / "package.json"
    package = json.loads(package_path.read_text(encoding="utf-8"))
    package["version"] = f"{value}.0.0"
    package_path.write_text(json.dumps(package, indent=2) + "\n", encoding="utf-8")
    replace_once(ROOT / "sw.js", r"^const VERSION\s*=\s*'v\d+';", f"const VERSION     = 'v{value}';")
    replace_once(ROOT / "index.html", r'<meta name="myai-calendar-build" content="\d+">', f'<meta name="myai-calendar-build" content="{value}">')


def recover_interrupted_release() -> None:
    if not JOURNAL.exists():
        return
    data = json.loads(JOURNAL.read_text(encoding="utf-8"))
    write_build(int(data["previous_build"]))
    (ROOT / data["note_path"]).write_text(data["note_before"], encoding="utf-8")
    JOURNAL.unlink(missing_ok=True)
    print(f"recovered an interrupted release; the tree is back at build {data['previous_build']}")


def served_files() -> list[Path]:
    files = [ROOT / name for name in SERVED]
    for folder in SERVED_DIRS:
        for path in sorted((ROOT / folder).rglob("*")):
            if path.is_symlink():
                raise ReleaseError(f"the release would hold a symlink: {path.relative_to(ROOT)}")
            if path.is_file() and path.suffix not in EXCLUDED_SUFFIXES and not (set(path.parts) & EXCLUDED_NAMES):
                files.append(path)
    missing = [str(p.relative_to(ROOT)) for p in files if not p.is_file()]
    if missing:
        raise ReleaseError(f"files the app needs are missing: {missing}")
    return sorted(files, key=lambda p: p.relative_to(ROOT).as_posix())


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    return sha256_bytes(path.read_bytes())


def release_time(build: int) -> tuple[int, int, int, int, int, int]:
    return time.gmtime(RELEASE_EPOCH + build * 86400)[:6]


def run_gate(portable: bool) -> str:
    subprocess.run(["npm", "run", "test:portable" if portable else "test"], cwd=ROOT, check=True)
    report = json.loads((ROOT / "artifacts" / "test-report.json").read_text(encoding="utf-8"))
    if report.get("failed"):
        raise ReleaseError("the gate report has failed suites")
    if report.get("passed", 0) + report.get("skipped", 0) != len(report.get("expectedSuites", [])):
        raise ReleaseError("the gate report does not account for every suite")
    def duration(ms: float) -> str:
        seconds = max(0, round(float(ms) / 1000))
        return f"{seconds // 60} min {seconds % 60:02d} s" if seconds >= 60 else f"{seconds} s"

    took = duration(report.get("wallMs", 0))
    timed = [r for r in report.get("results", []) if isinstance(r.get("durationMs"), (int, float))]
    slowest = max(timed, key=lambda r: r["durationMs"], default=None)
    if slowest:
        took += f"; slowest {slowest['id']} ({duration(slowest['durationMs'])})"
    if portable:
        return f"{report['passed']} suites passed; {report['skipped']} skipped (portable gate) in {took}"
    if report.get("skipped"):
        raise ReleaseError("the strict gate reported a skip")
    return f"{report['passed']} suites passed (strict gate) in {took}"


def create_zip(path: Path, build: int) -> dict[str, str]:
    manifest: dict[str, str] = {}
    stamp = release_time(build)
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for source in served_files():
            rel = source.relative_to(ROOT).as_posix()
            data = source.read_bytes()
            info = zipfile.ZipInfo(rel, date_time=stamp)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = (0o100644 << 16)
            info.create_system = 3
            zf.writestr(info, data)
            manifest[rel] = sha256_bytes(data)
    return manifest


def verify_zip(path: Path, build: int, expected: dict[str, str]) -> None:
    stamp = release_time(build)
    actual: dict[str, str] = {}
    with zipfile.ZipFile(path) as zf:
        if zf.testzip() is not None:
            raise ReleaseError("the zip has a damaged member")
        for info in zf.infolist():
            name = PurePosixPath(info.filename)
            if name.is_absolute() or ".." in name.parts or info.filename.startswith("/"):
                raise ReleaseError(f"unsafe path in the zip: {info.filename}")
            if info.is_dir():
                continue
            if (info.external_attr >> 16) & 0o170000 == 0o120000:
                raise ReleaseError(f"a link in the zip: {info.filename}")
            if info.date_time != stamp:
                raise ReleaseError(f"{info.filename} carries {info.date_time}, not this build's time {stamp}: "
                                   "every build must carry its own file times or a caching server cannot tell two builds apart")
            data = zf.read(info)
            actual[info.filename] = sha256_bytes(data)
            if info.filename == "BUILD_NUMBER" and data.decode("ascii").strip() != str(build):
                raise ReleaseError("the zip's BUILD_NUMBER is not the release's")
    if actual != expected:
        missing = sorted(set(expected) - set(actual))
        extra = sorted(set(actual) - set(expected))
        changed = sorted(k for k in set(expected) & set(actual) if expected[k] != actual[k])
        raise ReleaseError(f"zip and tree differ: missing={missing} extra={extra} changed={changed}")
    for needed in ("index.html", "sw.js", "manifest.webmanifest", "src/js/app.js"):
        if needed not in actual:
            raise ReleaseError(f"the zip lacks {needed}")


def package_release(output_dir: Path, portable: bool) -> tuple[int, Path, Path]:
    recover_interrupted_release()
    validate_identity()
    previous = read_build()
    target = previous + 1
    note = ROOT / "docs" / "build_notes" / f"BUILD{target}_NOTES.md"
    if not note.is_file():
        raise ReleaseError(f"missing build notes: {note.relative_to(ROOT)}")
    note_before = note.read_text(encoding="utf-8")
    if "GATE_RESULT" not in note_before:
        raise ReleaseError(f"{note.relative_to(ROOT)} must contain the literal GATE_RESULT before release")
    output_dir.mkdir(parents=True, exist_ok=True)
    final = output_dir / f"{PROJECT_ID}{target}.zip"
    checksum = output_dir / f"{PROJECT_ID}{target}.zip.sha256"
    if final.exists() or checksum.exists():
        raise ReleaseError(f"build {target} output already exists; build numbers are never reused")

    JOURNAL.write_text(json.dumps({"previous_build": previous, "target_build": target,
                                   "note_path": str(note.relative_to(ROOT)), "note_before": note_before}, indent=2) + "\n",
                       encoding="utf-8")
    published = False
    try:
        write_build(target)
        validate_identity(target)
        gate = run_gate(portable)
        note.write_text(note_before.replace("GATE_RESULT", gate), encoding="utf-8")
        with tempfile.TemporaryDirectory(prefix=f".myai-calendar-{target}-", dir=output_dir) as td:
            staged = Path(td) / final.name
            manifest = create_zip(staged, target)
            verify_zip(staged, target, manifest)
            staged_sum = Path(td) / checksum.name
            staged_sum.write_text(f"{sha256_file(staged)}  {final.name}\n", encoding="ascii")
            os.replace(staged, final)
            try:
                os.replace(staged_sum, checksum)
            except BaseException:
                final.unlink(missing_ok=True)
                raise
        published = True
        JOURNAL.unlink(missing_ok=True)
        return target, final, checksum
    except BaseException:
        if not published:
            write_build(previous)
            note.write_text(note_before, encoding="utf-8")
            JOURNAL.unlink(missing_ok=True)
        raise


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Build and package the next calendar release")
    ap.add_argument("--output", type=Path, default=ROOT.parent, help="where the zip and its sha256 go")
    ap.add_argument("--portable-gate", action="store_true", help="allow a suite whose outside tool is missing to be skipped, and record that")
    args = ap.parse_args(argv)
    try:
        build, archive, checksum = package_release(args.output.resolve(), args.portable_gate)
    except KeyboardInterrupt:
        print("\nrelease interrupted; nothing was published", file=sys.stderr)
        return 130
    except (ReleaseError, subprocess.CalledProcessError, OSError, json.JSONDecodeError) as exc:
        print(f"release failed: {exc}", file=sys.stderr)
        return 1
    print(f"build {build}: {archive}")
    print(f"sha256: {checksum}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
