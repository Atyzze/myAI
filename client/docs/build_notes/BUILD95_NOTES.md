# myAI Build 95

Build 95 makes switching the reply model reliable. No storage format change. The `/ollama` protocol gains two calls the client did not use before, `GET /api/ps` and an empty-prompt `POST /api/generate`; both are standard Ollama and neither carries recording content. The transcription boundary is untouched.

## What was wrong

A reply resolved its model and then posted `/api/generate` with a 45 second budget on the response headers. An Ollama-compatible server does not send those headers until the runner for that model is up, so that 45 seconds was being spent loading a model, not waiting for a network. A model whose weights are still warm in the host's page cache comes up inside the budget; the same model after another model has displaced it does not, and a large model on a machine that can hold only one is exactly the case where it will not.

What made it stick rather than recover: on expiry the client aborted the request, the server saw the client disconnect and dropped the scheduled load, and the next attempt started from nothing and failed at the same 45 seconds. The user-visible result was that switching models worked once and then produced timeouts indefinitely, as though the server were refusing to load anything further.

The client also had no way to tell "this server is loading a large model" from "this server is not answering", and reported both as `Reply server did not respond within 45 seconds.`

## The preflight

A reply now establishes that its model is loaded before it asks the model for anything. `ensureModelReady` in `src/js/reply.js`, decided by `src/js/model-ready-core.js`:

1. `GET /api/ps`. If the wanted model is already resident, that is the whole preflight, and a warm switch costs one small request.
2. Otherwise `POST /api/generate` with an empty prompt, which is Ollama's load call: it brings the model up and returns without generating. This request is given `CONFIG.MODEL_LOAD_BUDGET_MS`, ten minutes, and is never aborted early.
3. While it runs, `/api/ps` is polled every `CONFIG.MODEL_PROBE_MS`, three seconds. Each answer is evidence the server is alive and resets the failure count; `MODEL_PROBE_FAILURES_BEFORE_UNREACHABLE` consecutive failures, about twelve seconds of silence, ends the wait as unreachable. A single missed probe is a blip, not a dead server.
4. If after `CONFIG.MODEL_SWAP_GRACE_MS`, ninety seconds, the wanted model is still not resident and another model still is, the models in the way are released with `keep_alive: 0` and the wait continues. This is an escalation, not the opening move: a machine with room for both is never made to unload anything, and only a swap the server has not managed on its own is helped along. It happens once per preflight, and the model being loaded is never the one released.
5. The real streaming request then runs under the ordinary 45 second first-byte budget, which now measures only what it was meant to measure.

Progress is reported throughout, so the wait reads as `Loading qwen3.8:27b on the server, replacing gemma4:e4b (1m 30s)...` rather than as silence followed by a timeout. A load that genuinely never completes now says the server is answering and is not offline, and says how long it waited, which is a different diagnosis pointing at a different fix.

## Keeping a loaded model loaded

Reply requests carry `keep_alive: '30m'`. Switching back to a model used in the last half hour now finds it resident and skips the load entirely, which is the ping-pong case that prompted this work. Nothing pins memory that the server needs: it still evicts under pressure exactly as before.

## One retry, and only where it means something

If a model that the preflight confirmed resident then produces nothing within the first-byte budget, it was evicted between the check and the request, most likely by a translation using a different model. That case is retried once, after a fresh preflight. Where no preflight ran, because the server has no `/api/ps`, nothing is retried: retrying there would only double the wait. A cancelled job is never retried.

## Translation

Live translation preflights the same way with a sixty second budget and a twenty second grace, and falls through to the ordinary request on failure. A live transcript must not stall for ten minutes behind a model that will not load, and the existing translation backoff still applies.

## Stale choices

Changing the reply or translation model in Settings now drops the cached tag list, the resolved reply model, the resolved translation model and the readiness cache, both on the control's change event and on closing the panel. Previously a cache could outlive the choice that produced it.

## Where a server without /api/ps lands

If the preflight cannot read `/api/ps` at all, `ensureModelReady` reports that it could not establish readiness and the reply proceeds exactly as it did in build 94, timeout message included. The preflight adds a path; it does not remove the old one.

## Contracts

`REPLY-MODEL-002` is new: loading a model is waited out under supervision, and is never reported as a server that did not respond. Suites `pure`, `static-integrity`, `browser-lifecycle`; guards `MUT-MODEL-RESIDENT-IGNORED`, `MUT-MODEL-SWAP-NEVER-HELPED`, `MUT-MODEL-BLIP-READ-AS-DEATH`, `MUT-MODEL-RETRY-WITHOUT-PREFLIGHT`, `MUT-MODEL-PREFLIGHT-UNWIRED`.

The browser suite now runs a server that holds a model load for longer than the client's first-byte budget, across a swap from another resident model. That scenario fails on build 94's code and passes here, and a second scenario drives a swap the server never completes on its own and asserts the release escalation fires exactly once.

Release gate: 16 suites passed (strict gate)
