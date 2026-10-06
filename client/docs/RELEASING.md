# Releasing

`BUILD_NUMBER` is the release source of truth. The release tool synchronizes its mirrors:

- `package.json` uses `<build>.0.0`;
- `sw.js` uses `v<build>` for the actual service-worker shell/cache identity.

The service worker remains runtime truth about what shell a browser is currently using; `BUILD_NUMBER` is source/release truth.

## Build notes are mandatory

Every new packaged build must have `docs/build_notes/BUILD<N>_NOTES.md` before the build number can be earned. The note must contain the literal `GATE_RESULT`. The release tool replaces that marker with the actual test-gate result only after the gate succeeds.

Legacy release notes present in the pre-85 README were split into individual files for Builds 37–84. Build 85 onward is mechanically enforced.

## Create the next release

```bash
python3 tools/package_release.py --output /path/to/releases
```

The default gate is strict `npm test`. The packager then produces:

```text
myAI<N>.tar.zst
myAI<N>.tar.zst.sha256
```

The archive uses Zstandard level 10 and contains one top-level directory named `myai_build_<N>/`.

A constrained development environment may use `--portable-gate`; this records the portable/skipped result explicitly in the build note and should not be confused with the normal production gate.

The release archive excludes `.git`, `node_modules`, generated `artifacts/`, editor state and release-journal state. The finished archive is independently decompressed and compared byte-for-byte against the staged source manifest before publication.

The archive and its `.sha256` sidecar are both written in a hidden staging folder inside the output folder, so moving them into place cannot fail for being on another disk, and they are moved in together: if the second move fails, the first is taken back, so a half-published build cannot block the next release with "output already exists". Stopping a release with Ctrl-C restores the tree to the previous build, as any other failure does, and says so without a traceback.

The line that replaces `GATE_RESULT` records how long the gate took and its slowest suite, for example `18 suites passed (strict gate) in 4 min 34 s; slowest user-journeys (2 min 00 s)`.
