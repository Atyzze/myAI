// Behaviour that static-integrity used to check by reading the source text, checked here by running
// the real modules over the in-memory IndexedDB (tests/helpers/app-harness.mjs): the database
// connection's life, what the storage total counts, deletions that offer a backup first, the
// backup itself, background sweeps, and the jobs a deletion stops.
import { emitTestResult } from '../helpers/test-result.mjs';
const { page, memoryIdb, settle } = await import('../helpers/app-harness.mjs');
const { CONFIG } = await import('../../src/js/config.js');
const db = await import('../../src/js/db.js');
const { encodeMonoWav } = await import('../../src/js/audio.js');
const { retentionAckToken } = await import('../../src/js/retention-core.js');
const jobs = await import('../../src/js/jobs.js');
const settings = await import('../../src/js/settings.js');
settings.exposeSettingsGlobals();

let assertions = 0;
function ok(value, message) {
    assertions++;
    if (!value) throw new Error(`Assertion failed: ${message}`);
}
function eq(actual, expected, message) {
    ok(actual === expected, `${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

const DAY = 24 * 60 * 60 * 1000;
const wav = seconds => encodeMonoWav(new Float32Array(Math.round(seconds * 8000)).fill(0.1), 8000);

async function addRecording(fields = {}, { audio = null, live = null, fragments = [] } = {}) {
    const id = await db.dbExec(CONFIG.STORE_REC, 'add', {
        timestamp: Date.now(), durationMs: 60000, format: 'wav', sampleRate: 8000, captureState: 'ready',
        processing: false, transcripts: [], summaries: [], ...fields,
        ...(audio ? { audioBytes: audio.size } : {})
    });
    if (audio) await db.writeAudio(id, audio);
    if (live) await db.writeLiveTranscript(id, live);
    for (const fragment of fragments) {
        await db.dbExec(CONFIG.STORE_FRAGMENTS, 'add', { recId: id, sessionId: null, seq: fragment.seq ?? 0, bytes: fragment.blob.size, blob: fragment.blob });
    }
    return id;
}
const row = id => db.dbExec(CONFIG.STORE_REC, 'get', id);
const liveLines = texts => ({ lines: texts.map((text, i) => ({ startSec: i * 2, endSec: i * 2 + 1.5, text })), languages: [], coverage: [] });

async function clearAll() {
    for (const store of [CONFIG.STORE_REC, CONFIG.STORE_AUDIO, CONFIG.STORE_FRAGMENTS, CONFIG.STORE_LIVE]) {
        await db.dbExec(store, 'clear');
    }
    await db.dbExec(CONFIG.STORE_BEATS, 'clear').catch(() => {});
    page.reset();
    localStorage.clear();
}

function zipEntries(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const entries = new Map();
    let at = 0;
    while (at + 30 <= bytes.length && view.getUint32(at, true) === 0x04034b50) {
        const size = view.getUint32(at + 18, true);
        const nameLength = view.getUint16(at + 26, true);
        const extraLength = view.getUint16(at + 28, true);
        const name = new TextDecoder().decode(bytes.subarray(at + 30, at + 30 + nameLength));
        const start = at + 30 + nameLength + extraLength;
        entries.set(name, bytes.subarray(start, start + size));
        at = start + size;
    }
    return entries;
}

// The database connection, when another tab opens a newer version of the database.
{
    await clearAll();
    db.setDatabaseBusyCheck(() => false);
    const id = await addRecording({ filename: 'before the upgrade' });
    memoryIdb.versionChange();
    eq(db.databaseGuardState(), 'closed', 'connection: an idle tab gives its connection up when a newer version asks for it');
    let failure = null;
    try { await row(id); } catch (err) { failure = err; }
    ok(failure && failure.name === 'VersionError' && db.databaseGuardState() === 'stale',
       `connection: a connection that was closed is forgotten, so the next use opens a fresh one instead of throwing forever, and learns this tab is older than the database (${failure && failure.name}, ${db.databaseGuardState()})`);

    memoryIdb.reset();
    ok(!!(await addRecording({ filename: 'a fresh database' })), 'connection: with the database back at this version the tab works again');
    eq(db.databaseGuardState(), 'open', 'connection: and says so');

    db.setDatabaseBusyCheck(() => true);
    memoryIdb.versionChange();
    eq(db.databaseGuardState(), 'blocked',
       'connection: what counts as busy is whether this tab is holding a recording: a busy tab keeps its connection and says a newer version waits');
    ok(!!(await db.dbExec(CONFIG.STORE_REC, 'getAll')), 'connection: and goes on using it');
    ok(!db.noteDatabaseIdle(), 'connection: it is not given up while the tab is still busy');
    db.setDatabaseBusyCheck(() => false);
    ok(db.noteDatabaseIdle(), 'connection: once the tab is idle it is given up');
    eq(db.databaseGuardState(), 'closed', 'connection: and the tab says so');
    memoryIdb.reset();
}

// What the storage total counts, and audio that only a willing row takes.
{
    await clearAll();
    const kept = wav(2);
    await addRecording({ filename: 'kept' }, { audio: kept });
    const piece = wav(1);
    await addRecording({ filename: 'still recording', processing: true, captureState: 'recording' }, { fragments: [{ blob: piece }] });
    await db.calcTotalStorage();
    eq(db.getStorageTotal(), kept.size + piece.size,
       'storage: each stored recording is counted once, from the audio store and the pieces still being recorded, never again from the row that describes it');

    const refused = await addRecording({ filename: 'refuses' });
    const result = await db.commitAudio(refused, wav(1), () => null);
    ok(result === null && !(await db.readAudio(refused)),
       'storage: the audio is written only after the row has agreed to take it, so a row that refuses leaves no audio behind');
    const gone = await addRecording({ filename: 'deleted meanwhile' });
    await db.dbExec(CONFIG.STORE_REC, 'delete', gone);
    await db.commitAudio(gone, wav(1), rec => (rec ? { ...rec, audioBytes: 1 } : null));
    ok(!(await db.readAudio(gone)), 'storage: nor does a recording deleted while its audio was being prepared');
}

// The startup sweep of live transcripts.
{
    await clearAll();
    const owned = await addRecording({ filename: 'owned' }, { live: liveLines(['kept']) });
    await db.writeLiveTranscript(owned + 1000, liveLines(['orphan']));
    memoryIdb.ops = [];
    const removed = await db.cleanupOrphanLiveTranscripts();
    ok(removed === 1 && !(await db.readLiveTranscript(owned + 1000)) && !!(await db.readLiveTranscript(owned)),
       'sweep: a live transcript whose recording is gone is removed, and one whose recording is there is kept');
    ok(!memoryIdb.ops.some(op => op.store === CONFIG.STORE_LIVE && (op.action === 'getAll' || op.action === 'cursor')),
       `sweep: the startup sweep of live transcripts reads their keys, never every transcript (${JSON.stringify(memoryIdb.ops.filter(op => op.store === CONFIG.STORE_LIVE))})`);
}

// Deleting everything, with a backup offered first.
{
    await clearAll();
    const id = await addRecording({ filename: 'with audio', transcripts: [{ id: 1, text: 'hello', time: Date.now() }],
                                    liveTranscriptLines: 1 }, { audio: wav(1), live: liveLines(['hello']) });
    const textOnly = await addRecording({ filename: 'text only', transcripts: [{ id: 1, text: 'hi', time: Date.now() }],
                                          liveTranscriptLines: 1 }, { live: liveLines(['hi']) });
    page.answer(true, false);
    await window.deleteAllText();
    const kept = await row(id);
    ok(kept && kept.transcripts.length === 0 && !!(await db.readAudio(id)),
       'delete all text: a recording that keeps its audio loses its transcripts');
    ok(!(await db.readLiveTranscript(id)) && !(await db.readLiveTranscript(textOnly)) && kept.liveTranscriptLines === undefined,
       'delete all text: and so do the live transcripts of the rows it empties and of the rows it removes: no stored transcript outlives the dialog that deleted it');
    ok(!(await row(textOnly)), 'delete all text: a recording with nothing left is removed');

    await clearAll();
    const audioId = await addRecording({ filename: 'backup declined', transcripts: [{ id: 1, text: 'x', time: Date.now() }] }, { audio: wav(1) });
    page.answer(true, true, false, false);
    await window.deleteAllAudio();
    ok(!!(await db.readAudio(audioId)),
       'delete all audio: when the backup was not made and the person says not to go on, nothing is deleted: no destructive action runs the backup offer without reading its answer');
    ok(page.asked('confirm').some(dialog => /No backup was saved/.test(dialog.message)), 'delete all audio: and the person is told no backup was saved');

    await clearAll();
    const textId = await addRecording({ filename: 'backup made', transcripts: [{ id: 1, text: 'x', time: Date.now() }] }, { audio: wav(1) });
    page.answer(true, true, true, false);
    await window.deleteAllText();
    ok(page.downloads.length === 1, 'delete all text: the backup is downloaded first');
    ok((await row(textId)).transcripts.length === 1,
       'delete all text: and it deletes nothing until the person says the backup file was saved');
}

// The backup names only the audio it really holds.
{
    await clearAll();
    const present = await addRecording({ filename: 'present' }, { audio: wav(1) });
    const lost = await addRecording({ filename: 'lost', audioBytes: 4000 });
    page.answer(true);
    ok(await window.downloadBackup(), 'backup: a backup with a recording whose audio cannot be read is still made');
    const zip = zipEntries(new Uint8Array(await page.downloads[0].blob.arrayBuffer()));
    const listing = JSON.parse(new TextDecoder().decode(zip.get('transcripts.json')));
    const entry = listing.recordings.find(item => item.id === lost);
    ok(entry && entry.audioFile === null && entry.audioMissing === true && listing.manifest.audioMissing === 1,
       `backup: a backup names only the audio it really holds, and lists what it could not read (${JSON.stringify(entry)})`);
    ok(listing.recordings.find(item => item.id === present).audioFile, 'backup: the audio it does hold is named');
    ok(page.asked('alert').some(dialog => /could not be read/.test(dialog.message)), 'backup: and the person is told');

    let sweepDuringBackup = null;
    page.answer(() => { sweepDuringBackup = settings.runRetentionSweep({ announce: false }); return true; });
    await window.downloadBackup();
    eq((await sweepDuringBackup).skipped, 'backup', 'backup: no sweep runs while a backup is being made');
}

// Background sweeps and the jobs a deletion stops.
{
    await clearAll();
    localStorage.setItem('set-retention-audio', '1h');
    localStorage.setItem('set-retention-text', '1h');
    localStorage.setItem('retention-policy-acknowledged-v2', retentionAckToken({ audio: '1h', text: '1h' }));
    await addRecording({ filename: 'old', timestamp: Date.now() - 3 * DAY }, { audio: wav(1) });
    let releaseOtherTab = null;
    const otherTab = navigator.locks.request('myai-active-recording', () => new Promise(resolve => { releaseOtherTab = resolve; }));
    await settle();
    await settings.runRetentionSweep({ announce: false });
    ok(page.asked('alert').length === 0,
       'sweep: the background sweep never interrupts an idle tab with a message about a recording in another one');
    releaseOtherTab();
    await otherTab;

    await clearAll();
    const recId = await addRecording({ filename: 'answered', transcripts: [{ id: 1, text: 't', time: Date.now() }],
                                       summaries: [{ id: 5, text: 'reply', transcriptId: 1, time: Date.now() }] });
    const transcription = jobs.beginJob('t', recId);
    page.answer(true);
    await window.deleteSummary(recId, 5);
    ok((await row(recId)).summaries.length === 0, 'jobs: the reply is deleted');
    const reply = jobs.beginJob('r', recId);
    page.answer(true);
    await window.deleteTranscript(recId, 1);
    ok((await row(recId)).transcripts.length === 0, 'jobs: the transcript is deleted');
    ok(jobs.hasJob('t', recId) && !transcription.signal.aborted && jobs.hasJob('r', recId) && !reply.signal.aborted,
       'jobs: deleting one transcript or reply leaves the other work on that recording running');
    jobs.endJob('t', recId, transcription);
    jobs.endJob('r', recId, reply);

    const fill = jobs.beginJob('f', recId);
    page.answer(true);
    await window.deleteRec(recId);
    await settle();
    ok(fill.signal.aborted && !jobs.hasJob('f', recId),
       'jobs: the translation fill is a job like the others, so deleting the recording stops it');
}

// The translation fill after a recording waits for a reply that is running.
{
    await clearAll();
    const transcribe = await import('../../src/js/transcribe.js');
    const generated = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
        const path = String(url);
        const reply = body => ({ ok: true, status: 200, async json() { return body; }, async text() { return JSON.stringify(body); } });
        if (path.endsWith('/api/tags')) return reply({ models: [{ name: 'qwen3.8:27b' }] });
        if (path.endsWith('/api/ps')) return reply({ models: [{ name: 'qwen3.8:27b', size: 1, size_vram: 1 }] });
        if (path.endsWith('/api/generate')) {
            const body = JSON.parse(init.body || '{}');
            generated.push(Date.now());
            const numbered = String(body.prompt || '').split('\n').filter(line => /^\d+\. /.test(line))
                .map(line => line.replace(/^(\d+)\. /, '$1. NL '));
            return reply({ model: body.model, response: numbered.join('\n'), done: true });
        }
        return reply({});
    };
    const id = await addRecording({ filename: 'two languages' }, {
        live: { lines: [{ key: 'a', startSec: 0, endSec: 2, text: 'Good morning', language: 'en', translations: {} },
                        { key: 'b', startSec: 3, endSec: 5, text: 'Goedemorgen', language: 'nl', translations: {} }],
                languages: ['en', 'nl'], coverage: [] }
    });
    const reply = jobs.beginJob('r', id + 1);
    const filling = transcribe.fillTranslations(id);
    await new Promise(resolve => setTimeout(resolve, 400));
    const whileReplying = generated.length;
    jobs.endJob('r', id + 1, reply);
    const outcome = await filling;
    globalThis.fetch = realFetch;
    ok(whileReplying === 0, `fill: the translation fill waits while a reply is running (${whileReplying} sent meanwhile)`);
    ok(outcome.filled > 0 && generated.length > 0, `fill: and completes once the reply has finished (${JSON.stringify(outcome)})`);
}

// A recording stopped before its translation boxes caught up: the rest is translated after the
// reply, in sight. The recording says so and how far it is, every answer is kept as it comes and
// reaches the transcript the row shows, and stopping it stops only it and keeps what was done.
{
    await clearAll();
    const recorder = await import('../../src/js/recorder.js');
    const { liveStatusText } = await import('../../src/js/live-tabs.js');
    const until = async (test, ms = 3000) => {
        const end = Date.now() + ms;
        while (Date.now() < end) { if (await test()) return true; await new Promise(resolve => setTimeout(resolve, 10)); }
        return false;
    };
    const generated = [];
    let releaseSecond = null;
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
        const path = String(url);
        const reply = body => ({ ok: true, status: 200, async json() { return body; }, async text() { return JSON.stringify(body); } });
        if (path.endsWith('/api/tags')) return reply({ models: [{ name: 'qwen3.8:27b' }] });
        if (path.endsWith('/api/ps')) return reply({ models: [{ name: 'qwen3.8:27b', size: 1, size_vram: 1 }] });
        if (path.endsWith('/api/generate')) {
            const body = JSON.parse(init.body || '{}');
            generated.push(body.prompt);
            if (generated.length === 2) {
                await new Promise((resolve, reject) => {
                    releaseSecond = resolve;
                    if (init.signal) init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
                });
            }
            const numbered = String(body.prompt || '').split('\n').filter(line => /^\d+\. /.test(line))
                .map(line => line.replace(/^(\d+)\. /, '$1. EN '));
            return reply({ model: body.model, response: numbered.join('\n'), done: true });
        }
        return reply({});
    };
    window.cancelRecJob = jobs.cancelAllForRec;   // as main.js wires it: the ✕ of a transcription or reply
    // The status line's ✕ is tapped for real: elements made from here on keep their listeners.
    const realCreateElement = document.createElement;
    const madeButtons = [];
    document.createElement = tag => {
        const el = realCreateElement(tag);
        const listeners = {};
        el.addEventListener = (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); };
        el.fire = type => (listeners[type] || []).forEach(fn => fn({ stopPropagation() {}, preventDefault() {} }));
        if (el.tagName === 'BUTTON') madeButtons.push(el);
        return el;
    };
    const transcribe = await import('../../src/js/transcribe.js');
    const lines = Array.from({ length: 30 }, (_, i) => ({ key: `l${i}`, startSec: i * 3, endSec: i * 3 + 2,
                                                         text: `Zin nummer ${i}`, language: 'nl', translations: {} }));
    const id = await addRecording({ filename: 'stopped mid backlog', durationMs: 100000 },
        { live: { lines, languages: ['nl', 'en'], coverage: [{ fromSec: 0, toSec: 92 }] } });
    await transcribe.storeLiveTranscript(id);
    await db.dbUpdate(CONFIG.STORE_REC, id, rec => {
        rec.transcripts.unshift({ id: 's1', source: 'S', fromLive: true, text: '[00:00-00:02] Zin nummer 0',
                                  plain: 'Zin nummer 0', time: Date.now() });
        return rec;
    });

    const reply = jobs.beginJob('r', id + 1);
    const completing = recorder.completeTranscriptColumns(id);
    await new Promise(resolve => setTimeout(resolve, 300));
    const waiting = liveStatusText(id, 'translate');
    ok(generated.length === 0 && waiting === '🌐 The rest follows the reply: English 0 of 30 lines',
       `after stop: while a reply runs the recording says its translations wait for it, and how many there are (${waiting})`);
    jobs.endJob('r', id + 1, reply);
    ok(await until(() => generated.length === 2 && releaseSecond), 'after stop: once the reply is done, the translations go on');
    const kept = await until(async () => {
        const live = await db.readLiveTranscript(id);
        return live.lines.filter(line => line.translations && line.translations.en).length === 24;
    });
    const shown = (await row(id)).transcripts.find(item => item.id === 's1');
    ok(kept && /── English - Engels \(6 lines not translated\) ──/.test(shown.text) && /EN Zin nummer 23/.test(shown.text) && /^── As spoken/.test(shown.text)
       && /\[00:00-00:02\] Zin nummer 0/.test(shown.text) && shown.plain === 'Zin nummer 0',
       `after stop: each answer is kept as it comes, and reaches the transcript the row shows, whose words replies use are left alone (${shown.text.slice(0, 160)})`);
    const liveReading = (await row(id)).transcripts.find(item => item.source === 'L');
    ok(/EN Zin nummer 23/.test(liveReading.text) && /\[01:32-01:40\] \[not transcribed live\]/.test(liveReading.text),
       `after stop: and the live reading too, which still marks what the live transcript never heard (${liveReading.text.split('\n').slice(29, 32).join(' / ')})`);
    eq(liveStatusText(id, 'translate'), '🌐 Translating the rest: English 24 of 30 lines',
       'after stop: the recording says how far its translations are');

    const sameRecordingReply = jobs.beginJob('r', id);
    const cross = madeButtons.filter(button => button.className === 'live-status-cancel').pop();
    ok(cross, 'after stop: the status line has a ✕');
    cross.fire('click');
    await completing;
    document.createElement = realCreateElement;
    globalThis.fetch = realFetch;
    const live = await db.readLiveTranscript(id);
    ok(!jobs.hasJob('f', id) && jobs.hasJob('r', id) && !sameRecordingReply.signal.aborted,
       'after stop: stopping the translations stops only them, not a reply on the same recording');
    jobs.endJob('r', id, sameRecordingReply);
    ok(live.lines.filter(line => line.translations && line.translations.en).length === 24
       && /EN Zin nummer 23/.test((await row(id)).transcripts.find(item => item.id === 's1').text) && !(await row(id)).fillError,
       'after stop: and what was translated by then is kept, without a warning on the recording');
    eq(liveStatusText(id, 'translate'), '', 'after stop: the status line goes when the translations stop');
}

// A fill whose live transcript is deleted while an answer is on its way ends there, and does not
// write the live transcript back as a copy nobody can see.
{
    await clearAll();
    const transcribe = await import('../../src/js/transcribe.js');
    let release = null;
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
        const path = String(url);
        const reply = body => ({ ok: true, status: 200, async json() { return body; }, async text() { return JSON.stringify(body); } });
        if (path.endsWith('/api/tags')) return reply({ models: [{ name: 'qwen3.8:27b' }] });
        if (path.endsWith('/api/ps')) return reply({ models: [{ name: 'qwen3.8:27b', size: 1, size_vram: 1 }] });
        if (path.endsWith('/api/generate')) {
            const body = JSON.parse(init.body || '{}');
            if (!release) await new Promise(resolve => { release = resolve; });
            const numbered = String(body.prompt || '').split('\n').filter(line => /^\d+\. /.test(line))
                .map(line => line.replace(/^(\d+)\. /, '$1. EN '));
            return reply({ model: body.model, response: numbered.join('\n'), done: true });
        }
        return reply({});
    };
    const lines = Array.from({ length: 30 }, (_, i) => ({ key: `d${i}`, startSec: i * 3, endSec: i * 3 + 2,
                                                         text: `Regel ${i}`, language: 'nl', translations: {} }));
    const id = await addRecording({ filename: 'deleted live' }, { live: { lines, languages: ['nl', 'en'], coverage: [] } });
    const filling = transcribe.fillTranslations(id);
    for (let i = 0; i < 300 && !release; i++) await new Promise(resolve => setTimeout(resolve, 10));
    await db.deleteLiveTranscript(id);
    release();
    const outcome = await filling;
    globalThis.fetch = realFetch;
    ok(!(await db.readLiveTranscript(id)) && outcome.cancelled,
       `fill: a live transcript deleted while an answer was on its way stays deleted, and the fill ends there (${JSON.stringify(outcome)})`);

    // The deletion is asked for at the very moment the change is being made, as when the person
    // deletes the transcript just as an answer is saved.
    const raced = await addRecording({ filename: 'raced' }, { live: { lines, languages: ['nl', 'en'], coverage: [] } });
    let deleting = null;
    await db.updateLiveTranscript(raced, current => {
        deleting = db.deleteLiveTranscript(raced);
        return current && { ...current, touched: true };
    });
    await deleting;
    ok(!(await db.readLiveTranscript(raced)), 'fill: a change to the live transcript that overlaps its deletion does not bring it back');
}

// With Auto-transcribe on, the reading the row shows is made after the recording; when the live
// transcript heard everything it is the live lines again, and it carries their translations too.
{
    await clearAll();
    const transcribe = await import('../../src/js/transcribe.js');
    const id = await addRecording({ filename: 'all heard live', durationMs: 30000 }, {
        audio: wav(30),
        live: { lines: [{ startSec: 1, endSec: 9, text: 'Goedemorgen allemaal', language: 'nl', translations: { en: 'Good morning all' } },
                        { startSec: 11, endSec: 19, text: 'Good morning to you', language: 'en', translations: { nl: 'Goedemorgen' } },
                        { startSec: 21, endSec: 29, text: 'Tot straks', language: 'nl', translations: {} }],
                languages: ['nl', 'en'], coverage: [{ fromSec: 0, toSec: 30 }] }
    });
    await transcribe.transcribeChunked(id, () => {});
    const reading = (await row(id)).transcripts[0];
    ok(reading && reading.source === 'S' && reading.fromLive && /^── As spoken/.test(reading.text)
       && /── English - Engels \(1 line not translated\) ──\n\[00:01\] Good morning all/.test(reading.text)
       && /── Nederlands ──/.test(reading.text) && !/Good morning all/.test(reading.plain),
       `reading: the reading made after the recording from the live lines carries their translations, outside the words replies use (${reading && reading.text})`);
}

// The rows of recordings that are not finished, as the list draws them.
{
    await clearAll();
    const gui = await import('../../src/js/gui.js');
    const failed = await addRecording({ processing: true, captureState: 'finalize-error', finalizationError: 'disk full' });
    const interrupted = await addRecording({ processing: true, captureState: 'recording', ownerId: 'a-tab-that-closed',
                                             heartbeatAt: Date.now() - 10 * 60 * 1000 });
    await gui.renderList({ force: true });
    await settle();
    const walk = node => [node, ...((node && node.children) || []).flatMap(walk)];
    const rowHtml = recId => (walk(document.getElementById('recordingsList')).find(node => node && node.id === `rec-${recId}`) || {}).innerHTML || '';
    const actionsOf = recId => [...rowHtml(recId).matchAll(/data-action="([^"]+)" data-rec-id="(\d+)"/g)]
        .filter(match => Number(match[2]) === recId).map(match => match[1]);
    eq(actionsOf(failed).join(' '), 'retryFinalizeRec downloadRecoverableRec deleteRec',
       'rows: the row of a recording whose save failed offers to retry, to download the audio saved so far, and to delete');
    ok(/Finalization failed: disk full/.test(rowHtml(failed)), 'rows: and says what the save met');
    eq(actionsOf(interrupted).join(' '), 'recoverNowRec deleteRec',
       'rows: the row of a recording whose tab went away before saving it offers Recover now and Delete');
}

// A pinned recording: the row offers 📌 left of its format, a tap pins it and freezes its
// countdown, and the automatic sweep leaves it whole until it is unpinned and its time runs out.
{
    await clearAll();
    const gui = await import('../../src/js/gui.js');
    localStorage.setItem('set-retention-audio', '5m');
    localStorage.setItem('set-retention-text', '5m');
    localStorage.setItem('retention-policy-acknowledged-v2', retentionAckToken({ audio: '5m', text: '5m' }));
    const MIN = 60 * 1000;
    const now = Date.now();
    const id = await addRecording({ filename: 'keep this', timestamp: now - 2 * MIN, durationMs: MIN, endedAt: now - MIN,
                                    transcripts: [{ id: 'k', source: 'S', text: 'keep', plain: 'keep', time: now - MIN }] },
                                  { audio: wav(1) });
    const saving = await addRecording({ filename: 'still saving', processing: true, captureState: 'finalize-error' });
    const walk = node => [node, ...((node && node.children) || []).flatMap(walk)];
    const rowHtml = recId => (walk(document.getElementById('recordingsList')).find(node => node && node.id === `rec-${recId}`) || {}).innerHTML || '';
    await gui.renderList({ force: true });
    await settle();
    const top = (rowHtml(id).match(/<div class="rec-top">[\s\S]*?<\/div>/) || [''])[0];
    const pinAt = top.indexOf('data-action="pinRec"');
    ok(pinAt > 0 && top.indexOf('class="fmt-badge') > pinAt && /data-pin="1"/.test(top) && /aria-pressed="false"/.test(top),
       `pin: the row offers 📌 left of the format, not yet pinned (${top})`);
    ok(/⏳ audio/.test(rowHtml(id)) && !/rec-expiry frozen/.test(rowHtml(id)), 'pin: and its countdown runs');
    ok(!/data-action="pinRec"/.test(rowHtml(saving)), 'pin: a recording that is not saved yet has no pin');

    ok(await window.pinRec(id, true) && (await row(id)).pinnedAt > 0, 'pin: a tap on 📌 pins the recording');
    const pinned = rowHtml(id);
    ok(/class="pin-btn pinned"/.test(pinned) && /data-pin="0"/.test(pinned) && /aria-pressed="true"/.test(pinned),
       'pin: the row then shows it pinned, and a second tap would unpin it');
    ok(/class="rec-expiry frozen"/.test(pinned) && /❄️ audio/.test(pinned) && /❄️ text/.test(pinned) && !/⏳|class="soon"/.test(pinned),
       'pin: with its countdown frozen');
    eq(await window.pinRec(saving, true), false, 'pin: a recording that is not saved yet cannot be pinned');

    // An hour later by the wall clock, pinned a minute after it ended: far past a five-minute window.
    await db.dbUpdate(CONFIG.STORE_REC, id, rec => {
        rec.timestamp = now - 61 * MIN; rec.endedAt = now - 60 * MIN; rec.transcripts[0].time = now - 60 * MIN;
        rec.pinnedAt = now - 59 * MIN;
        return rec;
    });
    await settings.runRetentionSweep({ announce: false });
    ok(await row(id) && await db.readAudio(id) && (await row(id)).transcripts.length === 1,
       'pin: the sweep leaves a pinned recording whole, an hour past a five-minute window');
    eq(await window.pinRec(id, true), false, 'pin: pinning it again from a tab that still shows it unpinned changes nothing');
    ok(await window.pinRec(id, false) && !(await row(id)).pinnedAt, 'pin: a tap on 📌 unpins it');
    ok(/data-pin="1"/.test(rowHtml(id)) && /⏳ audio [34]m/.test(rowHtml(id)),
       `pin: and its countdown runs on from the four minutes it had left (${(rowHtml(id).match(/⏳ audio [^<]*/) || [''])[0]})`);
    await settings.runRetentionSweep({ announce: false });
    ok(await row(id) && await db.readAudio(id), 'pin: so it is not swept the moment it is unpinned');
    await db.dbUpdate(CONFIG.STORE_REC, id, rec => {
        rec.pinnedSpans = rec.pinnedSpans.map(([from, to]) => [from, to - 5 * MIN]);
        return rec;
    });
    await settings.runRetentionSweep({ announce: false });
    ok(!(await row(id)) && !(await db.readAudio(id)), 'pin: and once the time it had left has run out, the sweep deletes it as any other');
}

// A live transcript with holes: the saved reading marks them, the compact row offers to fill just
// those, and filling sends only the audio the live view never heard.
{
    await clearAll();
    const gui = await import('../../src/js/gui.js');
    const transcribe = await import('../../src/js/transcribe.js');
    const id = await addRecording({ filename: 'with holes', durationMs: 30000 }, {
        audio: wav(30),
        live: { lines: [{ startSec: 1, endSec: 4, text: 'the first part was heard', language: 'en',
                          translations: { nl: 'het eerste deel werd gehoord' } },
                        { startSec: 13, endSec: 16, text: 'and so was this part', language: 'en',
                          translations: { nl: 'en dit deel ook' } }],
                languages: ['en', 'nl'], coverage: [{ fromSec: 0, toSec: 8 }, { fromSec: 12, toSec: 20 }] }
    });
    await transcribe.storeLiveTranscript(id);
    const live = (await row(id)).transcripts[0];
    ok(live && live.source === 'L' && live.holes === 2
       && live.text.includes('[00:08-00:12] [not transcribed live]') && live.text.includes('[00:20-00:30] [not transcribed live]'),
       `holes: the saved live transcript marks the window it skipped and the ten seconds it never sent, and counts them (${JSON.stringify(live)})`);

    await gui.renderList({ force: true });
    await settle();
    const walk = node => [node, ...((node && node.children) || []).flatMap(walk)];
    const rowNode = () => walk(document.getElementById('recordingsList')).find(node => node && node.id === `rec-${id}`);
    const html = (rowNode() || {}).innerHTML || '';
    ok(/📝 Fill gaps/.test(html) && !new RegExp(`class="btn-row is-hidden" id="scribe-btns-${id}"`).test(html),
       'holes: the compact list, which hides 📝 Scribe once a recording has text, offers 📝 Fill gaps for it');

    const sentSeconds = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
        if (!String(url).startsWith('/transcribe')) return realFetch(url, init);
        const seconds = ((await init.body.arrayBuffer()).byteLength - 44) / 32000;
        sentSeconds.push(seconds);
        return { ok: true, status: 200, async json() {
            return { text: 'filled in', language: 'en', segments: [{ start: Math.max(0, seconds - 2), end: seconds - 0.5, text: 'filled in' }] };
        } };
    };
    await rowNode().querySelector(`#btn-t-${id}`).onclick();
    globalThis.fetch = realFetch;
    ok(sentSeconds.length > 0 && Math.max(...sentSeconds) < 20 && sentSeconds.reduce((a, b) => a + b, 0) < 25,
       `holes: 📝 Fill gaps sends only the parts the live transcript never heard, not the whole recording (${sentSeconds.map(s => s.toFixed(1)).join(', ')} s sent)`);
    const filled = (await row(id)).transcripts[0];
    ok(filled && filled.source === 'S' && filled.fromLive && /the first part was heard/.test(filled.plain)
       && /filled in/.test(filled.plain) && !/not transcribed live/.test(filled.text),
       `holes: and the reading it stores keeps the live lines and fills the holes (${filled && filled.text})`);
    ok(/^── As spoken/.test(filled.text) && /── Nederlands - Dutch ──\n\[00:01\] het eerste deel werd gehoord/.test(filled.text)
       && !/eerste deel/.test(filled.plain),
       `holes: it carries the translations the boxes made, as the live reading does, outside the words replies use (${filled && filled.text})`);
    await gui.renderList({ force: true });
    await settle();
    ok(!/📝 Fill gaps/.test((rowNode() || {}).innerHTML || ''), 'holes: after which the row stops offering it');
}

// A reply: the model is made ready first, at the context replies share, and the first word is
// waited for as long as a model reloading for a larger context needs.
{
    const reply = await import('../../src/js/reply.js');
    const { AI_NUM_CTX } = await import('../../src/js/model-ready-core.js');
    const requests = [];
    let firstByteDelayMs = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
        const path = String(url);
        requests.push({ path, body: init.body ? JSON.parse(init.body) : null });
        const json = body => ({ ok: true, status: 200, async json() { return body; }, async text() { return JSON.stringify(body); } });
        if (path.endsWith('/api/tags')) return json({ models: [{ name: 'qwen3.8:27b' }] });
        if (path.endsWith('/api/ps')) return json({ models: [{ name: 'qwen3.8:27b', size: 1, size_vram: 1 }] });
        if (path.endsWith('/api/generate')) {
            await new Promise((resolve, reject) => {
                const timer = setTimeout(resolve, firstByteDelayMs);
                if (init.signal) init.signal.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
            });
            return new Response('{"response":"The answer.","done":false}\n{"response":"","done":true}\n', { status: 200 });
        }
        return json({});
    };
    localStorage.setItem('server-processing-consent-v1', '1');
    const askedWith = async (transcript, recName) => {
        await clearAll();
        localStorage.setItem('server-processing-consent-v1', '1');
        reply.forgetModelChoices();
        requests.length = 0;
        const id = await addRecording({ filename: recName, transcripts: [{ id: 1, text: transcript, plain: transcript, time: Date.now() }] });
        let failure = '';
        try { await reply.runSummary(id, () => {}); } catch (err) { failure = `${err.name}: ${err.message}`; }
        return { id, failure, stored: (await row(id)).summaries || [] };
    };

    const short = await askedWith('We agreed to ship on Friday.', 'short');
    const generate = requests.findIndex(request => request.path.endsWith('/api/generate'));
    ok(short.stored.length === 1 && short.stored[0].text === 'The answer.', `reply: a reply is written (${short.failure})`);
    ok(generate > 0 && requests[generate - 1].path.endsWith('/api/ps'),
       `reply: a reply makes sure the model is loaded before it asks for one (${requests.map(request => request.path).join(', ')})`);
    eq(requests[generate].body.options.num_ctx, AI_NUM_CTX,
       'reply: a short reply asks for the context all replies and translations share, so moving between them never reloads the model');

    const saved = CONFIG.REMOTE_FIRST_BYTE_TIMEOUT_MS;
    CONFIG.REMOTE_FIRST_BYTE_TIMEOUT_MS = 150;
    firstByteDelayMs = 500;
    const long = await askedWith('word '.repeat(30000), 'long');
    CONFIG.REMOTE_FIRST_BYTE_TIMEOUT_MS = saved;
    firstByteDelayMs = 0;
    const longGenerate = requests.find(request => request.path.endsWith('/api/generate'));
    ok(longGenerate && longGenerate.body.options.num_ctx > AI_NUM_CTX && long.stored.length === 1,
       `reply: a reply that needs a larger context waits for its first word according to the context it needs, since the model reloads first (${long.failure})`);
    globalThis.fetch = realFetch;
}

await clearAll();
memoryIdb.reset();
console.log(`✓ all ${assertions} app-behaviour assertions passed`);
emitTestResult('app-behaviour', 'pass', { assertions });
process.exit(0);
