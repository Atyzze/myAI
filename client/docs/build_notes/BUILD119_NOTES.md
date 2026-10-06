# myAI Build 119

Live translation stops paying for model reloads it caused itself, and stops writing notes about its own speed into the transcript. Database version stays at 12.

## What was slow

Build 109 made replies and live translation share one AI model so the server would not swap models. It did not share the context size. Ollama allocates a model's context when it loads it, and a request that asks for a different `num_ctx` makes it unload and load the same model again. The app asked for four different ones:

- live and final translation: 4,096;
- a reply: 8,192, 16,384 or 32,768, depending on the prompt;
- the empty preload before a reply or translation: none at all, so the server's default.

So the first translation of a recording nearly always reloaded the model that the last reply had left resident. For a 27B model that is several seconds, and every translation sent while it happened waited for it too. Those seconds were then counted as translation time: the rate was the wall-clock time of the whole request, preload included, and the slow-translation notice fired after only two requests. That is how a GPU that translates a line in a fraction of a second could report "6.7s per line" twenty seconds into a recording, while `/api/ps` correctly said the model was fully on the GPU.

## One context for everything

`AI_NUM_CTX` (16,384) is now the context every request to the AI model asks for: translation during and after a recording, the preload before a reply or translation, and every reply whose prompt fits in it. Only a reply too large for it, such as a very large pasted context item, asks for `AI_MAX_NUM_CTX` (32,768), exactly the ceiling the reply budget already used. Translation requests now also ask the server to keep the model resident for the same half hour replies do.

16,384 rather than 32,768 keeps the model's memory close to what it was, so it still fits beside the transcription model on one GPU. A translation prompt is a few hundred tokens; the larger allocation costs memory, not speed.

## Loaded before the first line

When live transcription starts with translation boxes on, the app sends the empty preload for the selected model with that context straight away. If the model is resident with a different context, the one reload happens in the first seconds, while there is nothing to translate yet, and translations that arrive during it wait for it rather than starting another.

## Measured from the server

Ollama reports how long it spent loading, reading the prompt and writing the answer. A translation's cost is now the reading and writing only; load time is logged to the console as a load, not counted. A server that reports no durations is measured by the request's round trip, as before. Failed, aborted and misaligned requests are no longer counted at all, and a rate needs three successful requests, so one slow start cannot label the model slow.

## Nothing in the transcript

The translation notices no longer become transcript lines. The slow-translation notice, the misaligned-format notice, the reasoning-model notice and the "not answering" notice were written into the transcript with a timestamp and repeated in every box, although the box headings already said how many lines were waiting, how far behind a box was and whether the server was answering.

When the app knows why translation is struggling, the reason is added to the box heading while lines are waiting, and goes away when they are done: "AI model partly on CPU" (checked once, only when translation really is slow), "AI model ignores the line format" or "AI model answers with reasoning only". Details go to the console.

## Tests

`translate-request` checks that translation and the warm-up ask for the shared context and keep the model resident, and that a translation's timing excludes a nine-second model load. `pure` checks the timing arithmetic, that two requests are not yet a rate, that a reply below the shared context asks for exactly it, and that a heading reason disappears once nothing is waiting. `static-integrity` checks that the translation path never writes into the transcript, that live transcription warms the model, and that a reply uses the shared context as its floor.

`user-journeys` runs live transcription with translation boxes against a fake Ollama that behaves like the real one where it matters: it reloads when the context changes, makes requests wait for a load in progress, and starts with the model resident at 32,768. English and Dutch lines arrive, the boxes appear and lines are translated; the test checks that no translation caused a reload, that every request asked for the same context, that the warm-up came first, and that no system line was written. Against Build 118 it fails: the first translation asks for 4,096 and reloads the model, and the next one waits three seconds for it.

## Contracts

- `LIVE-TRANSLATION-ONE-LOAD-001`. Guards `MUT-TRANSLATE-OWN-CONTEXT`, `MUT-WARMUP-DEFAULT-CONTEXT`, `MUT-REPLY-OWN-CONTEXT`, `MUT-LOAD-TIME-CHARGED`, `MUT-RATE-FROM-TWO`, `MUT-CAUSE-LINGERS`, `MUT-SPEED-IN-TRANSCRIPT`, `MUT-NO-WARMUP`.

Release gate: 18 suites passed (strict gate)
