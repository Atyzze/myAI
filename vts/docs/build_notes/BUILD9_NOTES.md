# VTS build 9

Build 9 makes the Python runtime deliberately boring and predictable.

Changes:

- pins the VTS runtime to the CPython 3.12.x line via the authoritative
  `PYTHON_VERSION` file;
- `install.py` may be launched by a newer host `python3`, but it only creates and
  operates the VTS virtual environment with Python 3.12.x;
- if a Build 8 `.venv` was created with Python 3.14 (or any other minor), the
  installer recognizes it as incompatible and replaces that managed venv;
- if Python 3.12 is unavailable, installation fails immediately with a clear
  message rather than silently falling back to another interpreter;
- `VTS_PYTHON=/absolute/path/to/python3.12` can select a nonstandard Python 3.12
  installation explicitly;
- all pip installation paths now use `--only-binary=:all:`. VTS will never fall
  back to an sdist and unexpectedly compile NumPy or another dependency locally;
- `pyproject.toml`, verification, tests, and documentation all enforce the fixed
  Python 3.12 runtime contract.

Python 3.12 patch/security updates remain acceptable; moving VTS to another
major/minor interpreter requires an explicit future VTS build and compatibility
review.

Gate: 18 tests passed
