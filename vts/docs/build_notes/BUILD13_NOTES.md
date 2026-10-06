# VTS build 13

Build 13 makes network exposure explicit and installer-owned.

- keeps the managed service loopback-only (`127.0.0.1`) by default;
- adds `--bind [ADDRESS]`: `--bind` alone selects `0.0.0.0`, while an explicit
  IPv4/IPv6 address binds only that interface;
- adds `--behind-proxy` as the explicit acknowledgement that a trusted reverse
  proxy terminates TLS before traffic reaches VTS;
- keeps the legacy `--host ADDRESS` spelling accepted for existing automation;
- moves managed bind/port/proxy-TLS choices to installer-owned `VTS_*` runtime
  variables, so stale `server.env` values cannot silently override CLI choices;
- health checks now probe the configured concrete interface and map wildcard
  binds to loopback for local verification;
- `verify` discovers the service's installed bind address rather than assuming
  every VTS instance listens on loopback;
- documents that loopback remains preferred when the proxy shares the same host
  or network namespace, and warns that plaintext backend listeners must be
  firewall-restricted when `--behind-proxy` is used.

Gate: 30 tests passed
