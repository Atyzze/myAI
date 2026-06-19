/* ==========================================================================
   core.test.mjs — Zero-dependency tests for js/transcribe-core.js, the pure
   transcript-assembly logic (chunk slicing, overlap trimming, and timeline
   reassembly including the failed-chunk gap markers).

   Run:  node tests/core.test.mjs
   (Node 18+; uses only built-ins — no test framework, no install step.)

   These functions used to live inside transcribe.js, which imports db.js
   (opens IndexedDB at import time) and ai-worker.js (spawns a Web Worker at
   import time) — so they were unreachable from a plain-Node test. transcribe-
   core.js imports only config.js + dedup.js, both side-effect-free, so the most
   algorithmically subtle logic in the app is now directly testable.

   En-dash note: the timestamp separator emitted by reassembleTimeline is U+2013
   ("–", as in "[00:00–01:00]"), matching the source. The assertions below use
   that exact character on purpose.
   ========================================================================== */

import {
    sliceAudioChunks,
    trimOverlapSegments,
    trimOverlapTextLocal,
    reassembleTimeline
} from '../js/transcribe-core.js';

let passed = 0, failed = 0;
const fails = [];

function eq(actual, expected, name) {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { passed++; }
    else { failed++; fails.push(`✗ ${name}\n    expected ${e}\n    got      ${a}`); }
}
function ok(cond, name) {
    if (cond) { passed++; } else { failed++; fails.push(`✗ ${name}`); }
}

const SR = 16000;

/* ──────────────────────────────────────────────────────────────────────────
   sliceAudioChunks — 60 s core steps with ±3 s overlap windows
   ────────────────────────────────────────────────────────────────────────── */
{
    // 150 s of audio → three 60 s cores (0–60, 60–120, 120–150).
    const chunks = sliceAudioChunks(new Float32Array(SR * 150), SR, 60, 3);
    eq(chunks.length, 3,                 'slice: 150s @ 60s step → 3 chunks');
    eq(chunks.map(c => c.idx), [0, 1, 2], 'slice: idx runs 0..2');

    ok(chunks[0].hasPreOverlap  === false, 'slice: first chunk has NO pre-overlap');
    ok(chunks[0].hasPostOverlap === true,  'slice: first chunk HAS post-overlap');
    ok(chunks[2].hasPreOverlap  === true,  'slice: last chunk HAS pre-overlap');
    ok(chunks[2].hasPostOverlap === false, 'slice: last chunk has NO post-overlap');

    eq(chunks[0].coreSec,    0,   'slice: chunk0 core starts at 0s');
    eq(chunks[0].coreEndSec, 60,  'slice: chunk0 core ends at 60s');
    eq(chunks[2].coreEndSec, 150, 'slice: last core clamps to clip end (150s)');

    // First chunk: core + trailing overlap only (no leading overlap to add).
    eq(chunks[0].audio.length, SR * (60 + 3),     'slice: chunk0 window = core + post-overlap');
    // Middle chunk: leading + core + trailing overlap.
    eq(chunks[1].audio.length, SR * (3 + 60 + 3), 'slice: middle window = pre + core + post');

    // Boundary cases.
    eq(sliceAudioChunks(new Float32Array(0), SR).length, 0, 'slice: empty audio → 0 chunks');

    const short = sliceAudioChunks(new Float32Array(SR * 10), SR, 60, 3);
    eq(short.length, 1, 'slice: 10s (< one step) → 1 chunk');
    ok(short[0].hasPreOverlap === false && short[0].hasPostOverlap === false,
       'slice: lone short chunk has neither overlap');
    eq(short[0].coreEndSec, 10, 'slice: lone short chunk core ends at clip length');
}

/* ──────────────────────────────────────────────────────────────────────────
   trimOverlapSegments — keep only segments whose MIDPOINT is in the core window
   (remote/segment path). Window-relative times; core sits at [3, 63] here.
   ────────────────────────────────────────────────────────────────────────── */
{
    // 3 s pre-overlap + 60 s core + 3 s post-overlap.
    const midChunk = { startSec: 57, coreSec: 60, coreEndSec: 120, endSec: 123 };
    const segs = [
        { start: 0,  end: 2,  text: 'pre bleed' },   // mid 1.0  → drop (pre-overlap)
        { start: 3,  end: 5,  text: 'real start' },  // mid 4.0  → keep
        { start: 60, end: 63, text: 'real end' },    // mid 61.5 → keep
        { start: 64, end: 66, text: 'post bleed' }   // mid 65.0 → drop (post-overlap)
    ];
    eq(trimOverlapSegments(segs, midChunk).map(s => s.text),
       ['real start', 'real end'],
       'trimSeg: drops pre/post-overlap bleed by midpoint, keeps core segments');

    eq(trimOverlapSegments([],   midChunk), [], 'trimSeg: empty segments → []');
    eq(trimOverlapSegments(null, midChunk), [], 'trimSeg: null segments → []');

    // ±0.5 s tolerance: a segment whose midpoint sits just outside the core is
    // still kept (guards against off-by-a-hair clipping of real words).
    const edge = [{ start: 2, end: 3, text: 'edge' }]; // mid 2.5 == coreRelStart-0.5
    eq(trimOverlapSegments(edge, midChunk).length, 1, 'trimSeg: keeps a segment within the 0.5s tolerance');
}

/* ──────────────────────────────────────────────────────────────────────────
   trimOverlapTextLocal — word-budget overlap trim (local path, no segments)
   ────────────────────────────────────────────────────────────────────────── */
{
    const both      = { hasPreOverlap: true,  hasPostOverlap: true  };
    const firstOnly = { hasPreOverlap: false, hasPostOverlap: true  };
    const none      = { hasPreOverlap: false, hasPostOverlap: false };

    const words100 = Array.from({ length: 100 }, (_, i) => 'w' + i).join(' ');
    const out = trimOverlapTextLocal(words100, both).split(' ');
    eq(out.length, 84,          'trimLocal: 100 words, both overlaps → 8 trimmed each side');
    eq(out[0], 'w8',            'trimLocal: first kept word is w8');
    eq(out[out.length - 1], 'w91', 'trimLocal: last kept word is w91');

    const fo = trimOverlapTextLocal(words100, firstOnly).split(' ');
    eq(fo[0], 'w0',             'trimLocal: first chunk keeps the very first word');
    eq(fo.length, 92,           'trimLocal: first chunk trims only the trailing overlap');

    // The min(8, floor(len*0.1)) cap protects short chunks: at 20 words the 10%
    // budget (2) wins over the 8-word default, so only 2 words go each side.
    const w20 = Array.from({ length: 20 }, (_, i) => 'w' + i).join(' ');
    const o20 = trimOverlapTextLocal(w20, both).split(' ');
    eq(o20.length, 16,          'trimLocal: 20 words → 10% cap trims 2 each side');
    eq(o20[0], 'w2',            'trimLocal: 20-word case starts at w2');

    eq(trimOverlapTextLocal('a b c', none), 'a b c', 'trimLocal: no overlaps → text unchanged');
    eq(trimOverlapTextLocal('', both),      '',      'trimLocal: empty input → empty');
}

/* ──────────────────────────────────────────────────────────────────────────
   reassembleTimeline — ordered chunk results → one timestamped transcript
   ────────────────────────────────────────────────────────────────────────── */

// (a) two plain-text chunks join in order, timestamps from core start/end.
{
    const r = [
        { coreSec: 0,  coreEndSec: 60,  chunkStartSec: 0,  text: 'hello world', segments: [] },
        { coreSec: 60, coreEndSec: 120, chunkStartSec: 60, text: 'goodbye now', segments: [] }
    ];
    const out = reassembleTimeline(r, 2);
    eq(out.plain, 'hello world goodbye now', 'reassemble: two text chunks join in order');
    ok(out.timestamped.includes('[00:00–01:00] hello world'), 'reassemble: chunk0 timestamp from core span');
    ok(out.timestamped.includes('[01:00–02:00] goodbye now'), 'reassemble: chunk1 timestamp from core span');
}

// (b) seam overlap at a chunk boundary is trimmed (delegates to dedup.seamTrim).
{
    const r = [
        { coreSec: 0,  coreEndSec: 60,  chunkStartSec: 0,  text: 'the quick brown fox', segments: [] },
        { coreSec: 60, coreEndSec: 120, chunkStartSec: 60, text: 'fox jumps over',      segments: [] }
    ];
    eq(reassembleTimeline(r, 2).plain, 'the quick brown fox jumps over',
       'reassemble: seam-trims the duplicated boundary word');
}

// (c) a FAILED chunk in the middle leaves a visible gap, not a silent drop —
//     and content on both sides survives. This is the regression most likely
//     to break unnoticed (output just ends early / loses a minute).
{
    const r = [
        { coreSec: 0,   coreEndSec: 60,  chunkStartSec: 0,   text: 'first part', segments: [] },
        { coreSec: 60,  coreEndSec: 120, failed: true },
        { coreSec: 120, coreEndSec: 180, chunkStartSec: 120, text: 'third part', segments: [] }
    ];
    const out = reassembleTimeline(r, 3);
    ok(out.plain.includes('transcription unavailable'), 'reassemble: failed chunk leaves a visible gap marker');
    ok(out.plain.startsWith('first part'),              'reassemble: content BEFORE the gap is kept');
    ok(out.plain.endsWith('third part'),                'reassemble: content AFTER the gap is kept');
    ok(out.timestamped.includes('[01:00–02:00] [⚠️'),   'reassemble: gap marker carries the failed span timestamp');
}

// (d) per-segment timestamps expand inside one chunk (abs = chunkStartSec + seg).
{
    const r = [{
        coreSec: 0, coreEndSec: 60, chunkStartSec: 0, text: '',
        segments: [
            { start: 1, end: 3, text: 'alpha' },
            { start: 5, end: 7, text: 'beta'  }
        ]
    }];
    const out = reassembleTimeline(r, 1);
    eq(out.plain, 'alpha beta', 'reassemble: per-segment timestamps expand within a chunk');
    ok(out.timestamped.includes('[00:01–00:03] alpha'), 'reassemble: seg abs time = chunkStartSec + seg.start');
    ok(out.timestamped.includes('[00:05–00:07] beta'),  'reassemble: second segment abs time');
}

// (e) empty / all-null input → empty result (no crash).
eq(reassembleTimeline([], 0),            { timestamped: '', plain: '' }, 'reassemble: no results → empty');
eq(reassembleTimeline([null, null], 2),  { timestamped: '', plain: '' }, 'reassemble: all-null results → empty');

// (f) null (never-attempted) chunks between real ones are skipped. In the live
//     pipeline, transcribeChunked pre-fills trailing nulls with failed markers
//     BEFORE calling this; reassemble itself just skips holes it is handed.
{
    const r = [
        { coreSec: 0,   coreEndSec: 60,  chunkStartSec: 0,   text: 'aaa', segments: [] },
        null,
        { coreSec: 120, coreEndSec: 180, chunkStartSec: 120, text: 'ccc', segments: [] }
    ];
    eq(reassembleTimeline(r, 3).plain, 'aaa ccc', 'reassemble: null (never-attempted) chunks are skipped');
}

/* ── report ── */
console.log(`\n${'─'.repeat(60)}`);
if (failed === 0) {
    console.log(`✓ all ${passed} assertions passed`);
    process.exit(0);
} else {
    console.log(`${passed} passed, ${failed} FAILED:\n`);
    console.log(fails.join('\n'));
    process.exit(1);
}
