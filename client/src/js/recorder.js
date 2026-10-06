import { applyStopFlags, noteRecordingEnded, markFinalized, markSaveFailed } from './finalize-core.js';
import { CONFIG, fmtDur, fmtBytes, getLocalIso, getSetting, readStored, writeStored } from './config.js';
import { dbExec, dbUpdate, calcTotalStorage, bumpStorage, getUnfinishedRecordings,
         getAudioFragmentsForRecording, deleteAudioFragments,
         commitAudio, writeLiveTranscript, deleteLiveTranscript,
         writeCaptureBeat, readCaptureBeats, deleteCaptureBeat } from './db.js';
import { encodeMonoWav, getWorkletCode, stitchWavChunks, planPcmFlush,
         wavDataBytesFor, WAV_MAX_DATA_BYTES } from './audio.js';
import { pickOpusMime, resolveRecordingFormat } from './audio-format.js';
import { initialCaptureHealth, nextCaptureHealth, captureHealthTransition,
         shouldTryResume, describeCaptureStall, describeCaptureRecovery,
         capturedMs, opusLengthMs, samplesBeforeTap, heartbeatRowDue, liveSnapshotDue, captureBeatRecord,
         CAPTURE_STALL_MS, captureStallMs, meterLevel, nextAutoGain, LIMITER_SETTINGS } from './capture-health-core.js';
import { storageRunway, sessionRunway,
         describeRunway, describeRunwayAlert, runwayTone,
         nextRunwayAlert } from './runway-core.js';
import { makeWebmSeekable, webmAudioEndMs, WEBM_SEEKABLE_VERSION } from './webm-duration.js';
import { waveformFps, nextWaveFrame, waveWaitMs,
         refreshRateHz, WAVEFORM_HIDDEN_EVENT }    from './waveform-core.js';
import { runAutoPipeline }                         from './auto-pipeline.js';
import { storeLiveTranscript, transcribeChunked,
         fillTranslations, refreshLiveTranscript }  from './transcribe.js';
import { startLiveScribe, stopLiveScribe, flushLiveScribe, closeLiveScribe, pauseLiveScribe,
         pushLivePcm, isLiveScribeActive, liveScribeResult, liveTranscriptSizeAndSignature,
         setLiveScribeAudioSource, backfillLiveScribe,
         noteLiveSystemLine as liveScribeSystemNote } from './live-scribe.js';
import { singleFlight, runInOrderUntilCancelled, hasJob, CANCELLED } from './jobs.js';
import { showLiveStatus, updateLiveStatus, removeLiveStatus, openLiveLogTab } from './live-tabs.js';
import { transcriptsAfterCleanup }                from './transcribe-core.js';
import { liveTranscriptAfterCleanup }             from './deletion-core.js';
import { enableWakeLock, disableWakeLock }         from './wake-lock.js';
import { acquireRecordingLock, releaseRecordingLock, getRecordingOwnerId,
         publishRecordingLease, isRecordOwnedByLiveTab, isFreshHeartbeat,
         beatHeartbeatAt, recordHeartbeatAt } from './recording-lock.js';

export const AppState = {
    recId: null, audioCtx: null, stream: null,
    pcmBuffer: [], pcmLength: 0, wavSeq: 0,
    startTime: 0, graphStartSec: null, timerId: null, heartbeatTimer: null,
    analyser: null, dataArr: null, rafId: null, _vizTimer: null,
    gainNode: null, gainInterval: null, agcAnalyser: null,
    workletNode: null, workletFlushResolve: null, pendingFlushes: new Set(),
    pendingContext: null, _fpsEl: null, _fpsFrames: 0, _fpsSince: 0,
    _vizCanvas: null, _vizCtx: null, _vizDue: 0, _vizFps: 0, _vizW: 0, _vizH: 0,
    busy: false, captureStopScheduled: false,
    captureError: null, captureStopping: false,
    uncommittedFragments: new Map(), fragmentWriteFailed: false, mediaRecorderStopPromise: null,
    recFormat: 'wav', opusMime: null, mediaRecorder: null, opusSeq: 0,
    ownerId: getRecordingOwnerId(), sessionId: null,
    liveScribe: false, limiterNode: null, followUps: 0, rowBeat: null, savingId: null, liveSnapshot: null
};

function trackFollowUp(work) {
    AppState.followUps++;
    return Promise.resolve(work).finally(() => { AppState.followUps--; });
}

export function followUpsRunning() { return AppState.followUps > 0; }

export async function addContextToRecording(recId, item) {
    if (recId == null || !item) return 0;
    const updated = await dbUpdate(CONFIG.STORE_REC, recId, rec => {
        if (!rec) return null;
        const chain = rec.contextChain ? [...rec.contextChain] : (rec.context ? [rec.context] : []);
        chain.push(item);
        rec.contextChain = chain;
        delete rec.context;
        return rec;
    });
    return updated ? updated.contextChain.length : 0;
}

export function describeLiveContext(count) {
    const n = Number(count) || 0;
    if (n <= 0) return '';
    return `🧠 ${n} context item${n === 1 ? '' : 's'} for the AI reply`;
}

const _recordingStateListeners = new Set();

export function onRecordingStateChange(listener) {
    if (typeof listener !== 'function') return () => {};
    _recordingStateListeners.add(listener);
    return () => _recordingStateListeners.delete(listener);
}

function announceRecordingState() {
    for (const listener of [..._recordingStateListeners]) {
        try { listener(); } catch (err) { console.warn('Recording state listener failed:', err); }
    }
}

function makeRecordingSessionId() {
    try { return crypto.randomUUID(); } catch (_) {}
    return `${AppState.ownerId}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

function chunksForRecordingSession(chunks, rec) {
    const all = chunks || [];
    if (rec?.sessionId) return all.filter(chunk => chunk.sessionId === rec.sessionId);

    const sessions = new Set(all.map(chunk => chunk.sessionId).filter(Boolean));
    if (sessions.size <= 1) return all;
    throw new Error('Multiple isolated fragment sessions were found for this recording. The streams were kept separate to prevent corruption.');
}

async function deleteRecordingSessionChunks(recId, sessionId) {
    return deleteAudioFragments(recId, sessionId, { allSessions: false });
}

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
    stopWave();

    const btn = document.getElementById('recordBtn');
    if (btn) {
        btn.disabled = true;
        btn.classList.remove('recording');
        btn.textContent = `${captureErrorLabel()} — stopping…`;
    }
    showWaveform(false);

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
    fragment.bytes = Number(fragment.blob && fragment.blob.size) || 0;
    AppState.uncommittedFragments.set(key, fragment);
    if (AppState.fragmentWriteFailed) return false;
    try {
        await dbExec(CONFIG.STORE_FRAGMENTS, 'add', fragment);
        AppState.uncommittedFragments.delete(key);
        bumpStorage(fragment.blob?.size || 0);
        return true;
    } catch (err) {
        AppState.fragmentWriteFailed = true;
        handleCaptureFailure(err);
        return false;
    }
}

function startAutoGain() {
    const meter = AppState.agcAnalyser || AppState.analyser;
    if (!meter || !AppState.gainNode) return;
    if (AppState.gainInterval) clearInterval(AppState.gainInterval);
    const samples = new Float32Array(meter.fftSize);
    AppState.gainNode.gain.value = 0.8;

    AppState.gainInterval = setInterval(() => {
        if (!AppState.audioCtx || !AppState.gainNode) return;
        const target = nextAutoGain(AppState.gainNode.gain.value, meterLevel(meter, samples));
        if (target == null) return;
        AppState.gainNode.gain.setTargetAtTime(target, AppState.audioCtx.currentTime, 0.05);
    }, 100);
}

const LIVE_TRANSCRIPT_SNAPSHOT_EVERY_BEATS = 20;

function liveCaptureFlags(recId) {
    if (!AppState.captureError || AppState.recId !== recId) return null;
    return { captureError: AppState.captureError, incompleteAudio: AppState.uncommittedFragments.size > 0 };
}

async function persistOwnedHeartbeat(recId, durationMs, state, sessionId = AppState.sessionId, liveTranscript = null,
                                     { force = false, captureFlags = null } = {}) {
    if (recId == null) return;
    const now = Date.now();
    publishRecordingLease(recId, now, sessionId, durationMs);
    const heardMs = capturedMs(AppState.samplesSeen || 0, AppState.audioCtx ? AppState.audioCtx.sampleRate : 0);
    let beatStored = false;
    try {
        const beat = captureBeatRecord({
            recId, ownerId: AppState.ownerId, sessionId, now, durationMs, capturedMs: heardMs, state,
            captureFlags: captureFlags || liveCaptureFlags(recId)
        });
        beatStored = await writeCaptureBeat(beat);
    } catch (err) {
        console.warn('Recording beat failed; the recording row carries the heartbeat instead:', err);
    }
    let snapshotted = false;
    if (liveTranscript) {
        try {
            snapshotted = await writeLiveTranscript(recId, liveTranscript);
        } catch (err) {
            console.warn('Live transcript snapshot failed:', err);
        }
    }
    if (beatStored && !heartbeatRowDue({ last: AppState.rowBeat, recId, state, now, force, snapshotted })) return;
    AppState.rowBeat = { recId, state, at: now };
    try {
        await dbUpdate(CONFIG.STORE_REC, recId, (rec) => {
            if (!rec || rec.ownerId !== AppState.ownerId || !rec.processing) return null;
            rec.heartbeatAt = now;
            rec.durationMs = Math.max(rec.durationMs || 0, durationMs || 0);
            rec.captureState = state;
            if (heardMs > 0) rec.capturedMs = Math.max(rec.capturedMs || 0, heardMs);
            if (snapshotted) {
                rec.liveTranscriptLines = ((liveTranscript.lines || []).length) || 0;
            }
            return rec;
        });
    } catch (err) {
        console.warn('Recording heartbeat failed:', err);
    }
}

function liveSnapshotIfDue(started, beats) {
    if (!started || beats % LIVE_TRANSCRIPT_SNAPSHOT_EVERY_BEATS !== 0 || !isLiveScribeActive()) return null;
    const now = Date.now();
    const sizeAndSignature = liveTranscriptSizeAndSignature();
    if (!liveSnapshotDue({ now, last: AppState.liveSnapshot, ...sizeAndSignature })) return null;
    AppState.liveSnapshot = { at: now, ...sizeAndSignature };
    return liveScribeResult();
}

function startRecordingHeartbeat() {
    if (AppState.heartbeatTimer) clearInterval(AppState.heartbeatTimer);
    AppState.liveSnapshot = null;
    let beats = 0;
    const beat = () => {
        const started = !!AppState.startTime;
        const duration = started ? Math.max(0, Date.now() - AppState.startTime) : 0;
        beats++;
        return persistOwnedHeartbeat(
            AppState.recId,
            duration,
            started ? 'recording' : 'starting',
            AppState.sessionId,
            liveSnapshotIfDue(started, beats)
        );
    };
    beat();
    AppState.heartbeatTimer = setInterval(beat, CONFIG.RECORDING_HEARTBEAT_MS);
}

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
        track.addEventListener('mute', () => { AppState.trackMuted = true; });
        track.addEventListener('unmute', () => { AppState.trackMuted = false; });
        if (track.muted) AppState.trackMuted = true;
    }

    const source = AppState.audioCtx.createMediaStreamSource(AppState.stream);

    AppState.gainNode = AppState.audioCtx.createGain();
    AppState.gainNode.gain.value = 1.0;

    const limiter = AppState.audioCtx.createDynamicsCompressor();
    for (const [name, value] of Object.entries(LIMITER_SETTINGS)) limiter[name].value = value;

    AppState.analyser         = AppState.audioCtx.createAnalyser();
    AppState.analyser.fftSize = 2048;
    AppState.dataArr          = new Uint8Array(AppState.analyser.frequencyBinCount);

    AppState.agcAnalyser         = AppState.audioCtx.createAnalyser();
    AppState.agcAnalyser.fftSize = 1024;

    source.connect(AppState.gainNode);
    AppState.gainNode.connect(AppState.agcAnalyser);
    AppState.gainNode.connect(limiter);
    limiter.connect(AppState.analyser);
    AppState.limiterNode = limiter;

    if (AppState.recFormat === 'opus') {
        try {
            const dest = AppState.audioCtx.createMediaStreamDestination();
            limiter.connect(dest);
            const mr = new MediaRecorder(dest.stream, {
                mimeType: AppState.opusMime,
                audioBitsPerSecond: opusBitsPerSecond()
            });
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
                AppState.captureProgress = (AppState.captureProgress || 0) + ev.data.size;
                countRecordedBytes(ev.data.size);
                trackPendingFlush(persistAudioFragment({
                    recId, sessionId: AppState.sessionId, seq, createdAt: Date.now(), blob: ev.data
                }));
            };
            mr.start(CONFIG.IO_FLUSH_SEC * 1000);
            if (AppState.liveScribe) await attachCaptureWorklet();
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

    await attachCaptureWorklet();
}

async function attachCaptureWorklet() {
    if (AppState.workletNode || !AppState.audioCtx || !AppState.limiterNode) return;
    const workletBlob = new Blob([getWorkletCode()], { type: 'application/javascript' });
    const workletUrl  = URL.createObjectURL(workletBlob);
    try {
        await AppState.audioCtx.audioWorklet.addModule(workletUrl);
    } finally {
        URL.revokeObjectURL(workletUrl);
    }

    const workletNode = new AudioWorkletNode(AppState.audioCtx, 'recorder-worklet');
    AppState.workletNode = workletNode;
    if (AppState.recFormat === 'opus' && AppState.graphStartSec != null) {
        AppState.samplesSeen = Math.max(AppState.samplesSeen || 0,
            samplesBeforeTap(AppState.audioCtx.currentTime, AppState.graphStartSec, AppState.audioCtx.sampleRate));
    }
    AppState.limiterNode.connect(workletNode);
    workletNode.connect(AppState.audioCtx.destination);
    workletNode.port.onmessage = handleWorkletMessage;
    workletNode.port.onmessageerror = () => {
        handleCaptureFailure(new Error('The audio worklet stopped delivering valid data.'), 'encoder');
    };
}

const VIZ_MAX_DPR = 2;
const FPS_REFRESH_MS = 500;

export function fpsCounterWanted() {
    return readStored('myai-debug') === '1';
}

function queueWave() {
    const wait = waveWaitMs(performance.now(), AppState._vizDue);
    if (wait > 0) {
        AppState._vizTimer = setTimeout(() => {
            AppState._vizTimer = null;
            AppState.rafId = requestAnimationFrame(drawWave);
        }, wait);
    } else {
        AppState.rafId = requestAnimationFrame(drawWave);
    }
}

function stopWave() {
    cancelAnimationFrame(AppState.rafId);
    clearTimeout(AppState._vizTimer);
    AppState.rafId = null;
    AppState._vizTimer = null;
}

function drawWave(now = performance.now()) {
    AppState.rafId = null;
    if (AppState.captureError || !AppState.analyser || !AppState.dataArr || !(AppState._vizFps > 0)) return;
    const frame = nextWaveFrame(now, AppState._vizDue, AppState._vizFps);
    AppState._vizDue = frame.due;
    queueWave();
    if (frame.draw) paintWave(now);
}

function paintWave(now) {
    const canvas = AppState._vizCanvas || (AppState._vizCanvas = document.getElementById('visualizer'));
    const ctx = AppState._vizCtx || (AppState._vizCtx = canvas.getContext('2d'));
    const dpr = Math.min(VIZ_MAX_DPR, window.devicePixelRatio || 1);
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

    if (!AppState._fpsEl) return;
    AppState._fpsFrames = (AppState._fpsFrames || 0) + 1;
    if (!AppState._fpsSince) AppState._fpsSince = now;
    const span = now - AppState._fpsSince;
    if (span >= FPS_REFRESH_MS) {
        AppState._fpsEl.textContent = `${Math.round((AppState._fpsFrames * 1000) / span)} FPS`;
        AppState._fpsFrames = 0;
        AppState._fpsSince = now;
    }
}

function resetWaveform() {
    stopWave();
    AppState._vizCanvas = null;
    AppState._vizCtx = null;
    AppState._vizDue = 0;
    AppState._vizW = 0;
    AppState._vizH = 0;
    AppState._fpsFrames = 0;
    AppState._fpsSince = 0;
}

function showWaveform(on) {
    const canvas = document.getElementById('visualizer');
    if (canvas) canvas.style.display = on ? 'block' : 'none';
    document.getElementById('footer')?.classList.toggle('recording', on);
    const fpsDisplay = document.getElementById('fpsDisplay');
    AppState._fpsEl = on && fpsCounterWanted() ? fpsDisplay : null;
    fpsDisplay?.classList.toggle('on', !!AppState._fpsEl);
    if (!on) document.dispatchEvent(new CustomEvent(WAVEFORM_HIDDEN_EVENT));
}

export function measureScreenRefresh({ frames = 24, timeoutMs = 1500 } = {}) {
    return new Promise(resolve => {
        if (typeof requestAnimationFrame !== 'function') { resolve(null); return; }
        const stamps = [];
        let done = false;
        let frameId = null;
        let timer = null;
        const finish = () => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            cancelAnimationFrame(frameId);
            resolve(refreshRateHz(stamps));
        };
        const step = at => {
            stamps.push(at);
            if (stamps.length > frames) finish();
            else frameId = requestAnimationFrame(step);
        };
        timer = setTimeout(finish, timeoutMs);
        frameId = requestAnimationFrame(step);
    });
}

export function applyWaveformRate() {
    AppState._vizFps = waveformFps(getSetting('set-waveform-fps'));
    if (AppState.recId == null || AppState.captureError || !AppState.analyser) return;
    const on = AppState._vizFps > 0;
    showWaveform(on);
    if (!on) { stopWave(); return; }
    if (AppState.rafId == null && AppState._vizTimer == null) {
        AppState._vizDue = 0;
        drawWave();
    }
}

function handleWorkletMessage(e) {
    const payload = e.data || {};
    if (payload.type === 'flush-complete') {
        const resolve = AppState.workletFlushResolve;
        AppState.workletFlushResolve = null;
        if (resolve) resolve();
        return;
    }
    const audio = payload.type === 'audio' ? payload.data : payload;
    if (!(audio instanceof Float32Array) || audio.length === 0) return;

    AppState.samplesSeen = (AppState.samplesSeen || 0) + audio.length;
    AppState.captureProgress = (AppState.captureProgress || 0) + audio.length;

    if (AppState.liveScribe) pushLivePcm(audio, AppState.audioCtx ? AppState.audioCtx.sampleRate : 48000);

    if (AppState.recFormat === 'opus') return;
    AppState.pcmBuffer.push(audio);
    AppState.pcmLength += audio.length;
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

    const { flat, keptBuffer, keptLength } = planPcmFlush(AppState.pcmBuffer, samplesToProcess);
    AppState.pcmBuffer = isFinal ? [] : keptBuffer;
    AppState.pcmLength = isFinal ? 0 : keptLength;

    const wavBlob = encodeMonoWav(flat, AppState.audioCtx ? AppState.audioCtx.sampleRate : 48000);
    if (AppState.recId) {
        countRecordedBytes(wavBlob.size);
        await persistAudioFragment({
            recId: AppState.recId, sessionId: AppState.sessionId,
            seq: AppState.wavSeq++, createdAt: Date.now(), blob: wavBlob
        });
    }
}

async function retryUncommittedFragments(recId, sessionId) {
    if (AppState.uncommittedFragments.size === 0) return [];

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
            await dbExec(CONFIG.STORE_FRAGMENTS, 'add', fragment);
            AppState.uncommittedFragments.delete(key);
            committed.add(key);
            bumpStorage(fragment.blob?.size || 0);
        } catch (err) {
            if (err && err.name === 'ConstraintError') {
                AppState.uncommittedFragments.delete(key);
                committed.add(key);
                continue;
            }
            console.error('Audio fragment retry failed; the pieces after it stay in memory so the stored audio has no hole:', err);
            break;
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
        let fileMs = null;
        try { fileMs = await webmAudioEndMs(raw); } catch (_) { fileMs = null; }
        const lengthMs = opusLengthMs({ fileMs, wallMs: durationMs || 0, elapsedMs: Date.now() - (Number(rec.timestamp) || 0) });
        try { return await makeWebmSeekable(raw, Math.max(1, lengthMs)); }
        catch (_) { return raw; }
    }
    return stitchWavChunks(all.map(fragment => fragment.blob), rec.sampleRate || 48000);
}

export async function buildRecoverableAudio(recId) {
    const rec = await dbExec(CONFIG.STORE_REC, 'get', recId);
    if (!rec) return null;
    return buildEmergencyRecoveryBlob(recId, rec.sessionId, [], rec.format || 'wav', rec.mime, rec.durationMs || 0);
}

export async function downloadRecoverableAudio(recId) {
    const rec = await dbExec(CONFIG.STORE_REC, 'get', recId);
    const blob = rec ? await buildRecoverableAudio(recId) : null;
    if (!blob) return false;
    downloadRecoveryBlob(blob, rec.format || 'wav', rec.timestamp || Date.now());
    return true;
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

function ensureWavSizeLimit(chunks) {
    const dataBytes = wavDataBytesFor((chunks || []).map(chunk => chunk.blob));
    if (dataBytes <= WAV_MAX_DATA_BYTES) return;
    const err = new Error(
        `This recording holds ${fmtBytes(dataBytes)} of audio, more than the ${fmtBytes(WAV_MAX_DATA_BYTES)} ` +
        `a single WAV file can describe. Recoverable chunks were kept; download them or record in Opus for sessions this long.`);
    err.name = 'WavSizeLimitError';
    throw err;
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

function returnToMainView() {
    if (typeof document === 'undefined') return;
    for (const id of ['settingsOverlay', 'helpOverlay']) {
        const overlay = document.getElementById(id);
        if (overlay) { overlay.classList.remove('open'); overlay.setAttribute('aria-hidden', 'true'); }
    }
    const toggle = document.getElementById('liveScribeBtn');
    if (toggle) toggle.setAttribute('aria-pressed', 'false');
    try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch (_) { try { window.scrollTo(0, 0); } catch (_) {} }
}

async function completeTranscriptColumns(recId) {
    const result = await fillTranslations(recId);
    if (result.cancelled) return;
    const fillNoticeChanged = await dbUpdate(CONFIG.STORE_REC, recId, rec => {
        if (!rec || rec.deleting) return null;
        if (result.stopped) {
            rec.fillError = result.stopped;
            rec.fillErrorAt = Date.now();
            return rec;
        }
        if (!rec.fillError) return null;
        delete rec.fillError;
        delete rec.fillErrorAt;
        return rec;
    });
    if (!result.filled) {
        if (fillNoticeChanged) await _renderList({ force: true });
        return;
    }
    await refreshLiveTranscript(recId);
    await _renderList({ force: true });
    console.info(`Transcript columns completed: ${result.filled} line(s) translated`
        + (result.missing ? `, ${result.missing} could not be` : ''));
}

export function runAfterRecording(recId) {
    return runInOrderUntilCancelled([() => runAutoPipeline(recId), () => runSecondPass(recId)],
        (err, step) => console.warn(step === 0 ? 'Auto pipeline failed:' : 'Second pass failed:', err));
}

async function runSecondPass(recId) {
    const mode = getSetting('set-second-pass');
    if (mode === 'off') return;
    const rec = await dbExec(CONFIG.STORE_REC, 'get', recId);
    if (!rec || rec.deleting) return CANCELLED;
    showLiveStatus(recId, 'scribe', '🧹 Cleanup pass… (tap to watch)',
        () => openLiveLogTab(recId, rec.filename || `Recording #${recId}`),
        () => window.cancelRecJob(recId));
    try {
        await transcribeChunked(recId, text => updateLiveStatus(recId, 'scribe', `🧹 Cleanup pass: ${text}`),
                                { reuseLive: false });
    } finally {
        removeLiveStatus(recId, 'scribe');
    }
    if (mode !== 'replace' || hasJob('r', recId)) return;
    let dropLive = false;
    await dbUpdate(CONFIG.STORE_REC, recId, rec => {
        if (!rec || !Array.isArray(rec.transcripts)) return null;
        const kept = transcriptsAfterCleanup(rec.transcripts, rec.summaries);
        if (!kept.length || kept.length === rec.transcripts.length) return null;
        rec.transcripts = kept;
        dropLive = liveTranscriptAfterCleanup(rec, kept) === 'drop';
        if (dropLive) delete rec.liveTranscriptLines;
        return rec;
    });
    if (dropLive) await deleteLiveTranscript(recId).catch(() => {});
}

function cleanupRecordingState() {
    const stopStillSaving = AppState.captureStopping;
    stopLiveScribe({ keepText: true });
    if (AppState.gainInterval) clearInterval(AppState.gainInterval);
    if (AppState.heartbeatTimer) clearInterval(AppState.heartbeatTimer);
    try { if (AppState.workletNode) { AppState.workletNode.port.onmessage = null; AppState.workletNode.disconnect(); } } catch (_) {}
    if (AppState.stream) AppState.stream.getTracks().forEach(t => t.stop());
    if (AppState.audioCtx && AppState.audioCtx.state !== 'closed') AppState.audioCtx.close();

    clearInterval(AppState.timerId);
    AppState.timerId = null;
    resetWaveform();
    showWaveform(false);
    paintRunway('', 'ok');
    paintCaptureAlert('');
    AppState.captureHealth = null;
    AppState.trackMuted = false;

    disableWakeLock();
    try { if (AppState.mediaRecorder && AppState.mediaRecorder.state !== 'inactive') AppState.mediaRecorder.stop(); } catch (_) {}
    AppState.recId        = null;
    AppState.heartbeatTimer = null;
    AppState.workletNode  = null;
    AppState.limiterNode  = null;
    AppState.workletFlushResolve = null;
    AppState.agcAnalyser  = null;
    AppState.pcmBuffer    = [];
    AppState.pcmLength    = 0;
    AppState.wavSeq       = 0;
    AppState.startTime    = 0;
    AppState.graphStartSec = null;
    AppState.rowBeat      = null;
    AppState.pendingFlushes = new Set();
    AppState.captureStopScheduled = false;
    AppState.captureError      = null;
    AppState.captureStopping   = false;
    AppState.uncommittedFragments = new Map();
    AppState.fragmentWriteFailed = false;
    AppState.mediaRecorderStopPromise = null;
    AppState.mediaRecorder = null;
    AppState.opusSeq       = 0;
    AppState.recFormat     = 'wav';
    AppState.opusMime      = null;
    AppState.sessionId     = null;
    if (!stopStillSaving) document.getElementById('recordBtn').textContent = 'Start Recording';
    announceRecordingState();
}

async function markFinalizationError(recId, durationMs, err, finalizerId = null, stopFlags = null) {
    return dbUpdate(CONFIG.STORE_REC, recId, (rec) => {
        if (!rec || (finalizerId && rec.finalizerId !== finalizerId)) return null;
        return markSaveFailed(rec, { durationMs, error: err, stopFlags });
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

async function finalizeWavBackup(recId, durationMs, { runPipeline = true, finalizerId = null, stopFlags = null } = {}) {
    const rec0 = await dbExec(CONFIG.STORE_REC, 'get', recId);
    if (!rec0) return;
    const rawChunks = await getAudioFragmentsForRecording(recId);
    const chunks = chunksForRecordingSession(rawChunks, rec0);

    if (!chunks || chunks.length === 0) {
        const stored = await dbUpdate(CONFIG.STORE_REC, recId, rec => {
            if (!rec || (finalizerId && rec.finalizerId !== finalizerId)) return null;
            return markFinalized(applyStopFlags(rec, stopFlags), durationMs, !(rec.audioBytes > 0));
        });
        if (!stored && finalizerId) throw new Error('Finalization ownership changed.');
        return;
    }
    chunks.sort((a, b) => a.seq - b.seq);
    await ensureFinalizationHeadroom(chunks);
    ensureWavSizeLimit(chunks);

    const sampleRate = rec0.sampleRate || 48000;
    const dataBytes = wavDataBytesFor(chunks.map(chunk => chunk.blob));
    const derivedDuration = dataBytes > 0
        ? Math.round((dataBytes / 2 / sampleRate) * 1000)
        : 0;
    const effectiveDuration = derivedDuration || durationMs || rec0.durationMs || 0;
    const masterBlob = stitchWavChunks(chunks.map(chunk => chunk.blob), sampleRate);

    const stored = await commitAudio(recId, masterBlob, rec => {
        if (!rec || (finalizerId && rec.finalizerId !== finalizerId)) return null;
        rec.audioBytes = masterBlob.size;
        return markFinalized(applyStopFlags(rec, stopFlags), effectiveDuration);
    });
    if (!stored) {
        if (finalizerId) throw new Error('Finalization ownership changed.');
        return;
    }

    await deleteRecordingSessionChunks(recId, rec0.sessionId);
    await calcTotalStorage();
    if (runPipeline) await runAutoPipeline(recId);
}

async function finalizeOpus(recId, durationMs, mime, { runPipeline = true, finalizerId = null, stopFlags = null } = {}) {
    const rec0 = await dbExec(CONFIG.STORE_REC, 'get', recId);
    if (!rec0) return;
    const rawChunks = await getAudioFragmentsForRecording(recId);
    const chunks = chunksForRecordingSession(rawChunks, rec0);
    if (!chunks || chunks.length === 0) {
        const stored = await dbUpdate(CONFIG.STORE_REC, recId, rec => {
            if (!rec || (finalizerId && rec.finalizerId !== finalizerId)) return null;
            return markFinalized(applyStopFlags(rec, stopFlags), durationMs, !(rec.audioBytes > 0));
        });
        if (!stored && finalizerId) throw new Error('Finalization ownership changed.');
        return;
    }
    chunks.sort((a, b) => a.seq - b.seq);
    await ensureFinalizationHeadroom(chunks);
    const rawMaster = new Blob(chunks.map(chunk => chunk.blob), { type: mime || 'audio/webm' });
    let fileMs = null;
    try { fileMs = await webmAudioEndMs(rawMaster); } catch (_) { fileMs = null; }
    const effectiveDuration = opusLengthMs({
        fileMs,
        wallMs: Math.max(durationMs || 0, rec0.durationMs || 0),
        capturedMs: rec0.capturedMs || 0,
        elapsedMs: Date.now() - (Number(rec0.timestamp) || 0)
    });
    let masterBlob = rawMaster;
    let remuxError = null;
    try {
        masterBlob = await makeWebmSeekable(rawMaster, effectiveDuration);
    } catch (err) {
        console.warn('WebM remux failed; committing the unremuxed master and leaving it upgradable:', err);
        masterBlob = rawMaster;
        remuxError = err && err.message ? err.message : String(err);
    }
    const webmSeekable = masterBlob !== rawMaster
        && String(masterBlob.type || mime || '').toLowerCase().includes('webm');

    const stored = await commitAudio(recId, masterBlob, (rec) => {
        if (!rec || (finalizerId && rec.finalizerId !== finalizerId)) return null;
        rec.audioBytes = masterBlob.size;
        if (webmSeekable) rec.webmSeekableVersion = WEBM_SEEKABLE_VERSION;
        else delete rec.webmSeekableVersion;
        delete rec.webmDurationFixed;
        if (remuxError) rec.webmRemuxError = remuxError;
        else delete rec.webmRemuxError;
        return markFinalized(applyStopFlags(rec, stopFlags), effectiveDuration);
    });
    if (!stored) {
        if (finalizerId) throw new Error('Finalization ownership changed.');
        return;
    }

    await deleteRecordingSessionChunks(recId, rec0.sessionId);
    await calcTotalStorage();
    if (runPipeline) await runAutoPipeline(recId);
}

async function finalizeRecording(recId, durationMs, opts = {}) {
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
        try { await storeLiveTranscript(recId); }
        catch (liveErr) { console.warn('Could not keep the live transcript after retrying finalization:', liveErr); }
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

export async function buildLivePreviewBlob(recId) {
    if (recId == null) return null;
    const rec0 = await dbExec(CONFIG.STORE_REC, 'get', recId);
    if (!rec0) return null;
    const rawChunks = await getAudioFragmentsForRecording(recId);
    const chunks = chunksForRecordingSession(rawChunks, rec0);
    if (!chunks || chunks.length === 0) return null;
    chunks.sort((a, b) => a.seq - b.seq);
    if (rec0 && rec0.format === 'opus') {
        return new Blob(chunks.map(c => c.blob), { type: rec0.mime || 'audio/webm' });
    }
    const sampleRate = (rec0 && rec0.sampleRate) || 48000;
    return stitchWavChunks(chunks.map(c => c.blob), sampleRate);
}

async function absorbCaptureBeat(recId, beat, fallbackMs) {
    if (!beat) return fallbackMs;
    try {
        const updated = await dbUpdate(CONFIG.STORE_REC, recId, rec => {
            if (!rec || !beatHeartbeatAt(rec, beat)) return null;
            rec.durationMs = Math.max(rec.durationMs || 0, Number(beat.durationMs) || 0);
            noteRecordingEnded(rec, beat.heartbeatAt);
            if (Number(beat.capturedMs) > 0) rec.capturedMs = Math.max(rec.capturedMs || 0, Number(beat.capturedMs));
            if (beat.captureError && !rec.captureError) rec.captureError = { ...beat.captureError };
            if (beat.incompleteAudio) rec.incompleteAudio = true;
            return rec;
        });
        return updated ? updated.durationMs : fallbackMs;
    } catch (_) {
        return fallbackMs;
    }
}

export async function recoverIncompleteRecordings({ retryFailed = true } = {}) {
    const pending = (await getUnfinishedRecordings())
        .filter(rec => !rec.deleting && (retryFailed || rec.captureState !== 'finalize-error'));
    if (pending.length === 0) return { recovered: 0, deferred: 0 };

    const locked = await acquireRecordingLock();
    if (!locked) return { recovered: 0, deferred: pending.length };

    const now = Date.now();
    const beats = await readCaptureBeats();
    let recovered = 0;
    let deferred = 0;
    try {
        for (const rec of pending) {
            const beat = beats.get(Number(rec.id)) || null;
            if (AppState.recId === rec.id || isRecordOwnedByLiveTab(rec, now, beat)) {
                deferred++;
                continue;
            }
            const heartbeatAt = recordHeartbeatAt(rec, beat);
            if (rec.captureState !== 'finalize-error' && heartbeatAt && isFreshHeartbeat(heartbeatAt, now)) {
                deferred++;
                continue;
            }

            const finalizerId = await claimFinalizer(rec.id);
            if (!finalizerId) {
                deferred++;
                continue;
            }
            rec.durationMs = await absorbCaptureBeat(rec.id, beat, rec.durationMs || 0);
            let heartbeat = setInterval(
                () => touchFinalizer(rec.id, finalizerId).catch(() => {}),
                CONFIG.RECORDING_HEARTBEAT_MS
            );
            let settled = false;
            try {
                await finalizeRecording(rec.id, rec.durationMs || 0, { runPipeline: false, finalizerId });
                settled = true;
                try { await storeLiveTranscript(rec.id); }
                catch (liveErr) { console.warn('Could not keep the live transcript of a recovered recording:', liveErr); }
                recovered++;
            } catch (err) {
                settled = !!(await markFinalizationError(rec.id, rec.durationMs || 0, err, finalizerId).catch(() => null));
            } finally {
                clearInterval(heartbeat);
                heartbeat = null;
                await releaseFinalizer(rec.id, finalizerId).catch(() => {});
                if (settled) deleteCaptureBeat(rec.id).catch(() => {});
            }
        }
        return { recovered, deferred };
    } finally {
        await releaseRecordingLock();
    }
}

export function isLiveTranscriptionOn() { return !!AppState.liveScribe; }

function elapsedRecordingSec() {
    return AppState.startTime ? Math.max(0, (Date.now() - AppState.startTime) / 1000) : 0;
}

async function flushCapturedAudioToStorage() {
    if (AppState.recId == null) return;
    try {
        if (AppState.mediaRecorder && AppState.mediaRecorder.state === 'recording') {
            AppState.mediaRecorder.requestData();
        } else if (AppState.pcmLength > 0) {
            await trackPendingFlush(flushPcmToDb(true, AppState.pcmLength));
        }
    } catch (err) {
        console.warn('Could not flush captured audio before backfilling:', err);
    }
    await Promise.allSettled([...AppState.pendingFlushes]);
}

setLiveScribeAudioSource(recId => buildLivePreviewBlob(recId));

export async function setLiveTranscription(on) {
    const wanted = !!on;
    if (!wanted) {
        AppState.liveScribe = false;
        if (AppState.recId != null) pauseLiveScribe(); else closeLiveScribe();
        return false;
    }
    if (AppState.recId == null) { AppState.liveScribe = true; return true; }

    const originSec = elapsedRecordingSec();
    if (!startLiveScribe(AppState.recId,
                         AppState.audioCtx ? AppState.audioCtx.sampleRate : 48000,
                         originSec)) {
        AppState.liveScribe = false;
        return false;
    }
    AppState.liveScribe = true;
    try {
        await attachCaptureWorklet();
        await flushCapturedAudioToStorage();
        backfillLiveScribe(AppState.recId, originSec);
    } catch (err) {
        console.warn('Live transcription could not attach its audio tap:', err);
        AppState.liveScribe = false;
        pauseLiveScribe();
        return false;
    }
    return true;
}

let _renderList = () => {};
export function setRenderList(fn) { _renderList = fn; }

const LIVE_DEFAULT_ACK = 'live-transcribe-default-acknowledged-v1';

function liveTranscriptionByDefault() {
    if (getSetting('set-live-transcribe') !== 'on') return false;
    if (readStored(LIVE_DEFAULT_ACK) !== '1') {
        const accepted = confirm(
            'Live transcription is set to start with every recording.\n\n'
            + 'That means audio is sent to your transcription server from the moment you press record, '
            + 'rather than only when you ask for it. Recording itself needs no internet connection; this does, '
            + 'and live text stops arriving whenever that connection does - the recording keeps going regardless.\n\n'
            + 'Start recordings this way?');
        if (!accepted) { writeStored('set-live-transcribe', 'off'); return false; }
        writeStored(LIVE_DEFAULT_ACK, '1');
    }
    return true;
}

export async function startRecording({ live = false } = {}) {
    if (AppState.busy || AppState.recId) return;
    AppState.liveScribe = live === true || liveTranscriptionByDefault();
    AppState.busy = true;
    AppState.captureError = null;
    AppState.captureStopping = false;
    AppState.captureStopScheduled = false;
    AppState.pendingFlushes = new Set();
    AppState.uncommittedFragments = new Map();
    AppState.fragmentWriteFailed = false;
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
            filename: getLocalIso(now),
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
        announceRecordingState();
        publishRecordingLease(AppState.recId, now, AppState.sessionId, 0);
        AppState.rowBeat = null;
        startRecordingHeartbeat();

        if (AppState.liveScribe
            && !startLiveScribe(AppState.recId, AppState.audioCtx.sampleRate, 0)) {
            AppState.liveScribe = false;
        }

        await initAudioStream();
        if (AppState.captureError) throw new Error(AppState.captureError.message || 'Audio capture failed during startup.');
        AppState.startTime = Date.now();
        AppState.graphStartSec = AppState.audioCtx.currentTime;
        AppState.samplesSeen = 0;
        AppState.captureProgress = 0;
        AppState.trackMuted = false;
        AppState.captureHealth = initialCaptureHealth(AppState.startTime);
        AppState.recordedBytes = 0;
        AppState.runwayAt = 0;
        AppState.runwayKnown = false;
        AppState.runwayAnnounced = Infinity;
        AppState.timerId = setInterval(updateLiveGUI, CONFIG.GUI_UPDATE_MS);

        resetWaveform();
        applyWaveformRate();
        startAutoGain();
        recordBtn.disabled = false;
        await _renderList();
    } catch (err) {
        cleanupRecordingState();
        if (orphanId != null) {
            try { await deleteRecordingSessionChunks(orphanId, orphanSessionId); } catch (_) {}
            try { await dbExec(CONFIG.STORE_REC, 'delete', orphanId); } catch (_) {}
        }
        AppState.pendingContext = null;
        await releaseRecordingLock();
        recordBtn.classList.remove('recording');
        recordBtn.disabled = false;
        await _renderList();
        alert('Failed to start: ' + (err && err.message ? err.message : err));
    } finally {
        AppState.busy = false;
        announceRecordingState();
    }
}

const stopRecordingOnce = singleFlight(() => stopRecordingNow());

export function stopRecording() {
    return stopRecordingOnce();
}

async function stopRecordingNow() {
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
    let stopFlags = null;
    let rowSettled = false;

    persistOwnedHeartbeat(currentId, finalDuration, 'finalizing', currentSessionId).catch(() => {});
    finalizationHeartbeat = setInterval(
        () => persistOwnedHeartbeat(currentId, finalDuration, 'finalizing', currentSessionId, null,
                                    { captureFlags: stopFlags }),
        CONFIG.RECORDING_HEARTBEAT_MS
    );

    const began = Date.now();
    let lastMark = began;
    const phases = [];
    const mark = name => { const now = Date.now(); phases.push(`${name} ${now - lastMark}ms`); lastMark = now; };

    try {
        if (AppState.mediaRecorder) {
            try { await ensureMediaRecorderStopped(); } catch (_) {}
        }
        try { AppState.stream?.getTracks().forEach(track => track.stop()); } catch (_) {}
        if (AppState.workletNode) await flushWorkletTail();
        try {
            if (AppState.workletNode) {
                AppState.workletNode.port.onmessage = null;
                AppState.workletNode.port.onmessageerror = null;
                AppState.workletNode.disconnect();
            }
        } catch (_) {}

        mark('encoder');
        if (isLiveScribeActive()) {
            try { await flushLiveScribe(); }
            catch (err) { console.warn('Live transcription flush failed:', err); }
        }
        mark('live tail');
        const liveResult = liveScribeResult();

        await flushPcmToDb(true, AppState.pcmLength);
        await Promise.allSettled([...AppState.pendingFlushes]);
        mark('last fragments');

        unsaved = await retryUncommittedFragments(currentId, currentSessionId);
        failure = AppState.captureError || failure;
        unsavedBytes = unsaved.reduce((sum, fragment) => sum + (fragment.blob?.size || 0), 0);

        stopFlags = failure ? {
            captureError: { ...failure },
            incompleteAudio: unsaved.length > 0,
            unsavedFragmentCount: unsaved.length,
            unsavedBytes
        } : null;
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

        if (liveResult) {
            try { await writeLiveTranscript(currentId, liveResult); }
            catch (err) { console.warn('Could not store the live transcript:', err); }
        }
        try {
            await dbUpdate(CONFIG.STORE_REC, currentId, rec => {
                if (!rec) return null;
                if (liveResult) {
                    rec.liveTranscriptLines = ((liveResult.lines || []).length) || 0;
                }
                rec.durationMs = Math.max(rec.durationMs || 0, finalDuration);
                rec.captureState = 'finalizing';
                rec.heartbeatAt = Date.now();
                return applyStopFlags(rec, stopFlags);
            });
        } catch (err) {
            console.warn('Could not note the stop on the recording; finalizing it anyway:', err);
        }

        if (liveResult) {
            try { await storeLiveTranscript(currentId); }
            catch (err) { console.warn('Could not keep the live transcript:', err); }
        }
        mark('live transcript');

        await persistOwnedHeartbeat(currentId, finalDuration, 'finalizing', currentSessionId, null,
                                    { force: true, captureFlags: stopFlags });

        AppState.savingId = currentId;
        cleanupRecordingState();
        closeLiveScribe();
        returnToMainView();
        await _renderList();
        mark('first repaint');
        await finalizeRecording(currentId, finalDuration, { runPipeline: false, stopFlags });
        rowSettled = true;
        mark('master blob');

        if (!unsaved.length) {
            trackFollowUp(runAfterRecording(currentId));
            trackFollowUp(completeTranscriptColumns(currentId)
                .catch(err => console.warn('Completing the transcript columns failed:', err)));
        }
    } catch (err) {
        finalizationError = err;
        cleanupRecordingState();
        try { rowSettled = !!(await markFinalizationError(currentId, finalDuration, err, null, stopFlags)); }
        catch (markErr) { console.error('Could not persist finalization error state:', markErr); }
    } finally {
        AppState.savingId = null;
        if (finalizationHeartbeat) clearInterval(finalizationHeartbeat);
        if (rowSettled) deleteCaptureBeat(currentId).catch(() => {});
        try { await releaseRecordingLock(); }
        catch (lockErr) { console.error('Recording lock release failed:', lockErr); }
        btn.disabled = false;
        btn.textContent = 'Start Recording';
        AppState.busy = false;
        announceRecordingState();
        try { await _renderList(); }
        catch (renderErr) { console.error('Final recording repaint failed:', renderErr); }
        mark('final repaint');
        console.info(`Stop took ${Date.now() - began}ms: ${phases.join(', ')}`);
    }

    const reason = failure?.kind === 'quota'
        ? 'browser storage became full'
        : failure?.kind === 'microphone'
            ? 'the microphone input ended unexpectedly'
            : failure?.kind === 'encoder'
                ? 'the browser audio encoder failed'
                : 'an audio segment could not be written to browser storage';

    if (finalizationError) {
        if (!recoveryBlob) {
            try {
                recoveryBlob = await buildEmergencyRecoveryBlob(currentId, currentSessionId, unsaved,
                                                                currentFormat, currentMime, finalDuration);
            } catch (err) {
                console.error('Could not build the audio saved so far:', err);
            }
        }
        if (!failure) {
            const message = 'Recording was saved in recoverable chunks, but finalization failed: ' +
                (finalizationError && finalizationError.message ? finalizationError.message : finalizationError);
            if (recoveryBlob) {
                if (confirm(`${message}\n\nDownload the audio saved so far now?`)) {
                    downloadRecoveryBlob(recoveryBlob, currentFormat, recordingTimestamp);
                }
            } else {
                alert(message);
            }
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
function paintCaptureAlert(text) {
    const node = typeof document !== 'undefined' && document.getElementById('capture-alert');
    if (node) {
        node.textContent = text || '';
        node.hidden = !text;
    }
    const row = AppState.recId != null && document.getElementById(`rec-${AppState.recId}`);
    if (row) row.classList.toggle('rec-item-capture-stalled', !!text);
}

async function markAudioIncomplete(recId) {
    if (recId == null) return;
    try {
        await dbUpdate(CONFIG.STORE_REC, recId, rec => {
            if (!rec || rec.incompleteAudio) return null;
            rec.incompleteAudio = true;
            return rec;
        });
    } catch (err) {
        console.warn('Could not mark the recording as incomplete:', err);
    }
}

function checkCaptureHealth(now) {
    const ctx = AppState.audioCtx;
    const next = nextCaptureHealth(AppState.captureHealth, {
        progress: AppState.captureProgress || 0,
        nowMs: now,
        muted: AppState.trackMuted === true,
        suspended: !!ctx && ctx.state !== 'running',
        stallMs: AppState.workletNode
            ? CAPTURE_STALL_MS
            : captureStallMs(CONFIG.IO_FLUSH_SEC * 1000)
    });
    const move = captureHealthTransition(AppState.captureHealth, next);
    AppState.captureHealth = next;

    if (shouldTryResume(next)) {
        AppState.captureHealth = { ...next, resumeTried: true };
        try { ctx.resume().catch(() => {}); } catch (_) {}
    }

    if (move === 'stalled') {
        const message = describeCaptureStall(next);
        paintCaptureAlert(message);
        try { liveScribeSystemNote(message, 'error'); } catch (_) {}
        console.warn(message);
        markAudioIncomplete(AppState.recId);
    } else if (move === 'recovered') {
        const message = describeCaptureRecovery({ gapMs: AppState.captureHealth.longestGapMs });
        paintCaptureAlert('');
        try { liveScribeSystemNote(message, 'warn'); } catch (_) {}
        console.info(message);
    }
}

function updateLiveGUI() {
    if (!AppState.startTime) return;
    if (AppState.captureError) {
        paintCaptureFailureUI();
        return;
    }
    checkCaptureHealth(Date.now());
    const elapsed = Date.now() - AppState.startTime;
    const recordBtn = document.getElementById('recordBtn');
    if (recordBtn.textContent !== 'Stop Recording') recordBtn.textContent = 'Stop Recording';
    const rowClock = document.getElementById(`live-clock-${AppState.recId}`);
    if (rowClock) rowClock.textContent = fmtDur(elapsed);
    sampleRunway();
}

const RUNWAY_POLL_MS = 15000;
const RUNWAY_WARMUP_POLL_MS = 3000;
const OPUS_BITRATES = [24, 32, 48, 64, 96];

function opusBitsPerSecond() {
    const value = Number(getSetting('set-opus-bitrate'));
    return (OPUS_BITRATES.includes(value) ? value : 32) * 1000;
}

function countRecordedBytes(bytes) {
    AppState.recordedBytes = (AppState.recordedBytes || 0) + (Number(bytes) || 0);
}



function paintRunway(text, tone) {
    const node = typeof document !== 'undefined' && document.getElementById('session-runway');
    if (!node) return;
    node.textContent = text || '';
    node.hidden = !text;
    node.classList.toggle('runway-warn', tone === 'warn');
    node.classList.toggle('runway-error', tone === 'error');
}

function sampleRunway() {
    const now = Date.now();
    const every = AppState.runwayKnown ? RUNWAY_POLL_MS : RUNWAY_WARMUP_POLL_MS;
    if (now - (AppState.runwayAt || 0) < every) return;
    AppState.runwayAt = now;
    if (!navigator.storage?.estimate) { updateRunway(null, now); return; }
    navigator.storage.estimate()
        .then(estimate => updateRunway(estimate, now))
        .catch(() => {});
}

function updateRunway(estimate, now) {
    if (!AppState.startTime) { paintRunway('', 'ok'); return; }
    const elapsedSec = Math.max(1, (now - AppState.startTime) / 1000);
    const recorded = AppState.recordedBytes || 0;
    const storage = estimate
        ? storageRunway({
            usedBytes: Number(estimate.usage),
            quotaBytes: Number(estimate.quota),
            recordedBytes: recorded,
            bytesPerSec: recorded / elapsedSec
        })
        : null;
    const runway = sessionRunway({ storage });
    AppState.runwayKnown = runway.known;
    paintRunway(describeRunway(runway, { persistent: AppState.storagePersistent }),
                runwayTone(runway.secondsLeft));

    const threshold = nextRunwayAlert(runway.secondsLeft, AppState.runwayAnnounced);
    if (threshold == null) return;
    AppState.runwayAnnounced = threshold;
    const message = describeRunwayAlert(runway, threshold);
    noteRunwayAlert(message, threshold <= 300);
}

function noteRunwayAlert(message, interrupt) {
    let placed = false;
    try { placed = liveScribeSystemNote(message, 'error'); } catch (_) { placed = false; }
    console.warn(message);
    if (!interrupt) return;
    setTimeout(() => { try { alert(message); } catch (_) {} }, 0);
    return placed;
}
