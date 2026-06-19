/* ==========================================================================
 *  transcribe-core.js — PURE, DOM-free transcript assembly.
 *
 *  Extracted from transcribe.js so the most algorithmically subtle logic in the
 *  app (overlap windowing + timeline reassembly, including the failed-chunk gap
 *  markers) can be unit-tested in plain Node. This module imports ONLY config.js
 *  and dedup.js — both side-effect-free — so it never transits db.js (which opens
 *  IndexedDB at import time) or ai-worker.js (which spawns a Web Worker at import
 *  time). transcribe.js re-imports these for the live pipeline; behaviour is
 *  unchanged — the functions were moved, not modified.
 *
 *  Covered by tests/core.test.mjs.
 *  ========================================================================== */
import { fmtDur }                from './config.js';
import { seamTrim, appendTail }  from './dedup.js';

/* ──────────────────────────────────────────────────────────────────────────
 *  1. SLICE — cut resampled audio into overlapping windows
 *  ────────────────────────────────────────────────────────────────────────── */
export function sliceAudioChunks(f32, sampleRate, stepSec = 60, overlapSec = 3) {
    const step    = Math.floor(sampleRate * stepSec);
    const overlap = Math.floor(sampleRate * overlapSec);
    const chunks  = [];
    const total   = f32.length;
    let coreStart = 0;
    let idx       = 0;

    while (coreStart < total) {
        const winStart   = Math.max(0, coreStart - overlap);
        const winEnd     = Math.min(total, coreStart + step + overlap);
        const coreEnd    = Math.min(total, coreStart + step);
        chunks.push({
            idx,
            audio:          f32.slice(winStart, winEnd),
            coreSec:        coreStart / sampleRate,
            coreEndSec:     coreEnd / sampleRate,
            startSec:       winStart / sampleRate,
            endSec:         winEnd / sampleRate,
            hasPreOverlap:  coreStart > 0,
            hasPostOverlap: coreStart + step < total
        });
        coreStart += step;
        idx++;
    }
    return chunks;
}

/* ──────────────────────────────────────────────────────────────────────────
 *  2. OVERLAP TRIMMING — strip the ±3 s bleed from raw Whisper output
 *  ────────────────────────────────────────────────────────────────────────── */

/** Remote (segment-level): keep segments whose midpoint is inside the core window. */
export function trimOverlapSegments(segments, chunk) {
    if (!segments || segments.length === 0) return [];
    const coreRelStart = chunk.coreSec - chunk.startSec;
    const coreRelEnd   = chunk.coreEndSec - chunk.startSec;
    return segments.filter(seg => {
        const mid = (seg.start + seg.end) / 2;
        return mid >= coreRelStart - 0.5 && mid <= coreRelEnd + 0.5;
    });
}

/** Local (no segments): rough word-budget trim based on overlap duration. */
export function trimOverlapTextLocal(rawText, chunk) {
    if (!rawText) return '';
    const words     = rawText.trim().split(/\s+/);
    const trimCount = 8;   // ~3 s × 2.5 words/s ≈ 8 words
    let start = 0, end = words.length;
    if (chunk.hasPreOverlap)  start = Math.min(trimCount, Math.floor(words.length * 0.1));
    if (chunk.hasPostOverlap) end   = Math.max(start + 1, words.length - Math.min(trimCount, Math.floor(words.length * 0.1)));
    return words.slice(start, end).join(' ');
}

/* ──────────────────────────────────────────────────────────────────────────
 *  3. REASSEMBLE — ordered results → single timestamped transcript
 *  Uses positional seam trimming (dedup.js) against a bounded rolling tail,
 *  instead of order-blind Set ratio matching.
 *  ────────────────────────────────────────────────────────────────────────── */
export function reassembleTimeline(results, totalChunks) {
    const ordered = [];
    for (let i = 0; i < totalChunks; i++) {
        if (results[i]) ordered.push(results[i]);
    }
    if (ordered.length === 0) return { timestamped: '', plain: '' };

    // Flatten all segments into one absolute-timeline list.
    const allSegs = [];
    for (const r of ordered) {
        if (r.failed) {
            // A chunk that errored out: leave a visible placeholder so the hole
            // is obvious in both the timestamped view and the plain text fed to
            // the LLM, instead of silently swallowing that span of audio.
            allSegs.push({
                absStart: r.coreSec,
                absEnd:   r.coreEndSec,
                text:     '[⚠️ transcription unavailable for this section]'
            });
        } else if (r.segments && r.segments.length > 0) {
            for (const seg of r.segments) {
                allSegs.push({
                    absStart: r.chunkStartSec + seg.start,
                    absEnd:   r.chunkStartSec + seg.end,
                    text:     seg.text.trim()
                });
            }
        } else if (r.text) {
            allSegs.push({ absStart: r.coreSec, absEnd: r.coreEndSec, text: r.text.trim() });
        }
    }

    allSegs.sort((a, b) => a.absStart - b.absStart || a.absEnd - b.absEnd);

    const tsLines    = [];
    const plainParts = [];
    let   tail       = '';   // bounded rolling tail of emitted words

    for (const seg of allSegs) {
        if (!seg.text) continue;
        const kept = tail ? seamTrim(tail, seg.text) : seg.text;
        const keptTrim = kept.trim();
        if (!keptTrim) continue;

        tsLines.push(`[${fmtDur(seg.absStart * 1000)}–${fmtDur(seg.absEnd * 1000)}] ${keptTrim}`);
        plainParts.push(keptTrim);
        tail = appendTail(tail, keptTrim);
    }

    return {
        timestamped: tsLines.join('\n'),
        plain:       plainParts.join(' ').trim()
    };
}
