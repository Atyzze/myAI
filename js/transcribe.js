/* ==========================================================================
 *  transcribe.js — Audio chunking, overlap handling, dedup, pipeline
 *  ========================================================================== */
import { CONFIG, fmtDur, getSetting, uid }    from './config.js';
import { dbExec, dbUpdate }                    from './db.js';
import { encodeMonoWav, resampleTo16k }        from './audio.js';
import { aiWorker, aiJobs }                     from './ai-worker.js';
import { sliceAudioChunks, trimOverlapSegments,
         trimOverlapTextLocal, reassembleTimeline } from './transcribe-core.js';
import { beginJob, endJob, abortError }         from './jobs.js';
import { liveLogAppend, liveLogText }           from './live-tabs.js';

/* ──────────────────────────────────────────────────────────────────────────
 *  4. SINGLE-CHUNK TRANSCRIBERS (local / remote)
 *  ────────────────────────────────────────────────────────────────────────── */
export function transcribeChunkLocal(recId, chunkIndex, f32Chunk, onProgress, signal) {
    const lang = getSetting('set-transcribe-lang');
    return new Promise((resolve, reject) => {
        // A uid() nonce makes the job key unique per ATTEMPT. The on-device worker
        // can't be interrupted mid-chunk, so a cancelled-then-retried chunk could
        // otherwise reuse the deterministic key `transcribe-<rec>_c<i>` and let the
        // stale worker's late completion resolve the NEW job with old data (or
        // orphan it). The nonce + abort-delete below close that window.
        const fakeId = `${recId}_c${chunkIndex}_${uid()}`;
        const jobKey = `transcribe-${fakeId}`;

        const onAbort = () => {
            if (aiJobs[jobKey]) delete aiJobs[jobKey];   // worker still runs, but its result is now ignored
            reject(abortError());
        };
        if (signal) {
            if (signal.aborted) { reject(abortError()); return; }
            signal.addEventListener('abort', onAbort, { once: true });
        }
        const clearAbort = () => { if (signal) signal.removeEventListener('abort', onAbort); };

        aiJobs[jobKey] = {
            resolve: (v) => { clearAbort(); resolve(v); },
            reject:  (e) => { clearAbort(); reject(e); },
            progress: onProgress || (() => {})
        };
        aiWorker.postMessage(
            {
                action: 'transcribe',
                id: fakeId,
                data: f32Chunk,
                task: 'transcribe',                              // keep source language
                language: lang === 'auto' ? null : lang
            },
            [f32Chunk.buffer]
        );
    });
}

export async function transcribeChunkRemote(recId, chunkIndex, f32Chunk, signal, timeoutMs = 120000) {
    const url       = CONFIG.TRANSCRIBE_URL.replace(/\/+$/, '');
    const lang      = getSetting('set-transcribe-lang');
    const chunkBlob = encodeMonoWav(f32Chunk, 16000);
    const form      = new FormData();
    form.append('file', chunkBlob, `chunk_${recId}_${chunkIndex}.wav`);
    if (lang && lang !== 'auto') form.append('language', lang);

    // Per-chunk timeout so one hung request can't stall the whole pool forever.
    // We drive fetch with our own controller and forward the job's cancel
    // signal into it, so a user cancel still aborts the request.
    const tCtrl = new AbortController();
    const onJobAbort = () => tCtrl.abort();
    if (signal) {
        if (signal.aborted) tCtrl.abort();
        else signal.addEventListener('abort', onJobAbort, { once: true });
    }
    const timer = setTimeout(() => tCtrl.abort(), timeoutMs);

    try {
        const res = await fetch(url, { method: 'POST', body: form, signal: tCtrl.signal });
        if (!res.ok) throw new Error(`Cloud API failed on chunk ${chunkIndex + 1} (HTTP ${res.status})`);
        const data     = await res.json();
        const segments = data.segments || [];
        const text     = data.text || (segments.length ? segments.map(s => s.text).join(' ') : '');
        return { text: text.trim(), segments };
    } catch (err) {
        // Tell a user cancel (job signal aborted → propagate AbortError) apart
        // from our own timeout (convert to a normal Error so the pipeline treats
        // it as a recoverable chunk failure, not a cancellation).
        if (err && err.name === 'AbortError') {
            if (signal && signal.aborted) throw err;
            throw new Error(`Cloud chunk ${chunkIndex + 1} timed out after ${Math.round(timeoutMs / 1000)}s`);
        }
        throw err;
    } finally {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onJobAbort);
    }
}

/* ──────────────────────────────────────────────────────────────────────────
 *  5. THE PIPELINE — unified entry point for both local & remote
 *  ────────────────────────────────────────────────────────────────────────── */
function buildChunkDisplay(chunk, coreSegments, fallbackText) {
    if (!coreSegments || coreSegments.length === 0) return fallbackText;
    return coreSegments.map(seg => {
        const absStart = chunk.startSec + seg.start;
        const absEnd   = chunk.startSec + seg.end;
        return `[${fmtDur(absStart * 1000)}–${fmtDur(absEnd * 1000)}] ${seg.text.trim()}`;
    }).join('\n');
}

async function processOneChunk(chunk, recId, isLocal, results, state, signal) {
    // Stop picking up new chunks once cancelled. The local worker can't be
    // interrupted mid-chunk, but no further chunks will be dispatched.
    if (signal && signal.aborted) throw abortError();

    const i = chunk.idx;
    const onSubProgress = msg => liveLogAppend(recId, `  [${i + 1}] ↳ ${msg}`);

    try {
        let rawText, segments = [];
        if (isLocal) {
            rawText = await transcribeChunkLocal(recId, i, chunk.audio, onSubProgress, signal);
        } else {
            const result = await transcribeChunkRemote(recId, i, chunk.audio, signal);
            rawText  = result.text;
            segments = result.segments || [];
        }

        const coreSegments = trimOverlapSegments(segments, chunk);
        const trimmedText  = coreSegments.length > 0
            ? coreSegments.map(s => s.text).join(' ').trim()
            : trimOverlapTextLocal(rawText || '', chunk);

        results[i] = {
            coreSec:       chunk.coreSec,
            coreEndSec:    chunk.coreEndSec,
            chunkStartSec: chunk.startSec,
            text:          trimmedText,
            segments:      coreSegments
        };
        state.doneCount++;
        state.consecutiveFailures = 0;   // a success resets the circuit breaker

        // Pass an explicit "this chunk has real per-segment timestamps" flag so
        // the popup never has to sniff for a leading "[0…/[1…" — which broke past
        // 20 min (timestamps like [21:00] don't start with [0 or [1).
        liveLogText(recId, i, buildChunkDisplay(chunk, coreSegments, trimmedText),
                    chunk.coreSec, chunk.coreEndSec, coreSegments.length > 0);

        const pct = Math.round((state.doneCount / state.totalChunks) * 100);
        state.progressCallback(`${pct}% — ${state.doneCount}/${state.totalChunks} chunks done`);
        liveLogAppend(recId,
            `✅ [${i + 1}/${state.totalChunks}] ` +
            `${chunk.coreSec.toFixed(1)}s–${chunk.coreEndSec.toFixed(1)}s — ${trimmedText.length} chars`
        );
    } catch (err) {
        if (err && err.name === 'AbortError') throw err;   // user cancel — propagate

        // A single failed chunk must not lose the whole recording. Record a gap
        // placeholder (reassembly marks the hole) and keep going.
        results[i] = {
            coreSec:       chunk.coreSec,
            coreEndSec:    chunk.coreEndSec,
            chunkStartSec: chunk.startSec,
            text:          '',
            segments:      [],
            failed:        true
        };
        state.doneCount++;
        state.failCount++;
        state.consecutiveFailures++;
        state.lastError = err.message;
        liveLogAppend(recId, `⚠️ [${i + 1}/${state.totalChunks}] chunk failed: ${err.message}`);
        const pct = Math.round((state.doneCount / state.totalChunks) * 100);
        state.progressCallback(`${pct}% — ${state.doneCount}/${state.totalChunks} (${state.failCount} failed)`);

        // Circuit breaker: a run of consecutive failures means the endpoint is
        // probably down — stop dispatching NEW chunks so we don't hammer it.
        // (In-flight chunks, up to the concurrency limit, still settle.)
        if (state.consecutiveFailures >= state.failBreaker) {
            state.broken = true;
            liveLogAppend(recId,
                `⛔ Stopping after ${state.consecutiveFailures} consecutive failures — endpoint may be unreachable.`);
        }
    }
}

/** Run `worker` over `items` with at most `limit` in flight at once. Stops
 *  dispatching new items as soon as `shouldStop()` returns true (used by the
 *  circuit breaker so a dead endpoint isn't hammered). */
async function runPool(items, limit, worker, shouldStop) {
    let next = 0;
    const n = Math.min(limit, items.length);
    const runners = [];
    for (let k = 0; k < n; k++) {
        runners.push((async () => {
            while (next < items.length) {
                if (shouldStop && shouldStop()) return;
                const idx = next++;
                await worker(items[idx]);
            }
        })());
    }
    await Promise.all(runners);
}

/**
 * Main entry: transcribe a full recording in 60 s chunks (capped concurrency),
 * cancellable via the jobs registry. Saves a timestamped transcript to the DB.
 */
export async function transcribeChunked(recId, source, progressCallback) {
    const isLocal     = source === 'local';
    const sourceLabel = isLocal ? '💻 on-device' : '☁️ cloud';

    let rec = await dbExec(CONFIG.STORE_REC, 'get', recId);
    if (!rec || !rec.blob) throw new Error('Audio blob missing.');

    const ctrl   = beginJob('t', recId);
    const signal = ctrl.signal;
    const abortP = new Promise((_, reject) => {
        if (signal.aborted) return reject(abortError());
        signal.addEventListener('abort', () => reject(abortError()), { once: true });
    });

    try {
        const durationMin = ((rec.durationMs || 0) / 60000).toFixed(1);
        liveLogAppend(recId, `▶️ Starting ${sourceLabel} transcription — ${durationMin} min recording`);

        progressCallback('Resampling...');
        liveLogAppend(recId, '🔄 Resampling audio to 16 kHz...');
        const audio16k = await resampleTo16k(rec.blob);

        const chunks      = sliceAudioChunks(audio16k, 16000, 60, 3);
        const totalChunks = chunks.length;
        // One shared on-device Whisper instance cannot run chunks concurrently
        // (it double-loads the model and races its ONNX session). Force local to
        // 1; only remote chunks fan out to CONFIG.TRANSCRIBE_CONCURRENCY.
        const concurrency = isLocal ? 1 : CONFIG.TRANSCRIBE_CONCURRENCY;
        liveLogAppend(recId, `📦 ${totalChunks} chunks — 60 s steps, ±3 s overlap, up to ${concurrency} in parallel`);
        progressCallback(`0% — dispatching ${totalChunks} chunks`);

        const results = new Array(totalChunks).fill(null);
        const state   = {
            doneCount: 0, failCount: 0, consecutiveFailures: 0,
            broken: false, lastError: '',
            failBreaker: Math.min(5, totalChunks || 1),   // stop after N consecutive fails
            totalChunks, progressCallback
        };

        await Promise.race([
            runPool(chunks, concurrency,
                    c => processOneChunk(c, recId, isLocal, results, state, signal),
                    () => state.broken),
            abortP
        ]);

        // If literally nothing transcribed (every attempted chunk failed), don't
        // save a useless all-gaps record — surface a clear error instead so the
        // user can fix the endpoint and retry.
        const successCount = state.doneCount - state.failCount;
        if (successCount === 0 && state.failCount > 0) {
            throw new Error(state.lastError
                ? `Transcription failed — no chunks could be processed (${state.lastError}).`
                : 'Transcription failed — no chunks could be processed (is the server reachable?).');
        }

        // The circuit breaker stops dispatching NEW chunks after a run of
        // failures, leaving the later chunks as null (never attempted). Mark
        // those as explicit gaps too — otherwise reassembly skips them and the
        // saved transcript silently ENDS EARLY with no indication, even though
        // some earlier chunks succeeded. Now the hole is visible end-to-end.
        let skippedCount = 0;
        for (let i = 0; i < totalChunks; i++) {
            if (!results[i]) {
                const c = chunks[i];
                results[i] = {
                    coreSec:       c.coreSec,
                    coreEndSec:    c.coreEndSec,
                    chunkStartSec: c.startSec,
                    text:          '',
                    segments:      [],
                    failed:        true
                };
                skippedCount++;
            }
        }

        const { timestamped, plain } = reassembleTimeline(results, totalChunks);
        const totalGaps = state.failCount + skippedCount;
        const gapNote = totalGaps > 0 ? ` — ${totalGaps} chunk(s) failed or skipped` : '';
        liveLogAppend(recId, `🔗 Reassembled ${totalChunks} chunks → ${plain.length} chars${gapNote}`);

        // Atomic get→modify→put so a concurrent reply/transcribe (or a second
        // tab) writing this same record can't clobber the transcript we add.
        await dbUpdate(CONFIG.STORE_REC, recId, (cur) => {
            if (!cur) return null;
            cur.transcripts = cur.transcripts || [];
            cur.transcripts.unshift({
                id:     uid(),
                text:   timestamped || plain || 'No voice detected.',
                plain:  plain || '',
                source: isLocal ? 'D' : 'C',
                time:   Date.now()
            });
            return cur;
        });

        liveLogAppend(recId, `✅ Done — ${plain.length} chars total${gapNote}`);
        progressCallback('100% — done');
    } finally {
        endJob('t', recId);
    }
}
