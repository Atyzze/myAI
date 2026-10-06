# VTS Build 14

Build 14 makes transport encryption a fail-closed deployment invariant and
clarifies the installer lifecycle vocabulary.

- TLS is now required by default on every VTS listener, including loopback;
- the managed systemd unit always sets `VTS_TLS_ENABLED=1` unless plaintext was
  explicitly requested, so `server.env` cannot silently downgrade the service;
- missing certificate/key material now stops startup instead of falling back to
  HTTP;
- `--allow-plaintext` is the explicit, noisy opt-out for a trusted HTTP hop;
- Build 13's `--behind-proxy` option remains only as a deprecated compatibility
  alias for plaintext permission, because a reverse proxy can use HTTPS upstream;
- `/healthz` now reports `transport_security` as `tls` or `plaintext`;
- installer verification checks the configured transport and, when TLS is
  required, verifies that a plaintext HTTP probe is refused;
- adds `configure-service` for bind/port/TLS/user changes without reinstalling
  dependencies or models; the old `--service-only` spelling is hidden for
  compatibility;
- documentation now distinguishes a managed systemd service from `--no-service`
  asset-only/manual/container installs;
- documentation now explains optional diarization as speaker clustering rather
  than speaker identity recognition;
- reverse-proxy examples use HTTPS to the VTS upstream by default.

Release gate: 36 tests passed.
