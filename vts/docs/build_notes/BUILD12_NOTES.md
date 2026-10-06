# VTS build 12

Build 12 fixes legacy-service collisions during the VTS rename/migration.

- detects the installer-managed legacy `voice-transcribe.service` when it is still
  active on the requested VTS port and stops/disables it before installing
  `vts.service`;
- refuses to touch an unrelated/unmanaged service merely because it has a similar
  name;
- fails before deployment when the requested port is already owned by an unknown
  listener;
- `/healthz` is no longer considered healthy merely because it returns
  `{"status":"ready"}`: the installer requires the exact VTS service identity,
  current build number, retention-disabled contract and RAM-only request-payload
  contract;
- a legacy or foreign health response now fails immediately with a diagnostic
  instead of being accepted and only failing later in verification;
- deployment verification also confirms the active systemd unit points at the
  current extracted project directory and `server.py`;
- adds regression tests using the exact shape of the pre-VTS legacy health response
  seen during Build 11 installation.

Gate: 24 tests passed
