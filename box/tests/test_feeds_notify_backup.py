import json
import os
import shutil
import stat
import sys
import tempfile
import unittest
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import myai_backup as backup  # noqa: E402
import myai_feed as feed  # noqa: E402
import myai_notify as notify  # noqa: E402

ATOM = "{http://www.w3.org/2005/Atom}"


def add_event(root, pipeline, kind, message, time="2026-10-06T10:00:00Z", **extra):
    folder = root / "output" / pipeline
    folder.mkdir(parents=True, exist_ok=True)
    event = {"id": f"{pipeline}-{kind}-{message}", "time": time, "pipeline": pipeline, "kind": kind,
             "input": extra.get("input", ""), "outputs": extra.get("outputs", []), "message": message}
    with open(folder / "events.jsonl", "a") as handle:
        handle.write(json.dumps(event) + "\n")


class FeedTests(unittest.TestCase):
    def test_all_events_and_one_feed_per_pipeline(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            add_event(root, "transcribe", "done", "1 min <audio> & more", "2026-10-06T10:00:00Z",
                      input="a.wav", outputs=["a.wav.txt"])
            add_event(root, "backup", "failed", "disk missing", "2026-10-06T11:00:00Z")
            (root / "output/transcribe/events.jsonl").open("a").write("not json\n")
            feed.main(["--root", str(root), "--base-url", "https://box.ts.net"])
            tree = ET.parse(root / "output/feeds/events.atom")
            entries = tree.getroot().findall(f"{ATOM}entry")
            self.assertEqual([e.find(f"{ATOM}title").text for e in entries],
                             ["backup: failed", "transcribe: done - a.wav"])
            self.assertEqual(entries[1].find(f"{ATOM}content").text, "1 min <audio> & more")
            self.assertEqual(entries[1].find(f"{ATOM}link").get("href"),
                             "https://box.ts.net/output/transcribe/a.wav.txt")
            self.assertTrue((root / "output/feeds/backup.atom").is_file())
            self.assertTrue((root / "output/feeds/transcribe.atom").is_file())


class NotifyTests(unittest.TestCase):
    def setUp(self):
        self.td = tempfile.TemporaryDirectory()
        self.root = Path(self.td.name)
        self.sent = self.root / "sent.eml"
        self.sendmail = self.root / "fake-sendmail"
        self.sendmail.write_text(f"#!/bin/sh\n[ -f {self.root}/fail ] && exit 75\ncat >> {self.sent}\n")
        self.sendmail.chmod(self.sendmail.stat().st_mode | stat.S_IEXEC)

    def tearDown(self):
        self.td.cleanup()

    def run_notify(self, *extra):
        return notify.main(["--root", str(self.root), "--to", "me@example.org", "--from", "box@example.org",
                            "--sendmail", str(self.sendmail), *extra])

    def test_first_run_sends_no_backlog_then_only_new_matching_events(self):
        add_event(self.root, "transcribe", "failed", "old failure")
        self.assertEqual(self.run_notify(), 0)
        self.assertFalse(self.sent.exists(), "no backlog on the first run")
        add_event(self.root, "transcribe", "done", "fine")
        add_event(self.root, "transcribe", "failed", "new failure", input="x.mp3")
        add_event(self.root, "backup", "report", "7 of 7 backups succeeded")
        self.assertEqual(self.run_notify(), 0)
        mail = self.sent.read_text()
        self.assertIn("Subject: [myAI", mail)
        self.assertIn("new failure", mail)
        self.assertIn("7 of 7", mail)
        self.assertNotIn("fine", mail)
        self.assertNotIn("old failure", mail)
        self.assertEqual(mail.count("Subject:"), 1, "one email per run")
        self.assertEqual(self.run_notify(), 0)
        self.assertEqual(self.sent.read_text().count("Subject:"), 1, "nothing new, nothing sent")

    def test_pipeline_filter(self):
        self.run_notify("--pipelines", "backup")
        add_event(self.root, "transcribe", "failed", "not for me")
        self.run_notify("--pipelines", "backup")
        self.assertFalse(self.sent.exists())

    def test_a_failed_send_is_retried_and_recorded(self):
        self.run_notify()
        add_event(self.root, "transcribe", "failed", "needs telling")
        (self.root / "fail").write_text("")
        self.assertEqual(self.run_notify(), 1)
        own = (self.root / "output/notify/events.jsonl").read_text()
        self.assertIn("sending email failed", own)
        (self.root / "fail").unlink()
        self.assertEqual(self.run_notify(), 0)
        self.assertIn("needs telling", self.sent.read_text())
        self.assertNotIn("sending email failed", self.sent.read_text(), "never emails about itself")


RSYNC = shutil.which("rsync") or os.environ.get("RSYNC")


@unittest.skipUnless(RSYNC, "rsync not installed")
class BackupTests(unittest.TestCase):
    def setUp(self):
        self.td = tempfile.TemporaryDirectory()
        self.root = Path(self.td.name) / "srv"
        self.target = Path(self.td.name) / "disk"
        (self.root / "input/transcribe").mkdir(parents=True)
        (self.root / "input/transcribe/a.wav").write_text("audio")
        (self.root / "output/transcribe").mkdir(parents=True)
        (self.root / "output/transcribe/a.wav.txt").write_text("text")
        (self.root / "app/pipelines").mkdir(parents=True)
        (self.root / "app/pipelines/transcribe.json").write_text("{}")
        (self.root / "app/models").mkdir()
        (self.root / "app/models/huge.bin").write_text("weights")
        self.target.mkdir()
        self.now = datetime(2026, 10, 6, 3, 0, tzinfo=timezone.utc)

    def tearDown(self):
        self.td.cleanup()

    def make(self):
        return backup.Backup(self.root, self.target, keep_days=7, rsync=RSYNC, clock=lambda: self.now)

    def events(self):
        return [json.loads(l) for l in (self.root / "output/backup/events.jsonl").read_text().splitlines()]

    def test_unprepared_target_fails_loudly(self):
        self.assertEqual(self.make().run(), 1)
        kinds = [e["kind"] for e in self.events()]
        self.assertEqual(kinds, ["failed", "report"])
        self.assertIn("is the backup disk mounted", self.events()[0]["message"])
        self.assertIn("0 of 1", self.events()[1]["message"])

    def test_snapshots_hard_link_unchanged_files_and_prune_old_ones(self):
        (self.target / backup.MARKER).write_text("")
        self.assertEqual(self.make().run(), 0)
        host = self.target / os.uname().nodename
        [first] = backup.Backup(self.root, self.target, 7, RSYNC).snapshots(host)
        self.assertEqual((first / "input/transcribe/a.wav").read_text(), "audio")
        self.assertEqual((first / "output/transcribe/a.wav.txt").read_text(), "text")
        self.assertTrue((first / "app/pipelines/transcribe.json").is_file())
        self.assertFalse((first / "app/models").exists(), "models are re-downloadable, not backed up")

        self.now += timedelta(days=1)
        self.make().run()
        snaps = backup.Backup(self.root, self.target, 7, RSYNC).snapshots(host)
        self.assertEqual(len(snaps), 2)
        self.assertEqual(os.stat(snaps[0] / "input/transcribe/a.wav").st_ino,
                         os.stat(snaps[1] / "input/transcribe/a.wav").st_ino, "unchanged files are hard links")

        self.now += timedelta(days=10)
        self.make().run()
        snaps = backup.Backup(self.root, self.target, 7, RSYNC).snapshots(host)
        self.assertEqual(len(snaps), 1, "snapshots older than keep_days are pruned, the newest kept")
        kinds = [e["kind"] for e in self.events()]
        self.assertEqual(kinds, ["done", "report", "done", "done", "report"])


if __name__ == "__main__":
    unittest.main()
