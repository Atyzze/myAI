# Protocols

## VTS transcription

`POST /transcribe`

- request body: raw WAV bytes;
- format: 16 kHz, mono, signed 16-bit PCM;
- `Content-Type: audio/wav`;
- optional `X-Transcription-Language` header when language is explicitly selected;
- no multipart/form-data;
- no retention/backup field.

The client expects JSON containing transcript text and/or `segments`, plus optional language and diarization data. Requests are made with browser caching disabled. A segment without text (`text: null` or missing) is read as an empty one.

A server with more work than it can take may answer `503` or `429`. The transcription after a recording then sends half as many chunks at once, and a chunk turned away while another chunk of the same transcription is at the server waits for that one to come back and asks again. Any other failure is retried after 1.5 s and 5 s, a timeout after 20 s and 45 s.

VTS exposes `/healthz` for deployment verification. The browser does not use health metadata as a substitute for transcription results.

## Ollama-compatible service

The same-origin `/ollama` route is used for model discovery, generation and loaded-model state. Settings selects one AI model, and that same model handles both replies and live translation. Translation uses its own prompt and output budget, but not a separate model choice. Every generate request, including the empty preload, sends the same `num_ctx` (16,384), because Ollama reloads a model when the requested context differs from the one it was loaded with. A reply whose prompt does not fit asks for more, up to a ceiling: the model's own maximum (`context_length` from `/api/show`), and the box's `maxContext` from `/capabilities` when the box chose that model, otherwise 32,768. A reply keeps 10,240 tokens for its output (`num_predict`), thinking included. The prompt is budgeted with a per-model correction learned from Ollama's real `prompt_eval_count`, kept in `localStorage` under `ai-token-scale`. When a reply stops with `done_reason: "length"`, a notice says whether the context window or the reply limit was reached. Translation reads `load_duration`, `prompt_eval_duration` and `eval_duration` from the non-streamed response to tell a model load apart from translation time. A translation request is given 20 seconds plus 3 seconds per line; running out of that time is reported as a timeout, not as a cancel. The reply's context size is chosen from an estimate that counts Latin letters at about 3.3 per token, spaces as free, and digits, symbols and long letter-and-digit runs at one token each.

## Box capabilities

A myAI box (the Nix image in the repository) measures its hardware at boot and serves the result at the same-origin `/capabilities` as JSON: `tier`, `summary`, `whisper`, `llm` (the AI model it pulled, or null), `diarization`, `maxPanels`, `translateInFlight`, `transcribeConcurrency`, and plain-language `warnings` and `notes`. The page fetches it once at startup and never waits for it. The limits only ever lower the app's own: translation boxes (fewer than 2 means none), translations in flight (never below one) and transcription sections in parallel. The warnings are shown in Settings under "This box". Every field is read defensively; a missing or malformed field is no limit, and a server without the route (anything other than a box) changes nothing.

## Same-origin deployment

Production deployments normally reverse-proxy `/transcribe` and `/ollama` (and on a box, `/capabilities`) from the same origin that serves this static application. `sw.js` explicitly excludes these routes from shell caching.
