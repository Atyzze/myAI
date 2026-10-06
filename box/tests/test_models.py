import json
import os
import stat
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import myai_models as models  # noqa: E402

FAKE_OLLAMA = """#!/bin/sh
state="$(dirname "$0")/pulled"
case "$1" in
  list) echo "NAME ID SIZE MODIFIED"; [ -f "$state" ] && echo "$(cat "$state") abc 1GB now"; exit 0;;
  pull) echo "$2" > "$state"; exit 0;;
esac
exit 2
"""


def fake_snapshot(repo_id, local_dir, allow_patterns):
    folder = Path(local_dir)
    names = ("hyperparams.yaml", "embedding_model.ckpt") if "spkrec" in repo_id else ("config.json", "model.bin", "tokenizer.json")
    for name in names:
        (folder / name).write_text("x")
    (folder / ".cache").mkdir()


class ModelFetchTests(unittest.TestCase):
    def setUp(self):
        self.td = tempfile.TemporaryDirectory()
        self.root = Path(self.td.name)
        self.ollama = self.root / "ollama"
        self.ollama.write_text(FAKE_OLLAMA)
        self.ollama.chmod(self.ollama.stat().st_mode | stat.S_IEXEC)
        self.hub = types.SimpleNamespace(snapshot_download=mock.Mock(side_effect=fake_snapshot))
        self.patch = mock.patch.dict(sys.modules, {"huggingface_hub": self.hub})
        self.patch.start()

    def tearDown(self):
        self.patch.stop()
        self.td.cleanup()

    def run_plan(self, **plan):
        env = self.root / "models.env"
        env.write_text("".join(f"{k}={v}\n" for k, v in plan.items()))
        rc = models.main(["--plan", str(env), "--model-root", str(self.root / "models"),
                          "--state", str(self.root / "state.json"), "--ollama", str(self.ollama)])
        return rc, json.loads((self.root / "state.json").read_text())

    def test_first_boot_fetches_everything_and_second_boot_nothing(self):
        plan = dict(WHISPER_NAME="small", WHISPER_REPO="Systran/faster-whisper-small",
                    EMBED_REPO="speechbrain/spkrec-ecapa-voxceleb", LLM_MODEL="qwen3:4b")
        rc, state = self.run_plan(**plan)
        self.assertEqual(rc, 0)
        self.assertEqual(set(state.values()), {"downloaded"})
        whisper = self.root / "models/whisper/small"
        self.assertTrue((whisper / "model.bin").is_file())
        self.assertFalse((whisper / ".cache").exists())
        self.assertFalse((self.root / "models/whisper/small.partial").exists())

        rc, state = self.run_plan(**plan)
        self.assertEqual(rc, 0)
        self.assertEqual(set(state.values()), {"present"})
        self.assertEqual(self.hub.snapshot_download.call_count, 2)

    def test_no_llm_planned_means_no_pull(self):
        rc, state = self.run_plan(WHISPER_NAME="tiny", WHISPER_REPO="Systran/faster-whisper-tiny", EMBED_REPO="", LLM_MODEL="")
        self.assertEqual(rc, 0)
        self.assertEqual(list(state), ["whisper"])

    def test_a_failed_download_is_reported_and_retried_later(self):
        self.hub.snapshot_download.side_effect = OSError("no network")
        rc, state = self.run_plan(WHISPER_NAME="tiny", WHISPER_REPO="Systran/faster-whisper-tiny", EMBED_REPO="", LLM_MODEL="qwen3:0.6b")
        self.assertEqual(rc, 1)
        self.assertTrue(state["whisper"].startswith("failed: OSError"))
        self.assertEqual(state["AI model qwen3:0.6b"], "downloaded")


if __name__ == "__main__":
    unittest.main()
