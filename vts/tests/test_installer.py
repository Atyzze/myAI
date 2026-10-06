import importlib.util
import io
import os
import re
import stat
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]

spec = importlib.util.spec_from_file_location("voice_install", ROOT / "install.py")
install = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(install)


class InstallerContractTests(unittest.TestCase):
    def test_generated_unit_contains_privacy_hardening(self):
        unit = install.build_unit(
            name="vts",
            run_user="voice",
            run_group="voice",
            host="127.0.0.1",
            port=4444,
        )
        expected = (
            "MemorySwapMax=0",
            "LimitCORE=0",
            "ProtectSystem=strict",
            "NoNewPrivileges=true",
            "TemporaryFileSystem=/tmp:",
            "TemporaryFileSystem=/var/tmp:",
            "StandardOutput=journal",
            "StandardError=journal",
        )
        for token in expected:
            self.assertIn(token, unit)
        self.assertNotIn("ReadWritePaths=", unit)


    def test_installer_reads_fixed_python_runtime(self):
        self.assertEqual(install.PYTHON_VERSION, "3.12")
        self.assertEqual(install.PYTHON_VERSION_INFO, (3, 12))
        self.assertEqual((ROOT / ".python-version").read_text(encoding="ascii").strip(), "3.12")

    def test_installer_bootstraps_through_uv_without_project_sync(self):
        source = (ROOT / "install.py").read_text(encoding="utf-8")
        self.assertIn('"run",', source)
        self.assertIn('"--no-project",', source)
        self.assertIn('"--isolated",', source)
        self.assertIn('"--managed-python",', source)
        self.assertIn('UV_RUN_RECURSION_DEPTH', source)
        self.assertIn('os.execvpe(uv, cmd, env)', source)

    def test_venv_creation_is_owned_by_uv(self):
        source = (ROOT / "install.py").read_text(encoding="utf-8")
        self.assertNotIn('run([sys.executable, "-m", "venv"', source)
        self.assertIn('"venv",', source)
        self.assertIn('say(f"Creating .venv with uv-managed Python', source)

    def test_dependency_install_is_uv_wheel_only(self):
        source = (ROOT / "install.py").read_text(encoding="utf-8")
        self.assertIn('"pip", "install", "--python"', source)
        self.assertEqual(install.UV_WHEEL_ONLY_ARGS, ("--only-binary", ":all:"))
        self.assertNotIn('"--no-build"', source)
        self.assertNotIn('"-m", "pip", "install"', source)

    def test_installer_has_no_runtime_framework_imports(self):
        import ast
        source = (ROOT / "install.py").read_text(encoding="utf-8")
        tree = ast.parse(source)
        imported = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                imported.update(alias.name.split(".")[0] for alias in node.names)
            elif isinstance(node, ast.ImportFrom) and node.module:
                imported.add(node.module.split(".")[0])
        for module in ("fastapi", "uvicorn", "faster_whisper", "torch", "huggingface_hub"):
            self.assertNotIn(module, imported)


class LegacyMigrationAndHealthTests(unittest.TestCase):
    def test_legacy_unit_port_parser(self):
        text = 'Environment="PORT=4444"\nEnvironment="HF_HUB_OFFLINE=1"\n'
        self.assertEqual(install._unit_declared_port(text), 4444)
        self.assertIsNone(install._unit_declared_port('Environment="HOST=127.0.0.1"\n'))

    def test_health_contract_rejects_legacy_server(self):
        legacy = {
            "status": "ready",
            "diarization": True,
            "stores_audio": False,
            "stores_transcripts": False,
            "embedding_backend": "EncoderClassifier",
        }
        self.assertFalse(install.health_contract_matches(legacy))

    def test_health_contract_accepts_exact_current_build(self):
        current = {
            "status": "ready",
            "service": "VTS",
            "build": install.BUILD_NUMBER,
            "retention_supported": False,
            "content_persistence": "none",
            "request_payload_storage": "memory_only",
        }
        self.assertTrue(install.health_contract_matches(current))

    def test_installer_knows_legacy_service_identity(self):
        self.assertIn("voice-transcribe", install.LEGACY_SERVICE_NAMES)
        self.assertIn("voice-transcribe-installer", install.LEGACY_MANAGED_MARKER)


class NetworkBindingTests(unittest.TestCase):
    def _args(self, *argv):
        return install.parser().parse_args(["install", *argv])

    def test_default_bind_is_loopback(self):
        self.assertEqual(install.requested_bind(self._args()), "127.0.0.1")

    def test_bare_bind_means_all_ipv4_interfaces(self):
        self.assertEqual(install.requested_bind(self._args("--bind")), "0.0.0.0")

    def test_bind_accepts_specific_ipv4_or_ipv6_address(self):
        self.assertEqual(install.requested_bind(self._args("--bind", "10.20.30.40")), "10.20.30.40")
        self.assertEqual(install.requested_bind(self._args("--bind", "::1")), "::1")

    def test_wildcard_health_probe_uses_loopback(self):
        self.assertEqual(install.probe_host_for_bind("0.0.0.0"), "127.0.0.1")
        self.assertEqual(install.probe_host_for_bind("::"), "::1")
        self.assertEqual(install.probe_host_for_bind("10.20.30.40"), "10.20.30.40")

    def test_managed_service_requires_tls_by_default(self):
        unit = install.build_unit(
            name="vts", run_user="voice", run_group="voice",
            host="127.0.0.1", port=4444,
        )
        self.assertIn("Environment=VTS_TLS_ENABLED=1", unit)
        self.assertNotIn("Environment=VTS_TLS_ENABLED=0", unit)

    def test_allow_plaintext_is_explicit(self):
        args = self._args("--allow-plaintext")
        self.assertTrue(install.plaintext_requested(args))
        unit = install.build_unit(
            name="vts", run_user="voice", run_group="voice",
            host="0.0.0.0", port=4444, allow_plaintext=True,
        )
        self.assertIn("Environment=VTS_TLS_ENABLED=0", unit)

    def test_legacy_network_aliases_are_not_part_of_cli(self):
        source = (ROOT / "install.py").read_text(encoding="utf-8")
        self.assertNotIn('"--behind-proxy"', source)
        self.assertNotIn('"--host"', source)

    def test_cli_bind_values_override_server_env(self):
        unit = install.build_unit(
            name="vts", run_user="voice", run_group="voice",
            host="10.20.30.40", port=4444,
        )
        self.assertIn("Environment=VTS_BIND_HOST=10.20.30.40", unit)
        self.assertIn("Environment=VTS_BIND_PORT=4444", unit)
        source = (ROOT / "server.py").read_text(encoding="utf-8")
        self.assertIn('os.getenv("VTS_BIND_HOST") or os.getenv("HOST"', source)
        self.assertIn('os.getenv("VTS_BIND_PORT") or os.getenv("PORT"', source)
        self.assertIn('os.getenv("VTS_TLS_ENABLED") or os.getenv("TLS_ENABLED"', source)

    def test_health_contract_can_require_tls_transport(self):
        current = {
            "status": "ready",
            "service": "VTS",
            "build": install.BUILD_NUMBER,
            "retention_supported": False,
            "content_persistence": "none",
            "request_payload_storage": "memory_only",
            "transport_security": "tls",
        }
        self.assertTrue(install.health_contract_matches(current, expected_transport="tls"))
        self.assertFalse(install.health_contract_matches(current, expected_transport="plaintext"))

    def test_bind_can_be_used_directly_on_normal_install(self):
        args = install.parser().parse_args(["install", "--bind", "10.20.30.40"])
        self.assertEqual(args.command, "install")
        self.assertEqual(install.requested_bind(args), "10.20.30.40")

    def test_single_dash_bind_alias_is_supported(self):
        args = install.parser().parse_args(["install", "-bind", "0.0.0.0"])
        self.assertEqual(install.requested_bind(args), "0.0.0.0")

    def test_single_dash_allow_plaintext_alias_is_supported(self):
        args = install.parser().parse_args(["install", "-allow-plaintext"])
        self.assertTrue(install.plaintext_requested(args))

    def test_configure_service_subcommand_is_gone(self):
        self.assertNotIn("configure-service", install.parser().format_help())
        source = (ROOT / "install.py").read_text(encoding="utf-8")
        self.assertNotIn('def do_configure_service', source)
        self.assertNotIn('"--service-only"', source)


AUDIT_LINE_RE = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z session=\S+ source=\S+(?: .*)?")


class InstallAuditLogTests(unittest.TestCase):
    def _args(self, *argv):
        return install.parser().parse_args(["install", *argv])

    def test_install_log_lives_next_to_the_installer(self):
        self.assertEqual(install.INSTALL_LOG_PATH, ROOT / "var" / "log" / "install.log")

    def test_audit_line_starts_with_full_iso_datetime(self):
        stamp = "2026-09-15T15:14:35.123Z"
        line = install.format_install_log_line(
            "event=test", session="abc", source="installer", timestamp=stamp
        )
        self.assertTrue(line.startswith(stamp + " "))
        self.assertNotIn("\n", line)
        self.assertIn("session=abc", line)
        self.assertIn("source=installer", line)
        self.assertTrue(AUDIT_LINE_RE.fullmatch(line))

    def test_audit_log_is_appended_directly_without_sudo(self):
        source = (ROOT / "install.py").read_text(encoding="utf-8")
        self.assertIn("os.O_APPEND", source)
        self.assertNotIn('"tee"', source)
        self.assertNotIn("/var/log", source)

    def test_effective_parameters_capture_network_tls_and_models(self):
        args = self._args("--bind", "0.0.0.0", "--allow-plaintext", "--with-diarization")
        snap = install.install_parameter_snapshot(args)
        self.assertEqual(snap["bind"], "0.0.0.0")
        self.assertEqual(snap["transport"], "plaintext")
        self.assertTrue(snap["diarization"])
        self.assertEqual(snap["install_log"], str(ROOT / "var" / "log" / "install.log"))
        self.assertTrue(snap["whisper_model_repo"])
        self.assertTrue(snap["speaker_model_repo"])

    def test_install_and_update_are_the_audited_lifecycle_commands(self):
        source = (ROOT / "install.py").read_text(encoding="utf-8")
        self.assertIn('logging_active = args.command in {"install", "update"}', source)
        self.assertIn('parsed_arguments=', source)
        self.assertIn('effective_parameters=', source)
        self.assertIn('event=session_end exit_code=', source)

    def test_install_logs_never_ship_or_get_committed(self):
        spec = importlib.util.spec_from_file_location("vts_release_audit", ROOT / "tools" / "package_release.py")
        release = importlib.util.module_from_spec(spec)
        assert spec.loader is not None
        spec.loader.exec_module(release)
        self.assertTrue(release.excluded(release.ROOT / "var" / "log" / "install.log"))
        self.assertIn("var/", (ROOT / ".gitignore").read_text(encoding="utf-8").splitlines())

    def test_long_silent_steps_show_a_progress_line(self):
        source = (ROOT / "install.py").read_text(encoding="utf-8")
        self.assertIn('with _ProgressLine("installing Python dependencies"):', source)
        self.assertIn('with _ProgressLine(f"downloading {destination.name}/", measure=tmp, expected_bytes=expected_bytes):', source)
        self.assertIn('with _ProgressLine(f"waiting for {name}.service to answer /healthz"):', source)


class _FakeTTY(io.StringIO):
    def isatty(self):
        return True


class InstallAuditLogBehaviourTests(unittest.TestCase):
    """Write real sessions to a temporary var/log/install.log."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory(prefix="vts-audit-test-")
        self.addCleanup(tmp.cleanup)
        self.log = Path(tmp.name) / "var" / "log" / "install.log"
        self.console_out = tempfile.TemporaryFile("w+", encoding="utf-8")
        self.console_err = tempfile.TemporaryFile("w+", encoding="utf-8")
        self.addCleanup(self.console_out.close)
        self.addCleanup(self.console_err.close)
        for patcher in (
            mock.patch.object(install, "INSTALL_LOG_PATH", self.log),
            mock.patch.object(install, "_ORIGINAL_STDOUT", self.console_out),
            mock.patch.object(install, "_ORIGINAL_STDERR", self.console_err),
            mock.patch.dict(os.environ),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)
        for key in (install.INSTALL_LOG_SESSION_ENV, install.INSTALL_ORIGINAL_ARGV_ENV, install.UV_BOOTSTRAP_SENTINEL):
            os.environ.pop(key, None)
        self.addCleanup(setattr, sys, "stdout", sys.stdout)
        self.addCleanup(setattr, sys, "stderr", sys.stderr)
        # Runs first: never leave a journal open if an assertion failed mid-session.
        self.addCleanup(install._abandon_install_logging, 1)

    def _session(self, *argv, body=None, exit_code=0):
        os.environ.pop(install.INSTALL_LOG_SESSION_ENV, None)
        install.start_install_logging(install.parser().parse_args(["install", *argv]), list(argv))
        try:
            install.report_install_log_status()
            if body is not None:
                body()
        finally:
            install.stop_install_logging(exit_code)

    def _lines(self):
        return self.log.read_text(encoding="utf-8").splitlines()

    def _console(self):
        self.console_out.seek(0)
        self.console_err.seek(0)
        return self.console_out.read() + self.console_err.read()

    def test_session_is_written_to_the_install_log(self):
        def body():
            print("hello from the installer")
            install.run([sys.executable, "-c", "print('child says hi')"])

        self._session("--bind", "10.20.30.40", body=body)
        lines = self._lines()
        self.assertGreater(len(lines), 5)
        for line in lines:
            self.assertTrue(AUDIT_LINE_RE.fullmatch(line), line)
        self.assertEqual(len({re.search(r" session=(\S+) ", line).group(1) for line in lines}), 1)
        text = "\n".join(lines)
        self.assertIn("event=session_start project=VTS build=", text)
        self.assertIn("argv=python install.py --bind 10.20.30.40", text)
        self.assertIn(f'"install_log": "{self.log}"', text)
        self.assertIn(f"event=audit_ready path={self.log} mode=append_only", text)
        self.assertIn("source=stdout hello from the installer", text)
        self.assertIn("source=stdout child says hi", text)
        self.assertIn("source=command exit=0", text)
        self.assertTrue(lines[-1].endswith("source=installer event=session_end exit_code=0"))
        self.assertIn(f"install audit log: {self.log}", self._console())

    def test_missing_folders_are_created_and_new_log_is_private(self):
        self._session()
        umask = os.umask(0)
        os.umask(umask)
        self.assertTrue(self.log.is_file())
        self.assertEqual(stat.S_IMODE(self.log.stat().st_mode), 0o640 & ~umask)

    def test_existing_log_keeps_its_mode_and_content(self):
        self.log.parent.mkdir(parents=True)
        self.log.write_text("earlier line\n", encoding="utf-8")
        os.chmod(self.log, 0o644)
        self._session()
        self.assertEqual(stat.S_IMODE(self.log.stat().st_mode), 0o644)
        lines = self._lines()
        self.assertEqual(lines[0], "earlier line")
        self.assertTrue(lines[-1].endswith("event=session_end exit_code=0"))

    def test_repeated_sessions_append_and_never_truncate(self):
        self._session()
        first = self._lines()
        self._session(exit_code=1)
        both = self._lines()
        self.assertEqual(both[: len(first)], first)
        self.assertEqual(sum("event=session_start" in line for line in both), 2)
        self.assertTrue(both[-1].endswith("event=session_end exit_code=1"))

    def test_ctrl_c_during_install_is_recorded_as_exit_130(self):
        with mock.patch.object(install, "bootstrap_via_uv"), \
                mock.patch.object(install, "do_install", side_effect=KeyboardInterrupt):
            try:
                code = install.main(["install", "--no-service"])
            except KeyboardInterrupt:
                # unittest would otherwise abort the whole run instead of failing here.
                self.fail("Ctrl-C escaped main() instead of being recorded as exit 130")
        self.assertEqual(code, 130)
        self.assertIs(sys.stdout, self.console_out)
        self.assertIs(sys.stderr, self.console_err)
        lines = self._lines()
        self.assertIn("source=stderr fail interrupted by operator (Ctrl-C)", "\n".join(lines))
        self.assertTrue(lines[-1].endswith("event=session_end exit_code=130"))

    def test_interrupted_child_output_lands_before_session_end(self):
        real_wait = subprocess.Popen.wait
        state = {"raised": False}

        def wait_interrupted_once(proc, timeout=None):
            if timeout is None and not state["raised"]:
                state["raised"] = True
                raise KeyboardInterrupt
            return real_wait(proc, timeout=timeout)

        def body():
            with mock.patch.object(subprocess.Popen, "wait", wait_interrupted_once):
                with self.assertRaises(KeyboardInterrupt):
                    install.run([sys.executable, "-c", "import time; time.sleep(0.2); print('last words from child')"])

        self._session(body=body, exit_code=130)
        lines = self._lines()
        child = next(i for i, line in enumerate(lines) if line.endswith("source=stdout last words from child"))
        drained = next(i for i, line in enumerate(lines) if line.endswith("source=command exit=0 interrupted=true"))
        self.assertLess(child, drained)
        self.assertEqual(len(lines) - 1, next(i for i, line in enumerate(lines) if "event=session_end" in line))

    def test_interrupted_captured_command_still_records_output_and_exit(self):
        # The model download runs with capture=True; it is the step most likely to be interrupted.
        real_communicate = subprocess.Popen.communicate
        state = {"raised": False}

        def communicate_interrupted_once(proc, input=None, timeout=None):
            if not state["raised"]:
                state["raised"] = True
                raise KeyboardInterrupt
            return real_communicate(proc, input=input, timeout=timeout)

        def body():
            with mock.patch.object(subprocess.Popen, "communicate", communicate_interrupted_once):
                with self.assertRaises(KeyboardInterrupt):
                    install.run(
                        [sys.executable, "-c", "import time; time.sleep(0.2); print('captured last words')"],
                        capture=True,
                    )

        self._session(body=body, exit_code=130)
        lines = self._lines()
        output = next(i for i, line in enumerate(lines) if line.endswith("source=command.stdout captured last words"))
        record = next(i for i, line in enumerate(lines) if line.endswith("source=command exit=0 interrupted=true"))
        self.assertLess(output, record)

    def test_captured_command_result_is_unchanged(self):
        def body():
            result = install.run([sys.executable, "-c", "import sys; print('out'); print('err', file=sys.stderr); sys.exit(3)"],
                                 capture=True, check=False)
            self.assertEqual((result.returncode, result.stdout, result.stderr), (3, "out\n", "err\n"))
            with self.assertRaises(subprocess.CalledProcessError) as caught:
                install.run([sys.executable, "-c", "raise SystemExit(4)"], capture=True)
            self.assertEqual(caught.exception.returncode, 4)

        self._session(body=body)
        text = "\n".join(self._lines())
        self.assertIn("source=command.stdout out", text)
        self.assertIn("source=command.stderr err", text)
        self.assertIn("source=command exit=3", text)
        self.assertIn("source=command exit=4", text)

    def test_streams_are_restored_even_when_log_write_fails(self):
        install.start_install_logging(install.parser().parse_args(["install"]), [])
        install._INSTALL_JOURNAL._file.close()
        with self.assertRaises(install.Fail):
            install.stop_install_logging(1)
        self.assertIs(sys.stdout, self.console_out)
        self.assertIs(sys.stderr, self.console_err)
        self.assertIsNone(install._INSTALL_JOURNAL)


    def test_progress_line_redraws_in_place_and_yields_to_other_output(self):
        tty = _FakeTTY()
        with mock.patch.object(install, "_ORIGINAL_STDOUT", tty), \
                mock.patch.object(install._ProgressLine, "TTY_INTERVAL", 0.02), \
                mock.patch.object(install._ProgressLine, "QUIET_SECONDS", 0.0):
            def body():
                with install._ProgressLine("installing test dependencies"):
                    time.sleep(0.2)
                    print(" ok halfway")
                    time.sleep(0.2)

            self._session(body=body)
        out = tty.getvalue()
        self.assertIn("\r\x1b[K    ... installing test dependencies, 0s elapsed", out)
        self.assertIn("\r\x1b[K ok halfway\n", out)  # status erased before real output
        self.assertTrue(out.endswith("\r\x1b[K"))  # and erased when the step ends
        log = self.log.read_text(encoding="utf-8")
        self.assertIn("source=stdout  ok halfway", log)
        self.assertNotIn("installing test dependencies", log)

    def test_progress_text_reports_size_percent_and_speed(self):
        folder = self.log.parent.parent / "model.new"
        folder.mkdir(parents=True)
        (folder / "model.bin").write_bytes(b"\0" * 3_000_000)
        expected = folder.parent / "expected.size"
        expected.write_text("12000000", encoding="ascii")
        line = install._ProgressLine("downloading model/", measure=folder, expected_bytes=expected).status_text()
        self.assertRegex(line, r"^    \.\.\. downloading model/: 3\.0 MB of 12\.0 MB \(25%\), [\d.]+ [KMGT]?B/s, 0s elapsed$")

    def test_progress_without_tty_prints_plain_periodic_lines(self):
        with mock.patch.object(install._ProgressLine, "PLAIN_INTERVAL", 0.05), \
                mock.patch.object(install._ProgressLine, "QUIET_SECONDS", 0.0):
            def body():
                with install._ProgressLine("waiting for vts.service to answer /healthz"):
                    time.sleep(0.3)

            self._session(body=body)
        console = self._console()
        self.assertIn("    ... waiting for vts.service to answer /healthz, 0s elapsed\n", console)
        self.assertNotIn("\x1b[", console)
        self.assertNotIn("waiting for vts.service", self.log.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
