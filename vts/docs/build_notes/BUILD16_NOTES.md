# VTS Build 16

Build 16 adds a mandatory append-only installation audit trail.

- every `install` and `update` run appends to `/var/logs/install.log`;
- creates `/var/logs/` when needed and never truncates/replaces existing install
  history;
- every physical audit line begins with a full UTC RFC3339/ISO-8601 timestamp and
  includes a per-run session ID/source;
- records the original invocation, parsed arguments and the fully resolved
  effective installation parameters, including bind/port, TLS policy, service
  user, diarization choice, model repos/revisions, runtime/build identity and
  timeouts;
- records the supported `server.env` assignments present at install time plus
  the file SHA-256, without logging PEM contents or arbitrary shell environment
  variables;
- records every subprocess command and stdout/stderr, installer output,
  confirmations, failures and final exit code;
- keeps the install audit file separate from VTS runtime request metadata; the
  hardened VTS service itself has no write path to `/var/logs/install.log`;
- adds regression tests for the fixed audit path, ISO timestamp line format,
  append-only `tee -a` sink and effective parameter snapshot.

Release gate: 46 tests passed.
