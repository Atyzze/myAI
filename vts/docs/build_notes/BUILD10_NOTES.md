# VTS build 10

Build 10 makes uv the authoritative Python bootstrap and environment manager.

Changes:

- `python3 install.py` now automatically re-launches install/update/verify through
  `uv run --no-project --isolated --managed-python --python 3.12`;
- uv automatically acquires a managed CPython 3.12 runtime when the host does not
  provide one, so users no longer need to install a distro `python3.12` package;
- adds `.python-version` with `3.12` so uv and VTS share the same visible runtime
  contract;
- `.venv` creation now uses `uv venv --managed-python --python 3.12`;
- runtime dependencies are installed with `uv pip`; pip is no longer part of the
  installer path;
- `--only-binary :all:` and `--no-build` remain mandatory, so missing wheels fail
  immediately instead of launching Meson/GCC/CMake builds;
- the internal uv bootstrap uses `--no-project` specifically to prevent an eager
  dependency sync before install.py applies its deployment policy;
- verification and documentation now treat uv availability and `.python-version`
  as part of the installation contract.

Gate: 20 tests passed
