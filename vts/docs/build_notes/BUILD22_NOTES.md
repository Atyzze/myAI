# VTS Build 22

Build 22 makes the installer check the TLS certificate and key before it
installs or restarts the service, instead of starting a service that exits on
every restart until systemd gives up.

- background: a fresh build folder has no `fullchain.pem` / `privkey.pem`. The
  build 20 and 21 installs ran the full dependency and model install, wrote the
  unit, and then waited while `vts.service` exited on `resolve_tls()` five times
  and hit systemd's start limit; the reason was only visible in
  `install.py logs`. The failed build 20 install was very likely this as well,
  not only the CUDA library clash build 21 fixed;
- `install` and `update` now check TLS first, before `--force` asks for
  confirmation and before any dependency or model work, unless `--no-service` or
  `--allow-plaintext` is used;
- the check resolves the files exactly as `server.py` does (`TLS_CERT` /
  `TLS_KEY` from `server.env`, relative paths from the VTS folder, otherwise the
  files beside `server.py`) and loads them with the stdlib `ssl` loader Uvicorn
  uses, so it catches missing or unreadable files, invalid PEM, a
  passphrase-protected key (without prompting) and a key that does not belong to
  the certificate;
- when the files are missing and an earlier `vts_build_*` folder next to this
  one or one level up holds both, the error prints the `cp -p` command for the
  newest of them. The installer never copies key material itself, so each build
  folder stays self-contained;
- an expired certificate, or one expiring within 14 days, gives a warning;
- `restart` runs the same check before `systemctl restart` when TLS is on, and
  `verify` lists it as "TLS certificate and key";
- messages name paths and ssl error reasons only, never file contents;
- tests use embedded throwaway self-signed EC fixtures and cover each failure,
  the build folder hint, the no-copy guarantee, the check order in `install`,
  and the `--no-service` / `--allow-plaintext` exemptions.

Release gate: 92 tests passed.
