import ast
import os
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
SERVER = ROOT / "server.py"


def _load_function(name, namespace=None):
    """Execute one top-level function from server.py without importing it."""
    source = SERVER.read_text(encoding="utf-8")
    for node in ast.parse(source).body:
        if isinstance(node, ast.FunctionDef) and node.name == name:
            ns = {"os": os, **(namespace or {})}
            exec(ast.get_source_segment(source, node), ns)
            return ns[name]
    raise AssertionError(f"{name} not found in server.py")


class DeviceSelectionTests(unittest.TestCase):
    def setUp(self):
        self.resolve = _load_function("resolve_device")
        self.compute = _load_function("default_compute_type")

    def test_auto_uses_cuda_only_when_a_device_is_visible(self):
        self.assertEqual(self.resolve("auto", 1), "cuda")
        self.assertEqual(self.resolve("auto", 0), "cpu")

    def test_explicit_device_is_kept(self):
        self.assertEqual(self.resolve("cuda", 0), "cuda")
        self.assertEqual(self.resolve("cpu", 2), "cpu")

    def test_unknown_device_is_refused(self):
        with self.assertRaises(RuntimeError):
            self.resolve("rocm", 0)

    def test_compute_type_follows_device(self):
        self.assertEqual(self.compute("cuda"), "float16")
        self.assertEqual(self.compute("cpu"), "int8")

    def test_default_is_auto(self):
        source = SERVER.read_text(encoding="utf-8")
        self.assertIn('os.getenv("DEVICE", "auto")', source)
        self.assertNotIn('os.getenv("DEVICE", "cuda")', source)


class EmbeddingDeviceTests(unittest.TestCase):
    def setUp(self):
        self.pick = _load_function("embedding_device")

    def test_cpu_whisper_means_cpu_embeddings(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertEqual(self.pick("cpu"), "cpu")

    def test_override_wins(self):
        with mock.patch.dict(os.environ, {"EMBED_DEVICE": "cuda:1"}):
            self.assertEqual(self.pick("cpu"), "cuda:1")

    def test_cuda_whisper_with_cpu_only_torch_falls_back(self):
        fake_torch = mock.Mock()
        fake_torch.cuda.is_available.return_value = False
        with mock.patch.dict(os.environ, {}, clear=True), mock.patch.dict("sys.modules", {"torch": fake_torch}):
            self.assertEqual(self.pick("cuda"), "cpu")
        fake_torch.cuda.is_available.return_value = True
        with mock.patch.dict(os.environ, {}, clear=True), mock.patch.dict("sys.modules", {"torch": fake_torch}):
            self.assertEqual(self.pick("cuda"), "cuda")


class PackagedRuntimeTests(unittest.TestCase):
    def test_system_python_skips_both_reexecs(self):
        source = SERVER.read_text(encoding="utf-8")
        self.assertIn("if not SYSTEM_PYTHON and Path(sys.prefix).resolve() != VENV.resolve():", source)
        self.assertIn('if not SYSTEM_PYTHON and os.environ.get("VTS_SERVER_BOOTSTRAPPED") != "1":', source)

    def test_small_models_do_not_need_a_preprocessor_config(self):
        source = SERVER.read_text(encoding="utf-8")
        self.assertIn('REQUIRED = ("model.bin", "config.json", "tokenizer.json")', source)

    def test_health_reports_the_resolved_device(self):
        source = SERVER.read_text(encoding="utf-8")
        for field in ('"device": DEVICE', '"compute_type": COMPUTE_TYPE', '"model": MODEL_DIR.name'):
            self.assertIn(field, source)


if __name__ == "__main__":
    unittest.main()
