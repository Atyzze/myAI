# myAI

A zero-install browser PWA for recording voice notes, transcribing them, and generating AI replies. Audio and text are stored in IndexedDB. All AI work is sent through same-origin reverse-proxy routes connected to self-hosted services you control; no browser models or third-party model CDNs are used.

This front end accompanies **Sovereign Stack, Volume 1: Home Node**: https://github.com/Atyzze/sovereign-stack

## Main capabilities

- WAV or Opus recording with an always-visible top-right effective-codec indicator, live waveform, one integrated green LIVE card, timer, playback, periodic durable fragment writes, and visible fatal-error shutdown.
- Global cross-tab recording exclusion, heartbeat ownership, and per-session fragment isolation.
- Crash-safe finalization of interrupted active recordings.
- Desktop-seekable WebM/Opus downloads with finite duration, Segment metadata, SeekHead, and Cluster cues.
- Bounded long-session WAV and WebM/Opus transcription.
- Server-based Whisper transcription in overlapping timestamped chunks, with up to 10 requests in flight.
- Streamed replies from a self-hosted Ollama-compatible endpoint, with the model resolved against the installed list before sending.
- Live transcript and reply views that render in page on touch devices and as a popup on desktop, reporting characters, tokens, throughput and the answering model as they stream.
- Context chaining between recordings.
- Installable offline application shell.
- Storage reporting, exports, selective deletion, and keyboard-operable controls.
- Persistent-origin storage requests and finalization headroom checks for safer long recordings.

## Privacy and security boundary

Recordings and generated text are stored in this browser, while AI inputs are processed by the configured self-hosted services.

- **Transcription:** audio chunks are sent to the same-origin `/transcribe` service. The optional server-backup setting is off by default; compatible servers receive an explicit `store_backup` Boolean for each chunk.
- **Replies:** transcript, selected context, and AI instructions are sent to the same-origin `/ollama` service.
- **Browser runtime:** no Transformers.js bundle, Hugging Face model files, browser inference worker, or model cache is shipped.

The application asks for one first-use acknowledgement before server AI processing. Clearing site data resets that decision.

This repository contains no backend, user-account system, or multi-tenant isolation. Treat its browser origin as sensitive storage. Do not expose the app or AI routes using only an obscure URL.

A production deployment should provide:

- HTTPS and HSTS.
- Authentication and authorization.
- Request, rate, concurrency, and body-size limits.
- Connection, first-byte, idle, and total timeouts.
- Origin/CSRF controls appropriate to the authentication method.
- Logs that do not retain raw audio, transcripts, prompts, credentials, or private endpoint URLs.
- `Cache-Control: no-cache` for `sw.js`.

Recommended response headers:

```text
Content-Security-Policy: use the policy documented in index.html
X-Frame-Options: DENY
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
Permissions-Policy: microphone=(self), camera=(), geolocation=()
Strict-Transport-Security: max-age=31536000; includeSubDomains
```

Add `frame-ancestors 'none'` to the HTTP CSP header. It is not effective inside a meta CSP.

Report security issues through the repository's private GitHub security-advisory feature when available. Never attach real recordings, transcripts, tokens, or private endpoints to a public issue.

## Backend routes

The browser expects fixed same-origin paths:

- `POST /transcribe` for audio transcription. The multipart request includes `file`, optional `language`, and explicit `store_backup=true|false`.
- `GET /ollama/api/tags` for model discovery.
- `POST /ollama/api/generate` for streamed replies.

Change `CONFIG.TRANSCRIBE_URL` and `CONFIG.OLLAMA_URL` in `src/js/config.js` only when the reverse proxy uses different paths. The service worker explicitly excludes API routes from caching.

The reply model is a soft default (`gemma4:e4b`), not a requirement. Before generating, the reply path checks the configured model against `/api/tags` and keeps an explicit choice that still exists, otherwise falling back to the default, then to another size of the same model family, then to any installed model. The resolved name is written back to the setting, so a profile that has never opened Settings still gets a working reply and the picker never displays a model the app would not use.

Replies render as plain text, so `set-ai-instructions` ships with a default asking for Unicode symbols and light structure instead of LaTeX and heavy Markdown. Replace it with anything you like; emptying the box restores it.

The supplied faster-whisper server exposes the expected response shape, derives its worker/executor concurrency from `transcription.parallel_jobs`, and honors the per-request backup field when request overrides are enabled. The browser keeps at most ten transcription chunks in flight per recording.

## Recording safety

Only one tab may capture or finalize audio at a time. The application uses an exclusive Web Lock where available and a verified shared-storage lease as a fallback. Every recording and durable fragment carries an independent session ID. Fragment rows use auto-increment primary keys plus a unique `(recording ID, session ID, sequence)` index, so matching sequence numbers from separate sessions cannot overwrite one another.

Other tabs show `LIVE · OTHER TAB`, mirror the protected live row, and refuse to create a second stream. If the owner crashes, its lease expires after the configured stale interval and interrupted-recording finalization may proceed.

Any microphone, encoder, or fragment-write failure is fatal to the active capture. The microphone is stopped immediately, the green LIVE state changes to `ERROR · STOPPING`, the record button is disabled, and the normal stop/finalization path runs automatically. A failed fragment remains in memory until a verified retry. If it still cannot be committed, the browser copy is marked incomplete and the app offers a complete in-memory recovery download before that memory is released. Messages distinguish previously committed audio from uncommitted recent segments; the app never claims the newest segment was saved without confirmation.

Before creating a finalized master blob, the app checks the browser's estimated free origin storage because finalization temporarily needs both the durable fragments and the master copy. If there is not enough headroom, the fragments are kept for recovery instead of risking a destructive partial transition. Starting a recording also requests persistent origin storage from the record-button gesture. A grant reduces automatic eviction risk but does not replace downloading permanent backups.

## Opus duration, seeking, and long transcription

Chromium MediaRecorder commonly emits WebM in live-stream form with an unknown Segment size and no useful Duration or Cues. Browsers may play that stream while VLC or mpv-based players report no total duration or seeker.

myAI performs a container-only remux when a WebM/Opus recording is finalized. It writes a finite Segment, Duration, SeekHead, and one CuePoint per Cluster. Compressed Opus packets are copied unchanged; audio is not decoded or re-encoded. Older valid WebM recordings are upgraded lazily on download.

Long WebM/Opus transcription does not decode the complete recording. The container is indexed once, then each transcription window is assembled from only the overlapping Clusters, timestamp-rebased, decoded, uploaded, and released. There is no arbitrary 20-minute cutoff. WAV transcription similarly reads and resamples bounded ranges. Server transcription eagerly fills a 10-request worker pool, or the total chunk count when fewer than ten exist.

Ogg and unusual compressed formats use the browser's whole-file decoder fallback because they do not expose WebM Cluster structure. Browser WAV-to-Opus conversion remains limited because it is a separate real-time decode/re-encode operation.

## Repository layout

Production code and test infrastructure are intentionally separated:

```text
assets/                       PWA icons
src/js/                       browser application modules
tests/
   unit/                      deterministic unit and static checks
   integration/               multi-realm, browser, and ffmpeg tests
   mutation/                  controlled regression mutations
   helpers/                   baseline runner support
   fixtures/                  browser/worker fixtures
   baseline-contract.json     machine-readable compatibility contract
   run-baseline.mjs           strict release test runner
index.html
manifest.webmanifest
sw.js                         offline shell and the single version declaration
```

`src/` contains only code shipped to the browser. All tests and test-only runners live under the single root `tests/` directory. There is no separate `scripts/` directory.

The PWA uses two icon files, not three duplicate designs:

- `assets/icon-192.png` for compact installation contexts.
- `assets/icon-512.png` for both regular and maskable installation contexts.

The 512px design includes a mask-safe inset so one file can serve both purposes.

## Architecture

The project uses vanilla JavaScript ES modules with no bundler and no installed npm dependencies. The browser client loads only same-origin application code and sends AI requests to the configured server routes.

- `src/js/recorder.js` and `audio.js`: capture, durable fragments, finalization, encoding, and bounded WAV reads.
- `src/js/webm-duration.js`: WebM remuxing, Cluster indexing, and finite decode-window assembly.
- `src/js/recording-lock.js`: global Web Lock plus verified localStorage fallback.
- `src/js/transcribe.js` and `transcribe-core.js`: cancellable transcription and timeline assembly.
- `src/js/reply.js` and `reply-core.js`: server streaming, prompt budgeting, and timeouts.
- `src/js/jobs.js`: identity-safe cancellation registry.
- `src/js/db.js` and `idb-min.js`: IndexedDB access and atomic read-modify-write operations.
- `src/js/live-tabs.js`, `live-view.js`, `live-inline.js`, `live-render.js`: live transcript/reply registries, the popup and in-page views, and their shared rendering.
- `src/js/gui.js`: rendering, delegated actions, paging, playback, downloads, and conversion.
- `sw.js`: atomic shell installation and explicit cache routing.

The delegated action router allows the script CSP to omit `'unsafe-inline'`.

## Running locally

Serve the repository root over HTTPS or localhost. Do not open `index.html` directly as a file because ES modules and service workers require an HTTP origin.

```bash
python3 -m http.server 8080
```

Open `http://localhost:8080` in a modern browser. Microphone, AudioWorklet, MediaRecorder, IndexedDB, and service-worker behavior varies by browser; test the intended device before relying on it for important recordings.

## Versioning

The application version is written in exactly one place: `const VERSION` at the top of `sw.js`.

Two properties make that the only correct home. The service worker's own bytes are what the browser compares on every update check, so a version declared anywhere else could change without any update happening at all; and it names the cache that serves every module, so it is the only value that can honestly answer which build is on screen. A constant compiled into the application is itself served cache-first, so a stale shell keeps reporting a build nobody is running - precisely the failure the label in the corner of the interface is checked to rule out.

The label asks the active worker for that value at runtime (`src/js/version.js`) and repaints when a new worker takes over. When no worker serves the page it reads `dev` rather than guessing a number.

Releasing:

```bash
# 1. bump the single declaration
#    sw.js:  const VERSION = 'v35';
# 2. carry it into package.json
npm run version:sync
# 3. the gate fails if any second copy exists anywhere
npm test
```

## Compatibility baseline

The release baseline is executable and machine-readable:

```bash
npm test
```

Strict mode runs every required unit, contract, static, multi-tab, ffmpeg/ffprobe, real-Chromium, and mutation suite. Missing tools, skips, missing result markers, failed assertions, source-tree changes during tests, and surviving mutations all fail the command. A machine-readable report is written to `artifacts/baseline-report.json`.

For local diagnostics on a machine without Chromium or ffmpeg:

```bash
npm run test:portable
```

Portable mode may visibly skip unavailable external integrations and is not a release gate. Narrower commands include `npm run test:unit`, `npm run test:integration`, and `npm run test:mutation`.

The exact contracts and future acceptance criteria live in `tests/baseline-contract.json`. Current protected behavior includes:

| Contract | Protected behavior |
|---|---|
| `REC-LOCK-001` | One global recording/finalization owner across tabs. |
| `REC-SESSION-001` | Fragment identity includes recording, session, and sequence. |
| `REC-LIVE-001` | One integrated green live row with synchronized other-tab state. |
| `REC-LIFECYCLE-001` | Start, durable flush, stop, playback, and deletion. |
| `REC-FAILSAFE-001` | Capture failures stop visibly, retain uncommitted fragments, and never overstate saved audio. |
| `UI-AUDIO-STORAGE-001` | Saved audio, remaining browser quota, and audio fullness use stable two-decimal units. |
| `OPUS-SEEK-001` | Finite desktop-readable duration and seeking. |
| `OPUS-TRANSCRIBE-001` | Long WebM/Opus transcription through finite decode windows. |
| `JOB-RACE-001` | Stale jobs cannot unregister replacements. |
| `SW-CACHE-001` | Atomic offline updates and no API caching. |
| `SEC-RELEASE-001` | CSP, server-only module graph, and shell integrity. |
| `AI-BOUNDARY-001` | Explicit chunking and prompt bounds. |
| `SERVER-POOL-001` | Server transcription fills and respects a 10-request concurrency pool. |
| `SERVER-BACKUP-001` | Server backup retention is explicit, persistent, and off by default. |
| `LIVE-VIEW-001` | Live transcript and reply views render under the shipped CSP. |
| `LIVE-STREAM-002` | Re-initialising a live stream never orphans an attached view. |
| `TEST-HARNESS-001` | The release harness is executable and its coverage is declared. |
| `AI-STREAM-001` | Streamed replies survive arbitrary network framing. |
| `SW-ROUTE-002` | Proxied service routes are excluded from the cache exactly as configured. |
| `UI-LIVE-STATUS-001` | The live-status bar is operable and announced without a pointer. |
| `DB-DURABILITY-001` | A resolved write means the IndexedDB transaction committed. |
| `REC-WAKELOCK-001` | The screen wake lock survives the tab being backgrounded. |
| `AI-PIPELINE-001` | Automatic transcription and reply run end to end. |
| `UI-HELP-001` | The guide overlay opens, closes and returns focus. |
| `TEST-BASELINE-001` | The compatibility contract itself remains executable. |

### Mutation guards

The mutation suite edits temporary copies and requires the mapped tests to catch deliberate defects. It currently covers lock split-brain, fallback lease verification, session-index removal, WAV corruption, WebM passthrough, disabled Opus windowing, API caching, stale job cleanup, capture errors that continue recording, permissive skip handling, invalid contract mapping, inline popup script, unbounded popup waits, live-stream re-initialisation, a syntactically broken browser-evaluated expression, a module missing from the offline shell, broken NDJSON reply framing, a service route excluded only by prefix, a pointer-only live-status control, a write that resolves before its transaction commits, and a wake lock that is never re-acquired after the tab is backgrounded.

A deliberate behavioral change must update the machine-readable contract, affected tests, mutation guards, and the release notes below in the same review. Weakening a test only to make a change pass is itself a baseline change.

Predefined future gates include forced-tab crash recovery, mobile suspension, historical database migrations, deletion during AI work, browser-vendor Opus fixtures, actual-browser service-worker rollback, long-session memory ceilings, and keyboard/focus accessibility.
