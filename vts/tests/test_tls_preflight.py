import argparse
import contextlib
import datetime as dt
import importlib.util
import io
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]

spec = importlib.util.spec_from_file_location("voice_install_tls", ROOT / "install.py")
install = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(install)

# Throwaway self-signed EC test fixtures (CN=vts-test-a / vts-test-b, 100-year
# validity). They exist only for these tests and secure nothing.
CERT_A = """\
-----BEGIN CERTIFICATE-----
MIIBgDCCASegAwIBAgIUXbIvDgLBnyiMFaU7oSktIkCnQUUwCgYIKoZIzj0EAwIw
FTETMBEGA1UEAwwKdnRzLXRlc3QtYTAgFw0yNjA5MjQxMTQ3NTVaGA8yMTI2MDgz
MTExNDc1NVowFTETMBEGA1UEAwwKdnRzLXRlc3QtYTBZMBMGByqGSM49AgEGCCqG
SM49AwEHA0IABKbdWbqMjA0qS777zqGzEXNTxEjUNTuno2nzLm4uTu6K15Kr2HgI
Vk2C6vjO8uYcaXH0W3RZ5UyqSPjQLfgxTcujUzBRMB0GA1UdDgQWBBQaUzLrKHk8
UNDKwCZ10ZQlkwJqtTAfBgNVHSMEGDAWgBQaUzLrKHk8UNDKwCZ10ZQlkwJqtTAP
BgNVHRMBAf8EBTADAQH/MAoGCCqGSM49BAMCA0cAMEQCIGcGnhaU+JEYimnQXIX6
tD+5ie34Dj9t2ApWU96WeMWyAiBcD/ik4no4kAyFBliGUL/q/1PcHIo5td08lMK+
OpSZPw==
-----END CERTIFICATE-----
"""
KEY_A = """\
-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgpQi+V+BQtVvYcoZJ
JZS70aNnuqWss6Ypb9ZDsYk1bZuhRANCAASm3Vm6jIwNKku++86hsxFzU8RI1DU7
p6Np8y5uLk7uiteSq9h4CFZNgur4zvLmHGlx9Ft0WeVMqkj40C34MU3L
-----END PRIVATE KEY-----
"""
CERT_B = """\
-----BEGIN CERTIFICATE-----
MIIBgTCCASegAwIBAgIUd/lxG1S9axrl115xoDX9lOViQcIwCgYIKoZIzj0EAwIw
FTETMBEGA1UEAwwKdnRzLXRlc3QtYjAgFw0yNjA5MjQxMTQ3NTVaGA8yMTI2MDgz
MTExNDc1NVowFTETMBEGA1UEAwwKdnRzLXRlc3QtYjBZMBMGByqGSM49AgEGCCqG
SM49AwEHA0IABK/M+Kn1/TYbC1Wn1RrYd6LR1HIhgy2GmTPXTHKaYMjv0qvAeRw0
fVWKS9STgocUWwwG4vlYRLwd+0CaJyBhQJWjUzBRMB0GA1UdDgQWBBTFE3I85TpP
H3AfDHmIyh0GgYFXyTAfBgNVHSMEGDAWgBTFE3I85TpPH3AfDHmIyh0GgYFXyTAP
BgNVHRMBAf8EBTADAQH/MAoGCCqGSM49BAMCA0gAMEUCIEdPuPB1vJaBzTOC4UW/
humAo4HqSuNkG3B8yI5Ci6qaAiEAnaJJrv643UoL4WPI9626H02+9X1Kd9zhJTJW
9DJdKUw=
-----END CERTIFICATE-----
"""
KEY_B = """\
-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgFT/+ThFIii/byb0r
yTViJ/q63nvjD5NQ7+NFWUGROnyhRANCAASvzPip9f02GwtVp9Ua2Hei0dRyIYMt
hpkz10xymmDI79KrwHkcNH1VikvUk4KHFFsMBuL5WES8HftAmicgYUCV
-----END PRIVATE KEY-----
"""
KEY_A_ENC = """\
-----BEGIN ENCRYPTED PRIVATE KEY-----
MIHsMFcGCSqGSIb3DQEFDTBKMCkGCSqGSIb3DQEFDDAcBAj+ZK7ofAqWdwICCAAw
DAYIKoZIhvcNAgkFADAdBglghkgBZQMEASoEEMwJrToPVfr+nmqc7xEYscQEgZCw
ITSHCiLaGo2P/rS430/7UD4d02dzP8q6ClesVPHkmeUFpBuQTwnYejCO4HrHcz54
5OTJylJOjHC2DJrWXIqyR8/TA5m3MgvRcIBUXDu7cUXGGXSHt9MDHGxJhV3yzdI7
MeQBoac3/Qz/2hm44k46FQtb7HsH5hqjRVmWYyWS9W5bJm4jP0LxD7rXkj1xLos=
-----END ENCRYPTED PRIVATE KEY-----
"""


class _Folder:
    """A temporary VTS layout: <tmp>/<n>/vts_build_<b>/ with install.ROOT patched."""

    def __init__(self, test, build=22, parent="9"):
        self._tmp = tempfile.TemporaryDirectory()
        test.addCleanup(self._tmp.cleanup)
        self.base = Path(self._tmp.name).resolve()
        self.root = self.base / parent / f"vts_build_{build}"
        self.root.mkdir(parents=True)
        for name, value in (("ROOT", self.root), ("ENV_FILE", self.root / "server.env")):
            patcher = mock.patch.object(install, name, value)
            patcher.start()
            test.addCleanup(patcher.stop)

    def write(self, name, text, folder=None):
        path = (folder or self.root) / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        return path


def _run_quietly(func, *args):
    err = io.StringIO()
    with contextlib.redirect_stderr(err), contextlib.redirect_stdout(io.StringIO()):
        try:
            func(*args)
        except install.Fail as exc:
            return str(exc), err.getvalue()
    return None, err.getvalue()


class TlsMaterialTests(unittest.TestCase):
    def setUp(self):
        self.folder = _Folder(self)

    def test_matching_pair_beside_server_py_passes(self):
        self.folder.write("fullchain.pem", CERT_A)
        self.folder.write("privkey.pem", KEY_A)
        self.assertEqual(install.tls_material_problems(*install.tls_paths()), [])
        failure, _ = _run_quietly(install.require_tls_material)
        self.assertIsNone(failure)

    def test_missing_files_are_reported_by_path(self):
        problems = install.tls_material_problems(*install.tls_paths())
        self.assertEqual(len(problems), 1)
        self.assertIn(str(self.folder.root / "fullchain.pem"), problems[0])
        self.assertIn(str(self.folder.root / "privkey.pem"), problems[0])

    def test_mismatched_key_is_rejected(self):
        self.folder.write("fullchain.pem", CERT_A)
        self.folder.write("privkey.pem", KEY_B)
        problems = install.tls_material_problems(*install.tls_paths())
        self.assertEqual(len(problems), 1)
        self.assertIn("does not belong to the certificate", problems[0])

    def test_passphrase_key_is_rejected_without_prompting(self):
        self.folder.write("fullchain.pem", CERT_A)
        self.folder.write("privkey.pem", KEY_A_ENC)
        problems = install.tls_material_problems(*install.tls_paths())
        self.assertEqual(len(problems), 1)
        self.assertIn("passphrase-protected", problems[0])

    def test_garbage_is_rejected(self):
        self.folder.write("fullchain.pem", "not a certificate\n")
        self.folder.write("privkey.pem", "not a key\n")
        self.assertTrue(install.tls_material_problems(*install.tls_paths()))

    def test_errors_never_include_key_material(self):
        self.folder.write("fullchain.pem", CERT_A)
        self.folder.write("privkey.pem", KEY_B)
        failure, err = _run_quietly(install.require_tls_material)
        key_body = KEY_B.splitlines()[1]
        self.assertNotIn(key_body, failure)
        self.assertNotIn(key_body, err)

    def test_server_env_paths_are_honoured_and_relative_to_root(self):
        self.folder.write("certs/a.crt", CERT_A)
        self.folder.write("certs/a.key", KEY_A)
        self.folder.write("server.env", "# comment\nTLS_CERT=certs/a.crt\nTLS_KEY=\"certs/a.key\"\n")
        cert, key = install.tls_paths()
        self.assertEqual(cert, self.folder.root / "certs/a.crt")
        self.assertEqual(key, self.folder.root / "certs/a.key")
        self.assertEqual(install.tls_material_problems(cert, key), [])

    def test_expiry_note(self):
        now = dt.datetime(2026, 9, 24, tzinfo=dt.timezone.utc)
        self.assertIsNone(install.tls_expiry_note("Dec 31 00:00:00 2026 GMT", now))
        self.assertIn("expires in 6 day", install.tls_expiry_note("Sep 30 12:00:00 2026 GMT", now))
        self.assertIn("EXPIRED", install.tls_expiry_note("Sep 01 00:00:00 2026 GMT", now))
        self.assertIsNone(install.tls_expiry_note("not a date", now))


class OtherBuildHintTests(unittest.TestCase):
    def setUp(self):
        self.folder = _Folder(self, build=22, parent="9")

    def _old_build(self, parent, build):
        old = self.folder.base / parent / f"vts_build_{build}"
        self.folder.write("fullchain.pem", CERT_A, old)
        self.folder.write("privkey.pem", KEY_A, old)
        return old

    def test_suggests_newest_previous_build_and_does_not_copy(self):
        self._old_build("7", 18)
        newest = self._old_build("8", 21)
        failure, _ = _run_quietly(install.require_tls_material)
        self.assertIsNotNone(failure)
        self.assertIn(f"cp -p {newest}/fullchain.pem {newest}/privkey.pem {self.folder.root}/", failure)
        self.assertFalse((self.folder.root / "fullchain.pem").exists())
        self.assertFalse((self.folder.root / "privkey.pem").exists())

    def test_sibling_build_folder_is_found(self):
        sibling = self._old_build("9", 20)
        self.assertEqual(install.find_other_build_tls(), sibling)

    def test_no_hint_without_other_builds(self):
        failure, _ = _run_quietly(install.require_tls_material)
        self.assertIsNotNone(failure)
        self.assertNotIn("cp -p", failure)
        self.assertIn(f"Put fullchain.pem and privkey.pem in {self.folder.root}", failure)


class InstallOrderTests(unittest.TestCase):
    def _args(self, **overrides):
        values = dict(
            user=None, allow_plaintext=False, force=False, yes=True, no_service=False,
            with_diarization=True, refresh_models=False, name="vts", bind=None, port=4444, timeout=5,
        )
        values.update(overrides)
        return argparse.Namespace(**values)

    def _run(self, args):
        _Folder(self)
        calls = []
        with mock.patch.object(install, "require_host"), \
                mock.patch("os.geteuid", return_value=1000), \
                mock.patch.object(install, "install_dependencies", side_effect=lambda **kw: calls.append("deps")), \
                mock.patch.object(install, "ensure_models", side_effect=lambda **kw: calls.append("models")), \
                mock.patch.object(install, "install_unit", side_effect=lambda **kw: calls.append("unit")):
            failure, _ = _run_quietly(install.do_install, args)
        return failure, calls

    def test_missing_tls_stops_before_dependencies_models_and_unit(self):
        failure, calls = self._run(self._args())
        self.assertIn("TLS is required", failure or "")
        self.assertEqual(calls, [])

    def test_no_service_install_does_not_need_tls(self):
        with mock.patch.object(install.os, "chmod"), \
                mock.patch.object(install, "ensure_env_file"), \
                mock.patch.object(install, "audit_server_env_snapshot"):
            failure, calls = self._run(self._args(no_service=True))
        self.assertIsNone(failure)
        self.assertEqual(calls, ["deps", "models"])

    def test_plaintext_install_does_not_need_tls(self):
        class Reached(Exception):
            pass

        # Stop right after the heavy steps: getting there proves TLS was not required.
        with mock.patch.object(install.os, "chmod", side_effect=Reached):
            with self.assertRaises(Reached):
                self._run(self._args(allow_plaintext=True))

    def test_restart_checks_tls_before_systemctl(self):
        _Folder(self)
        with mock.patch.object(install, "require_host"), \
                mock.patch.object(install, "service_environment_value", return_value="1"), \
                mock.patch.object(install, "run") as run:
            failure, _ = _run_quietly(install.do_restart, argparse.Namespace(name="vts"))
        self.assertIn("TLS is required", failure or "")
        run.assert_not_called()

    def test_verify_reports_tls_material(self):
        source = (ROOT / "install.py").read_text(encoding="utf-8")
        self.assertIn('add(("TLS certificate and key", not tls_problems', source)


if __name__ == "__main__":
    unittest.main()
