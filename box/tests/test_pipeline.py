import json
import math
import os
import shutil
import struct
import sys
import tempfile
import time
import unittest
import wave
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import myai_pipeline as pl  # noqa: E402

SR = pl.SAMPLE_RATE


def tone(seconds, amp=8000, freq=220):
    n = int(seconds * SR)
    return struct.pack(f"<{n}h", *(int(amp * math.sin(2 * math.pi * freq * i / SR)) for i in range(n)))


def silence(seconds):
    return b"\x00\x00" * int(seconds * SR)


def blocks(pcm, size=SR * 2):
    for i in range(0, len(pcm), size):
        yield pcm[i:i + size]


class WindowTests(unittest.TestCase):
    def test_windows_cover_everything_exactly_once(self):
        pcm = tone(7) + silence(0.5) + tone(6) + silence(0.4) + tone(3)
        parts = list(pl.windows(blocks(pcm), window_s=6, search_s=2))
        self.assertEqual(b"".join(p for _, p in parts), pcm)
        starts = [s for s, _ in parts]
        self.assertEqual(starts[0], 0)
        for (s, p), nxt in zip(parts, starts[1:]):
            self.assertEqual(s + len(p) // 2, nxt)

    def test_cuts_land_in_the_quiet(self):
        pcm = tone(5.2) + silence(0.6) + tone(6)
        start, first = next(pl.windows(blocks(pcm), window_s=5, search_s=2))
        cut_s = len(first) / 2 / SR
        self.assertGreaterEqual(cut_s, 5.2)
        self.assertLessEqual(cut_s, 5.8)

    def test_a_tail_too_short_to_hear_is_dropped(self):
        parts = list(pl.windows(blocks(silence(0.1)), window_s=5, search_s=1))
        self.assertEqual(parts, [])

    def test_wav_wrapper_is_what_vts_accepts(self):
        data = pl.wav_bytes(tone(0.5))
        self.assertEqual(data[:4], b"RIFF")
        self.assertEqual(struct.unpack("<HHI", data[20:28]), (1, 1, SR))


class SpeakerTests(unittest.TestCase):
    def test_two_voices_and_short_segments_follow_the_previous_speaker(self):
        a, b = [1.0, 0.0, 0.1], [0.0, 1.0, 0.1]
        segs = [{"embedding": a}, {"embedding": [0.9, 0.1, 0.1]}, {}, {"embedding": b}, {"embedding": a}]
        n = pl.assign_speakers(segs, threshold=0.6)
        self.assertEqual(n, 2)
        self.assertEqual([s["speaker"] for s in segs], [1, 1, 1, 2, 1])
        self.assertTrue(all("embedding" not in s for s in segs), "voice vectors never reach the output")

    def test_no_vectors_means_no_speaker_labels(self):
        segs = [{"text": "a"}, {"text": "b"}]
        self.assertEqual(pl.assign_speakers(segs), 0)
        self.assertEqual([s["speaker"] for s in segs], [None, None])

    def test_speaker_cap(self):
        segs = [{"embedding": [math.cos(k), math.sin(k), 0]} for k in range(6)]
        self.assertEqual(pl.assign_speakers(segs, threshold=0.99, max_speakers=3), 3)


class FormatTests(unittest.TestCase):
    def test_text_groups_by_speaker_and_srt_numbers_cues(self):
        segs = [{"start": 0, "end": 1.5, "text": "Hello", "speaker": 1},
                {"start": 1.5, "end": 3, "text": "there.", "speaker": 1},
                {"start": 3725.25, "end": 3726, "text": "Hi!", "speaker": 2}]
        text = pl.to_text(segs)
        self.assertEqual(text, "[00:00:00] Speaker 1: Hello there.\n\n[01:02:05] Speaker 2: Hi!\n")
        srt = pl.to_srt(segs)
        self.assertIn("3\n01:02:05,250 --> 01:02:06,000\nSpeaker 2: Hi!", srt)


class FakeVts:
    def __init__(self, fail_times=0):
        self.calls = []
        self.fail_times = fail_times

    def __call__(self, wav, language):
        self.calls.append((len(wav), language))
        if len(self.calls) <= self.fail_times:
            raise RuntimeError("transcription server answered 503")
        with wave.open(__import__("io").BytesIO(wav)) as w:
            seconds = w.getnframes() / SR
        k = len(self.calls)
        return {"language": "nl" if language == "nl" else "en",
                "segments": [{"start": 0.2, "end": seconds - 0.1, "text": f"window {k}",
                              "embedding": [1.0, 0.0] if k % 2 else [0.0, 1.0]}]}


class RunTests(unittest.TestCase):
    def setUp(self):
        self.td = tempfile.TemporaryDirectory()
        self.root = Path(self.td.name)
        (self.root / "input" / "transcribe" / "team").mkdir(parents=True)
        self.audio = tone(4) + silence(0.5) + tone(4)
        self.definition = {"name": "transcribe", "input": "transcribe", "processor": "transcribe",
                           "settings": {"window_seconds": 4, "search_seconds": 1}}

    def tearDown(self):
        self.td.cleanup()

    def drop(self, rel, age=60, data=b"x"):
        path = self.root / "input" / "transcribe" / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        past = time.time() - age
        os.utime(path, (past, past))
        return path

    def processor(self, vts):
        return lambda path, options, settings: pl.process_transcribe(
            path, options, settings, decode=lambda p: blocks(self.audio), transcribe=vts)

    def events(self):
        log = self.root / "output" / "transcribe" / "events.jsonl"
        return [json.loads(l) for l in log.read_text().splitlines()] if log.exists() else []

    def test_a_dropped_file_becomes_text_srt_and_json(self):
        self.drop("team/standup.m4a")
        vts = FakeVts()
        stats = pl.run(self.definition, self.root, processor=self.processor(vts))
        self.assertEqual(stats, {"processed": 1})
        out = self.root / "output" / "transcribe" / "team"
        doc = json.loads((out / "standup.m4a.json").read_text())
        self.assertEqual(doc["source"]["path"], "team/standup.m4a")
        self.assertEqual(doc["speakers"], 2)
        self.assertAlmostEqual(doc["duration"], 8.5, delta=0.01)
        self.assertGreater(doc["segments"][1]["start"], 4.0, "segment times are offset by the window start")
        self.assertIn("Speaker 2: window 2", (out / "standup.m4a.txt").read_text())
        self.assertIn("-->", (out / "standup.m4a.srt").read_text())
        self.assertNotIn("embedding", json.dumps(doc))
        [event] = self.events()
        self.assertEqual((event["kind"], event["input"]), ("done", "team/standup.m4a"))
        self.assertEqual(len(event["outputs"]), 3)

    def test_done_files_are_not_done_again_until_they_change(self):
        path = self.drop("a.wav")
        vts = FakeVts()
        pl.run(self.definition, self.root, processor=self.processor(vts))
        calls = len(vts.calls)
        self.assertEqual(pl.run(self.definition, self.root, processor=self.processor(vts)), {"done_before": 1})
        self.assertEqual(len(vts.calls), calls)
        past = time.time() - 30
        path.write_bytes(b"changed")
        os.utime(path, (past, past))
        self.assertEqual(pl.run(self.definition, self.root, processor=self.processor(vts)), {"processed": 1})

    def test_files_still_being_copied_wait(self):
        self.drop("big.flac", age=1)
        self.assertEqual(pl.run(self.definition, self.root, processor=self.processor(FakeVts())), {"settling": 1})

    def test_sidecar_options_are_data(self):
        self.drop("dutch.ogg")
        (self.root / "input" / "transcribe" / "dutch.ogg.json").write_text('{"language": "nl"}')
        vts = FakeVts()
        pl.run(self.definition, self.root, processor=self.processor(vts))
        self.assertTrue(all(lang == "nl" for _, lang in vts.calls))
        doc = json.loads((self.root / "output/transcribe/dutch.ogg.json").read_text())
        self.assertEqual(doc["language"], "nl")

    def test_failures_retry_then_report_once(self):
        self.drop("bad.mp3")
        boom = lambda path, options, settings: (_ for _ in ()).throw(RuntimeError("cannot decode"))
        for _ in range(pl.MAX_ATTEMPTS):
            pl.run(self.definition, self.root, processor=boom)
        self.assertEqual([e["kind"] for e in self.events()], ["failed"])
        self.assertIn("gave up after 3 attempts", self.events()[0]["message"])
        self.assertEqual(pl.run(self.definition, self.root, processor=boom), {"given_up": 1})

    def test_a_missing_server_is_not_the_files_fault(self):
        self.drop("a.wav")
        self.drop("b.wav")
        def down(path, options, settings):
            raise pl.ServiceUnavailable("transcription server unreachable")
        for _ in range(pl.MAX_ATTEMPTS + 2):
            self.assertEqual(pl.run(self.definition, self.root, processor=down), {"waiting": 1})
        self.assertEqual(self.events(), [])
        self.assertEqual(pl.run(self.definition, self.root, processor=self.processor(FakeVts())), {"processed": 2})

    def test_vts_client_tells_unavailable_from_bad_audio(self):
        import threading
        from http.server import BaseHTTPRequestHandler, HTTPServer

        codes = []

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                self.rfile.read(int(self.headers["Content-Length"]))
                code = codes.pop(0)
                self.send_response(code)
                self.end_headers()
                self.wfile.write(b'{"segments": [], "language": "en"}' if code == 200 else b"{}")

            def log_message(self, *args):
                pass

        server = HTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        url = f"http://127.0.0.1:{server.server_port}/transcribe"
        call = pl.vts_transcribe({"vts_url": url, "retries": 1})
        original = pl.time.sleep
        pl.time.sleep = lambda s: None
        try:
            codes[:] = [503, 200]
            self.assertEqual(call(b"RIFF", "auto")["language"], "en")
            codes[:] = [503, 503]
            with self.assertRaises(pl.ServiceUnavailable):
                call(b"RIFF", "auto")
            codes[:] = [500, 500]
            with self.assertRaises(RuntimeError) as caught:
                call(b"RIFF", "auto")
            self.assertNotIsInstance(caught.exception, pl.ServiceUnavailable)
            codes[:] = [415]
            with self.assertRaises(RuntimeError):
                call(b"RIFF", "auto")
        finally:
            pl.time.sleep = original
            server.shutdown()
        dead = pl.vts_transcribe({"vts_url": "http://127.0.0.1:9/transcribe", "retries": 0})
        with self.assertRaises(pl.ServiceUnavailable):
            dead(b"RIFF", "auto")

    def test_hidden_and_unknown_files_are_ignored(self):
        self.drop(".partial-upload.wav")
        self.drop("notes.txt")
        self.drop(".sync/x.wav")
        self.assertEqual(pl.run(self.definition, self.root, processor=self.processor(FakeVts())), {})

    def test_writes_cannot_escape_the_output_folder(self):
        out = pl.Output(self.root / "output" / "transcribe")
        with self.assertRaises(ValueError):
            out.write("../other/x.txt", "nope")

    def test_two_runs_at_once_do_not_both_work(self):
        import fcntl
        folder = self.root / "output" / "transcribe"
        folder.mkdir(parents=True)
        with open(folder / ".lock", "w") as held:
            fcntl.flock(held, fcntl.LOCK_EX)
            self.assertEqual(pl.run(self.definition, self.root, processor=self.processor(FakeVts())), {"busy": 1})


@unittest.skipUnless(shutil.which("ffmpeg"), "ffmpeg not installed")
class FfmpegTests(unittest.TestCase):
    def test_real_decode_of_a_stereo_44k_file(self):
        with tempfile.TemporaryDirectory() as td:
            src = Path(td) / "in.wav"
            n = 44100 * 3
            with wave.open(str(src), "wb") as w:
                w.setnchannels(2)
                w.setsampwidth(2)
                w.setframerate(44100)
                w.writeframes(struct.pack(f"<{2 * n}h", *([1000, -1000] * n)))
            pcm = b"".join(pl.ffmpeg_pcm(src))
            self.assertAlmostEqual(len(pcm) / 2 / SR, 3.0, delta=0.05)

    def test_undecodable_file_raises(self):
        with tempfile.TemporaryDirectory() as td:
            bad = Path(td) / "bad.mp3"
            bad.write_bytes(b"not audio at all")
            with self.assertRaises(RuntimeError):
                b"".join(pl.ffmpeg_pcm(bad))


if __name__ == "__main__":
    unittest.main()
