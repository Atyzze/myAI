import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import myai_probe as probe  # noqa: E402


def hw(ram, cores, gpus=(), arch="x86_64"):
    return probe.Hardware(arch=arch, cpu_model="test", cores=cores, ram_gib=ram,
                          gpus=[probe.Gpu(**g) for g in gpus])


NV = lambda vram, name="NVIDIA GPU": {"vendor": "nvidia", "name": name, "vram_gib": vram}
AMD = lambda vram: {"vendor": "amd", "name": "Radeon", "vram_gib": vram, "integrated": vram < 2}
INTEL_IGPU = {"vendor": "intel", "name": "Intel UHD", "vram_gib": 0, "integrated": True}


class PlannerTests(unittest.TestCase):
    def test_fridge_still_runs_and_says_why_it_is_limited(self):
        p = probe.plan(hw(1.0, 4, arch="aarch64"))
        self.assertEqual(p["whisper"]["model"], "tiny")
        self.assertEqual(p["whisper"]["device"], "cpu")
        self.assertIsNone(p["llm"])
        self.assertEqual(p["client"]["maxPanels"], 0)
        self.assertEqual(p["tier"], "minimal")
        self.assertTrue(any("RAM" in w for w in p["warnings"]))

    def test_old_laptop_with_integrated_graphics(self):
        p = probe.plan(hw(8, 4, [INTEL_IGPU]))
        self.assertEqual(p["whisper"]["device"], "cpu")
        self.assertIn(p["whisper"]["model"], ("base", "small"))
        self.assertIsNotNone(p["llm"])
        self.assertLessEqual(probe._llm_size(p["llm"]["model"]), probe._llm_size("qwen3:4b"))
        self.assertEqual(p["llm"]["backend"], "cpu")
        self.assertEqual(p["client"]["translateInFlight"], 1)
        self.assertGreaterEqual(p["client"]["transcribeConcurrency"], 1)

    def test_integrated_gpu_uses_vulkan_only_when_enabled(self):
        p = probe.plan(hw(16, 8, [INTEL_IGPU]), {"accelerators": ["vulkan", "igpu"]})
        self.assertEqual(p["llm"]["backend"], "vulkan")
        self.assertEqual(p["llm"]["placement"], "igpu")

    def test_gaming_pc_runs_everything_on_the_gpu(self):
        p = probe.plan(hw(32, 12, [NV(8)]))
        self.assertEqual(p["whisper"], {**p["whisper"], "model": "large-v3-turbo", "device": "cuda", "compute_type": "float16"})
        self.assertEqual(p["llm"]["backend"], "cuda")
        self.assertEqual(p["llm"]["cpu_offload"], 0)
        self.assertEqual(p["client"]["maxPanels"], 4)
        self.assertEqual(p["client"]["transcribeConcurrency"], 10)
        self.assertEqual(p["warnings"], [])

    def test_big_card_gets_the_big_model(self):
        p = probe.plan(hw(64, 16, [NV(24, "RTX 4090")]))
        self.assertEqual(p["llm"]["model"], "qwen3.8:27b")
        self.assertEqual(p["tier"], "workstation")

    def test_small_card_warns_about_vram_but_still_loadbalances(self):
        p = probe.plan(hw(16, 8, [NV(4)]))
        self.assertEqual(p["whisper"]["device"], "cuda")
        self.assertIsNotNone(p["llm"])
        self.assertGreater(p["llm"]["cpu_offload"], 0)
        self.assertTrue(any("Insufficient VRAM" in w and "still run" in w for w in p["warnings"]))
        self.assertLess(p["client"]["maxPanels"], 4)

    def test_tiny_nvidia_card_is_ignored_for_whisper(self):
        p = probe.plan(hw(8, 4, [NV(2)]))
        self.assertEqual(p["whisper"]["device"], "cpu")
        self.assertEqual(p["llm"]["backend"], "cpu")

    def test_amd_card_uses_vulkan_and_whisper_stays_on_cpu(self):
        p = probe.plan(hw(32, 8, [AMD(16)]))
        self.assertEqual(p["llm"]["backend"], "vulkan")
        self.assertEqual(p["whisper"]["device"], "cpu")
        self.assertTrue(any("Vulkan" in n for n in p["notes"]))

    def test_amd_card_uses_rocm_when_the_image_has_it(self):
        p = probe.plan(hw(32, 8, [AMD(16)]), {"accelerators": ["rocm", "vulkan"]})
        self.assertEqual(p["llm"]["backend"], "rocm")

    def test_nvidia_without_cuda_in_image_says_so(self):
        p = probe.plan(hw(16, 8, [NV(8)]), {"accelerators": ["vulkan"]})
        self.assertEqual(p["whisper"]["device"], "cpu")
        self.assertEqual(p["llm"]["backend"], "vulkan")
        self.assertTrue(any("CUDA is not available" in w for w in p["warnings"]))

    def test_overrides_win(self):
        p = probe.plan(hw(32, 12, [NV(8)]), {"whisper_model": "small", "llm_model": "qwen3:14b", "diarization": False})
        self.assertEqual(p["whisper"]["model"], "small")
        self.assertEqual(p["llm"]["model"], "qwen3:14b")
        self.assertGreater(p["llm"]["cpu_offload"], 0)
        self.assertFalse(p["diarization"])

    def test_more_hardware_never_plans_less(self):
        rungs = [m for m, _ in probe.LLM_LADDER]
        previous = -1
        for ram in (2, 4, 6, 8, 12, 16, 24, 32, 64):
            p = probe.plan(hw(ram, 8))
            rung = rungs.index(p["llm"]["model"]) if p["llm"] else -1
            self.assertGreaterEqual(rung, previous, f"{ram} GiB planned a smaller model")
            previous = rung

    def test_reply_context_stays_at_32k_unless_memory_and_model_allow_more(self):
        self.assertEqual(probe.plan(hw(16, 8))["client"]["maxContext"], 32768, "CPU boxes keep 32k")
        self.assertEqual(probe.plan(hw(64, 16, [NV(24)]))["client"]["maxContext"], 32768,
                         "a card filled by the model has no room for a bigger context")
        # qwen3:4b supports 256k; 20 GiB free over 2 parallel requests holds 65k each, not 131k.
        self.assertEqual(probe._max_context("qwen3:4b", 20, 2), 65536)
        self.assertEqual(probe._max_context("qwen3:8b", 100, 1), 40960, "never above what the model supports")
        self.assertEqual(probe._max_context("qwen3:8b", 1, 4), 32768, "never below what the app already asks")
        self.assertEqual(probe._max_context(None, 100, 1), 32768)

    def test_max_context_override_wins(self):
        p = probe.plan(hw(16, 8), {"max_context": 131072})
        self.assertEqual(p["client"]["maxContext"], 131072)
        self.assertEqual(probe.capabilities(p)["maxContext"], 131072)


class OutputTests(unittest.TestCase):
    def test_outputs_are_complete_and_consistent(self):
        p = probe.plan(hw(16, 8, [NV(8)]))
        with tempfile.TemporaryDirectory() as td:
            probe.write_outputs(p, Path(td), "/var/lib/myai/models")
            names = sorted(f.name for f in Path(td).iterdir())
            self.assertEqual(names, ["capabilities.json", "models.env", "ollama.env", "profile.json", "vts.env"])
            caps = json.loads((Path(td) / "capabilities.json").read_text())
            self.assertEqual(caps["maxPanels"], p["client"]["maxPanels"])
            self.assertNotIn("hardware", caps)
            vts = (Path(td) / "vts.env").read_text()
            self.assertIn("DEVICE=cuda\n", vts)
            self.assertIn("MODEL_DIR=/var/lib/myai/models/whisper/large-v3-turbo\n", vts)
            models = (Path(td) / "models.env").read_text()
            self.assertIn(f"LLM_MODEL={p['llm']['model']}\n", models)

    def test_report_is_readable(self):
        text = probe.report(probe.plan(hw(1, 2)))
        self.assertIn("WARNING", text)
        self.assertIn("AI model none", text)

    def test_sysfs_detection(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            (root / "proc").mkdir()
            (root / "proc/meminfo").write_text("MemTotal:       16303100 kB\n")
            (root / "proc/cpuinfo").write_text("model name\t: Test CPU 9000\n")
            for card, vendor, vram in (("card0", "0x8086", None), ("card1", "0x1002", 17163091968)):
                dev = root / f"sys/class/drm/{card}/device"
                dev.mkdir(parents=True)
                (dev / "vendor").write_text(vendor + "\n")
                if vram:
                    (dev / "mem_info_vram_total").write_text(str(vram))
            (root / "sys/class/drm/card0-HDMI-A-1").mkdir()
            found = probe.detect(root)
            self.assertAlmostEqual(found.ram_gib, 15.5, delta=0.1)
            self.assertEqual(found.cpu_model, "Test CPU 9000")
            kinds = sorted((g.vendor, g.integrated, g.vram_gib) for g in found.gpus)
            self.assertEqual(kinds, [("amd", False, 16.0), ("intel", True, 0.0)])


class CliTests(unittest.TestCase):
    def test_overrides_stack_and_missing_files_are_skipped(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            (root / "hw.json").write_text(json.dumps({"ram_gib": 32, "cores": 12, "gpus": [NV(8)]}))
            (root / "a.json").write_text(json.dumps({"whisper_model": "small", "llm_model": "qwen3:4b"}))
            (root / "b.json").write_text(json.dumps({"llm_model": "qwen3:1.7b"}))
            (root / "bad.json").write_text("{not json")
            out = root / "run"
            rc = probe.main(["--hardware", str(root / "hw.json"), "--write", str(out),
                             "--overrides", str(root / "a.json"), "--overrides", str(root / "missing.json"),
                             "--overrides", str(root / "bad.json"), "--overrides", str(root / "b.json")])
            self.assertEqual(rc, 0)
            plan = json.loads((out / "profile.json").read_text())
            self.assertEqual(plan["whisper"]["model"], "small")
            self.assertEqual(plan["llm"]["model"], "qwen3:1.7b")
            self.assertIn("myAI box:", (out / "report.txt").read_text())


if __name__ == "__main__":
    unittest.main()
