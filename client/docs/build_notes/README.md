# Build notes

`tools/package_release.py` will not package build N until `BUILD<N>_NOTES.md` exists
here and contains `GATE_RESULT`.

Notes accumulate. Nothing in the release workflow deletes them, and nothing should:
they are the per-build record of what changed, what the gate said, and why. Prune them
by hand whenever you feel like it; that is a human decision, not a build step.

Before releasing build N, add a line for build N-1 to `docs/CHANGELOG.md`.
