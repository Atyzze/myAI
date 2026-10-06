import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class ProjectContractTests(unittest.TestCase):
    def test_multipart_dependency_is_not_declared(self):
        lines = [line.split("#", 1)[0].strip().lower() for line in (ROOT / "requirements.txt").read_text(encoding="utf-8").splitlines()]
        declared = [line for line in lines if line]
        self.assertFalse(any(line.startswith("python-multipart") or line.startswith("multipart==") for line in declared))

    def test_docs_name_the_raw_wav_protocol(self):
        protocol = (ROOT / "docs" / "PROTOCOL.md").read_text(encoding="utf-8")
        self.assertIn("not a multipart form", protocol)
        self.assertIn("16,000 Hz", protocol)


    def test_python_runtime_is_fixed_to_312(self):
        self.assertEqual((ROOT / "PYTHON_VERSION").read_text(encoding="ascii").strip(), "3.12")
        self.assertEqual((ROOT / ".python-version").read_text(encoding="ascii").strip(), "3.12")
        pyproject = (ROOT / "pyproject.toml").read_text(encoding="utf-8")
        self.assertIn('requires-python = "==3.12.*"', pyproject)
        self.assertIn('python-runtime = "3.12"', pyproject)
        self.assertIn('bootstrap = "uv"', pyproject)

    def test_installer_forbids_source_builds(self):
        source = (ROOT / "install.py").read_text(encoding="utf-8")
        self.assertIn('UV_WHEEL_ONLY_ARGS = ("--only-binary", ":all:")', source)
        self.assertNotIn('"--no-build"', source)
        self.assertIn("bootstrap_via_uv", source)
        self.assertIn("venv_matches_pinned_python", source)

    def test_tls_required_default_is_documented(self):
        readme = (ROOT / "README.md").read_text(encoding="utf-8")
        operations = (ROOT / "docs" / "OPERATIONS.md").read_text(encoding="utf-8")
        self.assertIn("TLS is required by default", readme)
        self.assertIn("--allow-plaintext", readme)
        self.assertIn("python3 install.py --bind", operations)
        self.assertNotIn("configure-service", operations)

    def test_simple_bind_cli_is_documented(self):
        operations = (ROOT / "docs" / "OPERATIONS.md").read_text(encoding="utf-8")
        readme = (ROOT / "README.md").read_text(encoding="utf-8")
        self.assertIn("python3 install.py --bind", operations)
        self.assertIn("--allow-plaintext", operations)
        self.assertIn("-bind", readme)


    def test_install_audit_log_is_documented(self):
        readme = (ROOT / "README.md").read_text(encoding="utf-8")
        operations = (ROOT / "docs" / "OPERATIONS.md").read_text(encoding="utf-8")
        privacy = (ROOT / "docs" / "PRIVACY.md").read_text(encoding="utf-8")
        for doc in (readme, operations, privacy):
            self.assertIn("var/log/install.log", doc)
        for doc in (readme, operations):
            self.assertIn("less var/log/install.log", doc)
            self.assertIn("tail -f var/log/install.log", doc)
            # The log is project-local; operators must not be sent to system log paths.
            self.assertNotIn("sudo less /var/log", doc)
            self.assertNotIn("sudo tail -f /var/log", doc)
        self.assertNotIn("/var/log", privacy)
        self.assertIn("ISO-8601", readme)

    def test_shell_installer_is_only_a_shim(self):
        shell = (ROOT / "install.sh").read_text(encoding="utf-8")
        self.assertIn('exec python3', shell)
        self.assertLess(len(shell.splitlines()), 10)


if __name__ == "__main__":
    unittest.main()
