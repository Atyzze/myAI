import importlib.util
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class BuildIdentityTests(unittest.TestCase):
    def test_build_number_is_positive_integer(self):
        raw = (ROOT / "BUILD_NUMBER").read_text(encoding="ascii").strip()
        self.assertTrue(raw.isdigit())
        self.assertGreater(int(raw), 0)

    def test_current_build_has_notes(self):
        build = int((ROOT / "BUILD_NUMBER").read_text(encoding="ascii").strip())
        self.assertTrue((ROOT / "docs" / "build_notes" / f"BUILD{build}_NOTES.md").is_file())

    def test_pyproject_mirrors_build_number(self):
        import re
        build = int((ROOT / "BUILD_NUMBER").read_text(encoding="ascii").strip())
        pyproject = (ROOT / "pyproject.toml").read_text(encoding="utf-8")
        match = re.search(r'(?m)^version = "([^"]+)"$', pyproject)
        self.assertIsNotNone(match)
        self.assertEqual(match.group(1), f"0.0.{build}")

    def test_runtime_exposes_build_identity(self):
        source = (ROOT / "server.py").read_text(encoding="utf-8")
        self.assertIn('PROJECT_ID = "VTS"', source)
        self.assertIn('PROJECT_NAME = "Voice Transcribe Server"', source)
        self.assertIn('"build": BUILD_NUMBER', source)

    def test_release_tool_uses_vts_archive_contract(self):
        spec = importlib.util.spec_from_file_location("vts_release", ROOT / "tools" / "package_release.py")
        module = importlib.util.module_from_spec(spec)
        assert spec.loader is not None
        spec.loader.exec_module(module)
        self.assertEqual(module.PROJECT_ID, "VTS")
        self.assertEqual(module.TOP_PREFIX, "vts_build_")
        self.assertEqual(module.DEFAULT_LEVEL, 10)
        for name in ("server.env", "fullchain.pem", "privkey.pem", ".venv", "model", "embed", "var"):
            self.assertIn(name, module.EXCLUDED_NAMES)


if __name__ == "__main__":
    unittest.main()
