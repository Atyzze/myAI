# Releasing

`BUILD_NUMBER` is the build the tree carries: the last one released. The packager makes the next:

```bash
python3 tools/package_release.py                 # strict gate: Radicale and Chromium needed
python3 tools/package_release.py --portable-gate # a suite whose outside tool is missing may skip, and the notes say so
```

1. `docs/build_notes/BUILD<N+1>_NOTES.md` must exist and contain the literal `GATE_RESULT`.
2. The build number moves to N+1 in `BUILD_NUMBER`, `package.json` (`<N>.0.0`), `sw.js`
   (`VERSION = 'v<N>'`, the offline shell's identity) and `index.html` (`myai-calendar-build`).
3. The gate runs (`npm test`: every suite, `artifacts/test-report.json`) and its result replaces
   `GATE_RESULT` in the notes, with how long it took and the slowest suite.
4. `myAI-calendar<N>.zip` is built: exactly the served files (`index.html`, `manifest.webmanifest`,
   `sw.js`, `BUILD_NUMBER`, `assets/`, `src/`) at its top level, each carrying this build's own
   file time (so a caching server can tell two builds apart). It is opened again and compared file
   by file with the tree, then published with its `.sha256` next to it.

Anything that fails, Ctrl-C included, puts the tree back at build N and the notes as they were. An
existing zip for a build number is never overwritten: build numbers are not reused.

On a box, nothing of this is needed: Nix builds the app from the repository (`nix/packages.nix`,
`calendar`), and the box's update manager publishes it to `app/calendar`.

`docs/CHANGELOG.md` gets one line per build.
