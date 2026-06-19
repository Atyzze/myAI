/* ==========================================================================
   recorder.js — Recording lifecycle, AGC, visualizer, IO flush, WAV stitch
   ========================================================================== */
import { CONFIG, fmtDur, getLocalIso }            from './config.js';
import { dbExec, dbUpdate, calcTotalStorage, bumpStorage } from './db.js';
import { encodeMonoWav, getWorkletCode, stitchWavChunks } from './audio.js';
import { runAutoPipeline }                         from './auto-pipeline.js';
import { enableWakeLock, disableWakeLock }         from './wake-lock.js';

// ── Shared mutable state ──
export const AppState = {
    recId: null, audioCtx: null, stream: null,
    pcmBuffer: [], pcmLength: 0, wavSeq: 0,
    startTime: 0, timerId: null,
    analyser: null, dataArr: null, rafId: null,
    gainNode: null, gainInterval: null, agcAnalyser: null,
    workletNode: null, pendingFlushes: [],
    pendingContext: null, _fpsLast: null,
    _vizW: 0, _vizH: 0,
    busy: false, quotaHit: false, _quotaStopScheduled: false,
    ioErrorCount: 0
};

// ── Quota handling — storage full mid-recording must not silently drop audio ──
function isQuotaError(err) {
    if (!err) return false;
    const name = err.name
        || (err.target && err.target.error && err.target.error.name)
        || '';
    return name === 'QuotaExceededError'
        || name === 'NS_ERROR_DOM_QUOTA_REACHED'
        || /quota/i.test(err.message || '');
}

function handleQuotaExceeded(err) {
    AppState.quotaHit = true;                 // stops handleWorkletMessage buffering more
    if (AppState._quotaStopScheduled) return;
    AppState._quotaStopScheduled = true;
    console.error('Storage quota exceeded during recording:', err);
    // Stop on a fresh microtask so we don't re-enter the flush we're inside.
    queueMicrotask(() => {
        if (AppState.recId != null) {
            stopRecording().finally(() => alert(
                'Storage is full — recording was stopped. ' +
                'Audio captured up to this point has been saved.'));
        }
    });
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

// ── Audio stream setup (mic → gain → limiter → analyser → worklet) ──
async function initAudioStream() {
    AppState.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
    });

    const source = AppState.audioCtx.createMediaStreamSource(AppState.stream);

    AppState.gainNode = AppState.audioCtx.createGain();
    AppState.gainNode.gain.value = 1.0;

    const limiter = AppState.audioCtx.createDynamicsCompressor();
    limiter.threshold.value = -8;
    limiter.knee.value      = 2;
    limiter.ratio.value     = 30;
    limiter.attack.value    = 0.003;
    limiter.release.value   = 0.080;

    // Visualizer analyser sits AFTER the limiter (shows the final signal).
    AppState.analyser       = AppState.audioCtx.createAnalyser();
    AppState.analyser.fftSize = 2048;
    AppState.dataArr        = new Uint8Array(AppState.analyser.frequencyBinCount);

    // AGC measurement tap BEFORE the limiter.
    AppState.agcAnalyser         = AppState.audioCtx.createAnalyser();
    AppState.agcAnalyser.fftSize = 1024;

    source.connect(AppState.gainNode);
    AppState.gainNode.connect(AppState.agcAnalyser);   // pre-limiter tap (no onward path needed)
    AppState.gainNode.connect(limiter);
    limiter.connect(AppState.analyser);

    const workletBlob = new Blob([getWorkletCode()], { type: 'application/javascript' });
    const workletUrl  = URL.createObjectURL(workletBlob);
    await AppState.audioCtx.audioWorklet.addModule(workletUrl);
    URL.revokeObjectURL(workletUrl);

    const workletNode = new AudioWorkletNode(AppState.audioCtx, 'recorder-worklet');
    AppState.workletNode = workletNode;

    limiter.connect(workletNode);
    workletNode.connect(AppState.audioCtx.destination);
    workletNode.port.onmessage = handleWorkletMessage;
}

// ── Visualizer (waveform canvas) ──
export function drawWave() {
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
    if (AppState.quotaHit) return;             // storage full — stop buffering audio
    AppState.pcmBuffer.push(e.data);
    AppState.pcmLength += e.data.length;
    const required = AppState.audioCtx.sampleRate * CONFIG.IO_FLUSH_SEC;
    if (AppState.pcmLength >= required) {
        // Track the promise so stopRecording can await all writes before finalizing.
        AppState.pendingFlushes.push(flushPcmToDb(false, required));
    }
}

async function flushPcmToDb(isFinal, samplesToProcess) {
    if (AppState.pcmLength === 0) return;
    const flat = new Float32Array(samplesToProcess);
    let offset = 0;
    const chunksToKeep = [];
    let keptLength = 0;

    for (const chunk of AppState.pcmBuffer) {
        if (offset < samplesToProcess) {
            const take = Math.min(chunk.length, samplesToProcess - offset);
            flat.set(chunk.subarray(0, take), offset);
            offset += take;
            if (take < chunk.length) {
                const remainder = chunk.subarray(take);
                chunksToKeep.push(remainder);
                keptLength += remainder.length;
            }
        } else {
            chunksToKeep.push(chunk);
            keptLength += chunk.length;
        }
    }

    AppState.pcmBuffer = isFinal ? [] : chunksToKeep;
    AppState.pcmLength = isFinal ? 0 : keptLength;

    const wavBlob = encodeMonoWav(flat, AppState.audioCtx ? AppState.audioCtx.sampleRate : 48000);
    if (AppState.recId) {
        try {
            await dbExec(CONFIG.STORE_WAV, 'add', {
                recId: AppState.recId, seq: AppState.wavSeq++, blob: wavBlob
            });
            bumpStorage(wavBlob.size);   // O(1) update instead of rescanning both stores
        } catch (err) {
            if (isQuotaError(err)) {
                handleQuotaExceeded(err);
            } else {
                // A non-quota write failure for this 4 s chunk. Don't reject:
                // the promise is only awaited (via allSettled) at stop, so a
                // rejection here surfaces as a noisy unhandled-rejection in the
                // meantime, and tearing down capture would lose far more audio.
                // Log + count, keep recording, and tell the user at stop that the
                // recording may have gaps.
                console.error('Failed to persist audio chunk:', err);
                AppState.ioErrorCount = (AppState.ioErrorCount || 0) + 1;
            }
        }
    }
}

// ── Cleanup shared state ──
function cleanupRecordingState() {
    if (AppState.gainInterval) clearInterval(AppState.gainInterval);
    try { if (AppState.workletNode) { AppState.workletNode.port.onmessage = null; AppState.workletNode.disconnect(); } } catch (_) {}
    if (AppState.stream) AppState.stream.getTracks().forEach(t => t.stop());
    if (AppState.audioCtx && AppState.audioCtx.state !== 'closed') AppState.audioCtx.close();

    cancelAnimationFrame(AppState.rafId);
    document.getElementById('visualizer').style.display = 'none';
    document.getElementById('fpsDisplay').style.display = 'none';
    document.getElementById('footer').classList.remove('recording');

    disableWakeLock();
    AppState.recId        = null;
    AppState.workletNode  = null;
    AppState.agcAnalyser  = null;
    AppState.pcmBuffer    = [];
    AppState.pcmLength    = 0;
    AppState.wavSeq       = 0;
    AppState.startTime    = 0;
    AppState.pendingFlushes = [];
    AppState.quotaHit          = false;
    AppState._quotaStopScheduled = false;
    AppState.ioErrorCount      = 0;
    document.getElementById('recordBtn').textContent = 'Start Recording';
}

// ── Finalize: stitch WAV chunks into master blob ──
// runPipeline=false is used by crash-recovery so reload doesn't silently re-run
// (and re-POST to) the cloud transcription/reply pipeline.
export async function finalizeWavBackup(recId, durationMs, { runPipeline = true } = {}) {
    const chunks = await dbExec(CONFIG.STORE_WAV, 'getAllFromIndex', { index: 'by-rec', val: recId });

    if (chunks.length === 0) {
        // Nothing captured (permission denied, instant stop, interrupted before
        // first flush). Clear the processing flag so the row doesn't get stuck
        // showing "Processing..." forever and re-appear on every reload.
        await dbUpdate(CONFIG.STORE_REC, recId, (rec0) => {
            if (!rec0) return null;
            rec0.processing = false;
            rec0.durationMs = durationMs;
            rec0.filename   = `${getLocalIso(rec0.timestamp)} - ${fmtDur(durationMs)} (no audio)`;
            return rec0;
        });
        return;
    }
    chunks.sort((a, b) => a.seq - b.seq);

    // Read once for the sample rate needed to build the header. The actual
    // mutation below is done atomically via dbUpdate so a concurrent writer
    // (or a second tab) can't clobber the master blob we store.
    const rec0 = await dbExec(CONFIG.STORE_REC, 'get', recId);
    if (!rec0) return;
    const sampleRate = rec0.sampleRate || 48000;

    // Stitch the master WAV by concatenating each chunk's PCM as a Blob SLICE
    // (lazy, by-reference) behind a fresh header — no full-file decode in RAM.
    // Verified byte-identical to the old decode→re-encode path. The same
    // concatenation feeds the live in-recording preview (buildLivePreviewBlob),
    // so it lives once in audio.js/stitchWavChunks and is unit-tested there.
    const masterBlob = stitchWavChunks(chunks.map(c => c.blob), sampleRate);

    const stored = await dbUpdate(CONFIG.STORE_REC, recId, (rec) => {
        if (!rec) return null;
        rec.blob       = masterBlob;
        rec.durationMs = durationMs;
        rec.processing = false;
        rec.filename   = `${getLocalIso(rec.timestamp)} - ${fmtDur(durationMs)}`;
        return rec;
    });
    if (!stored) return;   // record vanished (e.g. deleted) — nothing to finalize

    await dbExec(CONFIG.STORE_WAV, 'deleteRange', recId);
    calcTotalStorage();   // authoritative recount after the chunk→master swap

    // Hand off to the auto-pipeline (transcribe → reply if configured)
    if (runPipeline) await runAutoPipeline(recId);
}

// ── Live preview: a PLAYABLE snapshot of an in-progress recording ──
// Reads the 4-second WAV chunks already flushed to STORE_WAV for `recId` and
// stitches them into one playable WAV WITHOUT deleting them or touching the
// recording row — finalize still owns the destructive master-blob swap at stop.
// This is what lets the active recording's row show a working play bar while
// you're still recording (the GUI rebuilds the player from this on a timer).
//
// Returns null when nothing has been flushed yet (recording younger than one
// IO_FLUSH_SEC window) so the caller can show a "buffering" state instead of an
// empty <audio>. The snapshot lags real time by at most one flush interval (the
// not-yet-written PCM still sitting in AppState.pcmBuffer) — exactly the ~4 s
// preview cadence the live player advertises. Reads are isolated IndexedDB
// transactions, so a concurrent finalize delete can never corrupt the result.
export async function buildLivePreviewBlob(recId) {
    if (recId == null) return null;
    const chunks = await dbExec(CONFIG.STORE_WAV, 'getAllFromIndex', { index: 'by-rec', val: recId });
    if (!chunks || chunks.length === 0) return null;
    chunks.sort((a, b) => a.seq - b.seq);
    const rec0       = await dbExec(CONFIG.STORE_REC, 'get', recId);
    const sampleRate = (rec0 && rec0.sampleRate) || 48000;
    return stitchWavChunks(chunks.map(c => c.blob), sampleRate);
}

// ── Recover incomplete recordings on page load ──
// Finalizes WITHOUT running the auto-pipeline; the caller re-renders afterwards.
export async function recoverIncompleteRecordings() {
    const all = await dbExec(CONFIG.STORE_REC, 'getAllFromIndex', { index: 'by-date' });
    for (const rec of all) {
        if (rec.processing) {
            try { await finalizeWavBackup(rec.id, rec.durationMs || 0, { runPipeline: false }); }
            catch (err) {
                // Clear the stuck flag atomically (don't write back the stale
                // loop snapshot, which could miss finalize's partial writes).
                await dbUpdate(CONFIG.STORE_REC, rec.id, (cur) => {
                    if (!cur) return null;
                    cur.processing = false;
                    return cur;
                });
            }
        }
    }
}

// ── Public: start / stop ──
// renderList is injected to avoid circular dependency
let _renderList = () => {};
export function setRenderList(fn) { _renderList = fn; }

export async function startRecording() {
    // Debounce: ignore taps while a start/stop is in flight or one is active.
    if (AppState.busy || AppState.recId) return;
    AppState.busy = true;

    const recordBtn = document.getElementById('recordBtn');
    recordBtn.disabled = true;
    recordBtn.classList.add('recording');

    try {
        enableWakeLock();   // native screen wake lock (best-effort; user gesture present)
        AppState.audioCtx = new (window.AudioContext || window.webkitAudioContext)();

        const recObj = {
            filename:    `${getLocalIso()} - Recording...`,
            timestamp:   Date.now(),
            durationMs:  0,
            processing:  true,
            sampleRate:  AppState.audioCtx.sampleRate,
            transcripts: [],
            summaries:   []
        };

        if (AppState.pendingContext) {
            recObj.contextChain   = AppState.pendingContext;
            AppState.pendingContext = null;
        }

        AppState.recId = await dbExec(CONFIG.STORE_REC, 'add', recObj);

        await initAudioStream();
        AppState.startTime = Date.now();
        AppState.timerId   = setInterval(updateLiveGUI, CONFIG.GUI_UPDATE_MS);

        document.getElementById('visualizer').style.display = 'block';
        document.getElementById('fpsDisplay').style.display = 'block';
        document.getElementById('footer').classList.add('recording');
        AppState._fpsLast = null;
        AppState._vizW = 0;
        AppState._vizH = 0;
        drawWave();
        startAutoGain();
        recordBtn.disabled = false;          // recording active — allow Stop
        _renderList();
    } catch (err) {
        // Delete the orphan DB row so it doesn't get stuck as a "Processing..."
        // ghost that reappears on every reload.
        const orphanId = AppState.recId;
        cleanupRecordingState();
        if (orphanId != null) { try { await dbExec(CONFIG.STORE_REC, 'delete', orphanId); } catch (_) {} }
        recordBtn.disabled = false;
        _renderList();
        alert('Failed to start: ' + err.message);
    } finally {
        AppState.busy = false;
    }
}

export async function stopRecording() {
    if (AppState.busy || !AppState.recId) return;   // debounce double-taps
    AppState.busy = true;

    const btn = document.getElementById('recordBtn');
    btn.disabled = true;
    btn.textContent = 'Finalizing...';
    btn.classList.remove('recording');
    clearInterval(AppState.timerId);

    // Stop capture BEFORE the final flush so no further worklet messages arrive
    // mid-flush and re-enter flushPcmToDb on the shared PCM buffer.
    try {
        if (AppState.workletNode) {
            AppState.workletNode.port.onmessage = null;
            AppState.workletNode.disconnect();
        }
    } catch (_) {}
    try { if (AppState.stream) AppState.stream.getTracks().forEach(t => t.stop()); } catch (_) {}

    await flushPcmToDb(true, AppState.pcmLength);
    await Promise.allSettled(AppState.pendingFlushes);   // all chunk writes committed

    const finalDuration = Date.now() - AppState.startTime;
    const currentId     = AppState.recId;
    const hadIoErrors   = (AppState.ioErrorCount || 0) > 0;   // capture before cleanup clears it
    cleanupRecordingState();

    btn.disabled = false;
    AppState.busy = false;

    if (hadIoErrors) {
        alert('Some audio segments could not be saved (a storage or database error occurred during recording). ' +
              'The saved recording may have gaps.');
    }

    finalizeWavBackup(currentId, finalDuration).catch(console.error);
}

function updateLiveGUI() {
    if (!AppState.startTime) return;
    document.getElementById('recordBtn').textContent =
        `Stop Recording (${fmtDur(Date.now() - AppState.startTime)})`;
}
