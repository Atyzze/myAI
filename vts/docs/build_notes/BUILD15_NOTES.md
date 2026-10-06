# VTS Build 15

Build 15 simplifies the installer CLI around the normal idempotent install path.

- `python install.py` remains the normal install/update/configure command;
- `--bind ADDRESS` (and the convenience alias `-bind ADDRESS`) can be supplied
  directly, without a `configure-service` subcommand;
- `--bind` with no address still means `0.0.0.0`, while the default with no bind
  option remains `127.0.0.1`;
- TLS remains mandatory by default for every bind address;
- plaintext remains an explicit opt-out with `--allow-plaintext` (or
  `-allow-plaintext`);
- removes the public `configure-service` and legacy hidden `--service-only`
  installer paths so there is only one configuration/install lifecycle;
- documentation clarifies that repeated installs are idempotent: healthy
  dependencies and model assets are detected and skipped, then the managed
  service is rewritten/restarted as needed;
- documentation clarifies that Whisper supplies transcription while optional
  ECAPA speaker embeddings supply the evidence the browser clusters for speaker
  attribution;
- documents `/healthz` as a non-content-bearing health, identity and privacy
  contract endpoint used by installation/operations checks.

Release gate: 40 tests passed.
