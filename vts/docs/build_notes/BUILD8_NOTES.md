# VTS build 8

Build 8 establishes the VTS (Voice Transcribe Server) project identity and the
release/build-number contract.

Changes:

- rebranded the project and default systemd service from the generic
  `voice-transcribe` name to `VTS` / `vts`;
- added a single authoritative `BUILD_NUMBER` file;
- exposed the VTS build identity from `/healthz` and deployment verification;
- added `tools/package_release.py` as the only supported archive producer;
- release archives use exactly one `vts_build_<N>` top-level directory and are
  named `VTS<N>.tar.zst`;
- every shipped archive advances the build number by one;
- release archives are PAX tar files compressed with Zstandard level 10;
- release packaging excludes local state, models, virtualenvs, caches, TLS keys,
  `server.env`, and other deployment secrets/assets;
- release packaging runs the complete stdlib test gate, validates build identity,
  verifies archive structure and contents, and writes a SHA-256 sidecar;
- a release journal restores the previous build identity on a failed/interrupted
  release attempt when the next release command starts.

Gate: 14 tests passed
