/* ==========================================================================
 *  transcribe.js - Server transcription, audio chunking and timeline assembly
 *  ========================================================================== */
import { CONFIG, fmtDur, getSetting, uid, confirmServerProcessing } from './config.js';
import { dbExec, dbUpdate }                    from './db.js';
import { encodeMonoWav, resampleTo16k, inspectPcmWav,
         resamplePcmWavRangeTo16k, resampleWebmRangeTo16k } from './audio.js';
import { prepareWebmChunkSource }               from './webm-duration.js';
import { planAudioChunks, trimOverlapSegments, trimOverlapTextFallback,
         reassembleTimeline, runPool } from './transcribe-core.js';
import { beginJob, endJob, abortError }         from './jobs.js';
import { liveLogAppend, liveLogText }           from './live-tabs.js';

/* ──────────────────────────────────────────────────────────────────────────
 *  SINGLE-CHUNK SERVER TRANSCRIPTION
 *  ────────────────────────────────────────────────────────────────────────── */
export async function transcribeChunkServer(recId, chunkIndex, f32Chunk, signal, timeoutMs = 120000) {
    const url       = CONFIG.TRANSCRIBE_URL.replace(/\/+$/, '');
    const lang      = getSetting('set-transcribe-lang');
    const chunkBlob = encodeMonoWav(f32Chunk, 16000);
    const form      = new FormData();
    form.append('file', chunkBlob, `chunk_${recId}_${chunkIndex}.wav`);
    if (lang && lang !== 'auto') form.append('language', lang);
    form.append('store_backup', getSetting('set-remote-backups') === 'on' ? 'true' : 'false');

    const requestCtrl = new AbortController();
    const onJobAbort = () => requestCtrl.abort();
    if (signal) {
        if (signal.aborted) requestCtrl.abort();
        else signal.addEventListener('abort', onJobAbort, { once: true });
    }
    const timer = setTimeout(() => requestCtrl.abort(), timeoutMs);

    try {
        const res = await fetch(url, { method: 'POST', body: form, signal: requestCtrl.signal });
        if (!res.ok) throw new Error(`Transcription server failed on chunk ${chunkIndex + 1} (HTTP ${res.status})`);
        const data     = await res.json();
        const segments = Array.isArray(data.segments) ? data.segments : [];
        const text     = data.text || (segments.length ? segments.map(segment => segment.text).join(' ') : '');
        return { text: String(text || '').trim(), segments };
    } catch (err) {
        if (err && err.name === 'AbortError') {
            if (signal && signal.aborted) throw err;
            throw new Error(`Transcription chunk ${chunkIndex + 1} timed out after ${Math.round(timeoutMs / 1000)}s`);
        }
        throw err;
    } finally {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onJobAbort);
    }
}

function buildChunkDisplay(chunk, coreSegments, fallbackText) {
    if (!coreSegments || coreSegments.length === 0) return fallbackText;
    return coreSegments.map(segment => {
        const absStart = chunk.startSec + segment.start;
        const absEnd   = chunk.startSec + segment.end;
        return `[${fmtDur(absStart * 1000)}-${fmtDur(absEnd * 1000)}] ${segment.text.trim()}`;
    }).join('\n');
}

async function processOneChunk(chunk, recId, results, state, signal, loadAudio) {
    if (signal && signal.aborted) throw abortError();

    const index = chunk.idx;
    let audio = null;

    try {
        audio = await loadAudio(chunk);
        if (signal && signal.aborted) throw abortError();

        const result       = await transcribeChunkServer(recId, index, audio, signal);
        const coreSegments = trimOverlapSegments(result.segments || [], chunk);
        const trimmedText  = coreSegments.length > 0
            ? coreSegments.map(segment => segment.text).join(' ').trim()
            : trimOverlapTextFallback(result.text || '', chunk);

        results[index] = {
            coreSec:       chunk.coreSec,
            coreEndSec:    chunk.coreEndSec,
            chunkStartSec: chunk.startSec,
            text:          trimmedText,
            segments:      coreSegments
        };
        state.doneCount++;
        state.consecutiveFailures = 0;

        liveLogText(recId, index, buildChunkDisplay(chunk, coreSegments, trimmedText),
                    chunk.coreSec, chunk.coreEndSec, coreSegments.length > 0);

        const pct = Math.round((state.doneCount / state.totalChunks) * 100);
        state.progressCallback(`${pct}% - ${state.doneCount}/${state.totalChunks} chunks done`);
        liveLogAppend(recId,
            `✅ [${index + 1}/${state.totalChunks}] ` +
            `${chunk.coreSec.toFixed(1)}s-${chunk.coreEndSec.toFixed(1)}s - ${trimmedText.length} chars`
        );
    } catch (err) {
        if (err && err.name === 'AbortError') throw err;

        results[index] = {
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
        liveLogAppend(recId, `⚠️ [${index + 1}/${state.totalChunks}] chunk failed: ${err.message}`);
        const pct = Math.round((state.doneCount / state.totalChunks) * 100);
        state.progressCallback(`${pct}% - ${state.doneCount}/${state.totalChunks} (${state.failCount} failed)`);

        if (state.consecutiveFailures >= state.failBreaker) {
            state.broken = true;
            liveLogAppend(recId,
                `⛔ Stopping after ${state.consecutiveFailures} consecutive failures - server may be unreachable.`);
        }
    } finally {
        audio = null;
    }
}

/**
 * Transcribe a full recording in 60-second overlapping windows through the
 * configured self-hosted server. Work is cancellable through the jobs registry.
 */
export async function transcribeChunked(recId, progressCallback) {
    if (!confirmServerProcessing()) throw abortError('Server processing cancelled.');

    const rec = await dbExec(CONFIG.STORE_REC, 'get', recId);
    if (!rec || !rec.blob) throw new Error('Audio blob missing.');
    const resultGeneration = rec.resultGeneration || 0;

    const ctrl   = beginJob('t', recId);
    const signal = ctrl.signal;
    const abortP = new Promise((_, reject) => {
        if (signal.aborted) return reject(abortError());
        signal.addEventListener('abort', () => reject(abortError()), { once: true });
    });

    let fullAudio16k = null;
    try {
        const durationMin = ((rec.durationMs || 0) / 60000).toFixed(1);
        liveLogAppend(recId, `▶️ Starting server transcription - ${durationMin} min recording`);

        progressCallback('Preparing audio...');
        const pcmMeta = await inspectPcmWav(rec.blob);
        let chunks;
        let loadAudio;

        if (pcmMeta) {
            const total16k = Math.max(0, Math.round(pcmMeta.durationSec * 16000));
            chunks = planAudioChunks(total16k, 16000, 60, 3);
            loadAudio = chunk => resamplePcmWavRangeTo16k(
                rec.blob, pcmMeta, chunk.startSec, chunk.endSec
            );
            liveLogAppend(recId, '🔄 Streaming WAV ranges at 16 kHz (bounded memory)...');
        } else {
            let webmSource = null;
            try {
                webmSource = await prepareWebmChunkSource(rec.blob, rec.durationMs || 0);
            } catch (err) {
                liveLogAppend(recId, `⚠️ Bounded WebM parsing unavailable (${err.message}); trying browser decode.`);
            }

            if (webmSource) {
                const total16k = Math.max(0, Math.round(webmSource.durationSec * 16000));
                chunks = planAudioChunks(total16k, 16000, 60, 3);
                loadAudio = chunk => resampleWebmRangeTo16k(
                    webmSource, chunk.startSec, chunk.endSec
                );
                liveLogAppend(recId,
                    `🔄 Streaming ${webmSource.clusters.length} WebM/Opus Clusters in bounded decode windows...`);
            } else {
                liveLogAppend(recId, '🔄 Decoding compressed audio to 16 kHz using the browser fallback...');
                fullAudio16k = await resampleTo16k(rec.blob);
                chunks = planAudioChunks(fullAudio16k.length, 16000, 60, 3);
                loadAudio = chunk => fullAudio16k.slice(chunk.startSample, chunk.endSample);
            }
        }

        const totalChunks = chunks.length;
        if (totalChunks === 0) throw new Error('Recording contains no audio samples.');
        const concurrency = CONFIG.TRANSCRIBE_CONCURRENCY;
        liveLogAppend(recId, `📦 ${totalChunks} chunks - 60 s steps, ±3 s overlap, up to ${concurrency} in parallel`);
        progressCallback(`0% - dispatching ${totalChunks} chunks`);

        const results = new Array(totalChunks).fill(null);
        const state   = {
            doneCount: 0, failCount: 0, consecutiveFailures: 0,
            broken: false, lastError: '',
            failBreaker: Math.min(5, totalChunks || 1),
            totalChunks, progressCallback
        };

        await Promise.race([
            runPool(chunks, concurrency,
                    chunk => processOneChunk(chunk, recId, results, state, signal, loadAudio),
                    () => state.broken),
            abortP
        ]);

        const successCount = state.doneCount - state.failCount;
        if (successCount === 0 && state.failCount > 0) {
            throw new Error(state.lastError
                ? `Transcription failed - no chunks could be processed (${state.lastError}).`
                : 'Transcription failed - no chunks could be processed (is the server reachable?).');
        }

        let skippedCount = 0;
        for (let index = 0; index < totalChunks; index++) {
            if (!results[index]) {
                const chunk = chunks[index];
                results[index] = {
                    coreSec:       chunk.coreSec,
                    coreEndSec:    chunk.coreEndSec,
                    chunkStartSec: chunk.startSec,
                    text:          '',
                    segments:      [],
                    failed:        true
                };
                skippedCount++;
            }
        }

        const { timestamped, plain } = reassembleTimeline(results, totalChunks);
        const totalGaps = state.failCount + skippedCount;
        const gapNote = totalGaps > 0 ? ` - ${totalGaps} chunk(s) failed or skipped` : '';
        liveLogAppend(recId, `🔗 Reassembled ${totalChunks} chunks → ${plain.length} chars${gapNote}`);

        const stored = await dbUpdate(CONFIG.STORE_REC, recId, (current) => {
            if (!current || (current.resultGeneration || 0) !== resultGeneration) return null;
            current.transcripts = current.transcripts || [];
            current.transcripts.unshift({
                id:     uid(),
                text:   timestamped || plain || 'No voice detected.',
                plain:  plain || '',
                source: 'S',
                time:   Date.now()
            });
            delete current.pipelineError;
            delete current.pipelineErrorAt;
            return current;
        });
        if (!stored) throw abortError('Result discarded because the recording changed or was deleted.');

        liveLogAppend(recId, `✅ Done - ${plain.length} chars total${gapNote}`);
        progressCallback('100% - done');
    } finally {
        fullAudio16k = null;
        endJob('t', recId, ctrl);
    }
}
