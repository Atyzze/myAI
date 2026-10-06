#!/usr/bin/env python3
"""Create the only supported VTS release archive.

Release contract:
- every shipped archive advances BUILD_NUMBER exactly once;
- archive name is VTS<N>.tar.zst;
- archive contains exactly one top-level directory: vts_build_<N>;
- BUILD_NUMBER inside that directory must equal N;
- local/deployment state and secrets are excluded;
- the stdlib test gate must pass before the number is earned;
- output is a PAX tar compressed with Zstandard level 10 by default;
- the finished archive is integrity-checked before atomic publication.

This tool is standard-library only. It requires the host `zstd` binary.
"""
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
PROJECT_ID = "VTS"
TOP_PREFIX = "vts_build_"
DEFAULT_LEVEL = 10

EXCLUDED_NAMES = {
    ".git",
    ".venv",
    ".pytest_cache",
    "__pycache__",
    "model",
    "embed",
    "var",  # project-local install audit log: var/log/install.log
    "server.env",
    "fullchain.pem",
    "privkey.pem",
    ".coverage",
    ".DS_Store",
    JOURNAL.name,
}
EXCLUDED_SUFFIXES = {".pyc", ".pyo", ".swp", ".tmp"}


class ReleaseError(RuntimeError):
    pass


def read_build() -> int:
    try:
        value = int(BUILD_FILE.read_text(encoding="ascii").strip())
    except Exception as exc:
        raise ReleaseError(f"invalid or missing BUILD_NUMBER: {exc}") from exc
    if value < 1:
        raise ReleaseError("BUILD_NUMBER must be a positive integer")
    return value


def write_build(value: int) -> None:
    """Write authoritative build identity and its packaging-metadata mirror."""
    BUILD_FILE.write_text(f"{value}\n", encoding="ascii")
    pyproject = ROOT / "pyproject.toml"
    text = pyproject.read_text(encoding="utf-8")
    updated, count = re.subn(
        r'(?m)^version = "[^"]+"$',
        f'version = "0.0.{value}"',
        text,
        count=1,
    )
    if count != 1:
        raise ReleaseError("pyproject.toml must contain exactly one project version line")
    pyproject.write_text(updated, encoding="utf-8")


def run(cmd: list[str], *, capture: bool = False) -> subprocess.CompletedProcess[str]:
    kwargs = {"cwd": ROOT, "text": True, "check": True}
    if capture:
        kwargs |= {"stdout": subprocess.PIPE, "stderr": subprocess.STDOUT}
    return subprocess.run(cmd, **kwargs)


def recover_interrupted_release() -> None:
    if not JOURNAL.exists():
        return
    data = json.loads(JOURNAL.read_text(encoding="utf-8"))
    previous = int(data["previous_build"])
    note = ROOT / data["note_path"]
    note_before = data.get("note_before")
    write_build(previous)
    if note_before is not None:
        note.write_text(note_before, encoding="utf-8")
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
    files.sort(key=lambda p: p.relative_to(ROOT).as_posix())
    return files


def normalized_tarinfo(info: tarfile.TarInfo) -> tarfile.TarInfo:
    info.uid = 0
    info.gid = 0
    info.uname = "root"
    info.gname = "root"
    info.mtime = 0
    if info.isfile():
        # Keep executable bits, normalize all other permissions.
        info.mode = 0o755 if info.mode & 0o111 else 0o644
    return info


def run_test_gate() -> int:
    cmd = [sys.executable, "-m", "unittest", "discover", "-s", "tests", "-v"]
    proc = run(cmd, capture=True)
    print(proc.stdout, end="")
    matches = re.findall(r"Ran\s+(\d+)\s+tests?", proc.stdout)
    if not matches:
        raise ReleaseError("test gate passed but test count could not be parsed")
    return int(matches[-1])


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def create_tar(tar_path: Path, build: int) -> dict[str, str]:
    top = f"{TOP_PREFIX}{build}"
    manifest: dict[str, str] = {}
    with tarfile.open(tar_path, "w", format=tarfile.PAX_FORMAT) as tf:
        root_info = tarfile.TarInfo(top)
        root_info.type = tarfile.DIRTYPE
        root_info.mode = 0o755
        root_info.mtime = 0
        root_info.uid = root_info.gid = 0
        root_info.uname = root_info.gname = "root"
        tf.addfile(root_info)

        for source in release_files():
            rel = source.relative_to(ROOT).as_posix()
            arcname = f"{top}/{rel}"
            info = tf.gettarinfo(str(source), arcname=arcname)
            info = normalized_tarinfo(info)
            with source.open("rb") as handle:
                tf.addfile(info, handle)
            manifest[rel] = sha256(source)
    return manifest


def compress_zstd(tar_path: Path, output_path: Path, level: int) -> None:
    zstd = shutil.which("zstd")
    if not zstd:
        raise ReleaseError("zstd command not found")
    run([zstd, f"-{level}", "-T0", "-q", "-f", str(tar_path), "-o", str(output_path)])


def validate_member_name(name: str, top: str) -> str:
    pure = PurePosixPath(name)
    if pure.is_absolute() or ".." in pure.parts:
        raise ReleaseError(f"unsafe archive member: {name}")
    if not pure.parts or pure.parts[0] != top:
        raise ReleaseError(f"archive member outside {top}: {name}")
    if len(pure.parts) == 1:
        return ""
    return PurePosixPath(*pure.parts[1:]).as_posix()


def verify_archive(archive: Path, build: int, expected: dict[str, str]) -> None:
    zstd = shutil.which("zstd")
    if not zstd:
        raise ReleaseError("zstd command not found")
    top = f"{TOP_PREFIX}{build}"
    with tempfile.TemporaryDirectory(prefix="vts-release-verify-") as td:
        tar_path = Path(td) / "release.tar"
        with tar_path.open("wb") as out:
            subprocess.run([zstd, "-d", "-q", "-c", str(archive)], check=True, stdout=out)

        actual: dict[str, str] = {}
        build_members = 0
        with tarfile.open(tar_path, "r:") as tf:
            members = tf.getmembers()
            if not members:
                raise ReleaseError("archive is empty")
            top_levels = {PurePosixPath(m.name).parts[0] for m in members if PurePosixPath(m.name).parts}
            if top_levels != {top}:
                raise ReleaseError(f"archive must contain exactly one top-level directory {top}")
            for member in members:
                rel = validate_member_name(member.name, top)
                if not rel:
                    continue
                if any(part in EXCLUDED_NAMES for part in PurePosixPath(rel).parts):
                    raise ReleaseError(f"excluded path leaked into archive: {rel}")
                if member.issym() or member.islnk():
                    raise ReleaseError(f"links are not allowed in a release: {rel}")
                if not member.isfile():
                    continue
                extracted = tf.extractfile(member)
                if extracted is None:
                    raise ReleaseError(f"could not read archive member: {rel}")
                data = extracted.read()
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


def write_checksum(archive: Path) -> Path:
    checksum = archive.with_name(archive.name + ".sha256")
    checksum.write_text(f"{sha256(archive)}  {archive.name}\n", encoding="ascii")
    return checksum


def package_release(output_dir: Path, level: int) -> tuple[int, Path, Path]:
    recover_interrupted_release()
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
        tests = run_test_gate()
        note.write_text(note_before.replace("GATE_RESULT", f"{tests} tests passed"), encoding="utf-8")

        with tempfile.TemporaryDirectory(prefix=f"vts-build-{target}-") as td:
            td_path = Path(td)
            tar_path = td_path / f"VTS{target}.tar"
            zst_path = td_path / f"VTS{target}.tar.zst"
            manifest = create_tar(tar_path, target)
            compress_zstd(tar_path, zst_path, level)
            verify_archive(zst_path, target, manifest)
            os.replace(zst_path, final)
        checksum_path = write_checksum(final)
        published = True
        JOURNAL.unlink(missing_ok=True)
        return target, final, checksum_path
    except BaseException:
        if not published:
            write_build(previous)
            note.write_text(note_before, encoding="utf-8")
            JOURNAL.unlink(missing_ok=True)
        raise


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Build and package the next VTS release")
    p.add_argument("--output", type=Path, default=ROOT.parent, help="release output directory")
    p.add_argument("--compression-level", type=int, default=DEFAULT_LEVEL, choices=range(1, 20), metavar="1-19")
    return p


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try:
        build, archive, checksum = package_release(args.output.resolve(), args.compression_level)
    except (ReleaseError, subprocess.CalledProcessError, OSError, json.JSONDecodeError) as exc:
        print(f"release failed: {exc}", file=sys.stderr)
        try:
            print(f"tree is at build {read_build()}", file=sys.stderr)
        except Exception:
            pass
        return 1
    print(f"build {build}: {archive}")
    print(f"sha256: {checksum}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
