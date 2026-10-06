#!/usr/bin/env python3
"""Install and operate VTS (Voice Transcribe Server).

This file is intentionally Python-standard-library only. For runtime-sensitive
commands it bootstraps itself through uv-managed CPython 3.12, then acts as the
host lifecycle manager: create the venv, install dependencies, download model assets, generate
the hardened systemd unit, start/verify the service, and expose a few operational
commands.

Run as your normal login user. Privileged systemd operations are performed through
sudo; the model and virtualenv stay owned by the login user.
"""
from __future__ import annotations

import argparse
import datetime as _dt
import getpass
import hashlib
import json
import ipaddress
import os
import platform
import re
import shutil
import socket
import ssl
import shlex
import subprocess
import sys
import tempfile
import textwrap
import threading
import time
import uuid
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
BUILD_FILE = ROOT / "BUILD_NUMBER"
PYTHON_VERSION_FILE = ROOT / "PYTHON_VERSION"


def read_build_number() -> int:
    try:
        value = int(BUILD_FILE.read_text(encoding="ascii").strip())
    except Exception as exc:
        raise RuntimeError(f"Invalid or missing {BUILD_FILE.name}: {exc}") from exc
    if value < 1:
        raise RuntimeError(f"{BUILD_FILE.name} must be a positive integer")
    return value


def read_python_version() -> tuple[str, tuple[int, int]]:
    try:
        value = PYTHON_VERSION_FILE.read_text(encoding="ascii").strip()
    except Exception as exc:
        raise RuntimeError(f"Invalid or missing {PYTHON_VERSION_FILE.name}: {exc}") from exc
    match = re.fullmatch(r"(\d+)\.(\d+)", value)
    if not match:
        raise RuntimeError(f"{PYTHON_VERSION_FILE.name} must contain major.minor, e.g. 3.12")
    return value, (int(match.group(1)), int(match.group(2)))


BUILD_NUMBER = read_build_number()
PYTHON_VERSION, PYTHON_VERSION_INFO = read_python_version()
PROJECT_ID = "VTS"
PROJECT_NAME = "Voice Transcribe Server"
VENV = ROOT / ".venv"
VENV_PYTHON = VENV / "bin" / "python"
REQ = ROOT / "requirements.txt"
REQ_DIARIZE = ROOT / "requirements-diarization.txt"
ENV_FILE = ROOT / "server.env"
ENV_SAMPLE = ROOT / "server.env.example"
MODEL_DIR = ROOT / "model"
EMBED_DIR = ROOT / "embed"

DEFAULT_SERVICE = os.getenv("SERVICE_NAME", "vts")
DEFAULT_PORT = int(os.getenv("PORT", "4444"))
DEFAULT_HOST = "127.0.0.1"
DEFAULT_MODEL_REPO = os.getenv("WHISPER_MODEL_REPO", "dropbox-dash/faster-whisper-large-v3-turbo")
DEFAULT_MODEL_REVISION = os.getenv("WHISPER_MODEL_REVISION", "main")
DEFAULT_EMBED_REPO = os.getenv("EMBED_MODEL_REPO", "speechbrain/spkrec-ecapa-voxceleb")
DEFAULT_EMBED_REVISION = os.getenv("EMBED_MODEL_REVISION", "main")
REQUIRED_MODEL_FILES = ("config.json", "model.bin", "preprocessor_config.json", "tokenizer.json")
MANAGED_MARKER = "# X-Managed-By: VTS-install.py"
LEGACY_MANAGED_MARKER = "# X-Managed-By: voice-transcribe-installer"
LEGACY_SERVICE_NAMES = ("voice-transcribe",)
UV_BOOTSTRAP_SENTINEL = "VTS_UV_BOOTSTRAPPED"
UV_RECURSION_ENV = "UV_RUN_RECURSION_DEPTH"
# The install audit log lives inside the VTS directory, next to install.py. The
# installing user writes it directly; no sudo and no system log directory is used.
INSTALL_LOG_PATH = ROOT / "var" / "log" / "install.log"
INSTALL_LOG_FILE_MODE = 0o640
INSTALL_LOG_SESSION_ENV = "VTS_INSTALL_LOG_SESSION"
INSTALL_ORIGINAL_ARGV_ENV = "VTS_INSTALL_ORIGINAL_ARGV"
# uv defines --only-binary :all: as "wheels only; do not build source distributions".
# Do not combine it with --no-build: current uv treats those switches as mutually
# exclusive because they express the same policy through different selectors.
UV_WHEEL_ONLY_ARGS = ("--only-binary", ":all:")


def normalize_bind_address(value: str) -> str:
    """Validate and canonicalize a literal IPv4/IPv6 bind address."""
    try:
        return str(ipaddress.ip_address(value.strip()))
    except ValueError as exc:
        raise Fail(f"Invalid bind address {value!r}; use a literal IPv4/IPv6 address") from exc


def is_loopback_bind(host: str) -> bool:
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return host == "localhost"


def probe_host_for_bind(host: str) -> str:
    """Return an address from which this host can probe the configured listener."""
    if host == "0.0.0.0":
        return "127.0.0.1"
    if host == "::":
        return "::1"
    return host


def url_host(host: str) -> str:
    return f"[{host}]" if ":" in host and not host.startswith("[") else host


def requested_bind(args: argparse.Namespace) -> str:
    bind = getattr(args, "bind", None)
    if bind is not None:
        return normalize_bind_address(bind)
    return DEFAULT_HOST


def plaintext_requested(args: argparse.Namespace) -> bool:
    """Return whether the operator explicitly opted out of VTS TLS."""
    return bool(getattr(args, "allow_plaintext", False))


class Fail(RuntimeError):
    pass


_INSTALL_JOURNAL = None
_ACTIVE_PROGRESS = None
_ORIGINAL_STDOUT = sys.stdout
_ORIGINAL_STDERR = sys.stderr


def iso_timestamp() -> str:
    """Return an RFC3339/ISO-8601 UTC timestamp suitable for audit logs."""
    return _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def format_install_log_line(message: str, *, session: str, source: str = "installer", timestamp: str | None = None) -> str:
    """Format exactly one physical audit-log line; timestamp is always first."""
    clean = str(message).replace("\x00", "\\0").replace("\r", "\\r").replace("\n", "\\n")
    return f"{timestamp or iso_timestamp()} session={session} source={source} {clean}"


class InstallJournal:
    """Append-only install audit log inside the VTS directory.

    The installing user opens the file with O_APPEND, so every write lands at the
    end and earlier installation history is never truncated or rewritten. No sudo
    is involved. The hardened VTS service cannot write it: its unit keeps the
    project tree read-only.
    """

    def __init__(self, path: Path, session: str):
        self.path = path
        self.session = session
        self._lock = threading.Lock()
        path.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, INSTALL_LOG_FILE_MODE)
        self._file = os.fdopen(fd, "a", encoding="utf-8", errors="backslashreplace")

    def write(self, message: str, *, source: str = "installer") -> None:
        # Split user/tool output into physical lines so every line gets its own
        # timestamp. Carriage-return progress updates become independent entries.
        normalized = str(message).replace("\r\n", "\n").replace("\r", "\n")
        lines = normalized.split("\n")
        if lines and lines[-1] == "":
            lines.pop()
        if not lines:
            return
        with self._lock:
            try:
                for line in lines:
                    self._file.write(format_install_log_line(line, session=self.session, source=source) + "\n")
                self._file.flush()
            except (OSError, ValueError) as exc:
                raise Fail(f"Cannot write install audit log {self.path}: {exc}") from exc

    def close(self) -> None:
        with self._lock:
            try:
                self._file.close()
            except OSError:
                pass


def _human_bytes(count: float) -> str:
    units = ("B", "KB", "MB", "GB", "TB")
    index = 0
    while count >= 1000 and index < len(units) - 1:
        count /= 1000
        index += 1
    return f"{count:.0f} {units[index]}" if index == 0 else f"{count:.1f} {units[index]}"


def _human_duration(seconds: float) -> str:
    seconds = int(seconds)
    return f"{seconds // 60}m {seconds % 60:02d}s" if seconds >= 60 else f"{seconds}s"


def _tree_bytes(path: Path) -> int:
    total = 0
    for root, _dirs, files in os.walk(path):
        for name in files:
            try:
                total += os.lstat(os.path.join(root, name)).st_size
            except OSError:
                pass
    return total


class _ProgressLine:
    """Show that a long, otherwise silent step is alive: size, speed, elapsed time.

    Terminal only; never written to the install audit log. On a TTY one status
    line is redrawn in place and erased before any other output (see
    _TimestampingStream.write). Without a TTY a plain line is printed every
    PLAIN_INTERVAL seconds instead.
    """

    TTY_INTERVAL = 1.0
    PLAIN_INTERVAL = 30.0
    QUIET_SECONDS = 2.0  # do not draw while other output is still flowing

    def __init__(self, label: str, *, measure: Path | None = None, expected_bytes: Path | None = None):
        self.label = label
        self.measure = measure
        self.expected_bytes = expected_bytes
        self.lock = threading.Lock()
        self.last_output = time.monotonic()
        self._stream = _ORIGINAL_STDOUT
        try:
            self._tty = bool(self._stream.isatty())
        except Exception:
            self._tty = False
        self._visible = False
        self._started = time.monotonic()
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._loop, name="vts-progress", daemon=True)

    def __enter__(self) -> "_ProgressLine":
        global _ACTIVE_PROGRESS
        _ACTIVE_PROGRESS = self
        self._thread.start()
        return self

    def __exit__(self, *exc_info) -> None:
        global _ACTIVE_PROGRESS
        self._stop.set()
        self._thread.join()
        with self.lock:
            _ACTIVE_PROGRESS = None
            self.clear_locked()

    def clear_locked(self) -> None:
        if self._visible:
            self._visible = False
            self._stream.write("\r\x1b[K")
            self._stream.flush()

    def status_text(self) -> str:
        elapsed = time.monotonic() - self._started
        text = f"    ... {self.label}"
        if self.measure is not None:
            done = _tree_bytes(self.measure)
            if done:
                text += f": {_human_bytes(done)}"
                total = self._expected_total()
                if total:
                    text += f" of {_human_bytes(total)} ({min(100, done * 100 // total)}%)"
                text += f", {_human_bytes(done / max(elapsed, 0.001))}/s"
        return f"{text}, {_human_duration(elapsed)} elapsed"

    def _expected_total(self) -> int:
        if self.expected_bytes is None:
            return 0
        try:
            return int(self.expected_bytes.read_text(encoding="ascii").strip())
        except (OSError, ValueError):
            return 0

    def _loop(self) -> None:
        interval = self.TTY_INTERVAL if self._tty else self.PLAIN_INTERVAL
        while not self._stop.wait(interval):
            if time.monotonic() - self.last_output < self.QUIET_SECONDS:
                continue
            line = self.status_text()
            with self.lock:
                if self._stop.is_set():
                    return
                try:
                    if self._tty:
                        width = shutil.get_terminal_size((80, 24)).columns
                        self._stream.write("\r\x1b[K" + line[: max(width - 1, 20)])
                        self._visible = True
                    else:
                        self._stream.write(line + "\n")
                    self._stream.flush()
                except (OSError, ValueError):
                    return


class _TimestampingStream:
    """Mirror normal console output while copying complete lines into the journal."""

    def __init__(self, underlying, journal: InstallJournal, source: str):
        self.underlying = underlying
        self.journal = journal
        self.source = source
        self._buffer = ""

    def write(self, data):
        text = str(data)
        progress = _ACTIVE_PROGRESS
        if progress is None:
            self.underlying.write(text)
            self.underlying.flush()
        else:
            # Erase a live status line first so real output never mixes with it.
            with progress.lock:
                progress.clear_locked()
                self.underlying.write(text)
                self.underlying.flush()
                progress.last_output = time.monotonic()
        if self.journal is not _INSTALL_JOURNAL:
            # The session was already finalized; a late writer (for example a pump
            # thread of an interrupted child) must not raise on a closed sink.
            return len(text)
        normalized = text.replace("\r\n", "\n").replace("\r", "\n")
        self._buffer += normalized
        while "\n" in self._buffer:
            line, self._buffer = self._buffer.split("\n", 1)
            self.journal.write(line if line else "<blank>", source=self.source)
        return len(text)

    def flush(self):
        self.underlying.flush()

    def flush_log_buffer(self):
        if self._buffer:
            self.journal.write(self._buffer, source=self.source)
            self._buffer = ""

    def isatty(self):
        return self.underlying.isatty()

    def fileno(self):
        return self.underlying.fileno()

    @property
    def encoding(self):
        return getattr(self.underlying, "encoding", "utf-8")


def _journal_direct(message: str, *, source: str = "installer") -> None:
    if _INSTALL_JOURNAL is not None:
        _INSTALL_JOURNAL.write(message, source=source)


def install_parameter_snapshot(args: argparse.Namespace, *, update: bool = False) -> dict[str, object]:
    """Resolved non-secret install choices recorded for reproducibility/audit."""
    return {
        "build": BUILD_NUMBER,
        "command": "update" if update else "install",
        "project_root": str(ROOT),
        "python_runtime": f"{PYTHON_VERSION}.x",
        "service_name": service_name(args.name),
        "service_user": args.user or getpass.getuser(),
        "bind": requested_bind(args),
        "port": args.port,
        "transport": "plaintext" if plaintext_requested(args) else "tls",
        "diarization": bool(args.with_diarization),
        "no_service": bool(args.no_service),
        "force": bool(args.force),
        "refresh_models": bool(args.refresh_models),
        "startup_timeout_seconds": args.timeout,
        "assume_yes": bool(args.yes),
        "whisper_model_repo": DEFAULT_MODEL_REPO,
        "whisper_model_revision": DEFAULT_MODEL_REVISION,
        "speaker_model_repo": DEFAULT_EMBED_REPO if args.with_diarization else None,
        "speaker_model_revision": DEFAULT_EMBED_REVISION if args.with_diarization else None,
        "install_log": str(INSTALL_LOG_PATH),
    }


def start_install_logging(args: argparse.Namespace, raw_args: list[str], *, update: bool = False) -> None:
    """Start the mandatory append-only audit stream for install/update runs."""
    global _INSTALL_JOURNAL
    session = os.getenv(INSTALL_LOG_SESSION_ENV) or str(uuid.uuid4())
    os.environ[INSTALL_LOG_SESSION_ENV] = session
    try:
        journal = InstallJournal(INSTALL_LOG_PATH, session)
    except (OSError, Fail) as exc:
        raise Fail(f"Cannot initialize mandatory install audit log {INSTALL_LOG_PATH}: {exc}") from exc
    _INSTALL_JOURNAL = journal
    sys.stdout = _TimestampingStream(_ORIGINAL_STDOUT, journal, "stdout")
    sys.stderr = _TimestampingStream(_ORIGINAL_STDERR, journal, "stderr")

    original = raw_args
    encoded = os.getenv(INSTALL_ORIGINAL_ARGV_ENV)
    if encoded:
        try:
            candidate = json.loads(encoded)
            if isinstance(candidate, list) and all(isinstance(v, str) for v in candidate):
                original = candidate
        except Exception:
            pass
    journal.write(f"event=session_start project={PROJECT_ID} build={BUILD_NUMBER}")
    journal.write(f"cwd={os.getcwd()} uid={os.getuid()} euid={os.geteuid()} user={getpass.getuser()}")
    journal.write(f"argv={shlex.join(['python', 'install.py', *original])}")
    journal.write("parsed_arguments=" + json.dumps(vars(args), sort_keys=True, default=str))
    journal.write("effective_parameters=" + json.dumps(install_parameter_snapshot(args, update=update), sort_keys=True))
    if os.getenv(UV_BOOTSTRAP_SENTINEL) == "1":
        journal.write(f"bootstrap=uv managed_python={PYTHON_VERSION}.x no_project=true isolated=true")
    journal.write(f"event=audit_ready path={INSTALL_LOG_PATH} mode=append_only")


def report_install_log_status() -> None:
    """Tell the operator where this run is audited."""
    journal = _INSTALL_JOURNAL
    if journal is not None:
        ok(f"install audit log: {journal.path} (append-only, session {journal.session})")


def stop_install_logging(exit_code: int) -> None:
    global _INSTALL_JOURNAL
    journal = _INSTALL_JOURNAL
    if journal is None:
        return
    try:
        for stream in (sys.stdout, sys.stderr):
            if isinstance(stream, _TimestampingStream):
                stream.flush_log_buffer()
        journal.write(f"event=session_end exit_code={exit_code}")
    finally:
        # Restore real streams even when the sink is broken, so Python can still
        # report errors instead of losing sys.stderr.
        sys.stdout = _ORIGINAL_STDOUT
        sys.stderr = _ORIGINAL_STDERR
        _INSTALL_JOURNAL = None
        journal.close()


def _abandon_install_logging(exit_code: int) -> None:
    """Best-effort finalization when logging startup itself failed or was interrupted."""
    try:
        stop_install_logging(exit_code)
    except Exception:
        pass


def say(message: str) -> None:
    print(f"==> {message}")


def ok(message: str) -> None:
    print(f" ok {message}")


def warn(message: str) -> None:
    print(f"warn {message}", file=sys.stderr)


def die(message: str) -> "NoReturn":
    raise Fail(message)


def _pump_process_stream(pipe, target) -> None:
    try:
        for chunk in iter(pipe.readline, ""):
            target.write(chunk)
            target.flush()
    finally:
        pipe.close()


def _journal_command_output(out: str | None, err: str | None) -> None:
    if out:
        _journal_direct(out, source="command.stdout")
    if err:
        _journal_direct(err, source="command.stderr")


def run(cmd: list[str], *, check: bool = True, capture: bool = False, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    if _INSTALL_JOURNAL is None:
        if capture:
            return subprocess.run(cmd, check=check, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
        return subprocess.run(cmd, check=check, text=True, env=env)

    _journal_direct("exec=" + shlex.join([str(x) for x in cmd]), source="command")
    if capture:
        with subprocess.Popen(cmd, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env) as proc:
            try:
                out, err = proc.communicate()
            except KeyboardInterrupt:
                # The child received the same SIGINT. communicate() resumes without
                # losing buffered output, so record what it printed while exiting.
                try:
                    out, err = proc.communicate(timeout=10)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    out, err = proc.communicate()
                _journal_command_output(out, err)
                _journal_direct(f"exit={proc.returncode} interrupted=true", source="command")
                raise
        _journal_command_output(out, err)
        _journal_direct(f"exit={proc.returncode}", source="command")
        if check and proc.returncode:
            raise subprocess.CalledProcessError(proc.returncode, cmd, output=out, stderr=err)
        return subprocess.CompletedProcess(cmd, proc.returncode, out, err)

    proc = subprocess.Popen(
        cmd,
        text=True,
        stdin=None,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=env,
        bufsize=1,
    )
    assert proc.stdout is not None and proc.stderr is not None
    threads = [
        threading.Thread(target=_pump_process_stream, args=(proc.stdout, sys.stdout), daemon=True),
        threading.Thread(target=_pump_process_stream, args=(proc.stderr, sys.stderr), daemon=True),
    ]
    for thread in threads:
        thread.start()
    try:
        returncode = proc.wait()
    except KeyboardInterrupt:
        # The child is in our foreground process group and received the same
        # SIGINT. Let it exit and drain its final output into the audit log before
        # the interruption propagates to session finalization.
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()
        for thread in threads:
            thread.join(timeout=5)
        for stream in (sys.stdout, sys.stderr):
            if isinstance(stream, _TimestampingStream):
                stream.flush_log_buffer()
        _journal_direct(f"exit={proc.returncode} interrupted=true", source="command")
        raise
    for thread in threads:
        thread.join()
    for stream in (sys.stdout, sys.stderr):
        if isinstance(stream, _TimestampingStream):
            stream.flush_log_buffer()
    _journal_direct(f"exit={returncode}", source="command")
    result = subprocess.CompletedProcess(cmd, returncode)
    if check and returncode:
        raise subprocess.CalledProcessError(returncode, cmd)
    return result


def require_command(name: str) -> str:
    path = shutil.which(name)
    if not path:
        die(f"Required command not found: {name}")
    return path


def sudo_prefix() -> list[str]:
    if os.geteuid() == 0:
        return []
    require_command("sudo")
    return ["sudo"]


def require_host() -> None:
    if platform.system() != "Linux":
        die("This installer targets Linux/systemd hosts.")
    # install.py is a stdlib bootstrap and may itself be launched by a newer host
    # Python. The VTS runtime is separately pinned to PYTHON_VERSION below.
    if sys.version_info < (3, 10):
        die("The installer bootstrap needs Python 3.10 or newer.")
    if not Path("/run/systemd/system").is_dir():
        die("systemd is not active on this host.")
    require_command("systemctl")
    require_command("curl")


def interpreter_minor(executable: str | Path) -> tuple[int, int] | None:
    result = run(
        [str(executable), "-c", "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')"],
        check=False,
        capture=True,
    )
    if result.returncode != 0:
        return None
    try:
        major, minor = result.stdout.strip().split(".", 1)
        return int(major), int(minor)
    except Exception:
        return None


def uv_executable() -> str:
    """Return the uv executable used as VTS's Python/runtime bootstrap."""
    return require_command("uv")


def running_under_uv() -> bool:
    try:
        return int(os.getenv(UV_RECURSION_ENV, "0")) > 0
    except ValueError:
        return bool(os.getenv("UV"))


def bootstrap_via_uv(argv: list[str]) -> None:
    """Re-exec runtime-sensitive commands under uv-managed CPython.

    Plain `python install.py` is intentionally supported. The host interpreter is
    only a tiny stdlib launcher; uv owns acquisition/selection of the pinned
    CPython line. `--no-project` is deliberate: the bootstrap must not eagerly
    sync VTS's heavy runtime dependencies before install.py can enforce its own
    wheel-only install policy. `--isolated` prevents an already-active environment
    from influencing that bootstrap.
    """
    if running_under_uv() and sys.version_info[:2] == PYTHON_VERSION_INFO:
        return

    if os.getenv(UV_BOOTSTRAP_SENTINEL) == "1":
        die(
            f"uv bootstrap returned Python {sys.version_info.major}.{sys.version_info.minor}; "
            f"VTS requires Python {PYTHON_VERSION}.x"
        )

    uv = uv_executable()
    say(f"Re-launching through uv with managed Python {PYTHON_VERSION}.x")
    env = os.environ.copy()
    env[UV_BOOTSTRAP_SENTINEL] = "1"
    env.setdefault(INSTALL_ORIGINAL_ARGV_ENV, json.dumps(argv))
    cmd = [
        uv,
        "run",
        "--no-project",
        "--isolated",
        "--managed-python",
        "--python",
        PYTHON_VERSION,
        "--",
        "python",
        str(ROOT / "install.py"),
        *argv,
    ]
    try:
        os.execvpe(uv, cmd, env)
    except OSError as exc:
        die(f"Could not launch uv: {exc}")



def confirm(message: str, assume_yes: bool) -> bool:
    if assume_yes:
        _journal_direct(f"prompt={message!r} response=assumed_yes", source="interaction")
        return True
    try:
        reply = input(f"{message} [y/N] ").strip().lower()
    except EOFError:
        _journal_direct(f"prompt={message!r} response=eof", source="interaction")
        return False
    accepted = reply in {"y", "yes"}
    _journal_direct(f"prompt={message!r} response={'yes' if accepted else 'no'}", source="interaction")
    return accepted


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def venv_matches_pinned_python() -> bool:
    return VENV_PYTHON.exists() and interpreter_minor(VENV_PYTHON) == PYTHON_VERSION_INFO


def ensure_venv(force: bool = False) -> None:
    uv = uv_executable()
    if force and VENV.exists():
        say("Removing existing virtual environment")
        shutil.rmtree(VENV)
    elif VENV.exists() and not venv_matches_pinned_python():
        # Build 8/9 could leave a venv created by another Python minor.
        say(f"Replacing .venv because VTS requires Python {PYTHON_VERSION}.x")
        shutil.rmtree(VENV)

    if not VENV_PYTHON.exists():
        say(f"Creating .venv with uv-managed Python {PYTHON_VERSION}.x")
        run([
            uv,
            "venv",
            "--no-project",
            "--managed-python",
            "--python",
            PYTHON_VERSION,
            str(VENV),
        ])
    if not venv_matches_pinned_python():
        die(f"Virtual environment is not using Python {PYTHON_VERSION}.x")
    ok(f"virtual environment ready (uv-managed Python {PYTHON_VERSION}.x)")



# faster-whisper's CTranslate2 loads the CUDA 12 libraries from nvidia-*-cu12.
# PyTorch's PyPI wheels moved to CUDA 13 at torch 2.11 and pull
# nvidia-cudnn-cu13, which installs into the same nvidia/cudnn/lib/libcudnn*.so.9
# files and silently replaces the cuDNN CTranslate2 needs; the service then dies
# at startup. requirements-diarization.txt pins the CUDA 12 torch line, and this
# probe refuses any venv that mixes the two lines anyway. It reads package
# metadata only, so it never imports torch or touches the GPU.
CUDA_STACK_PROBE = r'''
import importlib.metadata as md
names = {}
for dist in md.distributions():
    name = (dist.metadata["Name"] or "").lower().replace("_", "-")
    if name:
        names[name] = dist.version
problems = []
cu13 = sorted(n for n in names if n.endswith("-cu13") or n == "cuda-toolkit")
if cu13:
    problems.append("CUDA 13 packages installed next to CTranslate2's CUDA 12 libraries: " + ", ".join(cu13))
if "torch" in names and "torchaudio" in names:
    torch_v = names["torch"].split("+")[0]
    audio_v = names["torchaudio"].split("+")[0]
    if torch_v != audio_v:
        problems.append(f"torchaudio {audio_v} does not match torch {torch_v}")
for problem in problems:
    print(problem)
raise SystemExit(1 if problems else 0)
'''


def cuda_stack_problems() -> list[str]:
    """Return reasons the venv's CUDA libraries are inconsistent, or []."""
    if not VENV_PYTHON.exists():
        return []
    proc = run([str(VENV_PYTHON), "-c", CUDA_STACK_PROBE], check=False, capture=True)
    if proc.returncode == 0:
        return []
    return [line.strip() for line in (proc.stdout or "").splitlines() if line.strip()] or ["CUDA library probe failed"]


def dependency_probe(diarization: bool = False) -> bool:
    imports = "import fastapi, faster_whisper, huggingface_hub, numpy, uvicorn"
    if diarization:
        imports += "; import speechbrain, torch, torchaudio, hyperpyyaml"
    return run([str(VENV_PYTHON), "-c", imports], check=False).returncode == 0


def install_dependencies(*, diarization: bool, force: bool = False) -> None:
    if not force and VENV_PYTHON.exists() and cuda_stack_problems():
        # Uninstalling the CUDA 13 wheels would delete the shared libcudnn files
        # the CUDA 12 wheel also owns, so a mixed venv cannot be repaired in place.
        say("Replacing .venv because it mixes CUDA 12 and CUDA 13 libraries")
        force = True
    ensure_venv(force=force)
    marker = VENV / ".vts-requirements.json"
    wanted = {"main": sha256_file(REQ)}
    if diarization:
        wanted["diarization"] = sha256_file(REQ_DIARIZE)
    have = None
    if marker.exists():
        try:
            have = json.loads(marker.read_text(encoding="utf-8"))
        except Exception:
            pass
    if have == wanted and dependency_probe(diarization) and not cuda_stack_problems():
        ok("Python dependencies already match")
        return

    say("Installing Python dependencies with uv (binary wheels only; source builds are forbidden)")
    uv = uv_executable()
    with _ProgressLine("installing Python dependencies"):
        run([uv, "pip", "install", "--python", str(VENV_PYTHON), *UV_WHEEL_ONLY_ARGS, "-r", str(REQ)])
        if diarization:
            run([uv, "pip", "install", "--python", str(VENV_PYTHON), *UV_WHEEL_ONLY_ARGS, "-r", str(REQ_DIARIZE)])
    problems = cuda_stack_problems()
    if problems:
        for problem in problems:
            warn(problem)
        die("Installed dependencies mix CUDA library lines; the service would fail to start. "
            "Check requirements-diarization.txt and rerun with --force.")
    marker.write_text(json.dumps(wanted, indent=2) + "\n", encoding="utf-8")
    ok("Python dependencies installed")


def model_complete(directory: Path, required: tuple[str, ...]) -> bool:
    return directory.is_dir() and all((directory / name).is_file() and (directory / name).stat().st_size for name in required)


def snapshot_download(repo: str, revision: str, destination: Path, patterns: list[str], required: tuple[str, ...], *, force: bool) -> None:
    if model_complete(destination, required) and not force:
        ok(f"model already present: {destination.name}/")
        return

    tmp = destination.with_name(destination.name + ".new")
    if tmp.exists():
        shutil.rmtree(tmp)
    tmp.mkdir(parents=True)

    script = r'''
import fnmatch, json, os, shutil
from pathlib import Path
from huggingface_hub import HfApi, snapshot_download
repo = os.environ["VT_REPO"]
revision = os.environ["VT_REVISION"]
dest = Path(os.environ["VT_DEST"])
patterns = json.loads(os.environ["VT_PATTERNS"])
info = HfApi().model_info(repo, revision=revision, files_metadata=True)
sha = info.sha
try:  # expected size for the installer's progress line; never fatal
    total = sum(s.size or 0 for s in info.siblings or [] if any(fnmatch.fnmatch(s.rfilename, p) for p in patterns))
    Path(os.environ["VT_EXPECTED_BYTES"]).write_text(str(total), encoding="ascii")
except Exception:
    pass
snapshot_download(repo_id=repo, revision=sha, local_dir=dest, allow_patterns=patterns, force_download=True)
shutil.rmtree(dest / ".cache", ignore_errors=True)
(dest / "SOURCE.json").write_text(json.dumps({"repo": repo, "requested_revision": revision, "resolved_revision": sha}, indent=2) + "\\n", encoding="utf-8")
print(sha)
'''
    handle, expected_name = tempfile.mkstemp(prefix="vts-download-", suffix=".size")
    os.close(handle)
    expected_bytes = Path(expected_name)
    env = os.environ.copy()
    env.update({
        "VT_REPO": repo,
        "VT_REVISION": revision,
        "VT_DEST": str(tmp),
        "VT_PATTERNS": json.dumps(patterns),
        "VT_EXPECTED_BYTES": str(expected_bytes),
        "HF_HUB_DISABLE_TELEMETRY": "1",
    })
    say(f"Downloading {repo}@{revision} into {destination.name}/")
    try:
        with _ProgressLine(f"downloading {destination.name}/", measure=tmp, expected_bytes=expected_bytes):
            result = run([str(VENV_PYTHON), "-c", script], capture=True, env=env)
        resolved = result.stdout.strip().splitlines()[-1] if result.stdout.strip() else revision
    except Exception:
        shutil.rmtree(tmp, ignore_errors=True)
        raise
    finally:
        expected_bytes.unlink(missing_ok=True)

    missing = [name for name in required if not (tmp / name).is_file()]
    if missing:
        shutil.rmtree(tmp, ignore_errors=True)
        die("Downloaded model is incomplete; missing: " + ", ".join(missing))
    if destination.exists():
        shutil.rmtree(destination)
    tmp.rename(destination)
    ok(f"installed {repo}@{resolved}")


def ensure_models(*, diarization: bool, force: bool = False) -> None:
    snapshot_download(
        DEFAULT_MODEL_REPO,
        DEFAULT_MODEL_REVISION,
        MODEL_DIR,
        ["config.json", "model.bin", "preprocessor_config.json", "tokenizer.json", "vocabulary.json"],
        REQUIRED_MODEL_FILES,
        force=force,
    )
    if diarization:
        snapshot_download(
            DEFAULT_EMBED_REPO,
            DEFAULT_EMBED_REVISION,
            EMBED_DIR,
            ["*.yaml", "*.ckpt", "*.txt", "*.json"],
            ("hyperparams.yaml", "embedding_model.ckpt"),
            force=force,
        )


def ensure_env_file() -> None:
    if not ENV_FILE.exists() and ENV_SAMPLE.exists():
        shutil.copyfile(ENV_SAMPLE, ENV_FILE)
        ok("created server.env from server.env.example")


TLS_EXPIRY_WARN_DAYS = 14


class _EncryptedKey(Exception):
    pass


def _refuse_passphrase():
    raise _EncryptedKey()


def server_env_assignments() -> dict[str, str]:
    """Plain KEY=VALUE assignments from server.env, as systemd's EnvironmentFile reads them."""
    values: dict[str, str] = {}
    if not ENV_FILE.exists():
        return values
    for raw in ENV_FILE.read_text(encoding="utf-8", errors="replace").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().strip("\"'")
    return values


def tls_paths() -> tuple[Path, Path]:
    """Resolve certificate/key exactly as server.py does: TLS_CERT/TLS_KEY or files beside server.py."""
    env = server_env_assignments()
    cert = Path(env.get("TLS_CERT") or (ROOT / "fullchain.pem")).expanduser()
    key = Path(env.get("TLS_KEY") or (ROOT / "privkey.pem")).expanduser()
    # The unit's WorkingDirectory is ROOT, so that is where relative paths point.
    return (cert if cert.is_absolute() else ROOT / cert), (key if key.is_absolute() else ROOT / key)


def tls_expiry_note(not_after: str, now: _dt.datetime | None = None) -> str | None:
    """Return a warning for an expired or soon-expiring certificate, else None."""
    try:
        expires = _dt.datetime.fromtimestamp(ssl.cert_time_to_seconds(not_after), tz=_dt.timezone.utc)
    except (ValueError, OverflowError):
        return None
    now = now or _dt.datetime.now(_dt.timezone.utc)
    if expires <= now:
        return f"TLS certificate EXPIRED on {expires:%Y-%m-%d}; clients will reject the connection"
    days = (expires - now).days
    if days < TLS_EXPIRY_WARN_DAYS:
        return f"TLS certificate expires in {days} day(s), on {expires:%Y-%m-%d}"
    return None


def tls_material_problems(cert: Path, key: Path) -> list[str]:
    """Why the service could not start TLS with these files, or [] when it can.

    Uses the same stdlib ssl loader Uvicorn uses, so a missing, unreadable,
    malformed, passphrase-protected or mismatched key/certificate is caught
    here. Only paths and ssl error classes are reported, never file contents.
    """
    missing = [str(path) for path in (cert, key) if not path.is_file()]
    if missing:
        return ["missing: " + ", ".join(missing)]
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    try:
        context.load_cert_chain(str(cert), str(key), password=_refuse_passphrase)
    except PermissionError as exc:
        return [f"not readable by {getpass.getuser()}: {exc.filename or cert}"]
    except _EncryptedKey:
        return [f"{key} is passphrase-protected; the service cannot unlock it"]
    except ssl.SSLError as exc:
        reason = getattr(exc, "reason", None) or type(exc).__name__
        if reason == "KEY_VALUES_MISMATCH":
            return [f"{key} does not belong to the certificate in {cert}"]
        return [f"{cert} / {key} could not be loaded as a PEM certificate and key ({reason})"]
    return []


def find_other_build_tls() -> Path | None:
    """Newest other VTS build folder nearby that holds both TLS files (suggestion only)."""
    candidates: list[tuple[int, float, Path]] = []
    patterns = ("vts_build_*", "*/vts_build_*")
    seen: set[Path] = set()
    for base, pattern in ((ROOT.parent, patterns[0]), (ROOT.parent.parent, patterns[1])):
        try:
            folders = list(base.glob(pattern))
        except OSError:
            continue
        for folder in folders:
            try:
                folder = folder.resolve()
                if folder == ROOT or folder in seen:
                    continue
                seen.add(folder)
                if not ((folder / "fullchain.pem").is_file() and (folder / "privkey.pem").is_file()):
                    continue
                match = re.search(r"vts_build_(\d+)$", folder.name)
                build = int(match.group(1)) if match else -1
                candidates.append((build, (folder / "fullchain.pem").stat().st_mtime, folder))
            except OSError:
                continue
    return max(candidates)[2] if candidates else None


def require_tls_material() -> None:
    """Stop before the service is (re)started when it would exit on its TLS files."""
    cert, key = tls_paths()
    problems = tls_material_problems(cert, key)
    if problems:
        for problem in problems:
            warn(f"TLS: {problem}")
        hint = (
            f"Put fullchain.pem and privkey.pem in {ROOT} (beside server.py)."
        )
        default_paths = cert == ROOT / "fullchain.pem" and key == ROOT / "privkey.pem"
        other = find_other_build_tls() if default_paths and not cert.is_file() and not key.is_file() else None
        if other is not None:
            hint += (
                f" Found them in {other}; to reuse them run:\n"
                f"    cp -p {shlex.quote(str(other / 'fullchain.pem'))} {shlex.quote(str(other / 'privkey.pem'))} {shlex.quote(str(ROOT))}/"
            )
        die(
            "TLS is required, but the service could not start with the configured certificate. "
            + hint
            + "\nThen rerun this command. For a trusted plaintext hop only, use --allow-plaintext."
        )
    note = None
    try:
        # Private but long-standing CPython helper; expiry is advisory only.
        note = tls_expiry_note(ssl._ssl._test_decode_cert(str(cert))["notAfter"])  # type: ignore[attr-defined]
    except Exception:
        pass
    if note:
        warn(note)
    ok(f"TLS certificate and key load: {cert.name} / {key.name}")


def service_name(value: str) -> str:
    value = value.removesuffix(".service")
    if not re.fullmatch(r"[A-Za-z0-9_.@-]+", value):
        die("Invalid systemd service name")
    return value


def unit_path(name: str) -> Path:
    return Path("/etc/systemd/system") / f"{name}.service"


def service_state(name: str) -> str:
    return run(["systemctl", "is-active", name], check=False, capture=True).stdout.strip()


def _unit_declared_port(text: str) -> int | None:
    match = re.search(r'(?m)^Environment=["\']?PORT=(\d+)["\']?\s*$', text)
    return int(match.group(1)) if match else None


def migrate_conflicting_legacy_service(target_name: str, port: int) -> None:
    """Stop the old installer-managed service when it owns the target port.

    VTS used `voice-transcribe.service` before the project was renamed to `vts`.
    Leaving that unit active makes a fresh `vts.service` enter a restart loop while
    health checks accidentally talk to the old process. Only the old installer
    marker plus an explicit matching PORT authorizes automatic migration.
    """
    for legacy in LEGACY_SERVICE_NAMES:
        if legacy == target_name:
            continue
        path = unit_path(legacy)
        if not path.exists():
            continue
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        if LEGACY_MANAGED_MARKER not in text:
            continue
        if service_state(legacy) not in {"active", "activating"}:
            continue
        declared = _unit_declared_port(text)
        if declared != port:
            continue
        say(f"Migrating legacy {legacy}.service from port {port} to {target_name}.service")
        run([*sudo_prefix(), "systemctl", "disable", "--now", legacy])
        ok(f"stopped legacy {legacy}.service; its project files were left untouched")


def tcp_port_open(port: int) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.5):
            return True
    except OSError:
        return False


def ensure_port_available_or_owned(name: str, port: int) -> None:
    # Updating an already-active target service is fine: systemd will stop it
    # before starting the replacement. Any other listener is a deployment error.
    if service_state(name) in {"active", "activating"}:
        return
    if tcp_port_open(port):
        die(
            f"Port {port} is already in use by another process/service. "
            f"Stop the conflicting listener before installing {name}.service."
        )


def health_contract_matches(body: dict | None, *, expected_transport: str | None = None) -> bool:
    return bool(
        body
        and body.get("status") == "ready"
        and body.get("service") == PROJECT_ID
        and body.get("build") == BUILD_NUMBER
        and body.get("retention_supported") is False
        and body.get("content_persistence") == "none"
        and body.get("request_payload_storage") == "memory_only"
        and (expected_transport is None or body.get("transport_security") == expected_transport)
    )


def build_unit(*, name: str, run_user: str, run_group: str, host: str, port: int, allow_plaintext: bool = False) -> str:
    # No writable application directory is granted. Recording-derived content has
    # nowhere on ordinary storage to go even if a later bug tries to create a file.
    return textwrap.dedent(f"""\
        {MANAGED_MARKER}
        # X-Managed-Dir: {ROOT}
        # Regenerate with: {ROOT}/install.py

        [Unit]
        Description=VTS - Voice Transcribe Server (build {BUILD_NUMBER})
        Documentation=file://{ROOT}/README.md file://{ROOT}/docs/PRIVACY.md
        After=network-online.target
        Wants=network-online.target
        StartLimitIntervalSec=300
        StartLimitBurst=5

        [Service]
        Type=simple
        User={run_user}
        Group={run_group}
        WorkingDirectory={ROOT}
        ExecStart={VENV_PYTHON} {ROOT / 'server.py'}

        # Installer-owned bind values use VTS_* names so server.env cannot
        # accidentally override an explicit deployment choice.
        Environment=VTS_BIND_HOST={host}
        Environment=VTS_BIND_PORT={port}
        # TLS is mandatory by default. Plaintext requires an explicit installer flag.
        Environment=VTS_TLS_ENABLED={0 if allow_plaintext else 1}
        Environment=RAM_TMP_DIR=/dev/shm/vts
        Environment=TMPDIR=/dev/shm/vts
        Environment=TMP=/dev/shm/vts
        Environment=TEMP=/dev/shm/vts
        Environment=XDG_CACHE_HOME=/dev/shm/vts
        Environment=PYTHONDONTWRITEBYTECODE=1
        Environment=HF_HUB_OFFLINE=1
        Environment=TRANSFORMERS_OFFLINE=1
        Environment=HF_HUB_DISABLE_TELEMETRY=1
        Environment=CUDA_CACHE_DISABLE=1
        EnvironmentFile=-{ENV_FILE}

        Restart=always
        RestartSec=5
        TimeoutStartSec=600
        TimeoutStopSec=30
        KillSignal=SIGINT
        SyslogIdentifier={name}
        StandardOutput=journal
        StandardError=journal

        # Privacy boundary: request content may live in process memory, not swap,
        # core dumps, normal temp directories, or a writable application tree.
        MemorySwapMax=0
        LimitCORE=0
        UMask=0077
        NoNewPrivileges=true
        ProtectSystem=strict
        ProtectHome=read-only
        TemporaryFileSystem=/tmp:rw,nosuid,nodev,noexec,size=128M
        TemporaryFileSystem=/var/tmp:rw,nosuid,nodev,noexec,size=128M

        # Hardening kept compatible with NVIDIA/CUDA device access.
        ProtectKernelTunables=true
        ProtectKernelLogs=true
        ProtectControlGroups=true
        ProtectClock=true
        ProtectHostname=true
        RestrictSUIDSGID=true
        RestrictRealtime=true
        LockPersonality=true
        RemoveIPC=true
        RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6

        [Install]
        WantedBy=multi-user.target
    """)


def install_unit(*, name: str, run_user: str, host: str, port: int, allow_plaintext: bool = False) -> None:
    import grp
    import pwd

    try:
        pw = pwd.getpwnam(run_user)
    except KeyError:
        die(f"Unknown user: {run_user}")
    run_group = grp.getgrgid(pw.pw_gid).gr_name
    content = build_unit(name=name, run_user=run_user, run_group=run_group, host=host, port=port, allow_plaintext=allow_plaintext)
    target = unit_path(name)
    current = target.read_text(encoding="utf-8") if target.exists() and os.access(target, os.R_OK) else None
    if current == content:
        ok("systemd unit unchanged")
    else:
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=False) as tmp:
            tmp.write(content)
            tmp_path = Path(tmp.name)
        try:
            run([*sudo_prefix(), "install", "-m", "0644", str(tmp_path), str(target)])
        finally:
            tmp_path.unlink(missing_ok=True)
        ok(f"wrote {target}")

    run([*sudo_prefix(), "systemctl", "daemon-reload"])
    run([*sudo_prefix(), "systemctl", "enable", name])
    run([*sudo_prefix(), "systemctl", "restart", name])


def _health_request(host: str, port: int, scheme: str) -> tuple[bool, dict | None, str | None]:
    probe_host = probe_host_for_bind(host)
    url = f"{scheme}://{url_host(probe_host)}:{port}/healthz"
    context = ssl._create_unverified_context() if scheme == "https" else None
    try:
        with urllib.request.urlopen(url, timeout=5, context=context) as response:
            return True, json.loads(response.read().decode("utf-8")), None
    except Exception as exc:
        return False, None, type(exc).__name__


def wait_health(name: str, host: str, port: int, timeout: int, *, allow_plaintext: bool = False) -> tuple[str, dict]:
    scheme = "http" if allow_plaintext else "https"
    transport = "plaintext" if allow_plaintext else "tls"
    say(f"Waiting for VTS build {BUILD_NUMBER} /healthz over {scheme} on port {port} (up to {timeout}s)")
    deadline = time.monotonic() + timeout
    last = "no response"
    with _ProgressLine(f"waiting for {name}.service to answer /healthz"):
        while time.monotonic() < deadline:
            state = service_state(name)
            if state not in {"active", "activating"}:
                die(f"{name}.service is {state or 'not active'}; run: python install.py logs")
            good, body, error = _health_request(host, port, scheme)
            if good and body:
                if health_contract_matches(body, expected_transport=transport):
                    ok(f"health/identity/privacy/transport contract passed over {scheme}")
                    return scheme, body
                if body.get("status") == "ready":
                    die(
                        f"Port {port} answered /healthz, but not as VTS build {BUILD_NUMBER} "
                        f"with transport={transport}. Received: {json.dumps(body, sort_keys=True)}"
                    )
            last = error or repr(body)
            time.sleep(2)
    die(f"Health check timed out ({last})")


def fs_type(path: Path) -> str | None:
    target = path.resolve()
    best: tuple[int, str] | None = None
    try:
        for line in Path("/proc/self/mountinfo").read_text(encoding="utf-8").splitlines():
            left, sep, right = line.partition(" - ")
            if not sep:
                continue
            fields = left.split()
            rhs = right.split()
            if len(fields) < 5 or not rhs:
                continue
            mountpoint = Path(fields[4].replace("\\040", " "))
            try:
                target.relative_to(mountpoint)
            except ValueError:
                continue
            item = (len(str(mountpoint)), rhs[0])
            if best is None or item[0] > best[0]:
                best = item
    except Exception:
        return None
    return best[1] if best else None


def systemctl_property(name: str, prop: str) -> str | None:
    result = run(["systemctl", "show", name, f"--property={prop}", "--value"], check=False, capture=True)
    return result.stdout.strip() if result.returncode == 0 else None


def service_environment_value(name: str, key: str) -> str | None:
    raw = systemctl_property(name, "Environment") or ""
    try:
        tokens = shlex.split(raw)
    except ValueError:
        tokens = raw.split()
    prefix = key + "="
    for token in tokens:
        if token.startswith(prefix):
            return token[len(prefix):]
    return None


def verify(name: str, port: int, *, host: str | None = None, require_service: bool = True) -> bool:
    checks: list[tuple[str, bool, str]] = []
    add = checks.append
    add(("VTS build identity", BUILD_NUMBER >= 1, f"build {BUILD_NUMBER}"))
    uv = shutil.which("uv")
    add(("uv bootstrap available", uv is not None, uv or "not found"))
    pyver_file = (ROOT / ".python-version").read_text(encoding="ascii").strip() if (ROOT / ".python-version").exists() else ""
    add((".python-version matches runtime", pyver_file == PYTHON_VERSION, pyver_file or "missing"))
    venv_ok = venv_matches_pinned_python()
    venv_detail = str(VENV_PYTHON) if not VENV_PYTHON.exists() else f"{VENV_PYTHON} -> {interpreter_minor(VENV_PYTHON)}"
    add((f"virtual environment uses Python {PYTHON_VERSION}.x", venv_ok, venv_detail))
    add(("/dev/shm is tmpfs", fs_type(Path("/dev/shm")) == "tmpfs", fs_type(Path("/dev/shm")) or "unknown"))
    add(("runtime dependencies", venv_ok and dependency_probe(False), "imports"))
    cuda_problems = cuda_stack_problems() if venv_ok else []
    add(("one CUDA library line (12)", not cuda_problems, "; ".join(cuda_problems) or "consistent"))
    add(("Whisper model", model_complete(MODEL_DIR, REQUIRED_MODEL_FILES), str(MODEL_DIR)))

    source = (ROOT / "server.py").read_text(encoding="utf-8")
    forbidden = ["UploadFile", "SpooledTemporaryFile", "store_backup", "RotatingFileHandler", "FileHandler("]
    found = [token for token in forbidden if token in source]
    add(("no retention/multipart file path", not found, ", ".join(found) if found else "clean"))
    add(("raw request streaming", "request.stream()" in source, "request.stream()"))
    add(("no-store responses", "Cache-Control" in source and "no-store" in source, "HTTP cache disabled"))

    service_exists = run(["systemctl", "cat", name], check=False, capture=True).returncode == 0
    add(("systemd service", service_exists if require_service else True, name))
    if service_exists:
        working = systemctl_property(name, "WorkingDirectory")
        exec_start = systemctl_property(name, "ExecStart")
        add(("service working directory", working == str(ROOT), working or "unset"))
        add(("service runs current server.py", bool(exec_start and str(ROOT / "server.py") in exec_start), exec_start or "unset"))
        props = {
            "ProtectSystem": "strict",
            "NoNewPrivileges": "yes",
            "MemorySwapMax": "0",
            "LimitCORE": "0",
        }
        for prop, expected in props.items():
            actual = systemctl_property(name, prop)
            add((prop, actual == expected, actual or "unset"))
        active = run(["systemctl", "is-active", name], check=False, capture=True).stdout.strip()
        add(("service active", active == "active", active or "unknown"))

        effective_host = host or service_environment_value(name, "VTS_BIND_HOST") or DEFAULT_HOST
        add(("service bind address", bool(effective_host), effective_host))
        tls_setting = (service_environment_value(name, "VTS_TLS_ENABLED") or "1").strip().lower()
        allow_plaintext = tls_setting in {"0", "false", "no", "off"}
        expected_scheme = "http" if allow_plaintext else "https"
        expected_transport = "plaintext" if allow_plaintext else "tls"
        add(("transport policy", tls_setting in {"0", "1", "false", "true", "no", "yes", "off", "on"},
             "plaintext explicitly allowed" if allow_plaintext else "TLS required"))
        if not allow_plaintext:
            cert, key = tls_paths()
            tls_problems = tls_material_problems(cert, key)
            add(("TLS certificate and key", not tls_problems, "; ".join(tls_problems) or f"{cert.name} / {key.name}"))
        good, body, error = _health_request(effective_host, port, expected_scheme)
        add(("health endpoint", bool(good and body and body.get("status") == "ready"),
             json.dumps(body) if body else (error or "unreachable")))
        if not allow_plaintext:
            plain_good, _, plain_error = _health_request(effective_host, port, "http")
            add(("plaintext HTTP refused", not plain_good, plain_error or "unexpectedly accepted"))
        if body:
            add(("health build matches", body.get("service") == PROJECT_ID and body.get("build") == BUILD_NUMBER, f"{body.get('service')} build {body.get('build')}"))
            add(("transport matches policy", body.get("transport_security") == expected_transport, str(body.get("transport_security"))))
            add(("server retention disabled", body.get("retention_supported") is False and body.get("content_persistence") == "none", str(body.get("content_persistence"))))
            add(("request payload RAM-only", body.get("request_payload_storage") == "memory_only", str(body.get("request_payload_storage"))))

    width = max(len(label) for label, _, _ in checks)
    print()
    print("Privacy/deployment verification")
    print("-" * (width + 30))
    failed = False
    for label, passed, detail in checks:
        failed |= not passed
        print(f"{label:<{width}}  {'OK' if passed else 'FAIL':<4}  {detail}")
    print()
    if failed:
        warn("verification failed")
        return False
    ok("verification passed")
    return True


AUDITABLE_SERVER_ENV_KEYS = {
    "HOST", "PORT", "DEVICE", "COMPUTE_TYPE", "CPU_THREADS", "MODEL_WORKERS",
    "MAX_BODY_MB", "DIARIZE", "EMBED_MIN_SEC", "LOG_CLIENT_IP",
    "TRUST_PROXY_HEADERS", "TLS_ENABLED", "TLS_CERT", "TLS_KEY", "RAM_TMP_DIR",
}


def audit_server_env_snapshot() -> None:
    """Record non-secret supported server.env assignments and a file digest."""
    if _INSTALL_JOURNAL is None:
        return
    if not ENV_FILE.exists():
        _journal_direct("server_env=absent", source="config")
        return
    values: dict[str, str] = {}
    for raw in ENV_FILE.read_text(encoding="utf-8", errors="replace").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if key in AUDITABLE_SERVER_ENV_KEYS:
            values[key] = value.strip().strip("\"'")
    _journal_direct(
        "server_env=" + json.dumps({
            "path": str(ENV_FILE),
            "sha256": sha256_file(ENV_FILE),
            "supported_assignments": values,
        }, sort_keys=True),
        source="config",
    )


def do_install(args: argparse.Namespace, *, update: bool = False) -> None:
    require_host()
    if os.geteuid() == 0:
        die("Run as your normal user, not root; sudo is used only for systemd operations.")
    run_user = args.user or getpass.getuser()
    allow_plaintext = plaintext_requested(args)

    if not args.no_service and not allow_plaintext:
        # Checked first: failing here takes seconds, not a full dependency and
        # model install followed by a service that exits on every restart.
        require_tls_material()

    if args.force and not confirm("--force removes .venv and downloaded model assets. Continue?", args.yes):
        die("Aborted")
    if args.force:
        shutil.rmtree(VENV, ignore_errors=True)
        shutil.rmtree(MODEL_DIR, ignore_errors=True)
        shutil.rmtree(EMBED_DIR, ignore_errors=True)

    install_dependencies(diarization=args.with_diarization, force=False)
    ensure_models(diarization=args.with_diarization, force=update and args.refresh_models)

    os.chmod(ROOT / "server.py", 0o755)
    os.chmod(ROOT / "install.py", 0o755)
    ensure_env_file()
    audit_server_env_snapshot()

    if args.no_service:
        ok("installation assets ready; systemd service installation skipped")
        return

    name = service_name(args.name)
    host = requested_bind(args)
    migrate_conflicting_legacy_service(name, args.port)
    ensure_port_available_or_owned(name, args.port)
    install_unit(
        name=name,
        run_user=run_user,
        host=host,
        port=args.port,
        allow_plaintext=allow_plaintext,
    )
    scheme, body = wait_health(name, host, args.port, args.timeout, allow_plaintext=allow_plaintext)
    print(json.dumps(body, indent=2, sort_keys=True))
    if not verify(name, args.port, host=host):
        die("Service started, but the privacy/deployment verification did not pass")
    if allow_plaintext:
        warn(
            f"PLAINTEXT IS ENABLED for VTS on {host}:{args.port}. "
            "Use this only on a trusted loopback/private hop; TLS is the default."
        )
    ok(f"{name}.service ready at {scheme}://{host}:{args.port}")



def do_status(args: argparse.Namespace) -> None:
    require_host()
    run(["systemctl", "status", service_name(args.name), "--no-pager"], check=False)


def do_logs(args: argparse.Namespace) -> None:
    require_host()
    cmd = [*sudo_prefix(), "journalctl", "-u", service_name(args.name)]
    if args.follow:
        cmd.append("-f")
    else:
        cmd += ["-n", str(args.lines), "--no-pager"]
    run(cmd, check=False)


def do_restart(args: argparse.Namespace) -> None:
    require_host()
    name = service_name(args.name)
    tls_setting = (service_environment_value(name, "VTS_TLS_ENABLED") or "1").strip().lower()
    if tls_setting not in {"0", "false", "no", "off"}:
        require_tls_material()
    run([*sudo_prefix(), "systemctl", "restart", name])
    ok(f"restarted {name}.service")


def do_uninstall(args: argparse.Namespace) -> None:
    require_host()
    name = service_name(args.name)
    target = unit_path(name)
    if not target.exists():
        die(f"No unit at {target}")
    text = target.read_text(encoding="utf-8", errors="replace")
    if MANAGED_MARKER not in text:
        die(f"Refusing to remove unmanaged unit: {target}")
    if not confirm(f"Stop, disable and remove {name}.service?", args.yes):
        die("Aborted")
    run([*sudo_prefix(), "systemctl", "disable", "--now", name], check=False)
    run([*sudo_prefix(), "rm", "-f", str(target)])
    run([*sudo_prefix(), "systemctl", "daemon-reload"])
    ok("service removed; project files, models and .venv were left untouched")


def network_service_flags(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--name", default=DEFAULT_SERVICE, help=f"systemd unit name (default: {DEFAULT_SERVICE})")
    parser.add_argument("--user", help="service user (default: current user)")
    parser.add_argument(
        "--bind", "-bind",
        nargs="?",
        const="0.0.0.0",
        metavar="ADDRESS",
        help=(
            "bind beyond the default 127.0.0.1; with no ADDRESS, listen on "
            "0.0.0.0; otherwise bind the exact IPv4/IPv6 address"
        ),
    )
    parser.add_argument(
        "--allow-plaintext", "-allow-plaintext",
        action="store_true",
        help="explicitly disable VTS TLS and accept HTTP; TLS is required by default",
    )
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help=f"listen port (default: {DEFAULT_PORT})")
    parser.add_argument("--timeout", type=int, default=240, help="startup health-check timeout")
    parser.add_argument("--yes", "-y", action="store_true", help="assume yes for destructive confirmations")


def common_install_flags(parser: argparse.ArgumentParser) -> None:
    network_service_flags(parser)
    parser.add_argument("--with-diarization", action="store_true", help="install optional speaker-embedding dependencies/model")
    parser.add_argument(
        "--no-service",
        action="store_true",
        help="install dependencies/models only; do not create or start a systemd service",
    )
    parser.add_argument("--force", action="store_true", help="recreate venv and model assets")
    parser.add_argument("--refresh-models", action="store_true", help="resolve/download model revisions again on update")


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Install and operate VTS - Voice Transcribe Server")
    sub = p.add_subparsers(dest="command")

    install = sub.add_parser("install", help="install/update dependencies, models and managed systemd service")
    common_install_flags(install)
    update = sub.add_parser("update", help="refresh an existing installation")
    common_install_flags(update)

    verify_p = sub.add_parser("verify", help="verify deployment and privacy invariants")
    verify_p.add_argument("--name", default=DEFAULT_SERVICE)
    verify_p.add_argument("--port", type=int, default=DEFAULT_PORT)
    verify_p.add_argument("--no-service", action="store_true", help="verify source/assets only")

    status = sub.add_parser("status", help="show systemd status")
    status.add_argument("--name", default=DEFAULT_SERVICE)
    logs = sub.add_parser("logs", help="show journal metadata logs")
    logs.add_argument("--name", default=DEFAULT_SERVICE)
    logs.add_argument("--follow", "-f", action="store_true")
    logs.add_argument("--lines", type=int, default=80)
    restart = sub.add_parser("restart", help="restart the service")
    restart.add_argument("--name", default=DEFAULT_SERVICE)
    uninstall = sub.add_parser("uninstall", help="remove the managed systemd service")
    uninstall.add_argument("--name", default=DEFAULT_SERVICE)
    uninstall.add_argument("--yes", "-y", action="store_true")
    return p


def main(argv: list[str] | None = None) -> int:
    args_list = list(sys.argv[1:] if argv is None else argv)
    known = {"install", "update", "verify", "status", "logs", "restart", "uninstall", "-h", "--help"}
    effective_command = args_list[0] if args_list and args_list[0] in known else "install"

    try:
        if effective_command in {"install", "update", "verify"}:
            bootstrap_via_uv(args_list)
    except Fail as exc:
        print(f"fail {exc}", file=sys.stderr)
        return 1

    if not args_list or args_list[0] not in known:
        args_list.insert(0, "install")
    args = parser().parse_args(args_list)

    logging_active = args.command in {"install", "update"}
    if logging_active:
        try:
            # raw_args intentionally excludes the inserted implicit `install`; the
            # parsed/effective records below state the command explicitly.
            original_args = list(sys.argv[1:] if argv is None else argv)
            start_install_logging(args, original_args, update=args.command == "update")
        except KeyboardInterrupt:
            _abandon_install_logging(130)
            print("fail interrupted by operator (Ctrl-C)", file=_ORIGINAL_STDERR)
            return 130
        except (Fail, OSError, subprocess.CalledProcessError) as exc:
            _abandon_install_logging(1)
            print(f"fail {exc}", file=_ORIGINAL_STDERR)
            return 1

    exit_code = 0
    try:
        print(f"{PROJECT_ID} — {PROJECT_NAME} — build {BUILD_NUMBER}")
        if logging_active:
            report_install_log_status()
        if args.command == "install":
            do_install(args)
        elif args.command == "update":
            do_install(args, update=True)
        elif args.command == "verify":
            require_host()
            exit_code = 0 if verify(service_name(args.name), args.port, require_service=not args.no_service) else 1
        elif args.command == "status":
            do_status(args)
        elif args.command == "logs":
            do_logs(args)
        elif args.command == "restart":
            do_restart(args)
        elif args.command == "uninstall":
            do_uninstall(args)
        else:
            parser().print_help()
    except Fail as exc:
        print(f"fail {exc}", file=sys.stderr)
        exit_code = 1
    except subprocess.CalledProcessError as exc:
        print(f"fail command exited {exc.returncode}: {' '.join(map(str, exc.cmd))}", file=sys.stderr)
        exit_code = exc.returncode or 1
    except KeyboardInterrupt:
        print("fail interrupted by operator (Ctrl-C); the run did not complete", file=sys.stderr)
        exit_code = 130
    finally:
        if logging_active:
            try:
                stop_install_logging(exit_code)
            except Exception as exc:
                print(f"fail could not finalize install audit log: {exc}", file=_ORIGINAL_STDERR)
                exit_code = exit_code or 1
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
