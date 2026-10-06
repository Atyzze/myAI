# Releasing VTS

## Build identity

`BUILD_NUMBER` is the single authoritative release number. It contains one
positive integer and is read by both `server.py` and `install.py`. `/healthz`
returns the same value as `build` together with `service: "VTS"`. The release
tool mirrors that number into `pyproject.toml` as `0.0.<build>` so generic Python
tooling sees the same identity without making `pyproject.toml` authoritative.

A build number identifies a shipped source archive, not a development commit.
Every archive that leaves the project consumes a new build number.

`PYTHON_VERSION` independently defines the supported runtime interpreter minor;
`.python-version` mirrors it for uv. Changing either runtime line is a
compatibility change and must be called out explicitly in the corresponding build
note. Normal Python patch/security updates within that minor do not consume a VTS
build by themselves.

## Release command

Before releasing, create the note for the *next* build:

    docs/build_notes/BUILD<N>_NOTES.md

The note must contain the literal token `GATE_RESULT`. Then run:

    python3 tools/package_release.py --output /path/to/releases

The release tool computes `current build + 1`; there is deliberately no option
to choose or reuse a build number manually.

On success it produces:

    VTS<N>.tar.zst
    VTS<N>.tar.zst.sha256

The compression level is Zstandard 10 by default. It can be changed explicitly
for internal testing, but distributed VTS archives should use the default.

## Archive contract

A release contains exactly one top-level directory:

    vts_build_<N>/

Inside it there is exactly one `BUILD_NUMBER`, and its value must be `<N>`.
Archive members may not contain absolute paths, `..`, or symbolic/hard links.

The release allowlist is the source tree minus local/deployment state. In
particular, releases exclude:

- `.git/`, `.venv/`, caches and coverage state;
- downloaded `model/` and `embed/` assets;
- `server.env`;
- `fullchain.pem` and `privkey.pem`;
- release-journal state.

The tar is PAX format with normalized ownership/timestamps and is compressed by
the host `zstd` binary. Before publication the tool decompresses and re-reads the
archive, verifies its structure and build identity, and compares every shipped
file hash to the source tree. Publication uses an atomic rename.

## Gate and rollback

The build number is only earned after the stdlib test suite succeeds and the
archive verifies. The release note's `GATE_RESULT` token is replaced with the
actual test count.

Before changing the build number, the release tool writes `.release_journal.json`
with the previous build and note contents. A normal failure restores both
immediately. If the process is killed, the next release command detects the
journal and restores the interrupted attempt before doing anything else.

Do not repair interrupted releases by editing `BUILD_NUMBER` manually. Fix the
cause and run `tools/package_release.py` again.

## Installing an archive

Extract the archive so its single `vts_build_<N>` directory remains intact. With
`uv` installed on the host, run from inside it:

    python3 install.py

The installer automatically enters uv-managed Python 3.12; the host does not need
a separately installed `python3.12` package. `python3 install.py verify` checks
that the running service reports the same VTS build as the extracted tree.
