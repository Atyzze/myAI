import ast
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SERVER = ROOT / "server.py"


class PrivacyInvariantTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source = SERVER.read_text(encoding="utf-8")
        cls.tree = ast.parse(cls.source)

    def test_old_persistent_upload_path_is_absent(self):
        for token in (
            "UploadFile",
            "SpooledTemporaryFile",
            "store_backup",
            "RotatingFileHandler",
            "FileHandler(",
            "python-multipart",
        ):
            self.assertNotIn(token, self.source, token)

    def test_request_body_uses_streaming_api(self):
        self.assertIn("request.stream()", self.source)
        self.assertIn("bytearray()", self.source)

    def test_no_explicit_file_open_for_writing(self):
        for node in ast.walk(self.tree):
            if not isinstance(node, ast.Call):
                continue
            name = None
            if isinstance(node.func, ast.Name):
                name = node.func.id
            elif isinstance(node.func, ast.Attribute):
                name = node.func.attr
            if name != "open":
                continue
            mode = None
            if len(node.args) >= 2 and isinstance(node.args[1], ast.Constant):
                mode = node.args[1].value
            for kw in node.keywords:
                if kw.arg == "mode" and isinstance(kw.value, ast.Constant):
                    mode = kw.value.value
            if isinstance(mode, str):
                self.assertFalse(any(flag in mode for flag in "wax+"), f"write-capable open(): {mode}")

    def test_no_store_and_retention_capabilities_are_explicit(self):
        self.assertIn('"retention_supported": False', self.source)
        self.assertIn('"content_persistence": "none"', self.source)
        self.assertIn('"request_payload_storage": "memory_only"', self.source)
        self.assertIn('"Cache-Control"', self.source)
        self.assertIn("no-store", self.source)

    def test_tls_is_default_and_transport_is_reported(self):
        self.assertIn('os.getenv("TLS_ENABLED", "1")', self.source)
        self.assertIn('"transport_security": ACTIVE_TRANSPORT', self.source)
        self.assertIn('HOST = os.getenv("VTS_BIND_HOST") or os.getenv("HOST", "127.0.0.1")', self.source)


if __name__ == "__main__":
    unittest.main()
