# Privacy contract

## Runtime invariant

Recording-derived content is never intentionally persisted by this service.

The `/transcribe` request body is accepted as raw WAV bytes into a bounded
`bytearray`, parsed directly in RAM, converted to a NumPy waveform, transcribed,
and returned. The service has no upload directory, transcript database, backup
flag, retention setting, multipart parser, or application file logger.

Application-owned mutable request/audio/tensor buffers are zeroed on a
best-effort basis when they are no longer needed. This is defense in depth, not
a claim that Python, CUDA, the kernel, TLS libraries, or hardware expose every
copy for deterministic erasure.

## What may persist

The service emits deliberately narrow operational events to stderr. Under the
generated systemd unit, journald receives only:

- timestamp and log level added by the logger/journal;
- source IP, unless `LOG_CLIENT_IP=0`;
- request byte count;
- audio duration;
- HTTP/result status;
- request latency;
- non-content exception class for failures.

This metadata is intentionally useful for abuse detection and rate limiting.
Whether journald itself is volatile or persistent is a host policy decision.

The server does **not** intentionally log:

- audio or encoded request bodies;
- transcript text;
- speaker embeddings;
- uploaded filenames (there are none in the protocol);
- user-agent strings;
- arbitrary request headers;
- language/model output beyond operational capability state.

Model weights, Python packages, source code and TLS keys are ordinary files read
from disk. They are not recording-derived content.

## Host hardening installed by install.py

The generated service includes:

- `MemorySwapMax=0` so the service's anonymous memory is not swapped;
- `LimitCORE=0` so crashes do not produce content-bearing core dumps;
- `ProtectSystem=strict` and no writable project path;
- RAM-backed `/tmp` and `/var/tmp` through `TemporaryFileSystem=`;
- temp/cache environment variables pointed at `/dev/shm/vts`;
- Python bytecode, Hugging Face networking/telemetry and CUDA disk cache disabled;
- Uvicorn access logging disabled;
- `Cache-Control: no-store` on application responses.

`server.py` independently refuses to start if its configured `RAM_TMP_DIR` is
not on a `tmpfs` filesystem.

## Transport confidentiality

VTS requires TLS by default, including on loopback. The generated managed unit
sets `VTS_TLS_ENABLED=1`, so stale local configuration cannot silently downgrade
the service to HTTP. If certificate/key material is unavailable, the server
fails startup rather than falling back to plaintext.

`--allow-plaintext` is the explicit opt-out. When TLS is active, plaintext HTTP
sent to the VTS port is rejected by the TLS layer before FastAPI receives an
HTTP request. A reverse proxy may itself connect to VTS over HTTPS; proxy
presence is not treated as permission to disable VTS TLS.

## Reverse proxies are part of the boundary

A proxy can violate the service's privacy contract before Python ever sees the
request. Nginx, Apache, a load balancer, container runtime or ingress proxy may
buffer request/response bodies to disk by default.

If a proxy is used, configure it to avoid body/temp/cache persistence. A safe
Nginx starting point is in `deploy/nginx.conf.example`.

## Limits of the claim

This project can enforce application and service-manager behavior. It cannot
prove physical zero persistence across firmware, GPU internals, hypervisors,
remote infrastructure or host mechanisms outside the configured service.
Full-disk hibernation, host-wide crash capture, VM snapshots and upstream
network appliances must be handled by the deployment environment if those are
inside the threat model.


## Installer audit data

`install.py install` and `install.py update` append deployment/audit information
to `var/log/install.log` inside the VTS directory. This file contains installation parameters and
installer/subprocess output, not recording audio or transcript content. It is
separate from the VTS service and is never writable by the hardened runtime
service. VTS does not truncate the file; previous installation sessions are
preserved.
