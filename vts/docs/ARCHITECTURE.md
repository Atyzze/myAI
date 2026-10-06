# Architecture

The service stays deliberately small so its content-handling path is auditable.

    browser/client
        |
        | raw PCM WAV body
        v
    Uvicorn / ASGI
        |
        | request.stream()
        v
    bounded bytearray in RAM
        |
        | direct RIFF/PCM parser
        v
    float32 NumPy waveform in RAM
        |                         \
        | Whisper                  \ optional ECAPA speaker embedding
        v                           v
    timed text segments + speaker vectors
        |
        v
    JSON response, Cache-Control: no-store

There is intentionally no `UploadFile`, multipart form parser, tempfile-based
media decoder, database, upload directory, transcript cache or backup subsystem.

## Why keep FastAPI/Uvicorn?

The privacy problem was not ASGI or FastAPI itself. The old persistence risk came
from using multipart `UploadFile`, whose implementation can spool sufficiently
large bodies to temporary files. The current endpoint uses `Request.stream()`
and owns the bounded in-memory buffer directly, retaining mature HTTP/TLS/server
code without rebuilding a web server from sockets.

## WAV parsing

The client already emits a known PCM WAV format. The server parses RIFF chunks
directly and rejects every other format. This avoids invoking FFmpeg/PyAV for the
request path and removes another source of opaque temp/cache behavior.

## Speaker attribution

Speaker embeddings remain optional. The service loads the local SpeechBrain ECAPA
network directly and returns per-segment vectors. The browser can cluster those
vectors over time; the server does not retain speaker state between requests.

## Logging

Application logging goes to stderr only. systemd sends it to journald. The server
formats its own request events and never gives arbitrary request/header/model text
to the operational log. Uvicorn's access log is disabled to avoid a second log
surface with different policy.

## Filesystem model

At runtime the service needs to read:

- `server.py` and its virtualenv;
- the Whisper model;
- optional embedding model;
- TLS certificate/key by default; plaintext is an explicit deployment opt-out.

It does not need an ordinary writable filesystem. The generated systemd unit
therefore mounts the normal filesystem read-only to the service and provides
RAM-backed temporary locations.

## Build identity

`BUILD_NUMBER` is the release identity. VTS reads it at startup and publishes it
through `/healthz`; `install.py verify` requires the live service to match the
source tree. Release packaging is described in `docs/RELEASING.md`.

## Runtime baseline

VTS deliberately targets one interpreter line: **CPython 3.12.x**. Interpreter
minor upgrades are compatibility events that require an explicit future VTS
build; they are not routine deployment churn. `PYTHON_VERSION` and
`.python-version` state the same contract.

`uv` owns interpreter acquisition and environment creation. The installer
re-executes runtime-sensitive commands through a managed Python 3.12 using
`uv run --no-project`, then creates the persistent `.venv` with `uv venv`.
Dependencies are installed with `uv pip` in wheel-only/no-build mode, so compiling
third-party Python packages is outside the supported deployment model.

### Whisper versus speaker attribution

Whisper/faster-whisper is the transcription engine in VTS; this deployment does
not obtain speaker identities or speaker labels from Whisper. When diarization is
enabled, VTS computes an ECAPA voice embedding for eligible speech segments and
returns that vector with the segment. The browser's diarization code clusters
those vectors over time and assigns its own speaker identities. Without the
optional embedding model, transcription still works but the browser has no voice
vectors to cluster into speakers.
