import { emitTestResult } from '../helpers/test-result.mjs';

let assertions = 0;
function ok(value, message) {
    assertions++;
    if (!value) throw new Error(`Assertion failed: ${message}`);
}
function eq(actual, expected, message) {
    ok(actual === expected, `${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

function matchesSelector(node, selector) {
    const match = String(selector).match(/^\.([\w-]+)(?:\[data-lang="([^"]*)"\])?$/);
    if (!match) return false;
    if (!String(node.className || '').split(/\s+/).includes(match[1])) return false;
    return match[2] == null || node.dataset.lang === match[2];
}

function makeElement(id) {
    const classes = new Set();
    let ownHtml = '';
    const detach = child => {
        if (child && child.parentNode) child.parentNode.children = child.parentNode.children.filter(one => one !== child);
    };
    return {
        id, className: '', textContent: '', tagName: 'DIV', parentNode: null,
        style: { setProperty() {} }, dataset: {}, hidden: false, children: [],
        get innerHTML() {
            return ownHtml + this.children.map(child => child.innerHTML || child.textContent || '').join('');
        },
        set innerHTML(value) {
            for (const child of this.children) child.parentNode = null;
            this.children = [];
            ownHtml = String(value);
            const isTranslationBoxMarkup = /^<div class="ls-panel-head"/.test(ownHtml);
            if (isTranslationBoxMarkup) {
                ownHtml = '';
                for (const headingOrBody of String(value).matchAll(/<div class="([^"]+)"(?: data-lang="([^"]*)")?><\/div>/g)) {
                    const child = makeElement('');
                    child.className = headingOrBody[1];
                    if (headingOrBody[2] != null) child.dataset.lang = headingOrBody[2];
                    child.parentNode = this;
                    this.children.push(child);
                }
            }
        },
        get lastChild() { return this.children[this.children.length - 1] || null; },
        classList: {
            add(...names) { names.forEach(name => classes.add(name)); },
            remove(...names) { names.forEach(name => classes.delete(name)); },
            toggle(name, on) { if (on) classes.add(name); else classes.delete(name); },
            contains(name) { return classes.has(name); }
        },
        appendChild(child) { detach(child); this.children.push(child); child.parentNode = this; return child; },
        removeChild(child) {
            this.children = this.children.filter(one => one !== child);
            if (child) child.parentNode = null;
            return child;
        },
        insertBefore(child, ref) {
            detach(child);
            const at = ref ? this.children.indexOf(ref) : -1;
            if (at < 0) this.children.push(child); else this.children.splice(at, 0, child);
            child.parentNode = this;
            return child;
        },
        querySelector(selector) {
            const find = node => {
                for (const child of node.children || []) {
                    if (matchesSelector(child, selector)) return child;
                    const inner = find(child);
                    if (inner) return inner;
                }
                return null;
            };
            return find(this);
        },
        querySelectorAll() { return []; },
        setAttribute(name, value) { this[name] = value; },
        getAttribute(name) { return this[name] ?? null; },
        addEventListener() {}, removeEventListener() {},
        remove() {}, scrollTo() {}, focus() {}
    };
}

const elements = new Map();
globalThis.document = {
    body: makeElement('body'),
    getElementById(id) {
        if (!elements.has(id)) elements.set(id, makeElement(id));
        return elements.get(id);
    },
    createElement(tag) {
        const element = makeElement('');
        element.tagName = String(tag).toUpperCase();
        return element;
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() {}, removeEventListener() {}
};
globalThis.window = {
    addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
    matchMedia: () => ({ matches: false, addEventListener() {} })
};
Object.defineProperty(globalThis, 'navigator', {
    value: { onLine: true, clipboard: { writeText: async () => {} } },
    configurable: true, writable: true
});
globalThis.CustomEvent = class { constructor(type, init) { this.type = type; Object.assign(this, init); } };

const store = new Map();
globalThis.localStorage = {
    getItem(key) { return store.has(key) ? store.get(key) : null; },
    setItem(key, value) { store.set(key, String(value)); },
    removeItem(key) { store.delete(key); }
};
store.set('server-processing-consent-v1', '1');
store.set('set-live-panels', '0');
store.set('set-speaker-detection', 'off');

let servedChunks = 0;
globalThis.fetch = async () => {
    servedChunks++;
    const index = servedChunks;
    return {
        ok: true,
        status: 200,
        async json() {
            return {
                text: `line ${index}`,
                segments: [{ start: 0.2, end: 1.8, text: `line ${index}` }],
                language: 'en'
            };
        }
    };
};

const { encodeMonoWav } = await import('../../src/js/audio.js');
const { WINDOW_SEC } = await import('../../src/js/live-scribe-core.js');
const scribe = await import('../../src/js/live-scribe.js');

const RATE = 16000;
const PREFIX_SEC = 24;
const LONG_SEC = 80;
const silence = new Float32Array(RATE * LONG_SEC);
for (let i = 0; i < silence.length; i++) silence[i] = Math.sin(i / 40) * 0.2;
const prefixBlob = encodeMonoWav(silence, RATE);
scribe.setLiveScribeAudioSource(async () => prefixBlob);

async function settle(rounds = 40) {
    for (let i = 0; i < rounds; i++) await new Promise(resolve => setTimeout(resolve, 5));
}

{
    ok(scribe.startLiveScribe(7, RATE, PREFIX_SEC) === true,
       'live transcription starts for a recording');
    ok(scribe.isLiveScribeActive() === true, 'it reports itself active once started');

    await scribe.backfillLiveScribe(7, PREFIX_SEC);
    await settle();

    const first = scribe.liveScribeResult();
    ok(first && first.lines.length > 0,
       'backfilling the audio from before the user pressed the button produces transcript lines');
    ok(first.coverage.length > 0, 'and records which seconds of audio it has covered');

    const linesBefore = first.lines.length;
    const coveredBefore = first.coverage.reduce((total, span) => total + (span.toSec - span.fromSec), 0);
    const requestsBefore = servedChunks;

    scribe.pauseLiveScribe();
    ok(scribe.isLiveScribeActive() === false, 'pausing stops the live session');

    ok(scribe.startLiveScribe(7, RATE, PREFIX_SEC) === true,
       'the same recording can be resumed');
    const resumed = scribe.liveScribeResult();
    ok(resumed !== null,
       'resuming the same recording keeps the transcript instead of blanking the panel');
    eq(resumed.lines.length, linesBefore,
       'every line survives the pause');
    const coveredAfter = resumed.coverage.reduce((total, span) => total + (span.toSec - span.fromSec), 0);
    eq(Math.round(coveredAfter), Math.round(coveredBefore),
       'the coverage map survives the pause, so already-transcribed audio is not re-sent');

    await scribe.backfillLiveScribe(7, PREFIX_SEC);
    await settle();
    eq(servedChunks, requestsBefore,
       'a resume does not re-transcribe audio the coverage map already accounts for');
}

{
    scribe.stopLiveScribe({ keepText: true });
    ok(scribe.startLiveScribe(99, RATE, 0) === true, 'a different recording starts cleanly');
    eq(scribe.liveScribeResult(), null,
       'a different recording never inherits the previous recording\'s transcript');
    scribe.closeLiveScribe();
}

{
    ok(scribe.startLiveScribe(12, RATE, 0) === true, 'a fresh recording starts');
    scribe.closeLiveScribe();
    ok(scribe.startLiveScribe(12, RATE, 0) === true, 'the same id can start again after a close');
    eq(scribe.liveScribeResult(), null,
       'closing discards the transcript outright, unlike pausing');
    scribe.closeLiveScribe();
}

{
    store.set('set-speaker-detection', 'on');
    store.set('speaker-detection-acknowledged-v1', '1');
    store.set('set-speaker-policy', 'infer');

    let turn = 0;
    let spoken = null;
    const voices = [
        { text: 'My name is Mark', embedding: [1, 0, 0] },
        { text: 'sounds good to me', embedding: [0, 1, 0] },
        { text: 'anyway where were we', embedding: [1, 0, 0] }
    ];
    globalThis.fetch = async () => {
        const voice = spoken != null
            ? { text: spoken, embedding: [1, 0, 0] }
            : voices[turn++ % voices.length];
        return {
            ok: true,
            status: 200,
            async json() {
                return {
                    text: voice.text,
                    segments: [{ start: 0.2, end: 1.8, text: voice.text, embedding: voice.embedding }],
                    language: 'en'
                };
            }
        };
    };

    const painted = () => document.getElementById('live-scribe-text').innerHTML || '';

    ok(scribe.startLiveScribe(21, RATE, LONG_SEC) === true, 'confirm: a recording with speaker labelling on starts');
    await scribe.backfillLiveScribe(21, LONG_SEC);
    await settle(80);

    const afterIntro = painted();
    ok(/Mark/.test(afterIntro),
       'confirm: an outright introduction is noticed');
    ok(/confirm speaker/i.test(afterIntro),
       'confirm: and is put on screen as a suggestion telling you how to accept it');
    ok(/\?/.test(afterIntro),
       'confirm: phrased as a question, because nothing has been decided');
    ok(/Mark \u2713/.test(document.getElementById('live-scribe-speakers').textContent),
       'confirm: the panel shows how sure it is, beside the suggestion rather than instead of it');

    spoken = 'confirm speaker 1';
    const speech = new Float32Array(RATE * (WINDOW_SEC + 2));
    for (let i = 0; i < speech.length; i++) speech[i] = Math.sin(i / 30) * 0.3;
    scribe.pushLivePcm(speech, RATE);
    await settle(120);

    const afterConfirm = painted();
    ok(/confirmed/i.test(afterConfirm),
       'confirm: saying it out loud while recording applies the suggestion and reports it as confirmed');
    ok(!/confirm speaker 1\?/.test(afterConfirm.split('confirmed').pop()),
       'confirm: and the suggestion stops standing once it has been answered');

    spoken = 'confirm speaker 4';
    scribe.pushLivePcm(speech, RATE);
    await settle(120);
    const afterStray = painted();
    ok(/nothing is waiting/i.test(afterStray),
       'confirm: confirming a speaker that has no suggestion standing applies nothing, and says so');
    ok(!/Speaker 4 \u2192/.test(afterStray),
       'confirm: it certainly does not invent a name to apply');

    scribe.closeLiveScribe();
    store.set('set-speaker-detection', 'off');
    store.set('set-speaker-policy', 'numbers');
}

{
    let releaseStale = null;
    const staleGate = new Promise(resolve => { releaseStale = resolve; });
    let phase = 'beforepause';
    globalThis.fetch = async () => {
        const tag = phase;
        if (tag === 'beforepause') await staleGate;
        return {
            ok: true,
            status: 200,
            async json() {
                return {
                    text: `${tag} window`,
                    segments: [{ start: 0.1, end: 1.5, text: `${tag} window` }],
                    language: 'en'
                };
            }
        };
    };

    ok(scribe.startLiveScribe(31, RATE, 0) === true, 'epoch: a recording starts');
    const speech = new Float32Array(RATE * (WINDOW_SEC + 2));
    for (let i = 0; i < speech.length; i++) speech[i] = Math.sin(i / 30) * 0.3;
    scribe.pushLivePcm(speech, RATE);
    await settle(10);

    scribe.pauseLiveScribe();
    ok(scribe.startLiveScribe(31, RATE, 0) === true,
       'epoch: the same recording resumes transcription after a pause');
    phase = 'afterresume';
    releaseStale();
    await settle(80);

    const painted = document.getElementById('live-scribe-text').innerHTML || '';
    ok(!/beforepause window/.test(painted),
       'epoch: a window answered after transcription paused never lands in the resumed session, '
       + 'even though the recording id never changed');

    scribe.closeLiveScribe();
}

{
    store.set('set-speaker-detection', 'on');
    store.set('speaker-detection-acknowledged-v1', '1');
    store.set('set-speaker-policy', 'numbers');
    const ALICE = [1, 0, 0, 0];
    const BOB = [0, 1, 0, 0];
    let voice = ALICE;
    let phase = 'before';
    let spoken = 0;
    globalThis.fetch = async () => {
        const who = voice === ALICE ? 'alice' : 'bob';
        const text = `${phase} ${who} ` + Array.from({ length: 8 }, (_, i) => `t${spoken}w${i}`).join(' ');
        return {
            ok: true,
            status: 200,
            async json() {
                return { text, segments: [{ start: 2.0, end: 4.0, text, embedding: voice }], language: 'en' };
            }
        };
    };
    const chunk = new Float32Array(RATE * WINDOW_SEC);
    for (let i = 0; i < chunk.length; i++) chunk[i] = Math.sin(i / 25) * 0.3;
    const speak = async order => {
        for (let k = 0; k < order.length; k++) {
            voice = order[k];
            spoken++;
            scribe.pushLivePcm(chunk, RATE);
            await settle(12);
        }
    };

    ok(scribe.startLiveScribe(41, RATE, 0) === true, 'resume: a recording with speaker labels starts');
    await speak([ALICE, BOB, ALICE, BOB, ALICE, BOB, ALICE, BOB]);
    const before = scribe.liveScribeResult().lines.map(line => line.text);
    ok(before.length >= 6 && before.some(text => /^Speaker 2: /.test(text)),
       `resume: two voices are told apart before the pause (${before.slice(0, 3).join(' | ')})`);
    const speakersHeader = document.getElementById('live-scribe-speakers');
    ok(/^🗣️ 2 speakers · \d+% sure \(Speaker 1, Speaker 2\)/.test(speakersHeader.textContent)
       && speakersHeader.classList.contains('found'),
       `numbers: the live header counts the speakers the lines show (${speakersHeader.textContent})`);

    scribe.pauseLiveScribe();
    ok(scribe.startLiveScribe(41, RATE, 40) === true, 'resume: the same recording shows its transcript again');
    phase = 'after';
    await speak([BOB, BOB, ALICE, BOB, ALICE, BOB, ALICE, ALICE]);
    const after = scribe.liveScribeResult().lines.map(line => line.text);
    const kept = after.filter(text => / before /.test(` ${text.replace(/^Speaker \d+: /, '')}`) || /^(Speaker \d+: )?before /.test(text));
    eq(kept.join('\n'), before.join('\n'),
       'resume: every line from before the pause keeps its speaker after showing live transcription again');
    ok(after.some(text => /^(Speaker \d+: )?after /.test(text)),
       'resume: and the lines after the pause are transcribed as well');
    scribe.closeLiveScribe();
    store.set('set-speaker-detection', 'off');
}

{
    // Build 133: as reported, somebody heard once took the first identity, so the first person on
    // screen was Speaker 2 and a third one Speaker 5. The numbers on screen count 1, 2, 3 in the
    // order the voices came in, and a suggestion is confirmed by the number it was announced with.
    store.set('set-speaker-detection', 'on');
    store.set('speaker-detection-acknowledged-v1', '1');
    store.set('set-speaker-policy', 'infer');
    const PASSERBY = [0, 0, 0, 1, 0];
    const ALICE = [1, 0, 0, 0, 0];
    const BOB = [0, 1, 0, 0, 0];
    const CAROL = [0, 0, 1, 0, 0];
    const called = new Map([[PASSERBY, 'passerby'], [ALICE, 'alice'], [BOB, 'bob'], [CAROL, 'carol']]);
    let voice = PASSERBY;
    let sentence = null;
    let spoken = 0;
    globalThis.fetch = async () => {
        const words = Array.from({ length: 8 }, (_, i) => `n${spoken}w${i}`).join(' ');
        const text = sentence != null ? `${sentence}. ${words}` : `${called.get(voice)} ${words}`;
        return {
            ok: true,
            status: 200,
            async json() {
                return { text, segments: [{ start: 2.0, end: 4.0, text, embedding: voice }], language: 'en' };
            }
        };
    };
    const chunk = new Float32Array(RATE * WINDOW_SEC);
    for (let i = 0; i < chunk.length; i++) chunk[i] = Math.sin(i / 25) * 0.3;
    const speak = async (order, saying = null) => {
        for (const who of order) {
            voice = who;
            sentence = saying;
            spoken++;
            scribe.pushLivePcm(chunk, RATE);
            await settle(12);
        }
        sentence = null;
    };

    ok(scribe.startLiveScribe(51, RATE, 0) === true, 'numbers: a recording with speaker labels starts');
    await speak([PASSERBY, ALICE, ALICE, ALICE, BOB, BOB, BOB, ALICE, BOB, CAROL, CAROL, CAROL, ALICE, CAROL]);
    const lines = scribe.liveScribeResult().lines.map(line => line.text);
    const firstOf = who => lines.find(text => new RegExp(`(^|: )${who} `).test(text)) || '';
    ok(/^Speaker 1: alice /.test(firstOf('alice')) && /^Speaker 2: bob /.test(firstOf('bob'))
       && /^Speaker 3: carol /.test(firstOf('carol')),
       `numbers: the first voice on screen is Speaker 1 and the next two are 2 and 3 (${[firstOf('alice'), firstOf('bob'), firstOf('carol')].join(' | ')})`);
    const header = document.getElementById('live-scribe-speakers').textContent;
    ok(/\(Speaker 1, Speaker 2, Speaker 3\)/.test(header),
       `numbers: the header lists them the same way (${header})`);

    const painted = () => document.getElementById('live-scribe-text').innerHTML || '';
    await speak([BOB], 'My name is Bob');
    ok(/say "confirm speaker 2"/.test(painted()) && !/confirm speaker [3-9]/.test(painted()),
       'numbers: a suggestion for the second voice asks you to confirm Speaker 2');
    await speak([ALICE], 'confirm speaker 2');
    const named = scribe.liveScribeResult().lines.map(line => line.text);
    ok(named.some(text => /^Bob: bob /.test(text)) && !named.some(text => /^Speaker 2: /.test(text)),
       `numbers: and confirming Speaker 2 names that voice (${named.filter(text => / bob /.test(` ${text} `)).slice(0, 2).join(' | ')})`);
    scribe.closeLiveScribe();
    store.set('set-speaker-detection', 'off');
    store.set('set-speaker-policy', 'numbers');
}

{
    let spoken = 0;
    globalThis.fetch = async () => {
        spoken++;
        const words = Array.from({ length: 330 }, (_, i) => `w${spoken}x${i}`).join(' ');
        return {
            ok: true,
            status: 200,
            async json() {
                return { text: words, segments: [{ start: 2.0, end: 4.0, text: words }], language: 'en' };
            }
        };
    };
    const chunk = new Float32Array(RATE * WINDOW_SEC);
    for (let i = 0; i < chunk.length; i++) chunk[i] = Math.sin(i / 25) * 0.3;

    ok(scribe.startLiveScribe(51, RATE, 0) === true, 'copy: a long recording starts');
    for (let k = 0; k < 30; k++) {
        scribe.pushLivePcm(chunk, RATE);
        await settle(6);
        if (k === 3) scribe.noteLiveSystemLine('⚠️ Not recording sound right now - a test notice', 'error');
    }
    await settle(20);
    const saved = scribe.liveScribeResult().lines.map(line => line.text);
    const copied = scribe.liveScribeTranscriptText().split('\n').filter(line => /^\[\d\d:\d\d\] /.test(line))
        .map(line => line.replace(/^\[\d\d:\d\d\] /, ''));
    ok(saved.join(' ').length > 60000,
       `copy: the saved transcript keeps the lines that scrolled out of view, from the very first one (${saved.join(' ').length} characters)`);
    eq(copied.length, saved.length,
       'copy: 📋 copies every line the recording saves, including the ones that scrolled out of view');
    eq(copied[0], saved[0], 'copy: starting from the first line');
    ok(!/Not recording sound/.test(scribe.liveScribeTranscriptText()),
       'copy: and a notice shown during the recording is not pasted as if someone said it');
    scribe.closeLiveScribe();
}

{
    const host = document.createElement('div');
    const rowsOf = keys => keys.map(key => ({ key, html: `<span class="ls-line">${key}</span>` }));
    const keys = Array.from({ length: 300 }, (_, i) => `w1.${i}:0`);
    scribe.syncRows(host, rowsOf(keys));
    const survivor = host.children[150];
    const realCreate = document.createElement;
    let created = 0;
    document.createElement = tag => { created++; return realCreate(tag); };
    scribe.syncRows(host, rowsOf([...keys.slice(1), 'w1.300:0']));
    document.createElement = realCreate;
    eq(created, 1,
       'rows: when the oldest line scrolls out and a new one arrives, one row is created instead of every row again');
    ok(host.children[149] === survivor && host.children.length === 300,
       'rows: and every other row stays the node it was');
    scribe.syncRows(host, rowsOf([...keys.slice(1, 100), ...keys.slice(101), 'w1.300:0']));
    ok(host.children.length === 299 && host.children.every(child => child.dataset.key !== keys[100]),
       'rows: a line removed from the middle, as a repetition review does, is removed without rebuilding the rest');
}

{
    let spoken = 0;
    globalThis.fetch = async () => {
        spoken++;
        const words = Array.from({ length: 12 }, (_, i) => `r${spoken}x${i}`).join(' ');
        return {
            ok: true,
            status: 200,
            async json() {
                return { text: words, segments: [{ start: 2.0, end: 4.0, text: words }], language: 'en' };
            }
        };
    };
    const chunk = new Float32Array(RATE * WINDOW_SEC);
    for (let i = 0; i < chunk.length; i++) chunk[i] = Math.sin(i / 25) * 0.3;
    ok(scribe.startLiveScribe(61, RATE, 0) === true, 'rows: a recording without translation boxes starts');
    for (let k = 0; k < 6; k++) { scribe.pushLivePcm(chunk, RATE); await settle(6); }
    const text = document.getElementById('live-scribe-text');
    const second = text.children[1];
    ok(second && second.dataset && /r\d+x0/.test(text.innerHTML), 'rows: each line is a row of its own');
    scribe.pushLivePcm(chunk, RATE);
    await settle(10);
    ok(text.children[1] === second,
       'rows: a new window adds its line without rebuilding the lines already on screen');
    scribe.closeLiveScribe();
}

{
    let requests = 0;
    globalThis.fetch = async () => {
        requests++;
        const final = requests > 1;
        const text = final ? 'the last thing said before stopping' : 'the first window of speech';
        const segment = final ? { start: 2.2, end: 3.8, text } : { start: 0.3, end: 3.7, text };
        return { ok: true, status: 200, async json() { return { text, segments: [segment], language: 'en' }; } };
    };
    const chunk = new Float32Array(RATE * WINDOW_SEC);
    for (let i = 0; i < chunk.length; i++) chunk[i] = Math.sin(i / 25) * 0.3;
    ok(scribe.startLiveScribe(71, RATE, 0) === true, 'stop: a recording with live transcription starts');
    scribe.pushLivePcm(chunk, RATE);
    await settle(20);
    scribe.pushLivePcm(chunk.subarray(0, RATE * 2), RATE);
    await scribe.flushLiveScribe();
    const saved = scribe.liveScribeResult().lines.map(line => line.text).join(' | ');
    ok(/the last thing said before stopping/.test(saved),
       `stop: the words said in the last seconds before Stop are in the saved live transcript (${saved})`);
    scribe.closeLiveScribe();
}

{
    const windows = [
        [{ start: 0.2, end: 0.6, text: 'Okay.' },
         { start: 0.7, end: 1.9, text: 'Okay, so we need to fix the bug.' },
         { start: 2.0, end: 2.9, text: 'We need to test the bug.' },
         { start: 3.0, end: 3.4, text: 'Yes, I think so.' },
         { start: 3.5, end: 3.9, text: 'Yes, I know so.' }],
        [{ start: 1.0, end: 2.6, text: 'Yes, I know so. Let us ship it.' },
         { start: 4.1, end: 6.0, text: 'I think we should' }],
        [{ start: 0.0, end: 3.5, text: 'I think we should go to the park.' }]
    ];
    let requests = 0;
    globalThis.fetch = async () => {
        const segments = windows[requests++] || [];
        return { ok: true, status: 200,
                 async json() { return { text: segments.map(one => one.text).join(' '), segments, language: 'en' }; } };
    };
    const chunk = new Float32Array(RATE * WINDOW_SEC);
    for (let i = 0; i < chunk.length; i++) chunk[i] = Math.sin(i / 25) * 0.3;
    ok(scribe.startLiveScribe(72, RATE, 0) === true, 'seams: a recording with live transcription starts');
    for (let k = 0; k < windows.length; k++) {
        scribe.pushLivePcm(chunk, RATE);
        await settle(20);
    }
    const saved = scribe.liveScribeResult().lines.map(line => line.text);
    eq(saved.slice(0, 5).join(' | '),
       'Okay. | Okay, so we need to fix the bug. | We need to test the bug. | Yes, I think so. | Yes, I know so.',
       'seams: sentences that only resemble the one before them are kept, because only the overlap with the previous window can repeat it');
    eq(saved[5], 'Let us ship it.', 'seams: while the words the previous window already heard are still removed');
    eq(saved.slice(6).join(' | '), 'I think we should | go to the park.',
       'seams: and a sentence split across two windows is saved in the order it was spoken');
    scribe.closeLiveScribe();
}

{
    let requests = 0;
    globalThis.fetch = async (url, init) => {
        const view = new DataView(await init.body.arrayBuffer());
        const samples = (view.byteLength - 44) / 2;
        let peak = 0;
        for (let i = Math.max(0, samples - 16000); i < samples; i++) peak = Math.max(peak, Math.abs(view.getInt16(44 + 2 * i, true)) / 32768);
        requests++;
        const text = `${peak > 0.4 ? 'after' : 'before'} the pause, request ${requests}`;
        return { ok: true, status: 200, async json() {
            return { text, segments: [{ start: samples / 16000 - 1.5, end: samples / 16000 - 0.5, text }], language: 'en' };
        } };
    };
    const HIGH = 48000;
    const tone = amplitude => {
        const out = new Float32Array(HIGH * WINDOW_SEC);
        for (let i = 0; i < out.length; i++) out[i] = Math.sin(i / 25) * amplitude;
        return out;
    };
    ok(scribe.startLiveScribe(73, HIGH, 0) === true, 'resume: a recording with live transcription starts');
    for (let k = 0; k < 2; k++) { scribe.pushLivePcm(tone(0.1), HIGH); await settle(30); }
    scribe.pushLivePcm(tone(0.1), HIGH);
    scribe.pauseLiveScribe();
    ok(scribe.startLiveScribe(73, HIGH, 12) === true, 'resume: 📝 is shown again while a window from before the pause is still being prepared');
    await settle(30);
    for (let k = 0; k < 4; k++) { scribe.pushLivePcm(tone(0.6), HIGH); await settle(30); }
    const lines = scribe.liveScribeResult().lines;
    const described = lines.map(line => line.text).join(' | ');
    eq(lines.filter(line => /^after/.test(line.text)).length, 4,
       `resume: every window after the pause is shown, none knocked out by a window cut before it (${described})`);
    eq(lines.filter(line => /^before/.test(line.text)).length, 2,
       `resume: a window still being prepared when 📝 was hidden is dropped with that session's other unsent audio, not added to the new one (${described})`);
    scribe.closeLiveScribe();
}

{
    let poisonTries = 0;
    globalThis.fetch = async (url, init) => {
        const view = new DataView(await init.body.arrayBuffer());
        const samples = (view.byteLength - 44) / 2;
        const window = Math.round(view.getInt16(44 + 2 * (samples - 1), true) / 32768 * 64) - 1;
        if (window === 1) {
            poisonTries++;
            return { ok: false, status: 500, async json() { return {}; } };
        }
        const text = `window ${window} is heard`;
        return { ok: true, status: 200, async json() {
            return { text, segments: [{ start: samples / 16000 - 1.5, end: samples / 16000 - 0.5, text }], language: 'en' };
        } };
    };
    const level = k => new Float32Array(RATE * WINDOW_SEC).fill((k + 1) / 64);
    ok(scribe.startLiveScribe(74, RATE, 0) === true, 'poison: a recording with live transcription starts');
    for (let k = 0; k < 6; k++) { scribe.pushLivePcm(level(k), RATE); await settle(10); }
    await new Promise(resolve => setTimeout(resolve, 1300));
    await settle(40);
    for (let k = 6; k < 8; k++) { scribe.pushLivePcm(level(k), RATE); await settle(10); }
    const result = scribe.liveScribeResult();
    const heard = result.lines.map(line => line.text);
    eq(heard.join(' | '),
       'window 0 is heard | window 2 is heard | window 3 is heard | window 4 is heard | window 5 is heard | window 6 is heard | window 7 is heard',
       'poison: a window the server keeps failing on while it answers the others does not hold back every line after it');
    ok(poisonTries >= 2 && poisonTries <= 6, `poison: it is tried a few times, not for the rest of the recording (${poisonTries})`);
    ok(!result.coverage.some(range => range.fromSec < 7.5 && range.toSec > 4.5),
       'poison: its audio is left for the transcription after the recording');
    const shown = document.getElementById('live-scribe-text').innerHTML;
    ok(/the server kept failing on 00:04-00:08/.test(shown),
       'poison: the live transcript says which part was left out and why');
    ok(/marked in the saved transcript for 📝 Fill gaps/.test(shown) && !/transcribed after the recording/.test(shown),
       'poison: with Auto-transcribe off it promises that part to 📝 Fill gaps, not to a transcription after the recording that will not run');
    ok(/ls-gap">…<\/span> <span class="ls-ts">\[00:10\]/.test(shown),
       'poison: the gap is marked on the line right after the skipped window');
    scribe.closeLiveScribe();
}

{
    const real = { now: Date.now, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout,
                   setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval };
    let virtualNow = real.now.call(Date);
    let seq = 0;
    const timers = new Map();
    Date.now = () => virtualNow;
    globalThis.setTimeout = (fn, ms = 0, ...args) => {
        const id = ++seq;
        timers.set(id, { at: virtualNow + Math.max(0, Number(ms) || 0), fn, args });
        return id;
    };
    globalThis.clearTimeout = id => { timers.delete(id); };
    globalThis.setInterval = () => ++seq;
    globalThis.clearInterval = () => {};
    globalThis.CSS = globalThis.CSS || { escape: value => String(value) };
    const flush = async (rounds = 30) => { for (let i = 0; i < rounds; i++) await new Promise(resolve => setImmediate(resolve)); };
    const advanceVirtualClock = async ms => {
        const target = virtualNow + ms;
        for (;;) {
            let nextId = null;
            let next = null;
            for (const [id, timer] of timers) if (timer.at <= target && (!next || timer.at < next.at)) { next = timer; nextId = id; }
            if (!next) break;
            virtualNow = next.at;
            timers.delete(nextId);
            try { next.fn(...next.args); } catch (_) {}
            await flush();
        }
        virtualNow = target;
        await flush();
    };

    let ollamaUp = true;
    let windowNo = 0;
    const heldBack = [];
    globalThis.fetch = async (url, init = {}) => {
        url = String(url);
        if (url.startsWith('/transcribe')) {
            const samples = (init.body.size - 44) / 2;
            const k = windowNo++;
            const text = k % 2
                ? `Dit is Nederlandse zin nummer ${k} met een aantal woorden erin.`
                : `This is English sentence number ${k} with several words in it.`;
            return { ok: true, status: 200, async json() {
                return { text, segments: [{ start: samples / 16000 - 1.5, end: samples / 16000 - 0.5, text }],
                         language: k % 2 ? 'nl' : 'en' };
            } };
        }
        if (!ollamaUp) throw new TypeError('Failed to fetch');
        if (url.endsWith('/api/tags')) return { ok: true, status: 200, async json() { return { models: [{ name: 'qwen3:8b' }] }; } };
        if (url.endsWith('/api/ps')) {
            return { ok: true, status: 200, async json() { return { models: [{ name: 'qwen3:8b', size: 10, size_vram: 10 }] }; } };
        }
        const body = JSON.parse(init.body || '{}');
        if (!body.prompt) return { ok: true, status: 200, async json() { return {}; } };
        const numbered = [...body.prompt.matchAll(/^(\d+)\. (.*)$/gm)].map(match => match[2]);
        const fenced = body.prompt.match(/---\n([\s\S]*?)\n---/);
        const response = numbered.length
            ? numbered.map((line, i) => `${i + 1}. T(${line})`).join('\n')
            : `T(${fenced ? fenced[1] : ''})`;
        return { ok: true, status: 200, async json() { return { response, prompt_eval_duration: 1e6, eval_duration: 2e8 }; } };
    };
    const heads = () => {
        const host = document.getElementById('live-scribe-text').children.find(child => child.className === 'ls-panels');
        return host ? host.children.map(panel => panel.children.find(child => child.className === 'ls-panel-head').textContent) : [];
    };

    store.set('set-translate-panels', '2');
    try {
        const chunk = new Float32Array(RATE * WINDOW_SEC);
        for (let i = 0; i < chunk.length; i++) chunk[i] = Math.sin(i / 25) * 0.3;
        ok(scribe.startLiveScribe(75, RATE, 0) === true, 'outage: a recording with two translation boxes starts');
        for (let k = 0; k < 8; k++) { scribe.pushLivePcm(chunk, RATE); await flush(); await advanceVirtualClock(4000); }
        ok(heads().length === 2 && heads().every(head => !/waiting/.test(head)),
           `outage: both boxes keep up while the AI server answers (${heads().join(' | ')})`);
        ollamaUp = false;
        for (let k = 0; k < 15; k++) { scribe.pushLivePcm(chunk, RATE); await flush(); await advanceVirtualClock(4000); }
        ok(heads().some(head => /waiting/.test(head)), `outage: lines wait while the AI server is down (${heads().join(' | ')})`);
        ollamaUp = true;
        let caughtUpAfter = null;
        for (let s = 4; s <= 40 && caughtUpAfter == null; s += 4) {
            scribe.pushLivePcm(chunk, RATE);
            await flush();
            await advanceVirtualClock(4000);
            if (heads().every(head => !/waiting/.test(head))) caughtUpAfter = s;
        }
        ok(caughtUpAfter != null && caughtUpAfter <= 20,
           `outage: once the AI server is back every waiting line is translated within 20 seconds (${caughtUpAfter}s: ${heads().join(' | ')})`);
        const copied = scribe.liveScribeTranscriptText();
        ok(!/not translated\]/.test(copied),
           'outage: a minute without the AI server marks no line "not translated": the server being down is not the line\'s fault');
    } finally {
        store.delete('set-translate-panels');
        scribe.closeLiveScribe();
        Date.now = real.now;
        globalThis.setTimeout = real.setTimeout;
        globalThis.clearTimeout = real.clearTimeout;
        globalThis.setInterval = real.setInterval;
        globalThis.clearInterval = real.clearInterval;
        heldBack.length = 0;
    }
}

{
    globalThis.CSS = globalThis.CSS || { escape: value => String(value) };
    let generate = 0;
    let windowNo = 0;
    const dutch = ['Goedemorgen allemaal, fijn dat jullie er zijn vandaag.', 'We beginnen met het eerste punt op de agenda.',
                   'Het budget voor volgend jaar moet nog worden goedgekeurd.', 'Wie wil er als eerste iets over zeggen?'];
    globalThis.fetch = async (url, init = {}) => {
        url = String(url);
        if (url.startsWith('/transcribe')) {
            const k = windowNo++;
            const body = k === 0
                ? { text: '', segments: [], language: 'en' }
                : { text: dutch[k % dutch.length], segments: [{ start: 2.5, end: 5.5, text: dutch[k % dutch.length] }], language: 'nl' };
            return { ok: true, status: 200, async json() { return body; } };
        }
        if (url.endsWith('/api/generate') && JSON.parse(init.body || '{}').prompt) generate++;
        return { ok: true, status: 200, async json() { return { models: [{ name: 'qwen3:8b' }], response: 'vertaald' }; } };
    };
    store.set('set-translate-panels', '2');
    try {
        const chunk = new Float32Array(RATE * WINDOW_SEC).fill(0.2);
        ok(scribe.startLiveScribe(76, RATE, 0) === true, 'first language: a recording with two translation boxes starts');
        for (let k = 0; k < 8; k++) { scribe.pushLivePcm(chunk, RATE); await settle(15); }
        const host = document.getElementById('live-scribe-text').children.find(child => child.className === 'ls-panels');
        ok(!host && generate === 0,
           `first language: a silent first window the server tagged as English opens no English box in a Dutch meeting, and nothing is sent for translation (${generate} requests)`);
        eq(document.getElementById('live-scribe-languages').textContent, '🌐 NL',
           'first language: the header names the language actually spoken');
    } finally {
        store.delete('set-translate-panels');
        scribe.closeLiveScribe();
    }
}

{
    globalThis.fetch = async (url, init = {}) => {
        const samples = (init.body.size ? init.body.size - 44 : init.body.byteLength - 44) / 2;
        const text = 'Dit is wat er werd gezegd voordat 📝 aan ging.';
        return { ok: true, status: 200, async json() {
            return { text, segments: [{ start: 0.5, end: Math.max(1, samples / 16000 - 0.5), text }], language: 'nl' };
        } };
    };
    ok(scribe.startLiveScribe(77, RATE, 12) === true, 'backfill language: 📝 is turned on 12 seconds into a recording');
    await scribe.backfillLiveScribe(77, 12);
    await settle();
    const backfilled = (scribe.liveScribeResult() || { lines: [] }).lines.filter(line => line.startSec < 12);
    ok(backfilled.length > 0 && backfilled.every(line => line.language === 'nl'),
       `backfill language: the lines transcribed from before 📝 carry the language they were spoken in (${JSON.stringify(backfilled.map(line => line.language))})`);
    scribe.closeLiveScribe();
}

{
    let n = 0;
    globalThis.fetch = async (url, init = {}) => {
        const samples = (init.body.size - 44) / 2;
        const text = `row number ${n++} of the session`;
        return { ok: true, status: 200, async json() {
            return { text, segments: [{ start: samples / 16000 - 1.5, end: samples / 16000 - 0.5, text }], language: 'en' };
        } };
    };
    const chunk = new Float32Array(RATE * WINDOW_SEC).fill(0.2);
    ok(scribe.startLiveScribe(78, RATE, 0) === true, 'rows kept: a recording with live transcription starts');
    for (let k = 0; k < 5; k++) { scribe.pushLivePcm(chunk, RATE); await settle(10); }
    const rowsBefore = [...document.getElementById('live-scribe-text').children];
    scribe.pauseLiveScribe();
    ok(scribe.startLiveScribe(78, RATE, 20) === true, 'rows kept: 📝 is shown again');
    const rowsAfter = [...document.getElementById('live-scribe-text').children];
    ok(rowsBefore.length === 5 && rowsAfter.length === 5 && rowsBefore.every((row, i) => row === rowsAfter[i]),
       `rows kept: showing 📝 again keeps the rows already on screen instead of building every one again (${rowsBefore.length} rows)`);
    scribe.closeLiveScribe();
}

{
    const replies = [
        [{ start: 2.5, end: 3.9, text: 'and then we decided to leave early.' }],
        [{ start: 0.5, end: 1.9, text: 'Did it to leave early.' }],
        [{ start: 2.4, end: 3.6, text: 'Next topic is hiring.' }]
    ];
    let requests = 0;
    globalThis.fetch = async () => {
        const segments = replies[Math.min(requests++, replies.length - 1)];
        return { ok: true, status: 200, async json() { return { text: segments[0].text, segments, language: 'en' }; } };
    };
    const speech = (from, to) => {
        const chunk = new Float32Array(RATE * WINDOW_SEC);
        chunk.fill(0.2, Math.round(from * RATE), Math.round(to * RATE));
        return chunk;
    };
    ok(scribe.startLiveScribe(79, RATE, 0) === true, 'overlap only: a recording with live transcription starts');
    scribe.pushLivePcm(speech(2.5, 4), RATE);
    await settle(15);
    scribe.pushLivePcm(speech(0, 0), RATE);
    await settle(15);
    scribe.pushLivePcm(speech(0.4, 1.6), RATE);
    await settle(15);
    const lines = scribe.liveScribeResult().lines.map(line => line.text);
    eq(lines.join(' | '), 'and then we decided to leave early. | Next topic is hiring.',
       'overlap only: a window whose only words lie in the part the previous window already heard, followed by quiet, adds no line of its own');
    ok(!/ls-gap/.test(document.getElementById('live-scribe-text').innerHTML),
       'overlap only: and a window that was heard and held nothing new does not mark the next line as coming after a gap');
    scribe.closeLiveScribe();
}

{
    const replies = [
        [{ start: 2.5, end: 4.0, text: 'and then we decided to leave' }],
        [{ start: 0.5, end: 2.4, text: 'then we decided to leave early.' }]
    ];
    let requests = 0;
    globalThis.fetch = async () => {
        const segments = replies[Math.min(requests++, replies.length - 1)];
        return { ok: true, status: 200, async json() { return { text: segments[0].text, segments, language: 'en' }; } };
    };
    const speech = (from, to) => {
        const chunk = new Float32Array(RATE * WINDOW_SEC);
        chunk.fill(0.2, Math.round(from * RATE), Math.round(to * RATE));
        return chunk;
    };
    ok(scribe.startLiveScribe(82, RATE, 0) === true, 'runs on: a recording with live transcription starts');
    scribe.pushLivePcm(speech(2.5, 4), RATE);
    await settle(15);
    scribe.pushLivePcm(speech(0, 0.4), RATE);
    await settle(15);
    const lines = scribe.liveScribeResult().lines.map(line => line.text);
    eq(lines.join(' | '), 'and then we decided to leave | early.',
       'runs on: the end of a sentence that began in the carry and runs on into the next window\'s own audio is kept');
    scribe.closeLiveScribe();
}

for (const { tail, spoken, expected, label } of [
    { tail: 2.25, spoken: 0.25, expected: 'and then we decided to leave | early.',
      label: 'runs on briefly: the end of a sentence that runs on a quarter of a second into the next window, followed by quiet, is kept' },
    { tail: 2.15, spoken: 0, expected: 'and then we decided to leave',
      label: 'runs on briefly: a sentence the server places a little past the carry, where the next window is quiet, is the previous window\'s words heard again and adds nothing' }
]) {
    const replies = [
        [{ start: 2.5, end: 4.0, text: 'and then we decided to leave' }],
        [{ start: 0.5, end: tail, text: 'then we decided to leave early.' }]
    ];
    let requests = 0;
    globalThis.fetch = async () => {
        const segments = replies[Math.min(requests++, replies.length - 1)];
        return { ok: true, status: 200, async json() { return { text: segments[0].text, segments, language: 'en' }; } };
    };
    const speech = (from, to) => {
        const chunk = new Float32Array(RATE * WINDOW_SEC);
        chunk.fill(0.2, Math.round(from * RATE), Math.round(to * RATE));
        return chunk;
    };
    ok(scribe.startLiveScribe(83, RATE, 0) === true, 'runs on briefly: a recording with live transcription starts');
    scribe.pushLivePcm(speech(2.5, 4), RATE);
    await settle(15);
    scribe.pushLivePcm(speech(0, spoken), RATE);
    await settle(15);
    eq(scribe.liveScribeResult().lines.map(line => line.text).join(' | '), expected, label);
    scribe.closeLiveScribe();
}

{
    const LEVELS_PER_UNIT = 64;
    const levelOf = n => (n + 1) / LEVELS_PER_UNIT;
    const heard = [];
    let release = null;
    let held = new Promise(resolve => { release = resolve; });
    globalThis.fetch = async (url, init = {}) => {
        const view = new DataView(await init.body.arrayBuffer());
        const samples = (view.byteLength - 44) / 2;
        const first = Math.round(view.getInt16(44, true) / 32767 * LEVELS_PER_UNIT) - 1;
        heard.push({ seconds: samples / RATE, first });
        await held;
        const text = `w${first}a w${first}b w${first}c`;
        return { ok: true, status: 200, async json() {
            return { text, segments: [{ start: samples / RATE - 1.5, end: samples / RATE - 0.5, text }], language: 'en' };
        } };
    };
    document.visibilityState = 'hidden';
    ok(scribe.startLiveScribe(80, RATE, 0) === true, 'drop: a recording with live transcription starts');
    for (let second = 0; second < 80; second++) {
        scribe.pushLivePcm(new Float32Array(RATE).fill(levelOf(second)), RATE);
        await settle(2);
    }
    const beforeRelease = heard.length;
    release();
    await settle(60);
    const afterDrop = heard[beforeRelease];
    ok(beforeRelease === 2 && afterDrop,
       `drop: while the server holds two windows the rest waits, and once more than a minute is waiting the oldest is let go (${beforeRelease} held, then ${heard.length - beforeRelease})`);
    eq(afterDrop.seconds, WINDOW_SEC,
       'drop: the first window after audio was let go carries nothing from before the gap');
    ok(afterDrop.first >= 19,
       `drop: it starts with audio from after the gap (second ${afterDrop.first}), not with the end of the last window sent before it`);
    scribe.closeLiveScribe();
    delete document.visibilityState;
}

{
    const LEVEL_BASE = 1600;
    const LEVEL_STEP = 64;
    const utterances = [
        { from: 5.0, to: 8.0, text: 'We start with the numbers from last week.' },
        { from: 28.6, to: 31.8, text: 'Then Anna presented the new roadmap.' },
        { from: 34.0, to: 36.5, text: 'Everyone agreed to try it for a month.' }
    ];
    const prefix = new Float32Array(RATE * 40);
    utterances.forEach((u, i) => prefix.fill((LEVEL_BASE + LEVEL_STEP * i) / 32767, Math.round(u.from * RATE), Math.round(u.to * RATE)));
    scribe.setLiveScribeAudioSource(async () => encodeMonoWav(prefix, RATE));
    globalThis.fetch = async (url, init = {}) => {
        const view = new DataView(await init.body.arrayBuffer());
        const samples = (view.byteLength - 44) / 2;
        const segments = [];
        let run = null;
        for (let i = 0; i <= samples; i++) {
            const value = i < samples ? view.getInt16(44 + 2 * i, true) : 0;
            const index = value > LEVEL_BASE / 2 ? Math.round((value - LEVEL_BASE) / LEVEL_STEP) : -1;
            if (run && run.index === index) continue;
            if (run && run.index >= 0) segments.push({ start: run.from / RATE, end: i / RATE, text: utterances[run.index].text });
            run = { index, from: i };
        }
        return { ok: true, status: 200, async json() {
            return { text: segments.map(s => s.text).join(' '), segments, language: 'en' };
        } };
    };
    ok(scribe.startLiveScribe(81, RATE, 40) === true, 'backfill seams: 📝 is turned on 40 seconds into a recording');
    await scribe.backfillLiveScribe(81, 40);
    await settle();
    const lines = scribe.liveScribeResult().lines.map(line => line.text);
    eq(lines.join(' | '), utterances.map(u => u.text).join(' | '),
       'backfill seams: a sentence both backfill windows heard where they overlap is shown once');
    scribe.closeLiveScribe();
    scribe.setLiveScribeAudioSource(async () => prefixBlob);
}

console.log(`✓ all ${assertions} live-scribe assertions passed`);
emitTestResult('live-scribe-unit', 'pass', { assertions });
