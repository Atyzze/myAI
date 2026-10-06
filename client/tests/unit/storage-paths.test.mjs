// What gets kept and what gets deleted, checked on the real settings.js, recorder.js and db.js
// running over the in-memory IndexedDB: automatic deletion, deleting a transcript or a recording,
// deletions a closed tab left half done, the backup, and a Stop that meets a full disk.
import { emitTestResult } from '../helpers/test-result.mjs';
const { page, memoryIdb, settle } = await import('../helpers/app-harness.mjs');
const { CONFIG } = await import('../../src/js/config.js');
const db = await import('../../src/js/db.js');
const { encodeMonoWav } = await import('../../src/js/audio.js');
const { retentionAckToken } = await import('../../src/js/retention-core.js');
const { INTERRUPTED_DELETIONS_KEY } = await import('../../src/js/deletion-core.js');
const { syntheticWebm } = await import('../helpers/synthetic-webm.mjs');
const settings = await import('../../src/js/settings.js');
const recorder = await import('../../src/js/recorder.js');
const lock = await import('../../src/js/recording-lock.js');
settings.exposeSettingsGlobals();

let assertions = 0;
function ok(value, message) {
    assertions++;
    if (!value) throw new Error(`Assertion failed: ${message}`);
}
function eq(actual, expected, message) {
    ok(actual === expected, `${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
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
        await db.dbExec(CONFIG.STORE_FRAGMENTS, 'add', { recId: id, sessionId: fields.sessionId ?? null, bytes: fragment.size, ...fragment });
    }
    return id;
}
const row = id => db.dbExec(CONFIG.STORE_REC, 'get', id);
const liveOf = id => db.readLiveTranscript(id);
const fragmentsOf = async id => (await db.getAudioFragmentsForRecording(id)).length;
const liveLines = texts => ({ lines: texts.map((text, i) => ({ startSec: i * 2, endSec: i * 2 + 1.5, text })), languages: [], coverage: [] });

function setRetention(audio, text) {
    localStorage.setItem('set-retention-audio', audio);
    localStorage.setItem('set-retention-text', text);
    localStorage.setItem('retention-policy-acknowledged-v2', retentionAckToken({ audio, text }));
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

async function backupIndex() {
    page.reset();
    page.answer(true);
    ok(await window.downloadBackup(), 'backup: the backup is made');
    const download = page.downloads[0];
    ok(download && download.blob, 'backup: and handed over as a file');
    const entries = zipEntries(new Uint8Array(await download.blob.arrayBuffer()));
    const json = entries.get('transcripts.json');
    ok(json, 'backup: it holds transcripts.json');
    return JSON.parse(new TextDecoder().decode(json)).recordings;
}

async function clearAll() {
    for (const rec of await db.dbExec(CONFIG.STORE_REC, 'getAllFromIndex', { index: 'by-date' })) {
        await db.deleteAudioFragments(rec.id, null, { allSessions: true });
        await db.deleteAudio(rec.id);
        await db.deleteLiveTranscript(rec.id);
        await db.deleteCaptureBeat(rec.id);
        await db.dbExec(CONFIG.STORE_REC, 'delete', rec.id);
    }
    localStorage.removeItem(INTERRUPTED_DELETIONS_KEY);
    page.reset();
}

{
    const id = await addRecording({ n: 0 });
    await Promise.all([1, 2, 3].map(() => db.dbUpdate(CONFIG.STORE_REC, id, rec => { rec.n++; return rec; })));
    eq((await row(id)).n, 3, 'stand-in database: updates that overlap run one after another, as in IndexedDB');
    let refused = null;
    try { await db.dbExec(CONFIG.STORE_REC, 'get', undefined); } catch (err) { refused = err.name; }
    eq(refused, 'DataError', 'stand-in database: and a missing key is refused, as in IndexedDB');
    await clearAll();
}

{
    setRetention('1h', '1y');
    const now = Date.now();
    const meeting = await addRecording({ timestamp: now - 75 * MINUTE, durationMs: 74 * MINUTE }, { audio: wav(1) });
    const note = await addRecording({ timestamp: now - 62 * MINUTE, durationMs: MINUTE }, { audio: wav(1) });
    await window.runRetentionSweep({ announce: false });
    ok(await row(meeting) && await db.readAudio(meeting),
       'retention: a 74-minute meeting stopped a minute ago keeps its audio under a one-hour audio window, and is not swept away as an empty row');
    ok(!(await row(note)),
       'retention: while a recording that ended 61 minutes ago loses its audio, and with nothing else in it, its row');
    await clearAll();
}

{
    setRetention('1y', '7d');
    const now = Date.now();
    const kept = await addRecording({ timestamp: now - 10 * DAY, durationMs: MINUTE, liveTranscriptLines: 2 },
                                    { audio: wav(1), live: liveLines(['one', 'two']) });
    const gone = await addRecording({ timestamp: now - 10 * DAY, durationMs: MINUTE, liveTranscriptLines: 2 },
                                    { live: liveLines(['three', 'four']) });
    await window.runRetentionSweep({ announce: false });
    ok(await row(kept) && !(await liveOf(kept)) && !(await row(kept)).liveTranscriptLines,
       'retention: text past its window takes the live transcript with it, while the audio it belongs to stays');
    ok(!(await row(gone)) && !(await liveOf(gone)),
       'retention: and a row with nothing else left goes with its live transcript');
    await clearAll();
}

{
    setRetention('1M', '1M');
    const id = await addRecording({ liveTranscriptLines: 2, transcripts: [{ id: 't1', source: 'L', text: 'a', time: Date.now() }] },
                                  { audio: wav(1), live: liveLines(['a', 'b']) });
    page.answer(true);
    await window.deleteTranscript(id, 't1');
    ok(/The live transcript it was made from is deleted too/.test(page.asked('confirm')[0]?.message || ''),
       'delete transcript: the question says the live transcript goes with the transcript made from it');
    ok(!(await liveOf(id)) && !(await row(id)).liveTranscriptLines && (await row(id)).transcripts.length === 0,
       'delete transcript: deleting the transcript made from the live one deletes the live transcript too, so no hidden copy is left');
    await clearAll();

    const both = await addRecording({ liveTranscriptLines: 2, transcripts: [
        { id: 't2', source: 'L', text: 'a', time: Date.now() },
        { id: 't3', source: 'S', fromLive: true, text: 'a', time: Date.now() }] },
        { audio: wav(1), live: liveLines(['a', 'b']) });
    page.answer(true);
    await window.deleteTranscript(both, 't2');
    ok(await liveOf(both) && (await row(both)).liveTranscriptLines === 2,
       'delete transcript: while another transcript made from it is kept, so is the live transcript');
    await clearAll();
}

{
    const shown = await addRecording({ liveTranscriptLines: 2, transcripts: [{ id: 'a', source: 'L', text: 'x', time: Date.now() }] },
                                     { live: liveLines(['shown', 'here']) });
    const orphan = await addRecording({ liveTranscriptLines: 2, transcripts: [{ id: 'b', source: 'S', text: 'y', time: Date.now() }] },
                                      { live: liveLines(['deleted', 'earlier']) });
    const recovered = await addRecording({ liveTranscriptLines: 2 }, { live: liveLines(['only', 'copy']) });
    const recordings = await backupIndex();
    const entry = id => recordings.find(item => item.id === id);
    ok(entry(shown).liveTranscript && entry(recovered).liveTranscript,
       'backup: a live transcript that a transcript shows, or that is a recording\'s only text, is backed up');
    eq(entry(orphan).liveTranscript, null,
       'backup: a live transcript whose transcript was deleted is not carried into the backup');
    await clearAll();
}

{
    const ownerless = await addRecording({ processing: true, captureState: 'finalize-error', sessionId: 's1',
                                           finalizationError: 'disk full' },
                                         { fragments: [{ seq: 0, blob: wav(2) }, { seq: 1, blob: wav(2) }, { seq: 2, blob: wav(2) }] });
    page.answer(false);
    await window.deleteRec(ownerless);
    const question = page.asked('confirm')[0]?.message || '';
    ok(/of audio saved so far, in 3 piece\(s\)/.test(question) && !/nothing but its own entry/.test(question),
       `delete recording: the question for a recording whose save failed says how much audio it still holds (${question.split('\n')[2]})`);
    ok(await row(ownerless) && await fragmentsOf(ownerless) === 3, 'delete recording: and No deletes nothing');
    page.answer(true);
    await window.deleteRec(ownerless);
    ok(!(await row(ownerless)) && await fragmentsOf(ownerless) === 0, 'delete recording: Yes deletes it and the audio it held');
    eq(localStorage.getItem(INTERRUPTED_DELETIONS_KEY), '[]', 'delete recording: a finished deletion leaves no note behind');
    await clearAll();
}

{
    const noted = await addRecording({ deleting: true, sessionId: 's1' },
                                     { audio: wav(1), live: liveLines(['x']), fragments: [{ seq: 0, blob: wav(1) }] });
    const seen = await addRecording({ deleting: true }, { audio: wav(1) });
    localStorage.setItem(INTERRUPTED_DELETIONS_KEY, JSON.stringify([noted]));
    settings.noticeInterruptedDeletion(await row(seen));
    const result = await settings.finishInterruptedDeletions();
    eq(result.finished, 2, 'interrupted delete: deletions a closed tab left half done are finished');
    ok(!(await row(noted)) && !(await db.readAudio(noted)) && !(await liveOf(noted)) && await fragmentsOf(noted) === 0,
       'interrupted delete: with everything the recording held');
    ok(!(await row(seen)), 'interrupted delete: also one noticed in the list rather than noted when it began');
    eq(localStorage.getItem(INTERRUPTED_DELETIONS_KEY), '[]', 'interrupted delete: and the note of it is cleared');
    await clearAll();
}

{
    const now = Date.now();
    const other = 'another-tab';
    const liveElsewhere = await addRecording({
        processing: true, captureState: 'recording', ownerId: other, sessionId: 's9',
        timestamp: now - 400 * DAY, heartbeatAt: now - 5 * MINUTE, deleting: false
    }, { fragments: [{ seq: 0, blob: wav(1) }] });
    await db.writeCaptureBeat({ recId: liveElsewhere, ownerId: other, sessionId: 's9', heartbeatAt: now, state: 'recording', durationMs: 1000 });
    setRetention('5m', '5m');
    page.answer(true, true, false, true, false);
    await window.deleteRec(liveElsewhere);
    await window.deleteAllAudio();
    await window.deleteAllText();
    await window.runRetentionSweep({ announce: false });
    ok(await row(liveElsewhere) && await fragmentsOf(liveElsewhere) === 1,
       'live elsewhere: deleting it, deleting all audio or all text and automatic deletion all leave alone a recording another tab is still capturing, known by its beat');
    const refusals = page.asked('alert').map(dialog => dialog.message).join('\n');
    ok(/It was not deleted/.test(refusals) && /Audio was not deleted/.test(refusals) && /Text was not deleted/.test(refusals),
       `live elsewhere: each deletion that was asked for says why it did nothing (${refusals.replace(/\n/g, ' / ')})`);
    await db.dbUpdate(CONFIG.STORE_REC, liveElsewhere, rec => { rec.deleting = true; return rec; });
    localStorage.setItem(INTERRUPTED_DELETIONS_KEY, JSON.stringify([liveElsewhere]));
    await settings.finishInterruptedDeletions();
    ok(await row(liveElsewhere) && await fragmentsOf(liveElsewhere) === 1,
       'live elsewhere: and finishing interrupted deletions also leaves alone a recording another tab is still capturing');
    await clearAll();
}

{
    const kept = await addRecording({ transcripts: [{ id: 't', source: 'S', text: 'keep me', time: Date.now() }] }, { audio: wav(1) });
    localStorage.setItem(INTERRUPTED_DELETIONS_KEY, JSON.stringify([kept]));
    await settings.finishInterruptedDeletions();
    ok(await row(kept) && await db.readAudio(kept),
       'interrupted delete: a noted recording that is not marked as being deleted is left whole');
    eq(localStorage.getItem(INTERRUPTED_DELETIONS_KEY), '[]', 'interrupted delete: and its stale note is dropped');

    const failing = await addRecording({}, { audio: wav(1) });
    memoryIdb.failNext(op => op.store === 'recordings' && op.action === 'put');
    page.answer(true);
    await window.deleteRec(failing);
    ok(await row(failing) && !(await row(failing)).deleting && localStorage.getItem(INTERRUPTED_DELETIONS_KEY) === '[]',
       'interrupted delete: a deletion that could not even mark its recording leaves no note behind');
    await settings.finishInterruptedDeletions();
    ok(await row(failing), 'interrupted delete: so nothing later deletes a recording the user was told was not deleted');
    await clearAll();
}

{
    const slow = memoryIdb.delayWhile(op => op.store === 'audio_fragments' && op.action === 'delete', 120);
    const id = await addRecording({ sessionId: 's2' }, { audio: wav(1), fragments: [{ seq: 0, blob: wav(1) }] });
    page.answer(true);
    const deleting = window.deleteRec(id);
    let noted = false;
    for (let i = 0; i < 40 && !noted; i++) {
        await new Promise(resolve => setTimeout(resolve, 5));
        noted = JSON.parse(localStorage.getItem(INTERRUPTED_DELETIONS_KEY) || '[]').includes(id)
             && !!(await row(id))?.deleting;
    }
    ok(noted, 'interrupted delete: while a deletion runs it is noted, so a tab that closes half way leaves a note another tab can finish');
    await deleting;
    slow();
    ok(!(await row(id)) && localStorage.getItem(INTERRUPTED_DELETIONS_KEY) === '[]',
       'interrupted delete: and once it is done the note is gone with the recording');
    await clearAll();
}

{
    localStorage.setItem('set-second-pass', 'replace');
    const blob = encodeMonoWav(new Float32Array(16000 * 3).fill(0.2), 16000);
    const id = await addRecording({ sampleRate: 16000, durationMs: 3000, liveTranscriptLines: 1,
                                    transcripts: [{ id: 'live', source: 'L', text: 'heard live', plain: 'heard live', time: Date.now() }] },
                                  { audio: blob, live: liveLines(['heard live']) });
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, status: 200, async json() {
        return { text: 'heard again', segments: [{ start: 0.5, end: 2.0, text: 'heard again' }], language: 'en' };
    } });
    await recorder.runAfterRecording(id);
    globalThis.fetch = realFetch;
    const cleaned = await row(id);
    ok(cleaned.transcripts.length === 1 && cleaned.transcripts[0].plain === 'heard again',
       'cleanup pass: set to replace, it keeps only the reading it made');
    ok(!(await liveOf(id)) && !cleaned.liveTranscriptLines,
       'cleanup pass: and the live transcript that reading replaced goes too, instead of staying behind unseen');
    localStorage.removeItem('set-second-pass');
    await clearAll();
}

{
    localStorage.setItem('set-second-pass', 'replace');
    const id = await addRecording({ sampleRate: 16000, durationMs: 3000, deleting: true },
                                  { audio: encodeMonoWav(new Float32Array(16000 * 3).fill(0.2), 16000) });
    const realFetch = globalThis.fetch;
    let sent = 0;
    globalThis.fetch = async () => { sent++; return { ok: true, status: 200, async json() { return { text: '', segments: [] }; } }; };
    await recorder.runAfterRecording(id);
    globalThis.fetch = realFetch;
    ok(sent === 0 && (await row(id)).transcripts.length === 0,
       `cleanup pass: the cleanup pass does not start on a recording being deleted (${sent} sent)`);
    localStorage.removeItem('set-second-pass');
    await clearAll();
}

{
    const webm = new Blob([syntheticWebm({ clusterTimes: [0, 4000, 8000] }).bytes], { type: 'audio/webm;codecs=opus' });
    const id = await addRecording({ format: 'opus', mime: 'audio/webm;codecs=opus', processing: true, captureState: 'recording',
                                    ownerId: 'a-tab-that-closed', sessionId: 's-opus', heartbeatAt: Date.now() - 10 * MINUTE,
                                    durationMs: 12000 }, { fragments: [{ seq: 0, blob: webm }] });
    await db.dbExec(CONFIG.STORE_FRAGMENTS, 'getAll');
    const outcome = await recorder.recoverIncompleteRecordings();
    const saved = await row(id);
    ok(outcome.recovered === 1 && saved && !saved.processing && saved.audioBytes > 0 && !!(await db.readAudio(id)),
       `recovery: a compressed recording whose tab closed is saved from its pieces (${JSON.stringify(outcome)})`);
    ok(!('blob' in saved),
       'stop: a finished compressed recording also puts its audio in the audio store and leaves only its size on the row');
    await clearAll();
}

{
    const now = Date.now();
    const other = 'another-tab';
    for (let i = 0; i < 3; i++) await addRecording({ filename: `finished ${i}` }, { audio: wav(1) });
    const capturing = await addRecording({ processing: true, captureState: 'recording', ownerId: other, sessionId: 'far',
                                           heartbeatAt: now - 5 * MINUTE }, { fragments: [{ seq: 0, blob: wav(1) }] });
    await db.writeCaptureBeat({ recId: capturing, ownerId: other, heartbeatAt: now, state: 'recording', durationMs: 1000 });
    const retrying = await addRecording({ processing: true, captureState: 'finalize-error', ownerId: other, sessionId: 'near',
                                          heartbeatAt: now - 5 * MINUTE }, { fragments: [{ seq: 0, blob: wav(1) }] });
    await db.writeCaptureBeat({ recId: retrying, ownerId: other, sessionId: 'near', heartbeatAt: now, state: 'finalizing', durationMs: 1000 });
    localStorage.setItem(lock.RECORDING_LEASE_KEY, JSON.stringify({ ownerId: other, recId: retrying, sessionId: 'near', durationMs: 1000, heartbeatAt: now }));
    memoryIdb.ops = [];
    const outcome = await recorder.recoverIncompleteRecordings();
    localStorage.removeItem(lock.RECORDING_LEASE_KEY);
    const recordingReads = memoryIdb.ops.filter(op => op.store === CONFIG.STORE_REC && op.action !== 'put' && op.action !== 'get');
    ok(recordingReads.length > 0 && recordingReads.every(op => op.index === 'by-state'),
       `recovery: startup looks up unfinished recordings through the capture-state index, never by reading every recording (${JSON.stringify(recordingReads)})`);
    ok(outcome.deferred === 2 && (await row(capturing)).processing && (await row(retrying)).processing,
       `recovery: recovery reads each recording's beat, so one another tab is still capturing, or still saving again after a failed save, is left alone although its row looks stale (${JSON.stringify(outcome)})`);
    await clearAll();
}

{
    const now = Date.now();
    const other = 'another-tab';
    const owned = await addRecording({ processing: true, captureState: 'finalizing', ownerId: other, heartbeatAt: now - 5 * MINUTE },
                                     { audio: wav(1) });
    await db.writeCaptureBeat({ recId: owned, ownerId: other, heartbeatAt: now, state: 'finalizing', durationMs: 1000 });
    await window.deleteRecAudio(owned);
    ok(await db.readAudio(owned) && /still being captured or finalized/.test(page.asked('alert').pop()?.message || ''),
       'delete audio: the audio of a recording another tab is still finalizing is not deleted, known by its beat');

    const raced = await addRecording({ processing: true, captureState: 'finalize-error', ownerId: other, heartbeatAt: now - 5 * MINUTE },
                                     { audio: wav(1) });
    page.answer(() => {
        memoryIdb.poke('capture_beats', raced, { recId: raced, ownerId: other, heartbeatAt: Date.now(), state: 'finalizing', durationMs: 1000 });
        return true;
    });
    await window.deleteRecAudio(raced);
    ok(await db.readAudio(raced) && /active in another tab/.test(page.asked('alert').pop()?.message || ''),
       'delete audio: nor one whose other tab took it up while the question was open');
    await clearAll();
}

async function stopRecordingWith({ captureError = null, unsaved = false, commitDelayMs = 0, failing = () => false } = {}) {
    await clearAll();
    CONFIG.RECORDING_HEARTBEAT_MS = 40;
    const ownerId = lock.getRecordingOwnerId();
    ok(await lock.acquireRecordingLock(), 'stop: the test tab holds the recording lock, as a recording tab does');
    const t0 = Date.now() - 60000;
    const id = await addRecording({ timestamp: t0, durationMs: 0, processing: true, captureState: 'recording',
                                    ownerId, sessionId: 's1', heartbeatAt: Date.now(), sampleRate: 8000 },
                                  { fragments: [{ seq: 0, blob: wav(1) }, { seq: 1, blob: wav(1) }, { seq: 2, blob: wav(1) }] });
    Object.assign(recorder.AppState, {
        recId: id, sessionId: 's1', startTime: t0, recFormat: 'wav', busy: false, ownerId,
        audioCtx: { sampleRate: 8000, state: 'closed', close() {} }, samplesSeen: 8000 * 3,
        rowBeat: { recId: id, state: 'recording', at: Date.now() },
        captureError: captureError ? { ...captureError, occurredAt: Date.now() } : null,
        fragmentWriteFailed: !!unsaved,
        uncommittedFragments: unsaved
            ? new Map([['s1:3', { recId: id, sessionId: 's1', seq: 3, blob: wav(1), bytes: 0 }]])
            : new Map()
    });
    const stopFailing = memoryIdb.failWhile(failing);
    const stopDelaying = memoryIdb.delayWhile(op => op.store === 'audio' && op.action === 'put' && op.mode === 'readwrite'
                                                    || (captureError && op.store === 'recordings' && op.action === 'put'),
                                              commitDelayMs);
    page.answer(false);
    let beforeSaved = null;
    let watching = true;
    const watch = (async () => {
        while (watching) {
            const current = await row(id).catch(() => null);
            if (current && current.processing) beforeSaved = current;
            await new Promise(resolve => setTimeout(resolve, 5));
        }
    })();
    await recorder.stopRecording();
    watching = false;
    await watch;
    stopDelaying();
    // A beat the stop wrote may still be committing; it meets the same disk, and it has to land
    // before a test moves the clock, or it would stamp the row with a fresh heartbeat afterwards.
    await memoryIdb.idle();
    stopFailing();
    await settle();
    return { id, beforeSaved };
}

{
    let rowWrites = 0;
    const fullDisk = op => (op.store === 'recordings' && op.action === 'put')
                        || (op.store === 'audio_fragments' && op.action === 'add');
    const { id } = await stopRecordingWith({ captureError: { kind: 'quota', message: 'Injected full disk' }, unsaved: true,
                                              commitDelayMs: 300, failing: fullDisk });
    const beat = (await db.readCaptureBeats()).get(id);
    ok(beat && beat.captureError && beat.captureError.kind === 'quota' && beat.incompleteAudio === true,
       `stop: when the disk stays full through a slow save, the beat still says capture failed and audio is missing (${JSON.stringify(beat && { error: beat.captureError, incomplete: beat.incompleteAudio })})`);
    await lock.releaseRecordingLock();

    const aged = Date.now() - 5 * MINUTE;
    memoryIdb.poke('capture_beats', id, current => ({ ...current, heartbeatAt: aged }));
    memoryIdb.poke('recordings', id, current => ({ ...current, heartbeatAt: aged }));
    const stillFull = memoryIdb.failWhile(op => op.store === 'recordings' && op.action === 'put' && ++rowWrites > 1);
    const attempt = await recorder.recoverIncompleteRecordings();
    await memoryIdb.idle();
    stillFull();
    const kept = (await db.readCaptureBeats()).get(id);
    ok(attempt.deferred === 0 && attempt.recovered === 0 && kept && kept.captureError && kept.incompleteAudio === true,
       `stop: a recovery that meets the same full disk and cannot mark the recording keeps its beat, error and all (${JSON.stringify(attempt)})`);

    memoryIdb.poke('capture_beats', id, current => ({ ...current, heartbeatAt: aged }));
    memoryIdb.poke('recordings', id, current => ({ ...current, heartbeatAt: aged, finalizerHeartbeatAt: aged }));
    await recorder.recoverIncompleteRecordings();
    const recovered = await row(id);
    ok(recovered && recovered.captureState === 'ready-incomplete' && recovered.incompleteAudio && recovered.captureError
       && / \(incomplete\)$/.test(recovered.filename),
       `stop: so once there is room again the recording is recovered marked incomplete, with the error it met (${recovered && recovered.captureState} ${recovered && recovered.filename})`);
}

{
    let rowWrites = 0;
    const firstTwoRowWritesFail = op => op.store === 'recordings' && op.action === 'put' && ++rowWrites <= 2;
    const { id, beforeSaved } = await stopRecordingWith({ commitDelayMs: 150, failing: firstTwoRowWritesFail });
    ok(beforeSaved && beforeSaved.captureState === 'finalizing' && beforeSaved.durationMs >= 59000,
       `stop: while it is being saved the recording says so, with its final length, also when noting the stop failed once (${beforeSaved && beforeSaved.captureState}, ${beforeSaved && beforeSaved.durationMs} ms)`);
    const saved = await row(id);
    ok(saved && !saved.processing && saved.audioBytes > 0, 'stop: and afterwards it is saved with its audio');
    ok(!('blob' in saved) && !!(await db.readAudio(id)),
       'stop: a finished recording puts its audio in the audio store and leaves only its size on the row, so listing recordings never loads audio');
    ok(saved.endedAt >= Date.now() - 5000 && saved.durationMs < 10000,
       `stop: it remembers when it stopped, a minute after it started, although only ${saved.durationMs} ms of audio were saved, so automatic deletion counts from then`);
    ok(!(await db.readCaptureBeats()).has(id), 'stop: and its beat is gone once it is saved');
    await lock.releaseRecordingLock();
}

await clearAll();
memoryIdb.reset();
console.log(`✓ all ${assertions} storage-path assertions passed`);
emitTestResult('storage-paths', 'pass', { assertions });
process.exit(0);
