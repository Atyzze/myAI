#!/usr/bin/env python3
"""myai-backup: a plain loop that copies input and output somewhere else.

No AI, no interpretation: rsync makes a dated snapshot of input/ and output/
(and the app's manifest and pipeline definitions) on the backup target,
hard-linking unchanged files to the previous snapshot so every snapshot is
complete but only changes cost space. Old snapshots are pruned by age; the
newest one is always kept.

The target must hold a file named .myai-backup-target. A backup disk that is
not mounted leaves an empty mount point behind, and copying into it would fill
the system disk while reporting success; the marker makes that a failure.

Every run is an event in output/backup/events.jsonl ("done" or "failed"), and
once a week a "report" event sums up the week, so the feeds and the email
notifier tell someone when backups stop working.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

MARKER = ".myai-backup-target"
STAMP = "%Y-%m-%dT%H%M%SZ"
WEEK = timedelta(days=7)


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def iso(t: datetime) -> str:
    return t.isoformat(timespec="seconds").replace("+00:00", "Z")


class Backup:
    def __init__(self, root: Path, target: Path, keep_days: int, rsync: str = "rsync",
                 clock=utcnow):
        self.root = root
        self.target = target
        self.keep_days = keep_days
        self.rsync = rsync
        self.clock = clock
        self.own = root / "output" / "backup"
        self.own.mkdir(parents=True, exist_ok=True)
        self.state_path = self.own / "state.json"

    # -- bookkeeping -------------------------------------------------------
    def state(self) -> dict:
        try:
            return json.loads(self.state_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {"runs": []}

    def save(self, state: dict) -> None:
        tmp = self.state_path.with_name(".state.json.partial")
        tmp.write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")
        os.replace(tmp, self.state_path)

    def event(self, kind: str, message: str, outputs: list[str] | None = None) -> None:
        event = {"id": str(uuid.uuid4()), "time": iso(self.clock()), "pipeline": "backup",
                 "kind": kind, "input": "", "outputs": outputs or [], "message": message}
        with open(self.own / "events.jsonl", "a", encoding="utf-8") as handle:
            handle.write(json.dumps(event) + "\n")
        print(f"{kind}: {message}", flush=True)

    # -- the copy ----------------------------------------------------------
    def snapshots(self, host_dir: Path) -> list[Path]:
        found = []
        for p in host_dir.iterdir() if host_dir.is_dir() else []:
            try:
                datetime.strptime(p.name, STAMP)
            except ValueError:
                continue
            if p.is_dir():
                found.append(p)
        return sorted(found)

    def copy(self) -> str:
        if not (self.target / MARKER).is_file():
            raise RuntimeError(f"{self.target} is not a prepared backup target (no {MARKER}); "
                               "is the backup disk mounted?")
        host_dir = self.target / os.uname().nodename
        host_dir.mkdir(exist_ok=True)
        previous = self.snapshots(host_dir)
        name = self.clock().strftime(STAMP)
        partial = host_dir / f".{name}.partial"
        shutil.rmtree(partial, ignore_errors=True)
        partial.mkdir()
        sources = [str(self.root / "input"), str(self.root / "output")]
        app = self.root / "app"
        cmd = [self.rsync, "-a", "--stats", "--exclude", ".lock", "--exclude", "*.partial"]
        if previous:
            cmd.append(f"--link-dest={previous[-1]}")
        result = subprocess.run(cmd + sources + [str(partial) + "/"], capture_output=True, text=True)
        if result.returncode not in (0, 24):   # 24: files vanished during the copy
            shutil.rmtree(partial, ignore_errors=True)
            raise RuntimeError(f"rsync failed ({result.returncode}): {result.stderr.strip()[-400:]}")
        meta = partial / "app"
        meta.mkdir()
        for item in ("manifest.json", "pipelines"):
            src = app / item
            if src.is_dir():
                shutil.copytree(src, meta / item, symlinks=False)
            elif src.is_file():
                shutil.copy2(src, meta / item)
        partial.rename(host_dir / name)
        moved = ""
        for line in result.stdout.splitlines():
            if line.startswith("Total transferred file size"):
                moved = line.split(":", 1)[1].strip()
        self.prune(host_dir)
        return f"snapshot {name}" + (f", {moved} copied" if moved else "")

    def prune(self, host_dir: Path) -> None:
        snaps = self.snapshots(host_dir)
        cutoff = self.clock() - timedelta(days=self.keep_days)
        for snap in snaps[:-1]:
            taken = datetime.strptime(snap.name, STAMP).replace(tzinfo=timezone.utc)
            if taken < cutoff:
                shutil.rmtree(snap, ignore_errors=True)

    # -- one run -------------------------------------------------------------
    def run(self) -> int:
        state = self.state()
        started = time.monotonic()
        try:
            message = self.copy()
            ok = True
            self.event("done", f"{message} in {time.monotonic() - started:.0f} s")
        except Exception as exc:  # noqa: BLE001 - every failure is reported, never raised
            ok = False
            message = f"{type(exc).__name__}: {exc}"[:500]
            self.event("failed", message)
        now = self.clock()
        state["runs"] = [r for r in state.get("runs", [])
                         if datetime.fromisoformat(r["time"].replace("Z", "+00:00")) > now - 5 * WEEK]
        state["runs"].append({"time": iso(now), "ok": ok, "message": message})
        last_report = state.get("last_report")
        if not last_report or datetime.fromisoformat(last_report.replace("Z", "+00:00")) <= now - WEEK:
            week = [r for r in state["runs"] if datetime.fromisoformat(r["time"].replace("Z", "+00:00")) > now - WEEK]
            good = sum(r["ok"] for r in week)
            last_good = max((r["time"] for r in state["runs"] if r["ok"]), default="never")
            self.event("report", f"last 7 days: {good} of {len(week)} backups succeeded; "
                                 f"last successful backup: {last_good}")
            state["last_report"] = iso(now)
        self.save(state)
        return 0 if ok else 1


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--root", type=Path, default=Path("/srv/myai"))
    ap.add_argument("--target", type=Path, required=True)
    ap.add_argument("--keep-days", type=int, default=30)
    ap.add_argument("--rsync", default="rsync")
    args = ap.parse_args(argv)
    return Backup(args.root, args.target, args.keep_days, args.rsync).run()


if __name__ == "__main__":
    sys.exit(main())
