# VTS — Voice Transcribe Server

VTS is a small, privacy-oriented GPU transcription service built around
faster-whisper. The runtime stays intentionally compact: `server.py` is the
service; `install.py` owns host setup and operation; `docs/` states the contracts
around them.

The current release identity is the integer in `BUILD_NUMBER`. `/healthz`, the
installer and release archives all expose the same build number. `pyproject.toml`
mirrors it as `0.0.<build>` for tooling; `BUILD_NUMBER` remains authoritative.

**Start here:**

    docs/PRIVACY.md       what is and is not persisted
    docs/PROTOCOL.md      HTTP request/response contract
    docs/OPERATIONS.md    install, update, verify, logs, recovery
    docs/ARCHITECTURE.md  runtime/data-flow design
    docs/RELEASING.md     build numbers and release archive contract

## Install

Run this as the normal Unix user that should own the model and virtualenv:

    python3 install.py

VTS deliberately standardizes its runtime on **CPython 3.12.x**, managed by
`uv`. The command above may start under whatever system `python3` happens to be;
`install.py` immediately re-launches itself through `uv run --no-project` with
managed Python 3.12. `uv` downloads that interpreter automatically when needed,
then creates the permanent `.venv` with the same Python line. Runtime packages
are installed through `uv pip` from wheels only; source builds are forbidden.

In other words, **do not install Python 3.12 manually just for VTS**. The only
bootstrap dependency is `uv` itself. Running `python3 install.py` is preferred
over a plain `uv run python install.py`, because VTS's internal `--no-project`
bootstrap avoids an eager project sync before the installer applies its own
wheel-only policy.

Before the managed service can start, provide `fullchain.pem` and `privkey.pem`
beside `server.py` (or configure `TLS_CERT` / `TLS_KEY`). TLS is mandatory by
default; use `--allow-plaintext` only when you deliberately accept an HTTP hop.

That creates `.venv/`, installs the pinned runtime dependencies, downloads the
Whisper model, writes a hardened `vts.service`, starts it, waits for `/healthz`,
and runs the privacy/deployment verification.

Speaker diarization is optional:

    python3 install.py --with-diarization

Diarization does not identify people by name. It installs the speaker-embedding
model/dependencies that let the client cluster transcript segments by distinct
voices (for example Speaker 1 / Speaker 2). Transcription works without it.

`./install.sh` remains only as a compatibility shim to `python3 install.py`.
There is no shell installer logic to keep in sync.

## Installation audit log

Every `install` or `update` run is audit-logged to **`var/log/install.log`** inside
the VTS directory, next to `install.py`. The installer creates the folder when
needed and writes the file as your normal user, so no sudo is involved and nothing
is written to the system `/var/log`. It only appends; it never truncates or
rewrites prior installation history. Every run prints the log path and its session
ID near the top of its output, and every physical log line begins with a UTC
RFC3339/ISO-8601 timestamp such as `2026-09-15T15:14:35.123Z`.

Each installation session records a unique session ID, the original command-line
arguments, parsed arguments, resolved/effective installation parameters, project
build/root/runtime, bind address and port, TLS/plaintext policy, service user,
diarization choice, model repositories/revisions, supported `server.env`
assignments plus its SHA-256, every subprocess command, subprocess output,
installer output, confirmations, failures, and the final exit code. Arbitrary
process-environment variables are deliberately **not** dumped, so unrelated
tokens/secrets in the calling shell are not copied into the audit file. An
interrupted run (Ctrl-C) is still recorded, including the interrupted command's
final output and `exit_code=130`.

Inspect it from the VTS directory with:

    less var/log/install.log
    tail -f var/log/install.log

Each extracted build directory keeps its own log, like its own `.venv/` and
`model/`; release archives never include `var/`.

The VTS runtime service does not write this file; it remains separate from the
request-metadata journal described below.

## Verify

    python3 install.py verify

Verification checks the deployment invariants rather than merely checking that
the process answered HTTP: `/dev/shm` must be tmpfs, the runtime source must not
contain the old multipart/retention path, systemd must disable swap and core
dumps for the service, the filesystem must be read-only to it, and `/healthz`
must advertise the same VTS build plus memory-only request processing and no
retention.

## Operate

    python3 install.py status
    python3 install.py logs
    python3 install.py logs --follow
    python3 install.py restart
    python3 install.py update
    python3 install.py uninstall

The journal intentionally contains only operational metadata emitted by
`server.py`: source IP (unless disabled), request size, audio duration, status,
latency, and non-content error class. It is the intended place to inspect abuse
and build external rate-limiting rules. Audio, transcript text and speaker
embeddings are not logged.

## API in one screen

    POST /transcribe
    Content-Type: audio/wav
    X-Transcription-Language: en     # optional

The body is raw 16 kHz, mono, signed 16-bit little-endian PCM WAV. It is **not**
`multipart/form-data`. The default body limit is 8 MiB. Responses use
`Cache-Control: no-store`.

Example with the default TLS-required transport:

    curl -k --data-binary @sample.wav \
      -H 'Content-Type: audio/wav' \
      https://127.0.0.1:4444/transcribe

See `docs/PROTOCOL.md` before changing the client/server wire format.

TLS is required by default, even on loopback. `server.py` looks for
`fullchain.pem` and `privkey.pem` beside itself, or absolute `TLS_CERT` /
`TLS_KEY` paths from `server.env`. Plain HTTP exists only as an explicit
`--allow-plaintext` deployment choice.

A reverse proxy does not require plaintext upstream: the preferred arrangement
is HTTPS from the client to the proxy and HTTPS again from the proxy to VTS. Use
`--allow-plaintext` only when you intentionally accept an unencrypted trusted
backend hop.

## Releasing

`tools/package_release.py` is the only supported way to produce a release
archive:

    python3 tools/package_release.py --output /path/to/releases

Every archive advances `BUILD_NUMBER` once. If the current build is 8, the next
successful archive is `VTS9.tar.zst`; build numbers are never reused. The tool
runs the test gate, updates the matching build note, creates a PAX tar with one
`vts_build_<N>` top-level directory, compresses it with Zstandard level 10,
verifies the archive byte-for-byte against the allowed source tree, and writes a
SHA-256 sidecar. Local models, virtualenvs, caches, `server.env`, and PEM files
are never included.

See `docs/RELEASING.md` for the complete contract.

## Repository layout

    BUILD_NUMBER                    authoritative build identity
    PYTHON_VERSION                  authoritative runtime Python minor (3.12)
    .python-version                 uv mirror of the runtime Python line
    server.py                       complete runtime implementation
    install.py                      host lifecycle and verification
    install.sh                      compatibility shim only
    pyproject.toml                  project/dependency declaration
    requirements.txt                deployment pins
    requirements-diarization.txt    optional speaker-model dependencies
    server.env.example              runtime configuration reference

    docs/ARCHITECTURE.md
    docs/PRIVACY.md
    docs/PROTOCOL.md
    docs/OPERATIONS.md
    docs/RELEASING.md
    docs/build_notes/               one immutable history note per release

    tools/package_release.py        gated build/archive producer
    deploy/nginx.conf.example       safe reverse-proxy starting point
    tests/                           stdlib static/contract tests

    model/                           installed asset; not shipped
    embed/                           optional installed asset; not shipped
    .venv/                           installed environment; not shipped

The project is intentionally not decomposed into a package tree just for the
sake of structure. For VTS, having the complete request path visible in one
`server.py` makes the no-retention property easier to audit.


## Network binding and TLS

VTS binds to `127.0.0.1` by default and requires TLS by default. Use `--bind [ADDRESS]` directly on the normal installer; no address means `0.0.0.0`. The alias `-bind` is also accepted.

After the first install, change only service/network policy without reinstalling
models or Python packages:

    python3 install.py --bind 10.20.30.40

That remains TLS-only. To consciously permit HTTP instead:

    python3 install.py --bind 10.20.30.40 --allow-plaintext

`--allow-plaintext` is the exception, not the default.
