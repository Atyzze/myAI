#!/usr/bin/env python3
"""myai-notify: email the events someone subscribed to.

Email is the box's universal way out: any pipeline's events (a failed
transcription, a backup that did not run, the weekly backup report) become an
email to whoever subscribed, filtered by pipeline and kind. Each run sends at
most one email with everything new since the last run, so a burst of failures
is one message, not a flood.

Reads output/*/events.jsonl, remembers how far it read in output/notify/state.json,
and hands the message to a sendmail-compatible program (msmtp on the box).
Its own failures to send are recorded as events in output/notify/, which the
feed shows; it never emails about itself.
"""

from __future__ import annotations

import argparse
import fnmatch
import json
import os
import subprocess
import sys
import uuid
from datetime import datetime, timezone
from email.message import EmailMessage
from pathlib import Path

OWN = "notify"
SKIP = {OWN, "feeds"}


def load_state(path: Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def new_events(output_root: Path, offsets: dict, first_run: bool) -> tuple[list[dict], dict]:
    found, updated = [], dict(offsets)
    for log in sorted(output_root.glob("*/events.jsonl")):
        if log.parent.name in SKIP:
            continue
        key = log.parent.name
        size = log.stat().st_size
        start = offsets.get(key, size if first_run else 0)
        if start > size:                       # log was replaced; read it again
            start = 0
        with open(log, "rb") as handle:
            handle.seek(start)
            chunk = handle.read()
        complete = chunk[: chunk.rfind(b"\n") + 1]
        for line in complete.decode("utf-8", "replace").splitlines():
            try:
                event = json.loads(line)
            except ValueError:
                continue
            if isinstance(event, dict):
                found.append(event)
        updated[key] = start + len(complete)
    found.sort(key=lambda e: str(e.get("time", "")))
    return found, updated


def wanted(event: dict, kinds: list[str], pipelines: list[str]) -> bool:
    return (any(fnmatch.fnmatch(str(event.get("kind", "")), k) for k in kinds)
            and any(fnmatch.fnmatch(str(event.get("pipeline", "")), p) for p in pipelines))


def compose(events: list[dict], sender: str, recipients: list[str], host: str) -> EmailMessage:
    kinds = sorted({f"{e.get('pipeline')} {e.get('kind')}" for e in events})
    msg = EmailMessage()
    msg["From"] = sender
    msg["To"] = ", ".join(recipients)
    msg["Subject"] = f"[myAI {host}] {len(events)} event{'s' if len(events) != 1 else ''}: {', '.join(kinds)[:120]}"
    lines = []
    for e in events:
        lines.append(f"{e.get('time')}  {e.get('pipeline')}  {str(e.get('kind', '')).upper()}")
        if e.get("input"):
            lines.append(f"  input:   {e['input']}")
        for rel in e.get("outputs", [])[:5]:
            lines.append(f"  output:  output/{e.get('pipeline')}/{rel}")
        lines.append(f"  {e.get('message', '')}")
        lines.append("")
    lines.append("All events: /feeds/events.atom on the box (over your tailnet).")
    msg.set_content("\n".join(lines))
    return msg


def record_failure(own: Path, message: str) -> None:
    event = {"id": str(uuid.uuid4()),
             "time": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
             "pipeline": OWN, "kind": "failed", "input": "", "outputs": [], "message": message[:500]}
    with open(own / "events.jsonl", "a", encoding="utf-8") as handle:
        handle.write(json.dumps(event) + "\n")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--root", type=Path, default=Path("/srv/myai"))
    ap.add_argument("--to", action="append", required=True)
    ap.add_argument("--from", dest="sender", required=True)
    ap.add_argument("--kinds", default="failed,report", help="comma-separated, globs allowed")
    ap.add_argument("--pipelines", default="*", help="comma-separated, globs allowed")
    ap.add_argument("--sendmail", default="msmtp", help="sendmail-compatible program; message on stdin")
    args = ap.parse_args(argv)

    output_root = args.root / "output"
    own = output_root / OWN
    own.mkdir(parents=True, exist_ok=True)
    state_path = own / "state.json"
    state = load_state(state_path)
    events, offsets = new_events(output_root, state.get("offsets", {}), first_run=not state)
    kinds = [k.strip() for k in args.kinds.split(",") if k.strip()]
    pipelines = [p.strip() for p in args.pipelines.split(",") if p.strip()]
    chosen = [e for e in events if wanted(e, kinds, pipelines)]

    if chosen:
        msg = compose(chosen, args.sender, args.to, os.uname().nodename)
        result = subprocess.run([args.sendmail, "-t"], input=msg.as_bytes(), capture_output=True, timeout=120)
        if result.returncode != 0:
            # Keep the old offsets so the same events are tried again next run.
            record_failure(own, f"sending email failed ({result.returncode}): "
                                f"{result.stderr.decode('utf-8', 'replace').strip()[-300:]}")
            print("email failed; will retry", file=sys.stderr, flush=True)
            return 1
    tmp = state_path.with_name(".state.json.partial")
    tmp.write_text(json.dumps({"offsets": offsets}, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, state_path)
    print(f"{len(events)} new events, {len(chosen)} emailed", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
