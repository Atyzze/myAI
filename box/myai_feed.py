#!/usr/bin/env python3
"""myai-feed: turn every pipeline's events into Atom feeds.

Reads output/*/events.jsonl (each written only by its own pipeline) and writes
output/feeds/events.atom plus output/feeds/<pipeline>.atom. Any feed reader, or
the email notifier, can subscribe to exactly the pipelines it cares about. No
interpretation happens here: an event is shown as it was recorded.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import uuid
from pathlib import Path
from xml.sax.saxutils import escape, quoteattr

MAX_ENTRIES = 200


def read_events(output_root: Path, skip: set[str]) -> list[dict]:
    events = []
    for log in sorted(output_root.glob("*/events.jsonl")):
        if log.parent.name in skip:
            continue
        try:
            lines = log.read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError:
            continue
        for line in lines[-5000:]:
            try:
                event = json.loads(line)
            except ValueError:
                continue
            if isinstance(event, dict) and event.get("id") and event.get("time"):
                events.append(event)
    events.sort(key=lambda e: e["time"], reverse=True)
    return events


def atom(events: list[dict], title: str, feed_id: str, base_url: str) -> str:
    updated = events[0]["time"] if events else "1970-01-01T00:00:00Z"
    parts = [
        '<?xml version="1.0" encoding="utf-8"?>',
        '<feed xmlns="http://www.w3.org/2005/Atom">',
        f"  <title>{escape(title)}</title>",
        f"  <id>{escape(feed_id)}</id>",
        f"  <updated>{escape(updated)}</updated>",
    ]
    for e in events[:MAX_ENTRIES]:
        kind = str(e.get("kind", "event"))
        what = f"{e.get('pipeline', '?')}: {kind}" + (f" - {e['input']}" if e.get("input") else "")
        parts += [
            "  <entry>",
            f"    <title>{escape(what)}</title>",
            f"    <id>urn:uuid:{escape(str(e['id']))}</id>",
            f"    <updated>{escape(str(e['time']))}</updated>",
            f"    <category term={quoteattr(kind)}/>",
            f"    <category term={quoteattr(str(e.get('pipeline', '')))}/>",
        ]
        for rel in e.get("outputs", [])[:5]:
            href = f"{base_url}/output/{e.get('pipeline')}/{rel}"
            parts.append(f"    <link rel=\"related\" href={quoteattr(href)}/>")
        parts += [
            f"    <content type=\"text\">{escape(str(e.get('message', '')))}</content>",
            "  </entry>",
        ]
    parts.append("</feed>")
    return "\n".join(parts) + "\n"


def write_atomic(path: Path, text: str) -> None:
    tmp = path.with_name(f".{path.name}.{uuid.uuid4().hex[:8]}.partial")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--root", type=Path, default=Path("/srv/myai"))
    ap.add_argument("--base-url", default="", help="prefix for links, e.g. https://myai.tailnet.ts.net")
    args = ap.parse_args(argv)

    output_root = args.root / "output"
    feeds = output_root / "feeds"
    feeds.mkdir(parents=True, exist_ok=True)
    events = read_events(output_root, skip={"feeds"})
    host = os.uname().nodename
    write_atomic(feeds / "events.atom", atom(events, f"myAI box {host}: all events",
                                             f"urn:myai:{host}:events", args.base_url))
    for pipeline in sorted({str(e.get("pipeline")) for e in events}):
        if not pipeline or "/" in pipeline or pipeline.startswith("."):
            continue
        mine = [e for e in events if e.get("pipeline") == pipeline]
        write_atomic(feeds / f"{pipeline}.atom", atom(mine, f"myAI box {host}: {pipeline}",
                                                      f"urn:myai:{host}:{pipeline}", args.base_url))
    print(f"{len(events)} events in feeds", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
