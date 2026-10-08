import { CONFIG, fmtDur, getSetting, uid, confirmServerProcessing } from './config.js';
import { translateLines }                      from './reply.js';
import { dbExec, dbUpdate, readAudio, readLiveTranscript, updateLiveTranscript } from './db.js';
import { encodeMonoWav, resampleTo16k, inspectPcmWav,
         resamplePcmWavRangeTo16k, resampleWebmRangeTo16k } from './audio.js';
import { prepareWebmChunkSource }               from './webm-duration.js';
import { planAudioChunks, textForChunkCore, chunkCoreSamples,
         reassembleTimeline, planWholeFileDecode,
         invertCoverage, mergeIntervals, planChunksForRanges, liveLinesAsResults, liveHoles, holeResults,
         fillMissingTranslations, describeFillProgress, withTranslations, spokenPart,
         summarizeChunkLevel, isNearSilent, settleLiveReplays,
         chunkRetryDelayMs, nextPoolLimit, runAdaptivePool, shouldWaitForOwnChunk, POOL_START,
         createServerQueue, requestCameBack, anotherRequestBack } from './transcribe-core.js';
import { beginJob, endJob, abortError, hasJobOfKind } from './jobs.js';
import { liveLogAppend, liveLogText }           from './live-tabs.js';
import { findTimedRepetitionCandidates } from './live-refine-core.js';
import { capped } from './capabilities-core.js';
import { boxCapabilities } from './capabilities.js';

const MAX_LIVE_REPLAY_RANGES = 6;

// Every segment the server sends has text from here on, if only an empty one: one segment it sent
// without any (text: null) would otherwise throw where a line is put together, and take every other
// line of its chunk down with it.
function segmentsWithText(segments) {
    if (!Array.isArray(segments)) return [];
    return segments
        .filter(segment => segment && typeof segment === 'object')
        .map(segment => (typeof segment.text === 'string'
            ? segment
            : { ...segment, text: segment.text == null ? '' : String(segment.text) }));
}

export async function transcribeChunkServer(recId, chunkIndex, f32Chunk, signal, timeoutMs = 120000) {
    return transcribeBlobServer(recId, chunkIndex, encodeMonoWav(f32Chunk, 16000), signal, timeoutMs);
}

export async function transcribeBlobServer(recId, chunkIndex, chunkBlob, signal, timeoutMs = 120000) {
    const url       = CONFIG.TRANSCRIBE_URL.replace(/\/+$/, '');
    const lang      = getSetting('set-transcribe-lang');
    const headers   = { 'Content-Type': 'audio/wav' };
    if (lang && lang !== 'auto') headers['X-Transcription-Language'] = lang;

    const requestCtrl = new AbortController();
    const onJobAbort = () => requestCtrl.abort();
    if (signal) {
        if (signal.aborted) requestCtrl.abort();
        else signal.addEventListener('abort', onJobAbort, { once: true });
    }
    const timer = setTimeout(() => requestCtrl.abort(), timeoutMs);

    try {
        const res = await fetch(url, {
            method: 'POST',
            headers,
            body: chunkBlob,
            cache: 'no-store',
            signal: requestCtrl.signal
        });
        if (!res.ok) {
            const failed = new Error(`Transcription server failed on chunk ${chunkIndex + 1} (HTTP ${res.status})`);
            failed.status = res.status;
            failed.busy = res.status === 503 || res.status === 429;
            throw failed;
        }
        const data     = await res.json();
        const segments = segmentsWithText(data.segments);
        const text     = data.text || (segments.length ? segments.map(segment => segment.text).join(' ') : '');
        return { text: String(text || '').trim(), segments, language: data.language || null };
    } catch (err) {
        if (err && err.name === 'AbortError') {
            if (signal && signal.aborted) throw err;
            const timeout = new Error(`Transcription chunk ${chunkIndex + 1} timed out after ${Math.round(timeoutMs / 1000)}s`);
            timeout.timedOut = true;
            throw timeout;
        }
        throw err;
    } finally {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onJobAbort);
    }
}

function speakerPrefix(segment) {
    const speaker = segment && (segment.speaker ?? segment.speaker_id ?? segment.speakerId);
    if (speaker == null || speaker === '') return '';
    return `${String(speaker).trim()}: `;
}

function buildChunkDisplay(chunk, coreSegments, fallbackText) {
    if (!coreSegments || coreSegments.length === 0) return fallbackText;
    return coreSegments.map(segment => {
        const absStart = chunk.startSec + segment.start;
        const absEnd   = chunk.startSec + segment.end;
        return `[${fmtDur(absStart * 1000)}-${fmtDur(absEnd * 1000)}] ${speakerPrefix(segment)}${segment.text.trim()}`;
    }).join('\n');
}

function chunkRetryDelay(ms, signal) {
    return new Promise((resolve, reject) => {
        let timer = null;
        const onAbort = () => { cleanup(); reject(abortError()); };
        const cleanup = () => {
            if (timer !== null) clearTimeout(timer);
            if (signal) signal.removeEventListener('abort', onAbort);
        };
        if (signal && signal.aborted) { reject(abortError()); return; }
        if (signal) signal.addEventListener('abort', onAbort, { once: true });
        timer = setTimeout(() => { cleanup(); resolve(); }, ms);
    });
}

function adjustPool(recId, state, outcome) {
    if (!state.pool) return;
    const before = state.pool.limit;
    state.pool.limit = nextPoolLimit(before, outcome, state.pool);
    if (state.pool.limit < before) {
        const why = outcome.timedOut ? 'not keeping up' : outcome.busy ? 'busy' : 'queuing requests';
        liveLogAppend(recId, `⚖️ The server is ${why}; `
            + `sending ${state.pool.limit} chunk${state.pool.limit === 1 ? '' : 's'} at a time.`);
    }
}

async function transcribeChunkWithRetry(recId, index, audio, signal, state) {
    let lastError = null;
    let busyWaits = 0;
    const queue = state.serverQueue || (state.serverQueue = createServerQueue());
    for (let attempt = 0; ; attempt++) {
        const started = Date.now();
        queue.inFlight++;
        let result = null;
        let err = null;
        try {
            result = await transcribeChunkServer(recId, index, audio, signal);
        } catch (failure) {
            err = failure || new Error('Transcription failed.');
        } finally {
            // A chunk the server turned away as busy did not free any room there; any other answer did.
            requestCameBack(queue, { freedRoom: !(err && err.busy) });
        }
        if (!err) {
            adjustPool(recId, state, { ok: true, ms: Date.now() - started });
            return result;
        }
        if (err.name === 'AbortError') throw err;
        adjustPool(recId, state, { ok: false, timedOut: !!err.timedOut, busy: !!err.busy });
        lastError = err;
        // Busy with other chunks of this same transcription, the server has room again as soon as one
        // of them comes back: the chunk waits for that and asks again, which costs it none of its tries.
        if (shouldWaitForOwnChunk(err, queue.inFlight, busyWaits)) {
            busyWaits++;
            attempt--;
            await anotherRequestBack(queue, signal);
            continue;
        }
        const wait = chunkRetryDelayMs(attempt, err);
        if (wait == null) break;
        liveLogAppend(recId,
            `↻ [${index + 1}/${state.totalChunks}] retrying in ${Math.round(wait / 1000)}s after: ${err.message}`);
        await chunkRetryDelay(wait, signal);
    }
    throw lastError;
}

async function processOneChunk(chunk, recId, results, state, signal, loadAudio) {
    if (signal && signal.aborted) throw abortError();

    const index = chunk.idx;
    let audio = null;
    let level = null;

    try {
        audio = await loadAudio(chunk);
        if (signal && signal.aborted) throw abortError();
        level = summarizeChunkLevel(chunkCoreSamples(audio, chunk));

        const result = await transcribeChunkWithRetry(recId, index, audio, signal, state);
        const { coreSegments, text: trimmedText } = textForChunkCore(result, chunk, {
            samples: audio,
            segmentText: segment => speakerPrefix(segment) + String(segment.text || '')
        });

        results[index] = {
            coreSec:       chunk.coreSec,
            coreEndSec:    chunk.coreEndSec,
            chunkStartSec: chunk.startSec,
            text:          trimmedText,
            segments:      coreSegments,
            silent:        !trimmedText && coreSegments.length === 0 && isNearSilent(level)
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

        const silent = isNearSilent(level);
        results[index] = {
            coreSec:       chunk.coreSec,
            coreEndSec:    chunk.coreEndSec,
            chunkStartSec: chunk.startSec,
            text:          '',
            segments:      [],
            failed:        true,
            silent
        };
        state.doneCount++;
        if (silent) state.silentCount++;
        state.failCount++;
        state.consecutiveFailures++;
        state.lastError = err.message;
        liveLogAppend(recId, silent
            ? `🔇 [${index + 1}/${state.totalChunks}] no speech in this section`
            : `⚠️ [${index + 1}/${state.totalChunks}] chunk failed: ${err.message}`);
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






export async function transcribePlannedChunks(recId, chunks, loadAudio,
                                              { signal = null, progressCallback = () => {},
                                                concurrency = capped(CONFIG.TRANSCRIBE_CONCURRENCY,
                                                                     boxCapabilities().transcribeConcurrency) } = {}) {
    const totalChunks = chunks.length;
    liveLogAppend(recId, `📦 ${totalChunks} chunks - 60 s steps, ±3 s overlap; ${Math.min(POOL_START, concurrency)} at a time `
        + `to start, up to ${concurrency} while the server keeps up`);
    progressCallback(`0% - dispatching ${totalChunks} chunks`);

    const results = new Array(totalChunks).fill(null);
    const state   = {
        doneCount: 0, failCount: 0, consecutiveFailures: 0,
        broken: false, lastError: '', silentCount: 0,
        failBreaker: Math.min(5, totalChunks || 1),
        totalChunks, progressCallback,
        pool: { limit: Math.min(POOL_START, concurrency), max: concurrency },
        serverQueue: createServerQueue()
    };

    await runAdaptivePool(chunks, state.pool,
        chunk => processOneChunk(chunk, recId, results, state, signal, loadAudio),
        () => state.broken);

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
    return { results, state, skippedCount };
}

async function storeTranscript(recId, resultGeneration, { timestamped, plain }, source = 'S',
                               { fromLive = false, holes = 0 } = {}) {
    return dbUpdate(CONFIG.STORE_REC, recId, (current) => {
        if (!current || (current.resultGeneration || 0) !== resultGeneration) return null;
        current.transcripts = current.transcripts || [];
        current.transcripts.unshift({
            id:     uid(),
            text:   timestamped || plain || 'No voice detected.',
            plain:  plain || '',
            source,
            ...(fromLive ? { fromLive: true } : {}),
            ...(holes > 0 ? { holes } : {}),
            time:   Date.now()
        });
        delete current.pipelineError;
        delete current.pipelineErrorAt;
        return current;
    });
}

// The live transcript as the recording's reading ('L'). What it never heard is marked where it was,
// so the saved reading does not pass a hole off as the whole recording; the row then offers to
// transcribe just those parts.
function liveReading(live, durationMs) {
    const holes = liveHoles(live.coverage, Math.max(0, Number(durationMs) || 0) / 1000);
    const results = [...liveLinesAsResults(live.lines || []), ...holeResults(holes)];
    return { ...withTranslations(reassembleTimeline(results, results.length), live), holes: holes.length };
}

export async function storeLiveTranscript(recId) {
    const rec = await dbExec(CONFIG.STORE_REC, 'get', recId);
    const live = await readLiveTranscript(recId);
    const lines = (live && live.lines) || [];
    if (!rec || !lines.length) return false;
    if ((rec.transcripts || []).length > 0) return false;
    const reading = liveReading(live, rec.durationMs);
    const stored = await storeTranscript(recId, rec.resultGeneration || 0, reading, 'L', { holes: reading.holes });
    return !!stored;
}

// A reading made after the recording from the live lines carries the translations too, as they are
// in the live transcript when it is stored: with Auto-transcribe on it is the one the row shows.
async function withLiveTranslations(recId, assembled) {
    const live = await readLiveTranscript(recId).catch(() => null);
    return withTranslations(assembled, live);
}

// Puts the live transcript's translations into every reading made from it: the 'L' reading is built
// again as it was stored, holes marked, and a reading made after the recording from the live lines
// keeps its own words and gets the language sections. `plain`, which replies use, is left as it is.
export async function refreshLiveReadings(recId) {
    const rec = await dbExec(CONFIG.STORE_REC, 'get', recId);
    const live = await readLiveTranscript(recId);
    if (!rec || !live || !(live.lines || []).length) return false;
    const reading = liveReading(live, rec.durationMs);
    return !!(await dbUpdate(CONFIG.STORE_REC, recId, current => {
        if (!current || current.deleting) return null;
        let changed = false;
        for (const item of current.transcripts || []) {
            let text = null;
            if (item.source === 'L') text = reading.timestamped || reading.plain;
            else if (item.fromLive) text = withTranslations({ timestamped: spokenPart(item.text), plain: item.plain }, live).timestamped;
            if (text && text !== item.text) {
                item.text = text;
                changed = true;
            }
        }
        return changed ? current : null;
    }));
}

export const FILL_REPLY_POLL_MS = 1000;

async function waitWhileAnyReplyRuns(signal, noteWaiting = () => {}) {
    let waited = false;
    while (hasJobOfKind('r')) {
        if (signal && signal.aborted) throw abortError();
        if (!waited) { waited = true; noteWaiting(true); }
        await new Promise(resolve => setTimeout(resolve, FILL_REPLY_POLL_MS));
    }
    if (waited) noteWaiting(false);
    if (signal && signal.aborted) throw abortError();
}

// Completes the languages the translation boxes did not finish before Stop. It waits while any reply
// runs, and reports where it is (`onProgress` gets the status line). Every answer is kept as it comes,
// in the live transcript and in the readings made from it, so stopping it, or closing the tab, keeps
// what was done; it ends by itself once the live transcript is gone.
export async function fillTranslations(recId, { onProgress = () => {} } = {}) {
    const live = await readLiveTranscript(recId);
    const lines = (live && live.lines) || [];
    const languages = (live && live.languages) || [];
    if (!lines.length || languages.length < 2) return { filled: 0, missing: 0, stopped: null, cancelled: false };

    const ctrl = beginJob('f', recId);
    let progress = null;
    let waiting = false;
    const report = () => onProgress(describeFillProgress(progress, { waiting }));
    const noteWaiting = now => { waiting = now; report(); };
    const keepAnswers = async (target, answers) => {
        const kept = await updateLiveTranscript(recId, current => {
            if (!current) return null;
            const stored = current.lines || [];
            for (const [index, text] of Object.entries(answers)) {
                const line = stored[Number(index)];
                if (!line) continue;
                line.translations = line.translations || {};
                line.translations[target] = text;
            }
            return current;
        });
        if (!kept) { ctrl.abort(); return; }
        await refreshLiveReadings(recId);
    };
    let outcome;
    try {
        outcome = await fillMissingTranslations(lines, languages,
            (prompt, count) => translateLines(prompt, count, ctrl.signal),
            { onProgress: next => { progress = next; report(); }, onBatch: keepAnswers, signal: ctrl.signal,
              waitBeforeEachRequest: () => waitWhileAnyReplyRuns(ctrl.signal, noteWaiting) });
    } finally {
        endJob('f', recId, ctrl);
    }
    const { done, missing, stopped, cancelled } = outcome;
    if (stopped) console.warn(stopped);
    return { filled: done, missing, stopped, cancelled };
}

export async function transcribeChunked(recId, progressCallback, { reuseLive = true } = {}) {
    if (!confirmServerProcessing()) throw abortError('Server processing cancelled.');

    const ctrl   = beginJob('t', recId);
    const signal = ctrl.signal;
    let rec = null;
    let audioBlob = null;
    try {
        rec = await dbExec(CONFIG.STORE_REC, 'get', recId);
        audioBlob = rec ? await readAudio(recId) : null;
        if (!rec || !audioBlob) throw new Error('Audio blob missing.');
        if (signal.aborted) throw abortError();
    } catch (err) {
        endJob('t', recId, ctrl);
        throw err;
    }
    const resultGeneration = rec.resultGeneration || 0;

    const abortP = new Promise((_, reject) => {
        if (signal.aborted) return reject(abortError());
        signal.addEventListener('abort', () => reject(abortError()), { once: true });
    });
    // A cancel while the audio is still being prepared rejects this before anything races it.
    abortP.catch(() => {});

    let fullAudio16k = null;
    try {
        const durationMin = ((rec.durationMs || 0) / 60000).toFixed(1);
        liveLogAppend(recId, `▶️ Starting server transcription - ${durationMin} min recording`);

        const storedLive = await readLiveTranscript(recId);
        const live = reuseLive ? storedLive : null;
        if (!reuseLive && storedLive) {
            liveLogAppend(recId,
                '🔁 Re-running by hand: transcribing the whole recording rather than reusing what was done live.');
        }
        let liveResults = (live && Array.isArray(live.lines) && live.lines.length)
            ? liveLinesAsResults(live.lines) : [];
        const declaredSec = Math.max(0, (Number(rec.durationMs) || 0) / 1000);
        let gaps = null;
        let missingRanges = [];
        const reviews = [];
        if (liveResults.length && declaredSec > 0) {
            missingRanges = invertCoverage(live.coverage || [], declaredSec, 1);
            const gapSec = missingRanges.reduce((sum, gap) => sum + (gap.toSec - gap.fromSec), 0);

            const liveReviewCandidates = findTimedRepetitionCandidates(liveResults, {
                maxCandidates: MAX_LIVE_REPLAY_RANGES
            });
            const suspectLive = new Set();
            const reviewRanges = [];
            for (const item of liveReviewCandidates) {
                suspectLive.add(item.previous);
                suspectLive.add(item.current);
                const range = { fromSec: Math.max(0, item.fromSec), toSec: Math.min(declaredSec, item.toSec) };
                reviewRanges.push(range);
                reviews.push({ ...range, items: [item.previous, item.current] });
            }
            if (suspectLive.size) {
                liveResults = liveResults.filter(item => !suspectLive.has(item));
                liveLogAppend(recId,
                    `🔎 Will replay ${reviewRanges.length} overlapping live region${reviewRanges.length === 1 ? '' : 's'} before saving, to check for repeats.`);
            }
            gaps = mergeIntervals([...missingRanges, ...reviewRanges]);

            liveLogAppend(recId,
                `♻️ ${live.lines.length} line(s) were transcribed live, covering `
                + `${fmtDur(Math.max(0, declaredSec - gapSec) * 1000)} of ${fmtDur(declaredSec * 1000)}.`);
            if (gaps.length === 0) {
                liveLogAppend(recId, '✅ Nothing left to transcribe - the whole recording was covered live and passed the overlap review.');
                progressCallback('100% - reusing the live transcript');
                const reused = await storeTranscript(recId, resultGeneration,
                    await withLiveTranslations(recId, reassembleTimeline(liveResults, liveResults.length)),
                    'S', { fromLive: true });
                if (!reused) throw abortError('Result discarded because the recording changed or was deleted.');
                return;
            }
            if (missingRanges.length) {
                liveLogAppend(recId,
                    `📭 ${missingRanges.length} gap(s) totalling ${fmtDur(gapSec * 1000)} still need transcribing.`);
            }
        }

        progressCallback('Preparing audio...');
        const pcmMeta = await inspectPcmWav(audioBlob);
        let chunks;
        let loadAudio;

        if (pcmMeta) {
            chunks = gaps
                ? planChunksForRanges(gaps, 16000, 60, 3)
                : planAudioChunks(Math.max(0, Math.round(pcmMeta.durationSec * 16000)), 16000, 60, 3);
            loadAudio = chunk => resamplePcmWavRangeTo16k(
                audioBlob, pcmMeta, chunk.startSec, chunk.endSec
            );
            liveLogAppend(recId, '🔄 Streaming WAV ranges at 16 kHz (bounded memory)...');
        } else {
            let webmSource = null;
            let webmError = null;
            try {
                webmSource = await prepareWebmChunkSource(audioBlob, rec.durationMs || 0,
                                                          { tolerateTruncation: true });
            } catch (err) {
                webmError = err;
            }

            if (webmSource) {
                if (webmSource.truncatedAt) {
                    liveLogAppend(recId,
                        `⚠️ The WebM container stops making sense at byte ${webmSource.truncatedAt.offset} ` +
                        `(${webmSource.truncatedAt.reason}). Transcribing the ${fmtDur(webmSource.durationSec * 1000)} ` +
                        `that indexed cleanly; the remainder is not readable.`);
                }
                chunks = gaps
                    ? planChunksForRanges(
                        gaps.map(gap => ({ fromSec: gap.fromSec, toSec: Math.min(gap.toSec, webmSource.durationSec) }))
                            .filter(gap => gap.toSec > gap.fromSec), 16000, 60, 3)
                    : planAudioChunks(Math.max(0, Math.round(webmSource.durationSec * 16000)), 16000, 60, 3);
                loadAudio = chunk => resampleWebmRangeTo16k(
                    webmSource, chunk.startSec, chunk.endSec
                );
                liveLogAppend(recId,
                    `🔄 Streaming ${webmSource.clusters.length} WebM/Opus Clusters in bounded decode windows...`);
            } else {
                if (webmError) {
                    liveLogAppend(recId, `⚠️ Bounded WebM parsing unavailable (${webmError.message}).`);
                }
                const plan = planWholeFileDecode({ durationMs: rec.durationMs });
                if (!plan.allowed) {
                    liveLogAppend(recId, `⛔ ${plan.reason}`);
                    throw new Error(plan.reason);
                }
                liveLogAppend(recId,
                    `🔄 Decoding compressed audio to 16 kHz using the browser fallback ` +
                    `(about ${Math.round(plan.estimatedBytes / (1024 * 1024))} MB held at once)...`);
                fullAudio16k = await resampleTo16k(audioBlob);
                chunks = gaps
                    ? planChunksForRanges(gaps, 16000, 60, 3)
                    : planAudioChunks(fullAudio16k.length, 16000, 60, 3);
                loadAudio = chunk => fullAudio16k.slice(chunk.startSample, chunk.endSample);
            }
        }

        const totalChunks = chunks.length;
        if (totalChunks === 0 && liveResults.length === 0) throw new Error('Recording contains no audio samples.');
        const { results, state, skippedCount } = await Promise.race([
            transcribePlannedChunks(recId, chunks, loadAudio, { signal, progressCallback }),
            abortP
        ]);

        const replay = settleLiveReplays(reviews, results, missingRanges);
        if (replay.keptLive) {
            liveResults = [...liveResults, ...replay.restore];
            liveLogAppend(recId,
                `↩️ ${replay.keptLive} replayed region${replay.keptLive === 1 ? '' : 's'} came back without text, so the live lines there are kept.`);
        }

        const successCount = state.doneCount - state.failCount;
        const hardFailures = state.failCount - state.silentCount;
        if (successCount === 0 && hardFailures > 0 && liveResults.length === 0) {
            throw new Error(state.lastError
                ? `Transcription failed - no chunks could be processed (${state.lastError}).`
                : 'Transcription failed - no chunks could be processed (is the server reachable?).');
        }

        const merged = [...replay.results, ...liveResults];
        const { timestamped, plain } = reassembleTimeline(merged, merged.length);
        const totalGaps = state.failCount + skippedCount;
        const holeCount = Math.max(0, totalGaps - state.silentCount);
        const noteParts = [];
        if (holeCount > 0) noteParts.push(`${holeCount} chunk(s) failed or skipped`);
        if (state.silentCount > 0) noteParts.push(`${state.silentCount} silent chunk(s)`);
        const gapNote = noteParts.length ? ` - ${noteParts.join(', ')}` : '';
        liveLogAppend(recId, `🔗 Reassembled ${totalChunks} chunks → ${plain.length} chars${gapNote}`);

        const reading = liveResults.length > 0
            ? await withLiveTranslations(recId, { timestamped, plain }) : { timestamped, plain };
        const stored = await storeTranscript(recId, resultGeneration, reading, 'S',
                                             { fromLive: liveResults.length > 0 });
        if (!stored) throw abortError('Result discarded because the recording changed or was deleted.');

        liveLogAppend(recId, `✅ Done - ${plain.length} chars total${gapNote}`);
        progressCallback('100% - done');
    } finally {
        fullAudio16k = null;
        endJob('t', recId, ctrl);
    }
}
