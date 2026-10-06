# Operations

## First install

VTS is deliberately pinned to **CPython 3.12.x**. Patch/security releases inside
the 3.12 line are supported; moving to 3.13, 3.14, or another minor is an explicit
VTS compatibility change. `PYTHON_VERSION` and `.python-version` both state that
contract.

The only host bootstrap dependency is **uv**. Run as the normal account that
should own this checkout:

    python3 install.py

The system `python3` is used only long enough to start the stdlib installer.
For install/update/verify commands, `install.py` automatically re-executes itself
as:

    uv run --no-project --isolated --managed-python --python 3.12 -- python install.py ...

`--no-project` is intentional. A plain `uv run python install.py` discovers
`pyproject.toml` and may begin syncing VTS's large CUDA/runtime dependency set
before the installer itself starts. The automatic bootstrap avoids that and lets
the installer enforce its deployment rules first.

If uv does not already have a suitable CPython 3.12 runtime, uv downloads and
manages it. VTS then creates `.venv` with `uv venv --managed-python --python 3.12`.
There is no requirement for the OS to package `python3.12`.

Runtime dependencies are installed with `uv pip --only-binary :all:`. In uv,
that option already means “use wheels only and do not build source distributions”;
combining it with `--no-build` is invalid in current uv releases. If a dependency
has no compatible wheel, installation fails immediately rather than launching
Meson/GCC or another source build. Build 10 also replaces an older
managed `.venv` if it uses a different Python minor. Downloaded models are
unaffected.

Default deployment is loopback-only on port 4444 **and TLS is required**.
Put `fullchain.pem` and `privkey.pem` beside `server.py`, or configure
`TLS_CERT` / `TLS_KEY` in `server.env`, before starting the managed service.
A new build folder does not contain them: copy both files in from the previous
build before installing. `install` and `update` check that the certificate and
key load and belong together before anything else runs, and `restart` checks
them before restarting the service; when they are missing and an earlier
`vts_build_*` folder nearby has them, the installer prints the `cp -p` command
to copy them in. It never copies key material itself.

For speaker diarization:

    python3 install.py install --with-diarization

Diarization is optional speaker separation. It installs the speaker-embedding
runtime/model used to group segments by voice. It does not identify a real
person by name, and ordinary transcription works without it.

For a dependency/model-only setup with no systemd changes:

    python3 install.py install --no-service

That is the only "non-service" installation mode: assets are prepared, but VTS
is not registered with or kept alive by systemd. It is useful for containers,
development, or manual `server.py` launches.

## TLS and network exposure

Managed VTS requires TLS by default on **every** bind address, including
`127.0.0.1`. Plain HTTP is never enabled merely because the listener is local.

The normal local deployment is:

    python3 install.py

which binds `127.0.0.1:4444` and expects TLS certificate/key material.

If a reverse proxy is in another network namespace or host, bind VTS to the
backend-facing interface. Re-running the installer is idempotent; already healthy
dependencies and model assets are skipped:

    python3 install.py --bind 10.20.30.40

or, for all IPv4 interfaces:

    python3 install.py --bind

Both commands still require TLS. A reverse proxy can and preferably should use
HTTPS for its upstream VTS connection too.

If you intentionally want an unencrypted trusted backend hop, it must be opted
into explicitly:

    python3 install.py --bind 10.20.30.40 --allow-plaintext

or on loopback:

    python3 install.py --allow-plaintext

`--allow-plaintext` changes the VTS listener itself to HTTP. On a TLS-required
listener, a plaintext HTTP client does not reach FastAPI; the TLS handshake
fails and the connection is refused before an HTTP request is processed.

The simplest project-local certificate layout is:

    fullchain.pem
    privkey.pem

`privkey.pem` should normally be mode `0600`. Absolute certificate paths may
instead be configured in `server.env`:

    TLS_CERT=/etc/vts/fullchain.pem
    TLS_KEY=/etc/vts/privkey.pem

The installer owns managed bind/port/TLS policy through `VTS_BIND_HOST`,
`VTS_BIND_PORT`, and `VTS_TLS_ENABLED`; `server.env` cannot silently weaken a
managed TLS-required service. Manual `server.py` launches use `HOST`, `PORT`,
and `TLS_ENABLED`, where TLS also defaults to enabled.

## Changing only service settings

Re-running `python3 install.py` is idempotent. Healthy dependencies and model assets
are detected and skipped; bind/TLS changes rewrite and restart the managed service:

    python3 install.py --bind 192.0.2.10

## Installation audit trail

Installation and update runs are permanently appended to a log inside the VTS
directory, next to `install.py`:

    var/log/install.log

The installer creates the folder when needed and opens the file in append mode as
the installing user; no sudo is used and the system `/var/log` is never touched.
A new log file gets mode `0640`; an existing file keeps its mode. Each physical
line starts with a full UTC RFC3339/ISO-8601 timestamp and carries a per-run
session identifier, which the installer also prints at the start of every run.

A run records both the invocation and the resolved configuration, including:

- raw and parsed installer arguments;
- VTS build, project root, pinned Python runtime and service identity;
- service user, bind address, port, TLS/plaintext policy and timeout;
- diarization/model choices and model repo/revision values;
- the SHA-256 and supported non-secret assignments from `server.env`;
- each external command executed and its stdout/stderr;
- installer messages, confirmations, failures and final exit code.

An interrupted run (Ctrl-C) still records the interrupted command's final output,
a `fail interrupted by operator` line and `event=session_end exit_code=130`.

Recording starts once the installer has re-launched under the pinned uv runtime.
Failures before that point (for example `uv` missing or invalid arguments) are
reported on the console only.

While dependencies install, models download or the installer waits for `/healthz`,
a status line on the terminal shows elapsed time, and for downloads also the size,
percentage and speed. It is redrawn in place and never written to the audit log.

The installer intentionally does not dump arbitrary shell environment variables,
because unrelated credentials/tokens may exist there. PEM contents are never
logged. The audit file therefore answers *how VTS was installed* without turning
the install record into a secret collector.

Typical inspection, from the VTS directory:

    less var/log/install.log
    tail -f var/log/install.log

Each extracted `vts_build_<N>` directory keeps its own log, like its own `.venv/`
and `model/`. `var/` is excluded from release archives and from git.

This is distinct from `journalctl -u vts`, which contains the server's constrained
runtime/request metadata.

Builds 16 and 17 wrote this log to system paths instead (`/var/logs/install.log`
and `/var/log/install.log`). Build 18 neither reads nor removes those files; if
they exist from earlier runs they can be deleted with sudo.

## Verification

Run after deployment changes:

    python3 install.py verify

A failure is a deployment failure, not a cosmetic warning. Fix the failed privacy
invariant before serving recordings.

Source/assets only, without requiring an installed service:

    python3 install.py verify --no-service

## Status and logs

    python3 install.py status
    python3 install.py logs
    python3 install.py logs --follow

The systemd journal is the intended persistent **runtime request** record. The separate
`var/log/install.log` file in the VTS directory records installation/update history only. Request event
lines are deliberately constrained, e.g.:

    event=transcribe ip=192.0.2.10 status=200 bytes=131116 audio_ms=4096 latency_ms=318

Use those fields for abuse analysis/rate-limit policy; do not add transcript text
to make debugging easier.

## Update

    python3 install.py update

This refreshes dependencies according to the checked-in pins and rewrites the
systemd unit. Existing downloaded models are retained by default.

To resolve/download the configured model revisions again:

    python3 install.py update --refresh-models

A complete clean reinstall is explicit and destructive to installed assets:

    python3 install.py install --force

## Configuration

`server.env` is local deployment state and is gitignored. `server.env.example`
documents supported values. The environment file is read after generated unit
defaults, so uncommented values override them.

After an edit:

    python3 install.py restart

For managed bind/TLS/user changes, regenerate the unit explicitly:

    python3 install.py

## Uninstall

    python3 install.py uninstall

Only a unit carrying this installer's management marker is removed. The project
tree, `.venv/`, `model/` and optional `embed/` remain untouched.

## Migrating from the pre-VTS service name

Older installations used `voice-transcribe.service`. When that unit was created by
the legacy VTS installer and explicitly owns the same port requested by the new
`vts.service`, the installer stops and disables the old unit before starting VTS.
Its project files are never removed. An unrelated listener on the requested port is
not touched; installation fails and identifies the port conflict instead.

A health endpoint is accepted only when it identifies itself as the exact VTS build
being installed and advertises the no-retention/RAM-only request contract. This
prevents an old process on the same port from being mistaken for a successful new
deployment.
