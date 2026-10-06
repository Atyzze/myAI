#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path, PurePosixPath

ROOT = Path(__file__).resolve().parents[1]
BUILD_FILE = ROOT / "BUILD_NUMBER"
JOURNAL = ROOT / ".release_journal.json"
PROJECT_ID = "myAI"
TOP_PREFIX = "myai_build_"
DEFAULT_LEVEL = 10
RELEASE_EPOCH = 1735689600

EXCLUDED_NAMES = {
    ".git",
    "node_modules",
    "artifacts",
    ".release_journal.json",
    ".DS_Store",
    "__pycache__",
}
EXCLUDED_SUFFIXES = {".swp", ".tmp", ".tar", ".zst", ".sha256", ".pyc"}


class ReleaseError(RuntimeError):
    pass


def run(cmd: list[str], *, cwd: Path = ROOT, capture: bool = False) -> subprocess.CompletedProcess[str]:
    kwargs: dict[str, object] = {"cwd": cwd, "text": True, "check": True}
    if capture:
        kwargs |= {"stdout": subprocess.PIPE, "stderr": subprocess.STDOUT}
    return subprocess.run(cmd, **kwargs)


def read_build() -> int:
    try:
        build = int(BUILD_FILE.read_text(encoding="ascii").strip())
    except Exception as exc:
        raise ReleaseError(f"invalid or missing BUILD_NUMBER: {exc}") from exc
    if build < 1:
        raise ReleaseError("BUILD_NUMBER must be positive")
    return build


def identity_values() -> tuple[int, int, int]:
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
    stamp = re.search(r'<meta name="myai-build" content="(\d+)">', index)
    if not stamp:
        raise ReleaseError("index.html has no myai-build stamp")
    return build, package_build, int(match.group(1)), int(stamp.group(1))


def validate_identity(expected: int | None = None) -> None:
    build, package_build, sw_build, index_build = identity_values()
    if expected is not None and build != expected:
        raise ReleaseError(f"BUILD_NUMBER is {build}, expected {expected}")
    if len({build, package_build, sw_build, index_build}) != 1:
        raise ReleaseError(
            f"build identity drift: BUILD_NUMBER={build}, package={package_build}, "
            f"sw={sw_build}, index={index_build}"
        )


def write_build(value: int) -> None:
    BUILD_FILE.write_text(f"{value}\n", encoding="ascii")

    package_path = ROOT / "package.json"
    package = json.loads(package_path.read_text(encoding="utf-8"))
    package["version"] = f"{value}.0.0"
    package_path.write_text(json.dumps(package, indent=2) + "\n", encoding="utf-8")

    sw_path = ROOT / "sw.js"
    sw = sw_path.read_text(encoding="utf-8")
    updated, count = re.subn(
        r"(?m)^const VERSION\s*=\s*'v\d+';",
        f"const VERSION     = 'v{value}';",
        sw,
        count=1,
    )
    if count != 1:
        raise ReleaseError("sw.js must contain exactly one VERSION declaration")
    sw_path.write_text(updated, encoding="utf-8")

    index_path = ROOT / "index.html"
    index = index_path.read_text(encoding="utf-8")
    stamped, count = re.subn(
        r'<meta name="myai-build" content="\d+">',
        f'<meta name="myai-build" content="{value}">',
        index,
        count=1,
    )
    if count != 1:
        raise ReleaseError("index.html must contain exactly one myai-build stamp")
    index_path.write_text(stamped, encoding="utf-8")


def recover_interrupted_release() -> None:
    if not JOURNAL.exists():
        return
    data = json.loads(JOURNAL.read_text(encoding="utf-8"))
    previous = int(data["previous_build"])
    note = ROOT / data["note_path"]
    write_build(previous)
    note.write_text(data["note_before"], encoding="utf-8")
    JOURNAL.unlink(missing_ok=True)
    print(f"recovered interrupted release; tree restored to build {previous}")


def excluded(path: Path) -> bool:
    rel = path.relative_to(ROOT)
    if any(part in EXCLUDED_NAMES for part in rel.parts):
        return True
    if path.name in EXCLUDED_NAMES:
        return True
    if path.suffix in EXCLUDED_SUFFIXES:
        return True
    return False


def release_files() -> list[Path]:
    files: list[Path] = []
    for path in ROOT.rglob("*"):
        if excluded(path):
            continue
        if path.is_symlink():
            raise ReleaseError(f"release tree contains symlink: {path.relative_to(ROOT)}")
        if path.is_file():
            files.append(path)
    return sorted(files, key=lambda p: p.relative_to(ROOT).as_posix())


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def release_mtime(build: int) -> int:
    return RELEASE_EPOCH + (build * 86400)


def normalized_tarinfo(info: tarfile.TarInfo, mtime: int) -> tarfile.TarInfo:
    info.uid = info.gid = 0
    info.uname = info.gname = "root"
    info.mtime = mtime
    if info.isfile():
        info.mode = 0o755 if info.mode & 0o111 else 0o644
    return info


def run_test_gate(portable: bool) -> str:
    cmd = ["npm", "run", "test:portable"] if portable else ["npm", "test"]
    run(cmd)
    report_path = ROOT / "artifacts" / "baseline-report.json"
    try:
        report = json.loads(report_path.read_text(encoding="utf-8"))
    except Exception as exc:
        raise ReleaseError(f"test gate passed but baseline report could not be read: {exc}") from exc
    if report.get("failed"):
        raise ReleaseError("baseline report contains failed suites")
    passed = int(report.get("passed", 0))
    skipped = int(report.get("skipped", 0))
    expected = len(report.get("expectedSuites", []))
    if passed + skipped != expected:
        raise ReleaseError("baseline report does not account for every expected suite")
    timing = describe_gate_time(report)
    if portable:
        return f"{passed} suites passed; {skipped} skipped (portable gate){timing}"
    if skipped:
        raise ReleaseError("strict gate reported a skip")
    return f"{passed} suites passed (strict gate){timing}"


def describe_duration(ms: float) -> str:
    seconds = max(0, round(float(ms) / 1000))
    if seconds < 60:
        return f"{seconds} s"
    return f"{seconds // 60} min {seconds % 60:02d} s"


def describe_gate_time(report: dict) -> str:
    wall = report.get("wallMs")
    if not isinstance(wall, (int, float)):
        return ""
    timed = [item for item in report.get("results", []) if isinstance(item.get("durationMs"), (int, float))]
    slowest = max(timed, key=lambda item: item["durationMs"], default=None)
    text = f" in {describe_duration(wall)}"
    if slowest:
        text += f"; slowest {slowest['id']} ({describe_duration(slowest['durationMs'])})"
    return text


def create_tar(tar_path: Path, build: int) -> dict[str, str]:
    top = f"{TOP_PREFIX}{build}"
    stamp = release_mtime(build)
    manifest: dict[str, str] = {}
    with tarfile.open(tar_path, "w", format=tarfile.PAX_FORMAT) as tf:
        root_info = tarfile.TarInfo(top)
        root_info.type = tarfile.DIRTYPE
        root_info.mode = 0o755
        root_info.mtime = stamp
        root_info.uid = root_info.gid = 0
        root_info.uname = root_info.gname = "root"
        tf.addfile(root_info)
        for source in release_files():
            rel = source.relative_to(ROOT).as_posix()
            info = normalized_tarinfo(tf.gettarinfo(str(source), arcname=f"{top}/{rel}"), stamp)
            with source.open("rb") as handle:
                tf.addfile(info, handle)
            manifest[rel] = sha256(source)
    return manifest


def compress_zstd(tar_path: Path, output_path: Path, level: int) -> None:
    zstd = shutil.which("zstd")
    if not zstd:
        raise ReleaseError("zstd command not found")
    run([zstd, f"-{level}", "-T0", "-q", "-f", str(tar_path), "-o", str(output_path)])


def verify_archive(archive: Path, build: int, expected: dict[str, str]) -> None:
    zstd = shutil.which("zstd")
    if not zstd:
        raise ReleaseError("zstd command not found")
    top = f"{TOP_PREFIX}{build}"
    with tempfile.TemporaryDirectory(prefix="myai-release-verify-") as td:
        tar_path = Path(td) / "release.tar"
        with tar_path.open("wb") as out:
            subprocess.run([zstd, "-d", "-q", "-c", str(archive)], check=True, stdout=out)
        actual: dict[str, str] = {}
        build_members = 0
        with tarfile.open(tar_path, "r:") as tf:
            members = tf.getmembers()
            top_levels = {PurePosixPath(m.name).parts[0] for m in members if PurePosixPath(m.name).parts}
            if top_levels != {top}:
                raise ReleaseError(f"archive must contain exactly one top-level directory {top}")
            for member in members:
                pure = PurePosixPath(member.name)
                if pure.is_absolute() or ".." in pure.parts:
                    raise ReleaseError(f"unsafe archive member: {member.name}")
                rel = PurePosixPath(*pure.parts[1:]).as_posix() if len(pure.parts) > 1 else ""
                if not rel:
                    continue
                if any(part in EXCLUDED_NAMES for part in PurePosixPath(rel).parts):
                    raise ReleaseError(f"excluded path leaked into archive: {rel}")
                if member.issym() or member.islnk():
                    raise ReleaseError(f"links are forbidden in release archives: {rel}")
                if member.mtime != release_mtime(build):
                    raise ReleaseError(
                        f"{rel} carries mtime {member.mtime}; every build must carry its own "
                        "modification time or a caching server cannot tell two builds apart")
                if not member.isfile():
                    continue
                fh = tf.extractfile(member)
                if fh is None:
                    raise ReleaseError(f"cannot read archive member: {rel}")
                data = fh.read()
                actual[rel] = hashlib.sha256(data).hexdigest()
                if rel == "BUILD_NUMBER":
                    build_members += 1
                    if data.decode("ascii").strip() != str(build):
                        raise ReleaseError("archive BUILD_NUMBER does not match archive name")
        if build_members != 1:
            raise ReleaseError("archive must contain exactly one BUILD_NUMBER")
        if actual != expected:
            missing = sorted(set(expected) - set(actual))
            extra = sorted(set(actual) - set(expected))
            changed = sorted(k for k in set(expected) & set(actual) if expected[k] != actual[k])
            raise ReleaseError(f"archive/source mismatch: missing={missing} extra={extra} changed={changed}")


def write_checksum(archive: Path, published_name: str | None = None) -> Path:
    name = published_name or archive.name
    checksum = archive.with_name(name + ".sha256")
    checksum.write_text(f"{sha256(archive)}  {name}\n", encoding="ascii")
    return checksum


def publish(moves: list[tuple[Path, Path]]) -> None:
    done: list[Path] = []
    try:
        for source, target in moves:
            os.replace(source, target)
            done.append(target)
    except BaseException:
        for target in done:
            target.unlink(missing_ok=True)
        raise


def package_release(output_dir: Path, level: int, portable: bool) -> tuple[int, Path, Path]:
    recover_interrupted_release()
    validate_identity()
    previous = read_build()
    target = previous + 1
    note = ROOT / "docs" / "build_notes" / f"BUILD{target}_NOTES.md"
    if not note.is_file():
        raise ReleaseError(f"missing build notes: {note.relative_to(ROOT)}")
    note_before = note.read_text(encoding="utf-8")
    if "GATE_RESULT" not in note_before:
        raise ReleaseError(f"{note.relative_to(ROOT)} must contain literal GATE_RESULT before release")

    output_dir.mkdir(parents=True, exist_ok=True)
    final = output_dir / f"{PROJECT_ID}{target}.tar.zst"
    checksum = output_dir / f"{PROJECT_ID}{target}.tar.zst.sha256"
    if final.exists() or checksum.exists():
        raise ReleaseError(f"build {target} output already exists; build numbers are never reused")

    JOURNAL.write_text(json.dumps({
        "previous_build": previous,
        "target_build": target,
        "note_path": str(note.relative_to(ROOT)),
        "note_before": note_before,
    }, indent=2) + "\n", encoding="utf-8")

    published = False
    try:
        write_build(target)
        validate_identity(target)
        gate_result = run_test_gate(portable)
        note.write_text(note_before.replace("GATE_RESULT", gate_result), encoding="utf-8")

        with tempfile.TemporaryDirectory(prefix=f".myai-build-{target}-", dir=output_dir) as td:
            td_path = Path(td)
            tar_path = td_path / f"myAI{target}.tar"
            zst_path = td_path / f"myAI{target}.tar.zst"
            manifest = create_tar(tar_path, target)
            compress_zstd(tar_path, zst_path, level)
            verify_archive(zst_path, target, manifest)
            checksum_staged = write_checksum(zst_path, final.name)
            publish([(zst_path, final), (checksum_staged, checksum)])
        published = True
        JOURNAL.unlink(missing_ok=True)
        return target, final, checksum
    except BaseException:
        if not published:
            write_build(previous)
            note.write_text(note_before, encoding="utf-8")
            JOURNAL.unlink(missing_ok=True)
        raise


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Build and package the next myAI release")
    p.add_argument("--output", type=Path, default=ROOT.parent, help="release output directory")
    p.add_argument("--compression-level", type=int, default=DEFAULT_LEVEL, choices=range(1, 20), metavar="1-19")
    p.add_argument("--portable-gate", action="store_true", help="allow explicit external-integration skips and record that fact in build notes")
    return p


def report_tree_build() -> None:
    try:
        print(f"tree is at build {read_build()}", file=sys.stderr)
    except Exception:
        pass


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try:
        build, archive, checksum = package_release(args.output.resolve(), args.compression_level, args.portable_gate)
    except KeyboardInterrupt:
        print("\nrelease interrupted; nothing was published", file=sys.stderr)
        report_tree_build()
        return 130
    except (ReleaseError, subprocess.CalledProcessError, OSError, json.JSONDecodeError) as exc:
        print(f"release failed: {exc}", file=sys.stderr)
        report_tree_build()
        return 1
    print(f"build {build}: {archive}")
    print(f"sha256: {checksum}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
