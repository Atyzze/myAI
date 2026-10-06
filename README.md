# myAI Voice Notes

A zero-install, self-hosted voice-note PWA. The browser records and stores notes locally, sends bounded WAV windows to VTS (Voice Transcribe Server) for transcription, and can use an Ollama-compatible service for replies and translation.

## Quick start

Serve this directory over HTTPS or localhost; do not open `index.html` directly because ES modules and service workers require an HTTP origin.

```bash
python3 -m http.server 8080
```

Then open `http://localhost:8080` in a modern browser. The application itself has no npm runtime dependencies.

## Project map

- `index.html`, `manifest.webmanifest`, `sw.js` — application shell and offline cache.
- `src/js/` — browser runtime. It intentionally remains a flat, auditable module set rather than being rearranged into cosmetic directory layers.
- `tests/` — executable compatibility baseline, integrations and mutation guards.
- `docs/` — architecture, storage, privacy, protocols, operations and release mechanics.
- `docs/CHANGELOG.md` — one line per build; `docs/build_notes/` holds detailed release notes.
- `tools/package_release.py` — the only supported release packager.
- `BUILD_NUMBER` — authoritative release build identity.

## Privacy model

Normal browsing intentionally stores recordings and associated text in this browser so interrupted recordings can be recovered. If an ephemeral browser session is wanted, use the browser's Private/Incognito mode rather than an application-specific pseudo-private storage mode.

The VTS transcription boundary is different: the client sends raw `audio/wav` request bodies with browser caching disabled and exposes no server-retention option. VTS is designed to have no recording-content retention capability. See `docs/PRIVACY.md` and `docs/PROTOCOL.md`.

## Silence and gaps

A section the transcription server could not process is retried before it is given up on. What remains is reported once per unbroken run rather than once per minute, and the client measures the audio it sent: a stretch that was simply quiet is reported as no speech detected, while a stretch that carried sound and still failed is reported as unavailable. Silence is a statement about the audio, not a fault, and is not presented as a warning. A server that answers busy (`503` or `429`) is sent fewer sections at once, and a section it turned away waits for one of the transcription's own sections to come back rather than being given up on.

## Live transcript behavior

The live transcript treats model output as revisable evidence. A phrase repeated where two audio windows overlap is retranscribed from the original audio, and the two windows are replaced by what the wider listen heard only when it clearly removes the repeat. Additional languages appear only after sustained sentence-level evidence. The live transcript is saved to the recording every minute. What it never heard, such as a few seconds the server kept failing on, is marked `[not transcribed live]` where it was in the saved transcript; with Auto-transcribe on it is transcribed after the recording, and otherwise the recording offers 📝 Fill gaps, which sends only those parts.

Speaker naming is deliberately confirm-before-apply. When conversation evidence suggests a name, the app shows the suggestion; saying `confirm speaker N` accepts it. There is no numbered "system z" command menu.

## Starting from the clipboard

The 📋 button beside Start Recording begins a recording that carries the clipboard's text as context. A pasted note becomes an ordinary context item on the recording, so it is shown, fed to the AI, exported, retained and deleted on exactly the same terms as context carried over from an earlier recording. Oversized pastes are capped rather than sent whole.

## AI model

Settings contains one AI model selector. The selected Ollama-compatible model is used for both replies and live translation. The default is `qwen3.8:27b`; a model already chosen in this browser takes precedence, and when the server does not have the chosen model the app falls back to one it does have. Build 109 intentionally removed the separate translation-model choice: one model can do both jobs, and sharing it avoids unnecessary model swaps and conflicting configuration. Since Build 119 every request also asks for the same context size, so translation, the preload and ordinary replies never make the server reload the model; only a reply whose prompt does not fit, such as one for a recording of more than about 50 minutes, asks for the larger context. Live transcription with translation boxes loads the model as it starts. Translation speed is measured from the server's own generation time and is shown in the translation box headings, never in the transcript.

## Storage compatibility

Updates never delete stored notes. A schema change only adds the stores and indexes the new layout needs and leaves everything already saved in place; no upgrade path deletes an object store. A newer version that opens while another tab is recording, or still transcribing, waits for that work and starts by itself once it is done. See `docs/STORAGE.md`.

## Testing

The strict compatibility gate is:

```bash
npm test
```

It requires the external integrations declared by the baseline, including Chromium and ffmpeg/ffprobe. Chromium is found without being told where it is: `CHROME_BIN` when it is set, then the newest Chromium that Playwright installed (`PLAYWRIGHT_BROWSERS_PATH`, `~/.cache/ms-playwright` or `/opt/pw-browsers`), then the `PATH` and the usual install locations.

The gate runs the quick suites (unit, contract and static) side by side, one per core. The browser suites then run one after another; on a machine with at least four cores they run side by side, together with the mutation guards on the cores left over. `MYAI_TEST_JOBS` sets the number of cores the gate plans for (1 runs everything one at a time) and `MYAI_MUTATION_WORKERS` the number of mutation workers. A suite's output is printed in one piece when it finishes, the gate ends with each suite's time, slowest first, and `artifacts/baseline-report.json` records the plan, each suite's `durationMs` and the gate's `wallMs`. For diagnostics in an environment where an external integration is unavailable:

```bash
npm run test:portable
```

Portable mode may report a visible skip and is not the normal production release gate.

### Mutation guards

The mutation suite deliberately edits temporary source copies and requires the mapped compatibility tests to reject each defect. The guards are listed in `tests/mutation/guards.mjs`. Before any guard runs, the whole table is checked and every problem is reported at once: an anchor that is missing or not unique, a transform that changes nothing, a guard no contract lists or a listed guard that does not exist. The guards then run in parallel, each worker on its own copy of the tree; a guard whose suite hangs is reported as a timeout, and one whose suite fails for another reason is reported as such, with the end of its output. A behavioral change must update the affected contract, regression test, mutation guard and build notes together; `baseline-contract` checks that every test file runs in the gate and that every guard is caught by a suite its contract names.

## Releasing

Prepare `docs/build_notes/BUILD<N>_NOTES.md` for the next build and leave the literal `GATE_RESULT` marker in it. Then run:

```bash
python3 tools/package_release.py --output /path/to/releases
```

The tool advances the build once, synchronizes `BUILD_NUMBER`, `package.json` and the service-worker shell identity, runs the test gate, inserts its result (with the gate's time and its slowest suite) into the build notes, creates `myAI<N>.tar.zst` at Zstandard level 10, independently verifies the archive and writes a SHA-256 sidecar. The archive and the sidecar are staged in the output folder and published together, or not at all.

See `docs/RELEASING.md` for the full contract.
