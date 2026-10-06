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

The same-origin `/ollama` route is used for model discovery, generation and loaded-model state. Settings selects one AI model, and that same model handles both replies and live translation. Translation uses its own prompt and output budget, but not a separate model choice. Every generate request, including the empty preload, sends the same `num_ctx` (16,384; a reply whose prompt does not fit asks for 32,768), because Ollama reloads a model when the requested context differs from the one it was loaded with. Translation reads `load_duration`, `prompt_eval_duration` and `eval_duration` from the non-streamed response to tell a model load apart from translation time. A translation request is given 20 seconds plus 3 seconds per line; running out of that time is reported as a timeout, not as a cancel. The reply's context size is chosen from an estimate that counts Latin letters at about 3.3 per token, spaces as free, and digits, symbols and long letter-and-digit runs at one token each.

## Same-origin deployment

Production deployments normally reverse-proxy `/transcribe` and `/ollama` from the same origin that serves this static application. `sw.js` explicitly excludes these routes from shell caching.
