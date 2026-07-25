/* ==========================================================================
   recorder.js - Recording lifecycle, AGC, visualizer, IO flush, WAV stitch
   ========================================================================== */
import { CONFIG, fmtDur, fmtBytes, getLocalIso, getSetting } from './config.js';
import { dbExec, dbUpdate, calcTotalStorage, bumpStorage,
         getAudioFragmentsForRecording, deleteAudioFragments } from './db.js';
import { encodeMonoWav, getWorkletCode, stitchWavChunks, planPcmFlush } from './audio.js';
import { pickOpusMime, resolveRecordingFormat } from './audio-format.js';
import { makeWebmSeekable, WEBM_SEEKABLE_VERSION } from './webm-duration.js';
import { runAutoPipeline }                         from './auto-pipeline.js';
import { enableWakeLock, disableWakeLock }         from './wake-lock.js';
import { acquireRecordingLock, releaseRecordingLock, getRecordingOwnerId,
         publishRecordingLease, isRecordOwnedByLiveTab, isFreshHeartbeat } from './recording-lock.js';

// ── Shared mutable state ──
export const AppState = {
    recId: null, audioCtx: null, stream: null,
    pcmBuffer: [], pcmLength: 0, wavSeq: 0,
    startTime: 0, timerId: null, heartbeatTimer: null,
    analyser: null, dataArr: null, rafId: null,
    gainNode: null, gainInterval: null, agcAnalyser: null,
    workletNode: null, workletFlushResolve: null, pendingFlushes: new Set(),
    pendingContext: null, _fpsLast: null,
    _vizW: 0, _vizH: 0,
    busy: false, captureStopScheduled: false,
    captureError: null, captureStopping: false,
    uncommittedFragments: new Map(), mediaRecorderStopPromise: null,
    // Opus capture (opt-in; WAV remains the default and fallback)
    recFormat: 'wav', opusMime: null, mediaRecorder: null, opusSeq: 0,
    ownerId: getRecordingOwnerId(), sessionId: null
};

function makeRecordingSessionId() {
    try { return crypto.randomUUID(); } catch (_) {}
    return `${AppState.ownerId}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

function chunksForRecordingSession(chunks, rec) {
    const all = chunks || [];
    if (rec?.sessionId) return all.filter(chunk => chunk.sessionId === rec.sessionId);

    // Legacy rows have no session id. Never merge multiple modern sessions just
    // because they share a damaged/legacy recording id: prefer true legacy
    // fragments and accept only one unambiguous modern session.
    const legacy = all.filter(chunk => !chunk.sessionId);
    if (legacy.length) return legacy;
    const sessions = new Set(all.map(chunk => chunk.sessionId).filter(Boolean));
    if (sessions.size <= 1) return all;
    throw new Error('Multiple isolated fragment sessions were found for this legacy recording. The streams were kept separate to prevent corruption.');
}

async function deleteRecordingSessionChunks(recId, sessionId) {
    return deleteAudioFragments(recId, sessionId, { allSessions: false });
}

// ── Capture/write failure handling ──
function isQuotaError(err) {
    if (!err) return false;
    const name = err.name
        || (err.target && err.target.error && err.target.error.name)
        || '';
    return name === 'QuotaExceededError'
        || name === 'NS_ERROR_DOM_QUOTA_REACHED'
        || /quota/i.test(err.message || '');
}

function captureErrorLabel(failure = AppState.captureError) {
    if (!failure) return 'Recording error';
    if (failure.kind === 'quota') return 'Storage full';
    if (failure.kind === 'microphone') return 'Microphone disconnected';
    if (failure.kind === 'encoder') return 'Audio encoder error';
    return 'Audio save error';
}

function paintCaptureFailureUI() {
    if (!AppState.captureError) return;
    clearInterval(AppState.timerId);
    cancelAnimationFrame(AppState.rafId);

    const btn = document.getElementById('recordBtn');
    if (btn) {
        btn.disabled = true;
        btn.classList.remove('recording');
        btn.textContent = `${captureErrorLabel()} — stopping…`;
    }
    document.getElementById('footer')?.classList.remove('recording');
    const visualizer = document.getElementById('visualizer');
    if (visualizer) visualizer.style.display = 'none';
    const fps = document.getElementById('fpsDisplay');
    if (fps) fps.style.display = 'none';

    const row = document.getElementById(`rec-${AppState.recId}`);
    if (row) {
        row.classList.add('rec-item-capture-error');
        const badge = row.querySelector('.live-rec-badge');
        if (badge) badge.innerHTML = '<span class="dot"></span>ERROR · STOPPING';
        const hint = row.querySelector('.live-rec-meta');
        if (hint) hint.textContent = `${captureErrorLabel()}. Capture has stopped; saving recoverable audio…`;
    }
}

function ensureMediaRecorderStopped() {
    const recorder = AppState.mediaRecorder;
    if (!recorder) return Promise.resolve();
    if (AppState.mediaRecorderStopPromise) return AppState.mediaRecorderStopPromise;
    if (recorder.state === 'inactive') return Promise.resolve();

    AppState.mediaRecorderStopPromise = new Promise(resolve => {
        let settled = false;
        const done = () => {
            if (settled) return;
            settled = true;
            resolve();
        };
        recorder.addEventListener('stop', done, { once: true });
        try { recorder.stop(); } catch (_) { done(); }
        setTimeout(done, 1500);
    });
    return AppState.mediaRecorderStopPromise;
}

function haltCaptureInputImmediately() {
    if (AppState.captureStopping) {
        paintCaptureFailureUI();
        return;
    }
    AppState.captureStopping = true;
    clearInterval(AppState.timerId);
    try { ensureMediaRecorderStopped(); } catch (_) {}
    try { AppState.stream?.getTracks().forEach(track => track.stop()); } catch (_) {}
    paintCaptureFailureUI();
}

function scheduleCaptureFailureStop() {
    if (AppState.captureStopScheduled) return;
    AppState.captureStopScheduled = true;
    const attempt = () => {
        if (AppState.recId == null) return;
        if (AppState.busy) {
            setTimeout(attempt, 25);
            return;
        }
        stopRecording().catch(err => console.error('Failed to stop after capture error:', err));
    };
    setTimeout(attempt, 0);
}

function handleCaptureFailure(err, kind = null) {
    if (AppState.recId == null) return;
    const quota = isQuotaError(err);
    if (!AppState.captureError) {
        AppState.captureError = {
            kind: kind || (quota ? 'quota' : 'storage'),
            message: err && err.message ? err.message : String(err || 'Unknown recording error'),
            occurredAt: Date.now()
        };
    }
    console.error('Fatal recording capture error:', err);
    haltCaptureInputImmediately();
    Promise.resolve(_renderList()).catch(renderErr => console.warn('Capture-error repaint failed:', renderErr));
    scheduleCaptureFailureStop();
}

function trackPendingFlush(promise) {
    const tracked = Promise.resolve(promise).finally(() => AppState.pendingFlushes.delete(tracked));
    AppState.pendingFlushes.add(tracked);
    return tracked;
}

function fragmentKey(fragment) {
    return `${fragment.sessionId || ''}:${fragment.seq}`;
}

async function persistAudioFragment(fragment) {
    const key = fragmentKey(fragment);
    AppState.uncommittedFragments.set(key, fragment);
    try {
        await dbExec(CONFIG.STORE_WAV, 'add', fragment);
        AppState.uncommittedFragments.delete(key);
        bumpStorage(fragment.blob?.size || 0);
        return true;
    } catch (err) {
        handleCaptureFailure(err);
        return false;
    }
}

// ── Auto gain control (software AGC) ──
function startAutoGain() {
    // Measure from a tap BEFORE the limiter (agcAnalyser) so the loop reflects
    // what the gain stage is doing instead of fighting the compressor downstream.
    const meter = AppState.agcAnalyser || AppState.analyser;
    if (!meter || !AppState.gainNode) return;
    if (AppState.gainInterval) clearInterval(AppState.gainInterval);
    const buf = new Uint8Array(meter.frequencyBinCount);
    AppState.gainNode.gain.value = 0.8;

    AppState.gainInterval = setInterval(() => {
        if (!AppState.audioCtx || !AppState.gainNode) return;
        meter.getByteTimeDomainData(buf);
        let sum = 0, peak = 0;
        for (let i = 0; i < buf.length; i++) {
            const v  = (buf[i] - 128) / 128;
            sum     += v * v;
            const av = Math.abs(v);
            if (av > peak) peak = av;
        }
        const rms = Math.sqrt(sum / buf.length);
        if (rms < 0.0005) return;
        const ratio = 0.15 / rms;
        let gain = AppState.gainNode.gain.value;
        gain *= 1 + (ratio < 1 ? 0.35 : 0.08) * (ratio - 1);
        if (peak > 0.9) gain *= 0.6;
        // Ceiling lowered from 80× to 24× (+27 dB): plenty for speech, far less
        // prone to pumping or amplifying room hiss to a roar in near-silence.
        const target = Math.min(Math.max(gain, 0.05), 24);
        // Ramp instead of an instantaneous .value set to avoid zipper noise.
        AppState.gainNode.gain.setTargetAtTime(target, AppState.audioCtx.currentTime, 0.05);
    }, 100);
}

// ── Recording heartbeat ──
async function persistOwnedHeartbeat(recId, durationMs, state, sessionId = AppState.sessionId) {
    if (recId == null) return;
    const now = Date.now();
    publishRecordingLease(recId, now, sessionId, durationMs);
    try {
        await dbUpdate(CONFIG.STORE_REC, recId, (rec) => {
            if (!rec || rec.ownerId !== AppState.ownerId || !rec.processing) return null;
            rec.heartbeatAt = now;
            rec.durationMs = Math.max(rec.durationMs || 0, durationMs || 0);
            rec.captureState = state;
            return rec;
        });
    } catch (err) {
        console.warn('Recording heartbeat failed:', err);
    }
}

async function persistRecordingHeartbeat(state = 'recording') {
    if (AppState.recId == null || !AppState.startTime) return;
    return persistOwnedHeartbeat(
        AppState.recId,
        Math.max(0, Date.now() - AppState.startTime),
        state
    );
}

function startRecordingHeartbeat() {
    if (AppState.heartbeatTimer) clearInterval(AppState.heartbeatTimer);
    const beat = () => {
        const started = !!AppState.startTime;
        const duration = started ? Math.max(0, Date.now() - AppState.startTime) : 0;
        return persistOwnedHeartbeat(
            AppState.recId,
            duration,
            started ? 'recording' : 'starting'
        );
    };
    beat();
    AppState.heartbeatTimer = setInterval(beat, CONFIG.RECORDING_HEARTBEAT_MS);
}

// ── Audio stream setup (mic → gain → limiter → analyser → capture sink) ──
async function initAudioStream() {
    AppState.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
    });
    for (const track of AppState.stream.getAudioTracks()) {
        track.addEventListener('ended', () => {
            if (AppState.recId != null && !AppState.captureStopping) {
                handleCaptureFailure(new Error('Microphone input ended unexpectedly.'), 'microphone');
            }
        });
    }

    const source = AppState.audioCtx.createMediaStreamSource(AppState.stream);

    AppState.gainNode = AppState.audioCtx.createGain();
    AppState.gainNode.gain.value = 1.0;

    const limiter = AppState.audioCtx.createDynamicsCompressor();
    limiter.threshold.value = -8;
    limiter.knee.value      = 2;
    limiter.ratio.value     = 30;
    limiter.attack.value    = 0.003;
    limiter.release.value   = 0.080;

    AppState.analyser         = AppState.audioCtx.createAnalyser();
    AppState.analyser.fftSize = 2048;
    AppState.dataArr          = new Uint8Array(AppState.analyser.frequencyBinCount);

    AppState.agcAnalyser         = AppState.audioCtx.createAnalyser();
    AppState.agcAnalyser.fftSize = 1024;

    source.connect(AppState.gainNode);
    AppState.gainNode.connect(AppState.agcAnalyser);
    AppState.gainNode.connect(limiter);
    limiter.connect(AppState.analyser);

    if (AppState.recFormat === 'opus') {
        try {
            // Opus uses MediaRecorder directly. Do not also create the PCM
            // AudioWorklet: doing so would allocate and post hundreds of buffers
            // per second only for the main thread to discard them.
            const dest = AppState.audioCtx.createMediaStreamDestination();
            limiter.connect(dest);
            const mr = new MediaRecorder(dest.stream, { mimeType: AppState.opusMime });
            AppState.mediaRecorder = mr;
            mr.onerror = event => {
                const err = event?.error || new Error('MediaRecorder reported an encoding error.');
                handleCaptureFailure(err, 'encoder');
            };
            mr.ondataavailable = (ev) => {
                if (!ev.data || ev.data.size === 0) return;
                const recId = AppState.recId;
                if (recId == null) return;
                const seq = AppState.opusSeq++;
                trackPendingFlush(persistAudioFragment({
                    recId, sessionId: AppState.sessionId, seq, createdAt: Date.now(), blob: ev.data
                }));
            };
            mr.start(CONFIG.IO_FLUSH_SEC * 1000);
            return;
        } catch (err) {
            console.warn('Opus capture unavailable, falling back to WAV:', err);
            AppState.recFormat     = 'wav';
            AppState.opusMime      = null;
            AppState.mediaRecorder = null;
            if (AppState.recId != null) {
                try {
                    await dbUpdate(CONFIG.STORE_REC, AppState.recId, (rec) => {
                        if (!rec) return null;
                        rec.format = 'wav';
                        delete rec.mime;
                        return rec;
                    });
                } catch (_) {}
            }
        }
    }

    const workletBlob = new Blob([getWorkletCode()], { type: 'application/javascript' });
    const workletUrl  = URL.createObjectURL(workletBlob);
    try {
        await AppState.audioCtx.audioWorklet.addModule(workletUrl);
    } finally {
        URL.revokeObjectURL(workletUrl);
    }

    const workletNode = new AudioWorkletNode(AppState.audioCtx, 'recorder-worklet');
    AppState.workletNode = workletNode;
    limiter.connect(workletNode);
    workletNode.connect(AppState.audioCtx.destination);
    workletNode.port.onmessage = handleWorkletMessage;
    workletNode.port.onmessageerror = () => {
        handleCaptureFailure(new Error('The audio worklet stopped delivering valid data.'), 'encoder');
    };
}

// ── Visualizer (waveform canvas) ──
export function drawWave() {
    if (AppState.captureError || !AppState.analyser || !AppState.dataArr) return;
    const canvas = document.getElementById('visualizer');
    const ctx    = canvas.getContext('2d');

    // Resize the backing store only when the displayed size actually changes,
    // instead of reallocating it on every animation frame.
    const dpr = window.devicePixelRatio || 1;
    const w   = Math.round(canvas.clientWidth  * dpr);
    const h   = Math.round(canvas.clientHeight * dpr);
    if (w !== AppState._vizW || h !== AppState._vizH) {
        canvas.width  = w;
        canvas.height = h;
        AppState._vizW = w;
        AppState._vizH = h;
    }

    AppState.analyser.getByteTimeDomainData(AppState.dataArr);
    ctx.fillStyle   = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.lineWidth   = 2;
    ctx.strokeStyle = '#fff';
    ctx.beginPath();

    const slice = canvas.width / AppState.dataArr.length;
    let x = 0;
    for (let i = 0; i < AppState.dataArr.length; i++) {
        const y = (AppState.dataArr[i] / 128.0) * (canvas.height / 2);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        x += slice;
    }
    ctx.lineTo(canvas.width, canvas.height / 2);
    ctx.stroke();

    // FPS counter
    const now = performance.now();
    if (AppState._fpsLast) {
        const delta = now - AppState._fpsLast;
        if (delta > 0) {
            const fpsEl = document.getElementById('fpsDisplay');
            if (fpsEl) fpsEl.textContent = `${Math.round(1000 / delta)} FPS`;
        }
    }
    AppState._fpsLast = now;

    AppState.rafId = requestAnimationFrame(drawWave);
}

// ── 4-second IO flush (PCM buffer → WAV chunk → IndexedDB) ──
function handleWorkletMessage(e) {
    const payload = e.data || {};
    if (payload.type === 'flush-complete') {
        const resolve = AppState.workletFlushResolve;
        AppState.workletFlushResolve = null;
        if (resolve) resolve();
        return;
    }
    if (AppState.recFormat === 'opus') return;
    const audio = payload.type === 'audio' ? payload.data : payload;
    if (!(audio instanceof Float32Array) || audio.length === 0) return;
    AppState.pcmBuffer.push(audio);
    AppState.pcmLength += audio.length;
    // After a fatal write/capture error, retain any final worklet tail in memory
    // for the stop/recovery path, but never make the UI look live or keep issuing
    // normal periodic writes.
    if (AppState.captureError) return;
    const required = AppState.audioCtx.sampleRate * CONFIG.IO_FLUSH_SEC;
    while (AppState.pcmLength >= required) {
        trackPendingFlush(flushPcmToDb(false, required));
    }
}

async function flushWorkletTail() {
    const node = AppState.workletNode;
    if (!node) return;
    await new Promise(resolve => {
        let settled = false;
        const done = () => {
            if (settled) return;
            settled = true;
            resolve();
        };
        AppState.workletFlushResolve = done;
        try { node.port.postMessage({ type: 'flush' }); } catch (_) { done(); }
        setTimeout(done, 500);
    });
}

async function flushPcmToDb(isFinal, samplesToProcess) {
    if (AppState.pcmLength === 0) return;

    // Cut the buffer at samplesToProcess (pure, unit-tested in audio.js). This whole
    // block runs synchronously before the first await below, so a worklet message
    // arriving mid-flush can't re-enter and double-consume the same samples.
    const { flat, keptBuffer, keptLength } = planPcmFlush(AppState.pcmBuffer, samplesToProcess);
    AppState.pcmBuffer = isFinal ? [] : keptBuffer;
    AppState.pcmLength = isFinal ? 0 : keptLength;

    const wavBlob = encodeMonoWav(flat, AppState.audioCtx ? AppState.audioCtx.sampleRate : 48000);
    if (AppState.recId) {
        await persistAudioFragment({
            recId: AppState.recId, sessionId: AppState.sessionId,
            seq: AppState.wavSeq++, createdAt: Date.now(), blob: wavBlob
        });
    }
}

async function retryUncommittedFragments(recId, sessionId) {
    if (AppState.uncommittedFragments.size === 0) return [];

    // A failed IndexedDB promise should mean the row was not committed, but
    // verify the unique stream/sequence coordinates before retrying so a late
    // transaction completion can never create a duplicate fragment.
    let existing = [];
    try { existing = await getAudioFragmentsForRecording(recId); } catch (_) {}
    const committed = new Set(existing
        .filter(row => row.sessionId === sessionId)
        .map(row => `${row.sessionId || ''}:${row.seq}`));

    const pending = [...AppState.uncommittedFragments.values()]
        .filter(fragment => Number(fragment.recId) === Number(recId) && fragment.sessionId === sessionId)
        .sort((a, b) => a.seq - b.seq);

    for (const fragment of pending) {
        const key = fragmentKey(fragment);
        if (committed.has(key)) {
            AppState.uncommittedFragments.delete(key);
            continue;
        }
        try {
            await dbExec(CONFIG.STORE_WAV, 'add', fragment);
            AppState.uncommittedFragments.delete(key);
            committed.add(key);
            bumpStorage(fragment.blob?.size || 0);
        } catch (err) {
            console.error('Audio fragment retry failed:', err);
        }
    }

    return [...AppState.uncommittedFragments.values()]
        .filter(fragment => Number(fragment.recId) === Number(recId) && fragment.sessionId === sessionId)
        .sort((a, b) => a.seq - b.seq);
}

async function buildEmergencyRecoveryBlob(recId, sessionId, unsaved, format, mime, durationMs) {
    const rec = await dbExec(CONFIG.STORE_REC, 'get', recId);
    if (!rec) return null;
    const stored = chunksForRecordingSession(await getAudioFragmentsForRecording(recId), rec);
    const bySeq = new Map();
    for (const fragment of stored) bySeq.set(fragment.seq, fragment);
    for (const fragment of unsaved) bySeq.set(fragment.seq, fragment);
    const all = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
    if (!all.length) return null;

    if (format === 'opus') {
        const raw = new Blob(all.map(fragment => fragment.blob), { type: mime || 'audio/webm' });
        try { return await makeWebmSeekable(raw, Math.max(1, durationMs || 0)); }
        catch (_) { return raw; }
    }
    return stitchWavChunks(all.map(fragment => fragment.blob), rec.sampleRate || 48000);
}

function downloadRecoveryBlob(blob, format, timestamp) {
    if (!blob) return;
    const ext = format === 'opus' ? 'webm' : 'wav';
    const name = `${getLocalIso(timestamp || Date.now()).replace(/[: ]/g, '-')}-recording-recovery.${ext}`;
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
}

async function ensureFinalizationHeadroom(chunks) {
    if (!navigator.storage?.estimate || !chunks?.length) return;
    let estimate;
    try { estimate = await navigator.storage.estimate(); } catch (_) { return; }
    const usage = Number(estimate.usage);
    const quota = Number(estimate.quota);
    if (!Number.isFinite(usage) || !Number.isFinite(quota)) return;
    if (quota <= usage) {
        const err = new Error('Not enough browser storage is available to build the final recording. Recoverable chunks were kept.');
        err.name = 'InsufficientStorageError';
        throw err;
    }
    const masterBytes = chunks.reduce((sum, chunk) => sum + (chunk.blob?.size || 0), 0);
    const safetyMargin = Math.max(2 * 1024 * 1024, Math.ceil(masterBytes * 0.05));
    if (quota - usage < masterBytes + safetyMargin) {
        const err = new Error(
            `Finalization needs about ${fmtBytes(masterBytes + safetyMargin)} of free app storage, ` +
            `but only ${fmtBytes(Math.max(0, quota - usage))} is estimated available. Recoverable chunks were kept.`
        );
        err.name = 'InsufficientStorageError';
        throw err;
    }
}

// ── Cleanup shared state ──
function cleanupRecordingState() {
    if (AppState.gainInterval) clearInterval(AppState.gainInterval);
    if (AppState.heartbeatTimer) clearInterval(AppState.heartbeatTimer);
    try { if (AppState.workletNode) { AppState.workletNode.port.onmessage = null; AppState.workletNode.disconnect(); } } catch (_) {}
    if (AppState.stream) AppState.stream.getTracks().forEach(t => t.stop());
    if (AppState.audioCtx && AppState.audioCtx.state !== 'closed') AppState.audioCtx.close();

    cancelAnimationFrame(AppState.rafId);
    document.getElementById('visualizer').style.display = 'none';
    document.getElementById('fpsDisplay').style.display = 'none';
    document.getElementById('footer').classList.remove('recording');

    disableWakeLock();
    try { if (AppState.mediaRecorder && AppState.mediaRecorder.state !== 'inactive') AppState.mediaRecorder.stop(); } catch (_) {}
    AppState.recId        = null;
    AppState.heartbeatTimer = null;
    AppState.workletNode  = null;
    AppState.workletFlushResolve = null;
    AppState.agcAnalyser  = null;
    AppState.pcmBuffer    = [];
    AppState.pcmLength    = 0;
    AppState.wavSeq       = 0;
    AppState.startTime    = 0;
    AppState.pendingFlushes = new Set();
    AppState.captureStopScheduled = false;
    AppState.captureError      = null;
    AppState.captureStopping   = false;
    AppState.uncommittedFragments = new Map();
    AppState.mediaRecorderStopPromise = null;
    AppState.mediaRecorder = null;
    AppState.opusSeq       = 0;
    AppState.recFormat     = 'wav';
    AppState.opusMime      = null;
    AppState.sessionId     = null;
    document.getElementById('recordBtn').textContent = 'Start Recording';
}

// ── Finalization helpers ──
function markFinalized(rec, durationMs, noAudio = false) {
    rec.durationMs  = Math.max(0, durationMs || 0);
    rec.processing  = false;
    rec.captureState = rec.incompleteAudio ? 'ready-incomplete' : 'ready';
    const suffix = noAudio ? ' (no audio)' : (rec.incompleteAudio ? ' (incomplete)' : '');
    rec.filename = `${getLocalIso(rec.timestamp)} - ${fmtDur(rec.durationMs)}${suffix}`;
    delete rec.ownerId;
    delete rec.heartbeatAt;
    delete rec.finalizationError;
    delete rec.finalizationErrorAt;
    delete rec.finalizerId;
    delete rec.finalizerHeartbeatAt;
    return rec;
}

async function markFinalizationError(recId, durationMs, err, finalizerId = null) {
    await dbUpdate(CONFIG.STORE_REC, recId, (rec) => {
        if (!rec || (finalizerId && rec.finalizerId !== finalizerId)) return null;
        rec.durationMs = Math.max(rec.durationMs || 0, durationMs || 0);
        rec.processing = true;                   // chunks remain recoverable
        rec.captureState = 'finalize-error';
        rec.finalizationError = err && err.message ? err.message : String(err);
        rec.finalizationErrorAt = Date.now();
        delete rec.ownerId;
        delete rec.heartbeatAt;
        delete rec.finalizerId;
        delete rec.finalizerHeartbeatAt;
        return rec;
    });
}

function makeFinalizerId() {
    try { return `${AppState.ownerId}:${crypto.randomUUID()}`; } catch (_) {}
    return `${AppState.ownerId}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

async function claimFinalizer(recId) {
    const finalizerId = makeFinalizerId();
    const now = Date.now();
    const claimed = await dbUpdate(CONFIG.STORE_REC, recId, rec => {
        if (!rec || !rec.processing || rec.deleting) return null;
        if (rec.finalizerId && rec.finalizerId !== finalizerId
            && isFreshHeartbeat(rec.finalizerHeartbeatAt, now)) return null;
        rec.finalizerId = finalizerId;
        rec.finalizerHeartbeatAt = now;
        return rec;
    });
    return claimed && claimed.finalizerId === finalizerId ? finalizerId : null;
}

async function touchFinalizer(recId, finalizerId) {
    await dbUpdate(CONFIG.STORE_REC, recId, rec => {
        if (!rec || rec.finalizerId !== finalizerId || !rec.processing) return null;
        rec.finalizerHeartbeatAt = Date.now();
        return rec;
    });
}

async function releaseFinalizer(recId, finalizerId) {
    await dbUpdate(CONFIG.STORE_REC, recId, rec => {
        if (!rec || rec.finalizerId !== finalizerId) return null;
        delete rec.finalizerId;
        delete rec.finalizerHeartbeatAt;
        return rec;
    });
}

// ── Finalize: stitch WAV chunks into master blob ──
export async function finalizeWavBackup(recId, durationMs, { runPipeline = true, finalizerId = null } = {}) {
    const rec0 = await dbExec(CONFIG.STORE_REC, 'get', recId);
    if (!rec0) return;
    const rawChunks = await getAudioFragmentsForRecording(recId);
    const chunks = chunksForRecordingSession(rawChunks, rec0);

    if (!chunks || chunks.length === 0) {
        const stored = await dbUpdate(CONFIG.STORE_REC, recId, rec => {
            if (!rec || (finalizerId && rec.finalizerId !== finalizerId)) return null;
            return markFinalized(rec, durationMs, !rec.blob);
        });
        if (!stored && finalizerId) throw new Error('Finalization ownership changed.');
        return;
    }
    chunks.sort((a, b) => a.seq - b.seq);
    await ensureFinalizationHeadroom(chunks);

    const sampleRate = rec0.sampleRate || 48000;
    const dataBytes = chunks.reduce((sum, chunk) => sum + Math.max(0, chunk.blob.size - 44), 0);
    const derivedDuration = dataBytes > 0
        ? Math.round((dataBytes / 2 / sampleRate) * 1000)
        : 0;
    const effectiveDuration = derivedDuration || durationMs || rec0.durationMs || 0;
    const masterBlob = stitchWavChunks(chunks.map(chunk => chunk.blob), sampleRate);

    const stored = await dbUpdate(CONFIG.STORE_REC, recId, rec => {
        if (!rec || (finalizerId && rec.finalizerId !== finalizerId)) return null;
        rec.blob = masterBlob;
        return markFinalized(rec, effectiveDuration);
    });
    if (!stored) {
        if (finalizerId) throw new Error('Finalization ownership changed.');
        return;
    }

    await deleteRecordingSessionChunks(recId, rec0.sessionId);
    await calcTotalStorage();
    if (runPipeline) await runAutoPipeline(recId);
}

// ── Finalize: concatenate Opus chunks into the master blob ──
async function finalizeOpus(recId, durationMs, mime, { runPipeline = true, finalizerId = null } = {}) {
    const rec0 = await dbExec(CONFIG.STORE_REC, 'get', recId);
    if (!rec0) return;
    const rawChunks = await getAudioFragmentsForRecording(recId);
    const chunks = chunksForRecordingSession(rawChunks, rec0);
    if (!chunks || chunks.length === 0) {
        const stored = await dbUpdate(CONFIG.STORE_REC, recId, rec => {
            if (!rec || (finalizerId && rec.finalizerId !== finalizerId)) return null;
            return markFinalized(rec, durationMs, !rec.blob);
        });
        if (!stored && finalizerId) throw new Error('Finalization ownership changed.');
        return;
    }
    chunks.sort((a, b) => a.seq - b.seq);
    await ensureFinalizationHeadroom(chunks);
    const effectiveDuration = Math.max(durationMs || 0, rec0.durationMs || 0);
    const rawMaster = new Blob(chunks.map(chunk => chunk.blob), { type: mime || 'audio/webm' });
    // Chrome/Chromium MediaRecorder WebM normally omits Segment Info Duration.
    // Add it before committing the master so downloaded files expose a finite
    // total length and a working seek track in ordinary media players.
    const masterBlob = await makeWebmSeekable(rawMaster, effectiveDuration);
    const webmSeekable = String(masterBlob.type || mime || '').toLowerCase().includes('webm');

    const stored = await dbUpdate(CONFIG.STORE_REC, recId, (rec) => {
        if (!rec || (finalizerId && rec.finalizerId !== finalizerId)) return null;
        rec.blob = masterBlob;
        if (webmSeekable) rec.webmSeekableVersion = WEBM_SEEKABLE_VERSION;
        else delete rec.webmSeekableVersion;
        delete rec.webmDurationFixed;
        return markFinalized(rec, effectiveDuration);
    });
    if (!stored) {
        if (finalizerId) throw new Error('Finalization ownership changed.');
        return;
    }

    await deleteRecordingSessionChunks(recId, rec0.sessionId);
    await calcTotalStorage();
    if (runPipeline) await runAutoPipeline(recId);
}

export async function finalizeRecording(recId, durationMs, opts = {}) {
    const rec = await dbExec(CONFIG.STORE_REC, 'get', recId);
    if (!rec) return;
    if (rec.format === 'opus') return finalizeOpus(recId, durationMs, rec.mime, opts);
    return finalizeWavBackup(recId, durationMs, opts);
}

export async function retryFinalizeRecording(recId) {
    if (AppState.recId != null) throw new Error('Stop the active recording before retrying finalization.');
    const rec = await dbExec(CONFIG.STORE_REC, 'get', recId);
    if (!rec) return;

    const locked = await acquireRecordingLock();
    if (!locked) throw new Error('Another tab is recording or finalizing audio.');
    let finalizerId = null;
    let heartbeat = null;
    try {
        finalizerId = await claimFinalizer(recId);
        if (!finalizerId) throw new Error('This recording is already being finalized or deleted in another tab.');
        await dbUpdate(CONFIG.STORE_REC, recId, cur => {
            if (!cur || cur.finalizerId !== finalizerId) return null;
            cur.processing = true;
            cur.captureState = 'finalizing';
            delete cur.finalizationError;
            return cur;
        });
        heartbeat = setInterval(
            () => touchFinalizer(recId, finalizerId).catch(() => {}),
            CONFIG.RECORDING_HEARTBEAT_MS
        );
        await _renderList();
        await finalizeRecording(recId, rec.durationMs || 0, { runPipeline: false, finalizerId });
    } catch (err) {
        if (finalizerId) await markFinalizationError(recId, rec.durationMs || 0, err, finalizerId);
        throw err;
    } finally {
        if (heartbeat) clearInterval(heartbeat);
        if (finalizerId) await releaseFinalizer(recId, finalizerId).catch(() => {});
        await releaseRecordingLock();
        await _renderList();
    }
}

// Reads the 4-second WAV chunks already flushed to STORE_WAV for `recId` and
// stitches them into one playable WAV WITHOUT deleting them or touching the
// recording row - finalize still owns the destructive master-blob swap at stop.
// This is what lets the active recording's row show a working play bar while
// you're still recording (the GUI rebuilds the player from this on a timer).
//
// Returns null when nothing has been flushed yet (recording younger than one
// IO_FLUSH_SEC window) so the caller can show a "buffering" state instead of an
// empty <audio>. The snapshot lags real time by at most one flush interval (the
// not-yet-written PCM still sitting in AppState.pcmBuffer) - exactly the ~4 s
// preview cadence the live player advertises. Reads are isolated IndexedDB
// transactions, so a concurrent finalize delete can never corrupt the result.
export async function buildLivePreviewBlob(recId) {
    if (recId == null) return null;
    const rec0 = await dbExec(CONFIG.STORE_REC, 'get', recId);
    if (!rec0) return null;
    const rawChunks = await getAudioFragmentsForRecording(recId);
    const chunks = chunksForRecordingSession(rawChunks, rec0);
    if (!chunks || chunks.length === 0) return null;
    chunks.sort((a, b) => a.seq - b.seq);
    if (rec0 && rec0.format === 'opus') {
        // Opus chunks are only valid concatenated from the start (which is what
        // we have). Duration may read as unknown mid-stream, so the live player
        // shows "so far" playback; the seek bar fills in once fully loaded.
        return new Blob(chunks.map(c => c.blob), { type: rec0.mime || 'audio/webm' });
    }
    const sampleRate = (rec0 && rec0.sampleRate) || 48000;
    return stitchWavChunks(chunks.map(c => c.blob), sampleRate);
}

// ── Recover incomplete recordings on page load ──
// A recent heartbeat is treated as live even when this tab cannot see the Web
// Lock directly. That prevents a second tab from finalizing and deleting chunks
// belonging to an active recorder. Callers may retry after the stale window.
export async function recoverIncompleteRecordings() {
    const all = await dbExec(CONFIG.STORE_REC, 'getAllFromIndex', { index: 'by-date' });
    const pending = all.filter(rec => rec.processing && !rec.deleting);
    if (pending.length === 0) return { recovered: 0, deferred: 0 };

    // Capture, normal finalization, recovery, explicit retry, and destructive
    // bulk maintenance all share this cross-tab lock. This turns those operations
    // into one serialized audio lifecycle instead of several cooperating races.
    const locked = await acquireRecordingLock();
    if (!locked) return { recovered: 0, deferred: pending.length };

    const now = Date.now();
    let recovered = 0;
    let deferred = 0;
    try {
        for (const rec of pending) {
            if (AppState.recId === rec.id || isRecordOwnedByLiveTab(rec, now)) {
                deferred++;
                continue;
            }
            if (rec.captureState !== 'finalize-error' && rec.heartbeatAt && isFreshHeartbeat(rec.heartbeatAt, now)) {
                deferred++;
                continue;
            }

            const finalizerId = await claimFinalizer(rec.id);
            if (!finalizerId) {
                deferred++;
                continue;
            }
            let heartbeat = setInterval(
                () => touchFinalizer(rec.id, finalizerId).catch(() => {}),
                CONFIG.RECORDING_HEARTBEAT_MS
            );
            try {
                await finalizeRecording(rec.id, rec.durationMs || 0, { runPipeline: false, finalizerId });
                recovered++;
            } catch (err) {
                await markFinalizationError(rec.id, rec.durationMs || 0, err, finalizerId);
            } finally {
                clearInterval(heartbeat);
                heartbeat = null;
                await releaseFinalizer(rec.id, finalizerId).catch(() => {});
            }
        }
        return { recovered, deferred };
    } finally {
        await releaseRecordingLock();
    }
}

// ── Public: start / stop ──
// renderList is injected to avoid circular dependency
let _renderList = () => {};
export function setRenderList(fn) { _renderList = fn; }

export async function startRecording() {
    if (AppState.busy || AppState.recId) return;
    AppState.busy = true;
    AppState.captureError = null;
    AppState.captureStopping = false;
    AppState.captureStopScheduled = false;
    AppState.pendingFlushes = new Set();
    AppState.uncommittedFragments = new Map();
    AppState.mediaRecorderStopPromise = null;

    const recordBtn = document.getElementById('recordBtn');
    recordBtn.disabled = true;
    recordBtn.classList.add('recording');
    let orphanId = null;
    let orphanSessionId = null;
    let contextForRecording = null;

    try {
        const locked = await acquireRecordingLock();
        if (!locked) throw new Error('Another tab is already recording. Stop it before starting here.');

        AppState.sessionId = makeRecordingSessionId();
        orphanSessionId = AppState.sessionId;
        enableWakeLock();
        AppState.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        AppState.mediaRecorder = null;
        AppState.opusSeq = 0;

        const opusMime = (typeof MediaRecorder !== 'undefined')
            ? pickOpusMime(type => { try { return MediaRecorder.isTypeSupported(type); } catch (_) { return false; } })
            : null;
        const chosen = resolveRecordingFormat(getSetting('set-recording-format'), opusMime);
        AppState.recFormat = chosen.format;
        AppState.opusMime  = chosen.mime;

        const now = Date.now();
        const recObj = {
            filename: `${getLocalIso(now)} - Recording...`,
            timestamp: now,
            durationMs: 0,
            processing: true,
            captureState: 'starting',
            ownerId: AppState.ownerId,
            sessionId: AppState.sessionId,
            heartbeatAt: now,
            resultGeneration: 0,
            sampleRate: AppState.audioCtx.sampleRate,
            format: chosen.format,
            transcripts: [],
            summaries: []
        };
        if (chosen.format === 'opus') recObj.mime = chosen.mime;

        contextForRecording = AppState.pendingContext;
        if (contextForRecording) {
            recObj.contextChain = contextForRecording;
            AppState.pendingContext = null;
        }

        AppState.recId = await dbExec(CONFIG.STORE_REC, 'add', recObj);
        orphanId = AppState.recId;
        publishRecordingLease(AppState.recId, now, AppState.sessionId, 0);
        // Keep ownership fresh while microphone permission and AudioWorklet /
        // MediaRecorder initialization are still pending. A second tab must not
        // interpret a long permission prompt as an abandoned recording.
        startRecordingHeartbeat();

        await initAudioStream();
        if (AppState.captureError) throw new Error(AppState.captureError.message || 'Audio capture failed during startup.');
        AppState.startTime = Date.now();
        AppState.timerId = setInterval(updateLiveGUI, CONFIG.GUI_UPDATE_MS);

        document.getElementById('visualizer').style.display = 'block';
        document.getElementById('fpsDisplay').style.display = 'block';
        document.getElementById('footer').classList.add('recording');
        AppState._fpsLast = null;
        AppState._vizW = 0;
        AppState._vizH = 0;
        drawWave();
        startAutoGain();
        recordBtn.disabled = false;
        await _renderList();
    } catch (err) {
        cleanupRecordingState();
        if (orphanId != null) {
            try { await deleteRecordingSessionChunks(orphanId, orphanSessionId); } catch (_) {}
            try { await dbExec(CONFIG.STORE_REC, 'delete', orphanId); } catch (_) {}
        }
        if (contextForRecording && !AppState.pendingContext) AppState.pendingContext = contextForRecording;
        await releaseRecordingLock();
        recordBtn.classList.remove('recording');
        recordBtn.disabled = false;
        await _renderList();
        alert('Failed to start: ' + (err && err.message ? err.message : err));
    } finally {
        AppState.busy = false;
    }
}

export async function stopRecording() {
    if (AppState.busy || !AppState.recId) return;
    AppState.busy = true;
    AppState.captureStopping = true;

    const btn = document.getElementById('recordBtn');
    btn.disabled = true;
    btn.textContent = AppState.captureError ? 'Saving after recording error…' : 'Finalizing...';
    btn.classList.remove('recording');
    clearInterval(AppState.timerId);
    clearInterval(AppState.heartbeatTimer);

    const currentId = AppState.recId;
    const currentSessionId = AppState.sessionId;
    const currentFormat = AppState.recFormat;
    const currentMime = AppState.opusMime;
    const finalDuration = Math.max(0, Date.now() - AppState.startTime);
    let finalizationHeartbeat = null;
    let failure = AppState.captureError;
    let unsaved = [];
    let unsavedBytes = 0;
    let recoveryBlob = null;
    let recordingTimestamp = Date.now();
    let finalizationError = null;

    // Keep the cross-tab ownership lease alive from the instant stopping begins.
    // Otherwise a slow final flush could make a fallback-lock tab look abandoned
    // before finalization has actually released its audio lifecycle lock.
    persistOwnedHeartbeat(currentId, finalDuration, 'finalizing', currentSessionId).catch(() => {});
    finalizationHeartbeat = setInterval(
        () => persistOwnedHeartbeat(currentId, finalDuration, 'finalizing', currentSessionId),
        CONFIG.RECORDING_HEARTBEAT_MS
    );

    try {
        if (AppState.mediaRecorder) {
            // Stop the encoder before its source tracks. ensureMediaRecorderStopped()
            // is idempotent, so the fatal-error path and a manual stop can safely race.
            try { await ensureMediaRecorderStopped(); } catch (_) {}
            try { AppState.stream?.getTracks().forEach(track => track.stop()); } catch (_) {}
        } else {
            // Stop PCM input first, then ask the worklet to emit its partial
            // aggregate before detaching the port. This avoids losing the final
            // <4096 samples. During an error, handleWorkletMessage retains this
            // tail in memory without resuming the normal flush loop.
            try { AppState.stream?.getTracks().forEach(track => track.stop()); } catch (_) {}
            if (AppState.workletNode) await flushWorkletTail();
            try {
                if (AppState.workletNode) {
                    AppState.workletNode.port.onmessage = null;
                    AppState.workletNode.port.onmessageerror = null;
                    AppState.workletNode.disconnect();
                }
            } catch (_) {}
        }

        await flushPcmToDb(true, AppState.pcmLength);
        await Promise.allSettled([...AppState.pendingFlushes]);

        // Keep failed fragments in memory until stop, then make one verified retry.
        // This recovers transient IndexedDB failures without ever continuing to
        // display a live recorder after the first error.
        unsaved = await retryUncommittedFragments(currentId, currentSessionId);
        failure = AppState.captureError || failure;
        unsavedBytes = unsaved.reduce((sum, fragment) => sum + (fragment.blob?.size || 0), 0);

        const recBeforeFinalize = await dbExec(CONFIG.STORE_REC, 'get', currentId);
        recordingTimestamp = recBeforeFinalize?.timestamp || recordingTimestamp;
        if (unsaved.length) {
            try {
                recoveryBlob = await buildEmergencyRecoveryBlob(
                    currentId, currentSessionId, unsaved,
                    currentFormat, currentMime, finalDuration
                );
            } catch (err) {
                console.error('Could not build emergency recovery download:', err);
            }
        }

        await dbUpdate(CONFIG.STORE_REC, currentId, rec => {
            if (!rec) return null;
            rec.durationMs = Math.max(rec.durationMs || 0, finalDuration);
            rec.captureState = 'finalizing';
            rec.heartbeatAt = Date.now();
            if (failure) {
                rec.captureError = { ...failure };
                rec.incompleteAudio = unsaved.length > 0;
                rec.unsavedFragmentCount = unsaved.length;
                rec.unsavedBytes = unsavedBytes;
            }
            return rec;
        });

        // Finalization can take longer than the stale-recording window on a
        // large note. Keep the ownership lease alive until the master blob is
        // committed so another tab cannot mistake it for crash recovery work.
        await persistOwnedHeartbeat(currentId, finalDuration, 'finalizing', currentSessionId);

        cleanupRecordingState();
        await _renderList();
        await finalizeRecording(currentId, finalDuration, { runPipeline: false });

        // Do not silently send a known-incomplete recording into automatic AI
        // processing. The saved partial recording remains available for an
        // explicit user-triggered transcription.
        if (!unsaved.length) {
            runAutoPipeline(currentId).catch(err => console.warn('Auto pipeline failed:', err));
        }
    } catch (err) {
        finalizationError = err;
        cleanupRecordingState();
        try { await markFinalizationError(currentId, finalDuration, err); }
        catch (markErr) { console.error('Could not persist finalization error state:', markErr); }
    } finally {
        if (finalizationHeartbeat) clearInterval(finalizationHeartbeat);
        try { await releaseRecordingLock(); }
        catch (lockErr) { console.error('Recording lock release failed:', lockErr); }
        btn.disabled = false;
        btn.textContent = 'Start Recording';
        AppState.busy = false;
        try { await _renderList(); }
        catch (renderErr) { console.error('Final recording repaint failed:', renderErr); }
    }

    const reason = failure?.kind === 'quota'
        ? 'browser storage became full'
        : failure?.kind === 'microphone'
            ? 'the microphone input ended unexpectedly'
            : failure?.kind === 'encoder'
                ? 'the browser audio encoder failed'
                : 'an audio segment could not be written to browser storage';

    if (finalizationError) {
        if (!failure) {
            alert('Recording was saved in recoverable chunks, but finalization failed: ' +
                  (finalizationError && finalizationError.message ? finalizationError.message : finalizationError));
            return;
        }
        let message = `Recording stopped because ${reason}. ` +
            `Previously committed audio remains in recoverable chunks, but finalization failed: ` +
            `${finalizationError && finalizationError.message ? finalizationError.message : finalizationError}`;
        if (recoveryBlob) {
            message += '\n\nA complete in-memory recovery file is available right now. Download it before closing this page?';
            if (confirm(message)) downloadRecoveryBlob(recoveryBlob, currentFormat, recordingTimestamp);
        } else {
            alert(message);
        }
        return;
    }

    if (failure && unsaved.length) {
        let message = `Recording stopped because ${reason}. Previously committed audio was saved, ` +
            `but ${unsaved.length} recent segment(s) (${fmtBytes(unsavedBytes)}) could not be stored. ` +
            `The browser copy is marked incomplete.`;
        if (recoveryBlob) {
            message += '\n\nA complete in-memory recovery file is available right now. Download it before closing this page?';
            if (confirm(message)) downloadRecoveryBlob(recoveryBlob, currentFormat, recordingTimestamp);
        } else {
            alert(message);
        }
        return;
    }

    if (failure) {
        const result = failure.kind === 'quota' || failure.kind === 'storage'
            ? 'The failed segment was recovered, and the saved recording is complete.'
            : 'Audio captured before the failure was saved successfully.';
        alert(`Recording stopped because ${reason}. ${result}`);
    }
}
function updateLiveGUI() {
    if (!AppState.startTime) return;
    if (AppState.captureError) {
        paintCaptureFailureUI();
        return;
    }
    const elapsed = Date.now() - AppState.startTime;
    document.getElementById('recordBtn').textContent = `Stop Recording (${fmtDur(elapsed)})`;
    const rowClock = document.getElementById(`live-clock-${AppState.recId}`);
    if (rowClock) rowClock.textContent = fmtDur(elapsed);
}
