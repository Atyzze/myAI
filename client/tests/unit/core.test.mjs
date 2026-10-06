import { emitTestResult } from '../helpers/test-result.mjs';

import {
    GAP_MARKER,
    SILENT_MARKER,
    summarizeChunkLevel,
    isNearSilent,
    planAudioChunks,
    trimOverlapSegments,
    trimOverlapTextFallback,
    reassembleTimeline,
    runPool,
    planWholeFileDecode,
    DECODED_BYTES_PER_SECOND,
    WHOLE_FILE_DECODE_BUDGET_BYTES
} from '../../src/js/transcribe-core.js';

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

async function waitUntil(predicate, message, timeoutMs = 1000) {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() >= deadline) throw new Error(`Timed out: ${message}`);
        await new Promise(resolve => setTimeout(resolve, 0));
    }
}


{
    const plan = planAudioChunks(SR * 150, SR, 60, 3);
    eq(plan.length, 3, 'plan: 150s → 3 descriptors');
    ok(!('audio' in plan[0]), 'plan: descriptors do not retain copied audio');
    eq([plan[1].startSample, plan[1].endSample], [SR * 57, SR * 123],
       'plan: middle descriptor includes ±3s overlap');
}

{
    const midChunk = { startSec: 57, coreSec: 60, coreEndSec: 120, endSec: 123 };
    const segs = [
        { start: 0,  end: 2,  text: 'pre bleed' },
        { start: 3,  end: 5,  text: 'real start' },
        { start: 60, end: 63, text: 'real end' },
        { start: 64, end: 66, text: 'post bleed' }
    ];
    eq(trimOverlapSegments(segs, midChunk).map(s => s.text),
       ['real start', 'real end'],
       'trimSeg: drops pre/post-overlap bleed by midpoint, keeps core segments');

    eq(trimOverlapSegments([],   midChunk), [], 'trimSeg: empty segments → []');
    eq(trimOverlapSegments(null, midChunk), [], 'trimSeg: null segments → []');

    const edge = [{ start: 2, end: 3, text: 'edge' }];
    eq(trimOverlapSegments(edge, midChunk).length, 1, 'trimSeg: keeps a segment within the 0.5s tolerance');
}

{
    const both      = { hasPreOverlap: true,  hasPostOverlap: true  };
    const firstOnly = { hasPreOverlap: false, hasPostOverlap: true  };
    const none      = { hasPreOverlap: false, hasPostOverlap: false };

    const words100 = Array.from({ length: 100 }, (_, i) => 'w' + i).join(' ');
    const out = trimOverlapTextFallback(words100, both).split(' ');
    eq(out.length, 84,          'trimFallback: 100 words, both overlaps → 8 trimmed each side');
    eq(out[0], 'w8',            'trimFallback: first kept word is w8');
    eq(out[out.length - 1], 'w91', 'trimFallback: last kept word is w91');

    const fo = trimOverlapTextFallback(words100, firstOnly).split(' ');
    eq(fo[0], 'w0',             'trimFallback: first chunk keeps the very first word');
    eq(fo.length, 92,           'trimFallback: first chunk trims only the trailing overlap');

    const w20 = Array.from({ length: 20 }, (_, i) => 'w' + i).join(' ');
    const o20 = trimOverlapTextFallback(w20, both).split(' ');
    eq(o20.length, 16,          'trimFallback: 20 words → 10% cap trims 2 each side');
    eq(o20[0], 'w2',            'trimFallback: 20-word case starts at w2');

    eq(trimOverlapTextFallback('a b c', none), 'a b c', 'trimFallback: no overlaps → text unchanged');
    eq(trimOverlapTextFallback('', both),      '',      'trimFallback: empty input → empty');
    const cjk = '这是一个没有空格的中文转录文本用于测试重叠修剪行为是否正常工作并保留中间内容';
    const cjkOut = trimOverlapTextFallback(cjk, both);
    ok(cjkOut.length < cjk.length && cjkOut.length > 10, 'trimFallback: CJK text trims overlap by code point');
}

{
    const r = [
        { coreSec: 0,  coreEndSec: 60,  chunkStartSec: 0,  text: 'hello world', segments: [] },
        { coreSec: 60, coreEndSec: 120, chunkStartSec: 60, text: 'goodbye now', segments: [] }
    ];
    const out = reassembleTimeline(r, 2);
    eq(out.plain, 'hello world goodbye now', 'reassemble: two text chunks join in order');
    ok(out.timestamped.includes('[00:00-01:00] hello world'), 'reassemble: chunk0 timestamp from core span');
    ok(out.timestamped.includes('[01:00-02:00] goodbye now'), 'reassemble: chunk1 timestamp from core span');
}

{
    const r = [
        { coreSec: 0,  coreEndSec: 60,  chunkStartSec: 0,  text: 'the quick brown fox', segments: [] },
        { coreSec: 60, coreEndSec: 120, chunkStartSec: 60, text: 'fox jumps over',      segments: [] }
    ];
    eq(reassembleTimeline(r, 2).plain, 'the quick brown fox jumps over',
       'reassemble: seam-trims the duplicated boundary word');
}

{
    const r = [
        { coreSec: 0,   coreEndSec: 60,  chunkStartSec: 0,   text: 'first part', segments: [] },
        { coreSec: 60,  coreEndSec: 120, failed: true },
        { coreSec: 120, coreEndSec: 180, chunkStartSec: 120, text: 'third part', segments: [] }
    ];
    const out = reassembleTimeline(r, 3);
    ok(out.plain.includes(GAP_MARKER), 'reassemble: failed chunk leaves a visible gap marker, so the model knows words are missing');
    ok(out.plain.startsWith('first part'),              'reassemble: content BEFORE the gap is kept');
    ok(out.plain.endsWith('third part'),                'reassemble: content AFTER the gap is kept');
    ok(out.timestamped.includes(`[01:00-02:00] ${GAP_MARKER}`),
       'reassemble: gap marker carries the failed span timestamp');
    ok(!out.timestamped.includes('⚠️'),
       'reassemble: a hole in the transcript is stated, not flagged as a fault');
}

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
    ok(out.timestamped.includes('[00:01-00:03] alpha'), 'reassemble: seg abs time = chunkStartSec + seg.start');
    ok(out.timestamped.includes('[00:05-00:07] beta'),  'reassemble: second segment abs time');
}

eq(reassembleTimeline([], 0),            { timestamped: '', plain: '' }, 'reassemble: no results → empty');
eq(reassembleTimeline([null, null], 2),  { timestamped: '', plain: '' }, 'reassemble: all-null results → empty');

{
    const r = [
        { coreSec: 0,   coreEndSec: 60,  chunkStartSec: 0,   text: 'aaa', segments: [] },
        null,
        { coreSec: 120, coreEndSec: 180, chunkStartSec: 120, text: 'ccc', segments: [] }
    ];
    eq(reassembleTimeline(r, 3).plain, 'aaa ccc', 'reassemble: null (never-attempted) chunks are skipped');
}

{
    const items = Array.from({ length: 23 }, (_, i) => i);
    const started = [];
    const completed = [];
    let active = 0;
    let peak = 0;
    let releaseFirstWave;
    const firstWaveGate = new Promise(resolve => { releaseFirstWave = resolve; });

    const pool = runPool(items, 10, async item => {
        active++;
        peak = Math.max(peak, active);
        started.push(item);
        if (started.length <= 10) await firstWaveGate;
        await Promise.resolve();
        completed.push(item);
        active--;
    });

    await waitUntil(() => started.length === 10, 'ten remote pool slots to fill');
    eq(started.slice(0, 10), [0,1,2,3,4,5,6,7,8,9],
       'pool: eagerly dispatches the first ten chunks in order');
    eq(peak, 10, 'pool: reaches ten concurrent workers when enough chunks exist');
    releaseFirstWave();
    await pool;
    ok(peak <= 10, 'pool: never exceeds the configured ten-request ceiling');
    eq(completed.slice().sort((a, b) => a - b), items,
       'pool: processes every chunk exactly once');
}

{
    const items = [0, 1, 2, 3];
    let active = 0;
    let peak = 0;
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const pool = runPool(items, 10, async () => {
        active++;
        peak = Math.max(peak, active);
        await gate;
        active--;
    });
    await waitUntil(() => peak === 4, 'short pool to fill all available items');
    eq(peak, 4, 'pool: uses only the available chunk count when fewer than ten exist');
    release();
    await pool;
}

{
    const items = Array.from({ length: 30 }, (_, i) => i);
    const started = [];
    let stop = false;
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const pool = runPool(items, 10, async item => {
        started.push(item);
        await gate;
    }, () => stop);
    await waitUntil(() => started.length === 10, 'breaker test first wave to fill');
    stop = true;
    release();
    await pool;
    eq(started.length, 10,
       'pool: circuit breaker prevents dispatch beyond already-running requests');
}

{
    const completed = [];
    await runPool([0, 1, 2], 0, async item => completed.push(item));
    eq(completed, [0, 1, 2], 'pool: invalid non-positive limits safely fall back to one worker');
}

{
    const failed = i => ({ coreSec: i * 60, coreEndSec: (i + 1) * 60,
                           chunkStartSec: i * 60, text: '', segments: [], failed: true });
    const good = (i, text) => ({ coreSec: i * 60, coreEndSec: (i + 1) * 60,
                                 chunkStartSec: i * 60, text, segments: [] });
    const countMarkers = text => String(text).split(GAP_MARKER).length - 1;

    const run = reassembleTimeline([failed(0), failed(1), failed(2)], 3);
    eq(countMarkers(run.timestamped), 1,
       'gaps: one unbroken run of failures is reported once, not once per chunk');
    ok(run.timestamped.includes('[00:00-03:00]'),
       'gaps: the single marker spans the whole run it replaces');
    eq(countMarkers(run.plain), 1,
       'gaps: the text handed to the model states the hole once');

    const mixed = reassembleTimeline([good(0, 'alpha beta'), failed(1), failed(2), good(3, 'gamma')], 4);
    eq(countMarkers(mixed.timestamped), 1,
       'gaps: failures between real speech collapse into the one span they cover');
    ok(mixed.timestamped.includes('[01:00-03:00]'),
       'gaps: a collapsed run keeps the real start and end of the hole');
    ok(/alpha beta/.test(mixed.plain) && /gamma/.test(mixed.plain),
       'gaps: surrounding speech is unaffected by the exemption');

    const seam = reassembleTimeline([good(0, 'alpha beta gamma'), good(1, 'beta gamma delta')], 2);
    eq(seam.plain, 'alpha beta gamma delta',
       'gaps: exempting placeholders does not weaken seam trimming for real speech');

    eq(countMarkers(reassembleTimeline([good(0, 'x'), failed(1)], 2).plain), 1,
       'gaps: a placeholder does not leak into the rolling seam tail');
}

{
    const quiet = i => ({ coreSec: i * 60, coreEndSec: (i + 1) * 60, chunkStartSec: i * 60,
                          text: '', segments: [], failed: true, silent: true });
    const good = (i, text) => ({ coreSec: i * 60, coreEndSec: (i + 1) * 60, chunkStartSec: i * 60, text, segments: [] });
    const out = reassembleTimeline([quiet(0), good(1, 'buy milk tomorrow'), quiet(2)], 3);
    eq(out.plain, 'buy milk tomorrow',
       'silence: the text handed to the model carries only what was said, never a no-speech note');
    ok(out.timestamped.includes(SILENT_MARKER),
       'silence: while the timestamped reading still says where it was quiet');
}

{
    const silent = i => ({ coreSec: i * 60, coreEndSec: (i + 1) * 60,
                           chunkStartSec: i * 60, text: '', segments: [],
                           failed: true, silent: true });
    const failed = i => ({ coreSec: i * 60, coreEndSec: (i + 1) * 60,
                           chunkStartSec: i * 60, text: '', segments: [], failed: true });
    const good = (i, text) => ({ coreSec: i * 60, coreEndSec: (i + 1) * 60,
                                 chunkStartSec: i * 60, text, segments: [] });
    const count = (text, marker) => String(text).split(marker).length - 1;

    const quiet = reassembleTimeline([silent(0), silent(1), silent(2), silent(3)], 4);
    eq(count(quiet.timestamped, SILENT_MARKER), 1,
       'silence: twenty quiet minutes are one neutral note, not one per minute');
    ok(quiet.timestamped.includes('[00:00-04:00]'),
       'silence: the note covers the whole quiet stretch');
    eq(count(quiet.timestamped, GAP_MARKER), 0,
       'silence: nothing was spoken, so nothing is reported as unavailable');

    const both = reassembleTimeline([silent(0), failed(1), silent(2)], 3);
    eq(count(both.timestamped, SILENT_MARKER), 2,
       'silence: a real hole between two quiet stretches keeps them apart');
    eq(count(both.timestamped, GAP_MARKER), 1,
       'silence: a section that genuinely failed is still reported as a failure');

    const around = reassembleTimeline([good(0, 'alpha'), silent(1), good(2, 'beta')], 3);
    ok(/alpha/.test(around.plain) && /beta/.test(around.plain),
       'silence: speech on either side of a quiet stretch is untouched');
}

{
    ok(isNearSilent(summarizeChunkLevel(new Float32Array(16000))),
       'level: a buffer of digital silence reads as silent');
    const hum = new Float32Array(16000);
    for (let i = 0; i < hum.length; i++) hum[i] = Math.sin(i / 40) * 0.0008;
    ok(isNearSilent(summarizeChunkLevel(hum)),
       'level: inaudible room hum still counts as no speech');
    const speech = new Float32Array(16000);
    for (let i = 0; i < speech.length; i++) speech[i] = Math.sin(i / 8) * 0.22;
    ok(!isNearSilent(summarizeChunkLevel(speech)),
       'level: audio at speaking level is never written off as silence');
    const blip = new Float32Array(16000);
    blip[4000] = 0.9;
    ok(!isNearSilent(summarizeChunkLevel(blip)),
       'level: one loud transient keeps the section out of the silence bucket');
    ok(summarizeChunkLevel(new Float32Array(0)) === null,
       'level: an empty buffer yields no measurement to judge');
    ok(isNearSilent(null) === false,
       'level: an unmeasured section is never assumed silent');
}

{
    const original = {
        coreSec: 0, coreEndSec: 7, chunkStartSec: 0, text: '',
        segments: [
            { start: 0, end: 4, text: 'basic tests and should work', _reviewSuppressed: true },
            { start: 2, end: 7, text: 'It should work without too much strain at all.', _reviewSuppressed: true }
        ]
    };
    const reread = {
        coreSec: 0, coreEndSec: 7, chunkStartSec: 0, text: '',
        segments: [{ start: 0, end: 7, text: 'basic tests and should work without too much strain at all.' }]
    };
    const out = reassembleTimeline([original, reread], 2);
    eq(out.plain, 'basic tests and should work without too much strain at all.',
       'review: disproved overlapping observations are replaced by the audio-backed reread');
    ok(!out.plain.includes('should work It should work'),
       'review: the field-case duplicate cannot survive the replacement');
}

{
    const tiny = planAudioChunks(16000 * 10, 16000, 0.00001, 0);
    ok(Array.isArray(tiny) && tiny.length > 0 && tiny.length < 1e6,
       'plan: a sub-sample step terminates instead of looping forever');
    eq(planAudioChunks(16000 * 120, 16000, 60, 3).length, 2,
       'plan: the normal 60 s step is unchanged by the guard');
}

{
    const budget = 64 * 1024 * 1024;
    const limitSec = Math.floor(budget / DECODED_BYTES_PER_SECOND);

    const short = planWholeFileDecode({ durationMs: 60_000, budgetBytes: budget });
    ok(short.allowed === true, 'budget: a one-minute recording is decodable');
    eq(short.estimatedBytes, 60 * DECODED_BYTES_PER_SECOND,
       'budget: the estimate is decoded bytes, not file bytes');

    const atLimit = planWholeFileDecode({ durationMs: limitSec * 1000, budgetBytes: budget });
    ok(atLimit.allowed === true, 'budget: exactly the budget is allowed');

    const overLimit = planWholeFileDecode({ durationMs: (limitSec + 1) * 1000, budgetBytes: budget });
    ok(overLimit.allowed === false, 'budget: one second past the budget is refused');
    ok(/download/i.test(overLimit.reason),
       'budget: a refusal says what to do with the recording instead');

    const fiveHours = planWholeFileDecode({ durationMs: 5 * 3600 * 1000 });
    ok(fiveHours.allowed === false,
       'budget: a five-hour recording is refused under the shipped budget');
    ok(fiveHours.estimatedBytes > WHOLE_FILE_DECODE_BUDGET_BYTES,
       'budget: the shipped budget is smaller than a five-hour decode');

    for (const bad of [0, -1, NaN, Infinity, null, undefined]) {
        ok(planWholeFileDecode({ durationMs: bad }).allowed === false,
           `budget: an unbudgetable length (${String(bad)}) is refused rather than guessed`);
    }

    ok(planWholeFileDecode().allowed === false,
       'budget: no arguments at all is refused, not defaulted to permitted');
}

console.log(`\n${'─'.repeat(60)}`);
if (failed === 0) {
    console.log(`✓ all ${passed} assertions passed`);
    emitTestResult('transcript-core', 'pass', { assertions: passed });
    process.exit(0);
} else {
    console.log(`${passed} passed, ${failed} FAILED:\n`);
    console.log(fails.join('\n'));
    process.exit(1);
}
