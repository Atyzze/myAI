# myAI Build 135

The app now sizes its work to the box it is served from. This is the first build in the myAI monorepo (`client/`), next to VTS (`vts/`) and the Nix box image that runs both with Ollama on anything from a GPU workstation to a laptop with integrated graphics. That box measures its hardware at boot and publishes what it can take; the app reads it once and never asks for more. Servers that are not a box publish nothing, and for them nothing changes. Database version stays at 13.

## What a box publishes

`GET /capabilities` returns the tier the box planned for (`minimal`, `basic`, `standard`, `strong`, `workstation`), a one-line summary, the Whisper model and device, the AI model it pulled (or none), and three limits: `maxPanels`, `translateInFlight` and `transcribeConcurrency`. It also carries plain-language warnings such as "Only 4 GiB of RAM" or "Insufficient VRAM: it will still run, about 70% on the CPU, so replies are slower", and notes such as "Whisper runs on the CPU". The route is excluded from the service worker like `/ollama` and `/transcribe`, and fetched with `cache: 'no-store'`.

## What the app does with it

- `capabilities.js` fetches it once at startup, gives up after 5 seconds, and nothing waits for it. Until it answers, every limit is the app's own.
- `capabilities-core.js` reads it defensively: numbers are whole and kept in range, a missing or malformed field is no limit, messages are cut at 300 characters and at most six are kept.
- Translation boxes: the setting still chooses how many; a box lowers it to what it keeps up with. Fewer than two means none, as the setting already does. A box with no AI model shows none.
- Translations in flight: at most the box's number, and never fewer than one, so the queue cannot stall.
- Transcription after a recording: sections in parallel are at most the box's number (a CPU box answers 1 to 4; a CUDA box answers the app's own 10).
- Settings › Server processing gains a "This box" row, hidden on servers without `/capabilities`, with the summary, the warnings and the notes.

The AI model needs no change: a box pulls only the model it planned for, and the existing fallback already picks the installed model when the default is not there.

## Tests

`pure`: capabilities parsing, the limits and the Settings description. `static`: the service worker excludes exactly the configured routes, now including `CAPABILITIES_URL`, and the offline shell lists both new modules.

22 suites passed; 0 skipped (portable gate) in 10 min 48 s; slowest mutation-guards (6 min 08 s)
