import ast
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SERVER = ROOT / "server.py"


def _load_function(name):
    """Execute one top-level function from server.py without importing it
    (importing server.py re-executes into the venv and loads models)."""
    source = SERVER.read_text(encoding="utf-8")
    for node in ast.parse(source).body:
        if isinstance(node, ast.FunctionDef) and node.name == name:
            namespace = {}
            exec(ast.get_source_segment(source, node), namespace)
            return namespace[name]
    raise AssertionError(f"{name} not found in server.py")


class EmbeddingBatchPlanTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.plan = staticmethod(_load_function("plan_embedding_batches"))

    def test_every_segment_is_planned_exactly_once(self):
        spans = [(0, 50), (60, 70), (80, 300), (310, 320), (330, 400)]
        batches = self.plan(spans, 200)
        flat = sorted(i for batch in batches for i in batch)
        self.assertEqual(flat, list(range(len(spans))))

    def test_padded_size_of_each_batch_stays_within_budget(self):
        spans = [(0, n) for n in (10, 90, 35, 60, 20, 80, 45, 5, 70)]
        budget = 150
        for batch in self.plan(spans, budget):
            longest = max(spans[i][1] - spans[i][0] for i in batch)
            if len(batch) > 1:
                self.assertLessEqual(len(batch) * longest, budget)

    def test_clip_longer_than_budget_gets_its_own_batch(self):
        spans = [(0, 10), (0, 500), (0, 12)]
        batches = self.plan(spans, 100)
        self.assertIn([1], batches)

    def test_many_short_segments_share_batches(self):
        spans = [(0, 10)] * 20
        self.assertEqual(len(self.plan(spans, 100)), 2)

    def test_empty_input(self):
        self.assertEqual(self.plan([], 100), [])


class GpuMemoryInvariantTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source = SERVER.read_text(encoding="utf-8")

    def test_embedding_is_batched_by_padded_duration(self):
        self.assertIn('EMBED_BATCH_SEC = max(1.0, float(os.getenv("EMBED_BATCH_SEC", "30")))', self.source)
        self.assertIn("plan_embedding_batches(spans, budget)", self.source)

    def test_embedding_passes_are_serialised(self):
        self.assertIn("_embed_lock = threading.Lock()", self.source)
        self.assertIn("with _embed_lock:", self.source)

    def test_cuda_cache_is_released_after_embedding(self):
        self.assertIn("torch.cuda.empty_cache()", self.source)
        self.assertIn("embedder.release_cached_memory()", self.source)

    def test_server_leaves_allocator_config_to_the_operator(self):
        # Build 20 forced expandable_segments; build 21 removed it again so the
        # memory fix does not depend on driver support for that allocator mode.
        self.assertNotIn("expandable_segments", self.source)

    def test_env_example_documents_batch_budget(self):
        example = (ROOT / "server.env.example").read_text(encoding="utf-8")
        self.assertIn("# EMBED_BATCH_SEC=30", example)


class CudaLibraryLineTests(unittest.TestCase):
    """Build 20 fresh installs resolved torch 2.14 (CUDA 13), whose cuDNN
    overwrote the CUDA 12 cuDNN CTranslate2 needs, and the service crash-looped."""

    def _pins(self):
        pins = {}
        for line in (ROOT / "requirements-diarization.txt").read_text(encoding="utf-8").splitlines():
            line = line.split("#", 1)[0].strip()
            if "==" in line:
                name, version = line.split("==", 1)
                pins[name.strip().lower()] = version.strip()
        return pins

    def test_torch_is_pinned_to_the_cuda12_line(self):
        pins = self._pins()
        self.assertEqual(pins.get("torch"), "2.10.0")

    def test_torchaudio_matches_torch(self):
        pins = self._pins()
        self.assertEqual(pins.get("torchaudio"), pins.get("torch"))

    def test_main_requirements_stay_on_cuda12(self):
        text = (ROOT / "requirements.txt").read_text(encoding="utf-8")
        self.assertIn("nvidia-cublas-cu12", text)
        self.assertIn("nvidia-cudnn-cu12", text)
        self.assertNotIn("cu13", text)

    def _probe(self, packages):
        import subprocess, sys, tempfile
        sys.path.insert(0, str(ROOT))
        try:
            import install
        finally:
            sys.path.pop(0)
        with tempfile.TemporaryDirectory() as tmp:
            for name, version in packages:
                info = Path(tmp) / f"{name.replace('-', '_')}-{version}.dist-info"
                info.mkdir()
                (info / "METADATA").write_text(f"Metadata-Version: 2.1\nName: {name}\nVersion: {version}\n", encoding="utf-8")
            code = f"import sys; sys.path.insert(0, {tmp!r})\n" + install.CUDA_STACK_PROBE
            return subprocess.run([sys.executable, "-I", "-S", "-c", code], text=True, capture_output=True)

    def test_probe_accepts_a_consistent_cuda12_stack(self):
        proc = self._probe([("torch", "2.10.0"), ("torchaudio", "2.10.0"), ("nvidia-cudnn-cu12", "9.10.2.21")])
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)

    def test_probe_rejects_the_build20_stack(self):
        proc = self._probe([
            ("torch", "2.14.0"), ("torchaudio", "2.11.0"),
            ("nvidia-cudnn-cu12", "9.26.0.51"), ("nvidia-cudnn-cu13", "9.24.0.43"), ("cuda-toolkit", "13.0.3.0"),
        ])
        self.assertEqual(proc.returncode, 1)
        self.assertIn("nvidia-cudnn-cu13", proc.stdout)
        self.assertIn("torchaudio 2.11.0 does not match torch 2.14.0", proc.stdout)

    def test_installer_checks_after_install_and_replaces_mixed_venvs(self):
        source = (ROOT / "install.py").read_text(encoding="utf-8")
        self.assertIn("Replacing .venv because it mixes CUDA 12 and CUDA 13 libraries", source)
        self.assertIn("problems = cuda_stack_problems()", source)
        self.assertIn('"one CUDA library line (12)"', source)


if __name__ == "__main__":
    unittest.main()
