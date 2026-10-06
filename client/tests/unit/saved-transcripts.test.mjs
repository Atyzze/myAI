// Saved transcripts, end to end: a recording is stored, transcribed by the real transcribeChunked
// against a stand-in transcription server, and the transcript that lands on the recording is
// compared with what was said. The stand-in hears speech the way a real server does: each
// utterance is a run of samples with its own level, so it knows from the audio it is sent which
// utterances a chunk contains, where they sit in it, and which ones the chunk's edge cut short.
import { emitTestResult } from '../helpers/test-result.mjs';
const { memoryIdb } = await import('../helpers/app-harness.mjs');
const { CONFIG } = await import('../../src/js/config.js');
const db = await import('../../src/js/db.js');
const { encodeMonoWav } = await import('../../src/js/audio.js');
const transcribe = await import('../../src/js/transcribe.js');
const { SILENT_MARKER } = await import('../../src/js/transcribe-core.js');

let assertions = 0;
function ok(value, message) {
    assertions++;
    if (!value) throw new Error(`Assertion failed: ${message}`);
}
function eq(actual, expected, message) {
    ok(actual === expected, `${message}\n    expected ${JSON.stringify(expected)}\n    got      ${JSON.stringify(actual)}`);
}

const RATE = 16000;
const LEVEL_BASE = 1600;
const LEVEL_STEP = 64;

let roomNoise = 0;

function speak(script, durationSec) {
    const samples = new Float32Array(Math.round(durationSec * RATE)).fill(roomNoise);
    script.forEach((utterance, index) => {
        const level = (LEVEL_BASE + LEVEL_STEP * index) / 32767;
        samples.fill(level, Math.round(utterance.from * RATE), Math.round(utterance.to * RATE));
    });
    return samples;
}

let script = [];

function heardRuns(view, samples) {
    const runs = [];
    let current = null;
    for (let i = 0; i < samples; i++) {
        const value = view.getInt16(44 + 2 * i, true);
        const index = value > LEVEL_BASE / 2 ? Math.round((value - LEVEL_BASE) / LEVEL_STEP) : -1;
        if (current && current.index === index) { current.to = i + 1; continue; }
        if (current && current.index >= 0) runs.push(current);
        current = { index, from: i, to: i + 1 };
    }
    if (current && current.index >= 0) runs.push(current);
    return runs;
}

globalThis.fetch = async (url, init = {}) => {
    if (!String(url).startsWith('/transcribe')) throw new Error(`unexpected request to ${url}`);
    const buffer = await init.body.arrayBuffer();
    const view = new DataView(buffer);
    const samples = (buffer.byteLength - 44) / 2;
    const segments = heardRuns(view, samples).map(run => {
        const utterance = script[run.index];
        const words = utterance.text.split(' ');
        const heardSec = (run.to - run.from) / RATE;
        const fullSec = utterance.to - utterance.from;
        let text = utterance.text;
        if (heardSec < fullSec - 0.01) {
            const count = Math.max(1, Math.round(words.length * heardSec / fullSec));
            text = run.from === 0 ? words.slice(-count).join(' ') : words.slice(0, count).join(' ');
        }
        return { start: run.from / RATE, end: run.to / RATE, text };
    });
    const body = { text: segments.map(segment => segment.text).join(' '), segments, language: 'en' };
    return { ok: true, status: 200, async json() { return body; } };
};

async function storedRecording(durationSec) {
    const blob = encodeMonoWav(speak(script, durationSec), RATE);
    const id = await db.dbExec(CONFIG.STORE_REC, 'add', {
        timestamp: Date.now() - durationSec * 1000, durationMs: durationSec * 1000, format: 'wav', sampleRate: RATE,
        audioBytes: blob.size, captureState: 'ready', processing: false, transcripts: [], summaries: []
    });
    await db.writeAudio(id, blob);
    return id;
}

async function transcribed(durationSec) {
    const id = await storedRecording(durationSec);
    await transcribe.transcribeChunked(id, () => {});
    const rec = await db.dbExec(CONFIG.STORE_REC, 'get', id);
    return rec.transcripts[0];
}

const said = () => script.map(utterance => utterance.text).join(' ');

{
    script = [
        { from: 2.0, to: 3.5, text: 'Did the build pass?' },
        { from: 4.0, to: 5.0, text: 'I think so.' },
        { from: 5.2, to: 7.0, text: 'So what do we ship first?' },
        { from: 8.0, to: 8.6, text: 'The app.' },
        { from: 8.8, to: 10.5, text: 'The app and the server.' },
        { from: 11.0, to: 11.5, text: 'Thanks.' },
        { from: 11.7, to: 12.5, text: 'Thanks, everyone.' }
    ];
    const saved = await transcribed(20);
    eq(saved.plain, said(),
       'repeats: a sentence that starts with the words the one before it ended on is saved whole');
    eq(saved.source, 'S', 'repeats: it is the transcription after the recording that says so');
}

{
    script = [
        { from: 20.0, to: 23.0, text: 'We looked at the numbers again this morning.' },
        { from: 57.0, to: 59.4, text: 'That is the first half of the plan.' },
        { from: 59.6, to: 60.3, text: 'Okay.' },
        { from: 60.5, to: 62.5, text: 'Okay, so we start with the budget.' },
        { from: 62.8, to: 66.0, text: 'This sentence starts after the first boundary and runs on.' },
        { from: 116.0, to: 119.5, text: 'The last full sentence of the second minute.' },
        { from: 119.7, to: 120.4, text: 'Right.' },
        { from: 120.6, to: 124.2, text: 'Right, and then we went home early.' }
    ];
    const saved = await transcribed(130);
    eq(saved.plain, said(),
       'boundaries: every sentence around two chunk boundaries is saved exactly once, a sentence both chunks heard included, and a real repeat right after a boundary is kept');
}

{
    script = [
        { from: 10.0, to: 12.0, text: 'Hello there, this is the start.' },
        { from: 121.0, to: 122.5, text: 'See you on Monday then.' }
    ];
    const saved = await transcribed(185);
    eq(saved.plain, said(), 'quiet minute: every word is saved once');
    ok(saved.text.includes('[02:01-02:02] See you on Monday then.'),
       `quiet minute: words spoken just after a quiet minute are saved at the time they were said\n${saved.text}`);
    ok(saved.text.includes(`[01:00-02:00] ${SILENT_MARKER}`),
       `quiet minute: and the quiet minute before them is saved as no speech, not as their place\n${saved.text}`);
}

{
    roomNoise = 0.02;
    script = [
        { from: 10.0, to: 12.0, text: 'Hello there, this is the start.' },
        { from: 121.0, to: 122.5, text: 'See you on Monday then.' }
    ];
    const saved = await transcribed(185);
    roomNoise = 0;
    eq(saved.plain, said(), 'noisy minute: with the room audible but nobody speaking, every word is still saved once');
    ok(saved.text.includes('[02:01-02:02] See you on Monday then.') && !saved.text.includes('[01:00-02:00] See you'),
       `noisy minute: and the words spoken just after it keep their own time\n${saved.text}`);
}

{
    script = [];
    const lines = [
        { startSec: 0.2, endSec: 0.6, text: 'Okay.' },
        { startSec: 0.7, endSec: 1.9, text: 'Okay, so we need to fix the bug.' },
        { startSec: 2.0, endSec: 2.9, text: 'We need to test the bug.' },
        { startSec: 3.0, endSec: 3.4, text: 'Yes, I think so.' },
        { startSec: 3.5, endSec: 3.9, text: 'Yes, I know so.' },
        { startSec: 5.0, endSec: 6.6, text: 'Let us ship it.' }
    ];
    const id = await storedRecording(8);
    await db.writeLiveTranscript(id, { lines, languages: [], coverage: [{ fromSec: 0, toSec: 8 }] });
    ok(await transcribe.storeLiveTranscript(id), 'live: the live transcript is kept as the recording\'s transcript');
    const kept = (await db.dbExec(CONFIG.STORE_REC, 'get', id)).transcripts[0];
    eq(kept.plain, lines.map(line => line.text).join(' '),
       'live: the transcript kept from the live one says what the live transcript showed, line for line');

    await transcribe.transcribeChunked(id, () => {});
    const reused = (await db.dbExec(CONFIG.STORE_REC, 'get', id)).transcripts[0];
    eq(reused.plain, lines.map(line => line.text).join(' '),
       'live: and the transcription after the recording, which reuses the live lines, keeps every one of them');
}

{
    script = [
        { from: 49.2, to: 50.8, text: 'Okay, so here we go now.' },
        { from: 53.0, to: 56.0, text: 'This part was never heard live.' }
    ];
    const lines = [
        { startSec: 10.0, endSec: 12.0, text: 'The live part starts here.' },
        { startSec: 49.2, endSec: 50.8, text: 'Okay, so here we go now.' }
    ];
    const id = await storedRecording(70);
    await db.writeLiveTranscript(id, { lines, languages: [], coverage: [{ fromSec: 0, toSec: 50 }] });
    await transcribe.transcribeChunked(id, () => {});
    const saved = (await db.dbExec(CONFIG.STORE_REC, 'get', id)).transcripts[0];
    eq(saved.plain, 'The live part starts here. Okay, so here we go now. This part was never heard live.',
       'gap: where the transcription of a gap meets the live lines, what both heard is saved once');
}

{
    const realFetch = globalThis.fetch;
    const answers = [
        ['every chunk', { segments: [{ start: 0, end: 1, text: 'journey' }] }],
        ['timestamps the server did not fill in', { segments: [{ start: null, end: 'soon', text: 'journey' }] }]
    ];
    for (const [kind, reply] of answers) {
        let request = 0;
        globalThis.fetch = async (url, init = {}) => {
            const view = new DataView(await init.body.arrayBuffer());
            let sound = false;
            for (let i = 44; i < view.byteLength && !sound; i += 2) sound = view.getInt16(i, true) !== 0;
            const said = `journey ${++request}`;
            const body = sound
                ? { text: said, language: 'en', segments: reply.segments.map(segment => ({ ...segment, text: said })) }
                : { text: '', segments: [], language: 'en' };
            return { ok: true, status: 200, async json() { return body; } };
        };
        script = [{ from: 62, to: 118, text: 'a long stretch of speech' }];
        const saved = await transcribed(150);
        ok(saved.text.includes('[01:00-02:00] journey'),
           `server timestamps: a minute full of speech is not lost when the server puts its words at ${kind === 'every chunk' ? 'the start of every chunk' : 'no usable time'}\n${saved.text}`);
    }
    globalThis.fetch = realFetch;
}

{
    const { cancelAllForRec } = await import('../../src/js/jobs.js');
    let unhandled = 0;
    const count = () => { unhandled++; };
    process.on('unhandledRejection', count);
    script = [{ from: 1, to: 2, text: 'Never sent.' }];
    const id = await storedRecording(90);
    const slowRead = memoryIdb.delayWhile(op => op.store === 'live_transcripts' && op.action === 'get', 120);
    const running = transcribe.transcribeChunked(id, () => {});
    setTimeout(() => cancelAllForRec(id), 50);
    let outcome = null;
    try { await running; } catch (err) { outcome = err && err.name; }
    await new Promise(resolve => setTimeout(resolve, 50));
    slowRead();
    process.off('unhandledRejection', count);
    eq(outcome, 'AbortError', 'cancel: a transcription cancelled while its audio is being prepared ends as cancelled');
    eq(unhandled, 0, 'cancel: and leaves no rejected promise behind that nothing handles');
}

{
    const { cancelAllForRec } = await import('../../src/js/jobs.js');
    const realFetch = globalThis.fetch;
    let sent = 0;
    globalThis.fetch = async (...args) => { sent++; return realFetch(...args); };
    script = [{ from: 1, to: 2, text: 'Never sent either.' }];
    const id = await storedRecording(90);
    memoryIdb.ops = [];
    const running = transcribe.transcribeChunked(id, () => {});
    cancelAllForRec(id);
    let outcome = null;
    try { await running; } catch (err) { outcome = err && err.name; }
    await new Promise(resolve => setTimeout(resolve, 100));
    globalThis.fetch = realFetch;
    const readAfterwards = memoryIdb.ops.filter(op => op.store !== CONFIG.STORE_REC && op.store !== CONFIG.STORE_AUDIO);
    ok(outcome === 'AbortError' && sent === 0 && readAfterwards.length === 0,
       `cancel: a transcription is cancellable from its first moment: cancelled before its audio was even read, it reads nothing more and sends nothing (${outcome}, ${sent} sent, ${JSON.stringify(readAfterwards)})`);
}

{
    const realFetch = globalThis.fetch;
    let inFlight = 0;
    let replied = false;
    let mostBeforeFirstReply = 0;
    globalThis.fetch = async (...args) => {
        inFlight++;
        if (!replied) mostBeforeFirstReply = Math.max(mostBeforeFirstReply, inFlight);
        await new Promise(resolve => setTimeout(resolve, 30));
        try { return await realFetch(...args); } finally { inFlight--; replied = true; }
    };
    script = [{ from: 30, to: 32, text: 'Somewhere in the first minute.' }];
    const saved = await transcribed(8 * 60);
    globalThis.fetch = realFetch;
    ok(saved && saved.plain === 'Somewhere in the first minute.', 'pool: an eight-minute recording is transcribed');
    ok(mostBeforeFirstReply === 2,
       `pool: it sends a few chunks at a time to start, not all it may send at once (${mostBeforeFirstReply} before the first answer)`);
}

{
    const realFetch = globalThis.fetch;
    let requests = 0;
    globalThis.fetch = async (...args) => {
        requests++;
        if (requests === 1) return { ok: false, status: 503, async json() { return {}; }, async text() { return 'busy'; } };
        return realFetch(...args);
    };
    script = [{ from: 3, to: 5, text: 'Said while the server was busy.' }];
    let saved = null;
    try { saved = await transcribed(20); } catch (err) { saved = { plain: `failed: ${err && err.message}` }; }
    globalThis.fetch = realFetch;
    ok(saved && saved.plain === 'Said while the server was busy.' && requests === 2,
       `retry: a chunk the server fails once is tried again after a pause, from a bounded list rather than an open-ended loop (${requests} requests, ${saved && saved.plain})`);
}

{
    // A server that works on one chunk at a time, for longer than the pauses between tries, and
    // answers 503 to any other chunk while it does. Time runs twenty times faster here, so the 1.5 s
    // and 5 s pauses take 75 and 250 ms; the server takes 250 ms a chunk, five seconds at real speed.
    const realFetch = globalThis.fetch;
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn, ms = 0, ...args) => realSetTimeout(fn, Math.max(0, Number(ms) || 0) / 20, ...args);
    let inFlight = 0;
    let accepted = 0;
    let refused = 0;
    globalThis.fetch = async (...args) => {
        if (inFlight > 0) {
            refused++;
            return { ok: false, status: 503, async json() { return {}; }, async text() { return 'busy'; } };
        }
        inFlight++;
        accepted++;
        try {
            await new Promise(resolve => realSetTimeout(resolve, 250));
            return await realFetch(...args);
        } finally {
            inFlight--;
        }
    };
    script = Array.from({ length: 8 }, (_, minute) => ({ from: minute * 60 + 30, to: minute * 60 + 32,
                                                        text: `Something said in minute ${minute + 1}.` }));
    let saved = null;
    try { saved = await transcribed(8 * 60); } catch (err) { saved = { plain: `failed: ${err && err.message}`, text: '' }; }
    globalThis.fetch = realFetch;
    globalThis.setTimeout = realSetTimeout;
    ok(saved && saved.plain === said() && !/unavailable/.test(saved.text),
       `busy: every chunk reaches a server that takes one at a time: a chunk it turns away waits for this transcription's own chunk there to come back, instead of being given up on after pauses shorter than the server's work (${saved && saved.text})`);
    ok(accepted === 8 && refused <= accepted,
       `busy: and fewer chunks are sent at once after a busy answer, so the server is not asked again and again by chunks it cannot take (${accepted} answered, ${refused} turned away)`);
}

{
    // A server that sends one segment without any text among the ones it heard.
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (...args) => {
        const answer = await realFetch(...args);
        const body = await answer.json();
        const segments = [...body.segments, { start: 0.1, end: 0.2, text: null }];
        return { ok: true, status: 200, async json() { return { ...body, segments }; } };
    };
    script = [{ from: 5, to: 7, text: 'A line beside a segment without text.' }];
    let saved = null;
    try { saved = await transcribed(30); } catch (err) { saved = { plain: `failed: ${err && err.message}`, text: '' }; }
    globalThis.fetch = realFetch;
    ok(saved && saved.plain === said() && !/unavailable/.test(saved.text),
       `segments: one segment the server sent without text does not take the rest of its chunk down with it (${saved && saved.text})`);
}

memoryIdb.reset();
console.log(`✓ all ${assertions} saved-transcript assertions passed`);
emitTestResult('saved-transcripts', 'pass', { assertions });
process.exit(0);
