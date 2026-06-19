/* ==========================================================================
   pure.test.mjs — Zero-dependency tests for the app's pure, DOM-free logic.

   Run:  node tests/pure.test.mjs
   (Node 18+; uses only built-ins — no test framework, no install step.)

   Only modules with no browser-API calls at import time are covered here
   (config.js, dedup.js, audio.js). The seam-trim cases include the
   multilingual regression that the Unicode-aware normalizer fixed.

   The pure transcript-assembly logic (slicing, overlap trimming, timeline
   reassembly) lives in js/transcribe-core.js and is covered by its own
   sibling suite, tests/core.test.mjs — run both.
   ========================================================================== */

import { escapeHtml, escapeAttr, escapeJs,
         fmtDur, fmtBytes, fmtSize, uid }        from '../js/config.js';
import { seamTrim, appendTail, SEAM_TRIM_SRC }   from '../js/dedup.js';
import { buildWavHeader, encodeMonoWav, stitchWavChunks } from '../js/audio.js';

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

/* ── config: escaping ── */
eq(escapeHtml('<tag>&'), '&lt;tag&gt;&amp;', 'escapeHtml escapes < > &');
eq(escapeHtml('"\''), '"\'', 'escapeHtml leaves quotes (attr layer handles them)');
eq(escapeAttr('"x\''), '&quot;x&#39;', 'escapeAttr escapes both quote types');
ok(![...escapeJs("a');alert(1)//")].includes("'"), 'escapeJs leaves no raw single quote');
ok(escapeJs("a'b").includes('&#39;'), 'escapeJs entity-encodes the quote');
ok(!/[<>"]/.test(escapeJs('</script><img src=x onerror=1>')), 'escapeJs neutralizes < > "');

/* ── config: formatters ── */
eq(fmtDur(0),        '00:00',    'fmtDur 0');
eq(fmtDur(1000),     '00:01',    'fmtDur 1s');
eq(fmtDur(61000),    '01:01',    'fmtDur 1m1s');
eq(fmtDur(3661000),  '01:01:01', 'fmtDur 1h1m1s (hours shown)');

eq(fmtBytes(0),          '0 B',    'fmtBytes 0');
eq(fmtBytes(512),        '512 B',  'fmtBytes <1KB');
eq(fmtBytes(1024),       '1.0 KB', 'fmtBytes 1KB');
eq(fmtBytes(1536),       '1.5 KB', 'fmtBytes 1.5KB');
eq(fmtBytes(1048576),    '1.0 MB', 'fmtBytes 1MB');
eq(fmtBytes(1073741824), '1.0 GB', 'fmtBytes 1GB');

eq(fmtSize(1023),   '1023 B',   'fmtSize <1KB');
eq(fmtSize(50000),  '48.8 KB',  'fmtSize KB range');
eq(fmtSize(200000), '0.19 MB',  'fmtSize MB range (2dp)');

/* ── config: uid unique + monotonic ──
   By design uid() guarantees up to 1000 distinct ids per millisecond (the
   counter is taken mod 1000), which is far beyond this app's real rate (a
   handful of sub-items per user action). Test within that ceiling: 800 rapid
   calls — even if they all land in one millisecond — must stay unique and
   strictly increasing. */
{
    const ids = Array.from({ length: 800 }, () => uid());
    ok(new Set(ids).size === ids.length, 'uid: no collisions within the 1000/ms ceiling');
    let sorted = true;
    for (let i = 1; i < ids.length; i++) if (ids[i] <= ids[i - 1]) { sorted = false; break; }
    ok(sorted, 'uid: strictly increasing');
}

/* ── dedup: seamTrim ── */
eq(seamTrim('the quick brown fox', 'fox jumps over'), 'jumps over',
   'seamTrim removes the single overlapping leading word');
eq(seamTrim('hello world', 'world world world'), 'world world',
   'seamTrim trims only the seam, not legitimate repeats');
eq(seamTrim('alpha beta', 'gamma delta'), 'gamma delta',
   'seamTrim returns full text when there is no overlap');
eq(seamTrim('', 'lonely text'), 'lonely text', 'seamTrim: empty prev → full next');
eq(seamTrim('anything', ''), '', 'seamTrim: empty next → empty');
eq(seamTrim('end .', '. start'), '. start',
   'seamTrim: punctuation-only token never counts as a duplicate');

/* multilingual regression: non-Latin script must NOT be deleted wholesale */
eq(seamTrim('你好 世界', '再见 朋友'), '再见 朋友',
   'seamTrim keeps Chinese text when there is no real overlap');
eq(seamTrim('你好 世界', '世界 再见'), '再见',
   'seamTrim still trims a genuine Chinese seam overlap');

/* dedup: the popup-injected source (SEAM_TRIM_SRC, derived via toString) must
   stay byte-for-byte behaviourally identical to the module function it ships
   alongside. Guards the refactor that dropped `new Function` for a real fn. */
{
    const injected = new Function(SEAM_TRIM_SRC + '; return seamTrim;')();
    ok(typeof injected === 'function', 'SEAM_TRIM_SRC materialises a function (popup path)');
    const probes = [
        ['the quick brown fox', 'fox jumps over'],
        ['hello world', 'world world world'],
        ['你好 世界', '世界 再见'],
        ['end .', '. start'],
        ['', 'lonely text'],
        ['anything', '']
    ];
    let drift = false;
    for (const [a, b] of probes) if (injected(a, b) !== seamTrim(a, b)) drift = true;
    ok(!drift, 'injected popup seamTrim matches the module seamTrim on all probes');
}

/* ── dedup: appendTail bounding ── */
eq(appendTail('a b c', 'd e', 4), 'b c d e', 'appendTail keeps only last N words');
eq(appendTail('', 'x y', 40), 'x y', 'appendTail from empty tail');
ok(appendTail('w '.repeat(100), 'z', 40).split(' ').length === 40,
   'appendTail caps at the window size');

/* ── audio: buildWavHeader byte layout ── */
{
    const buf = buildWavHeader(1000, 16000);
    const v   = new DataView(buf);
    const tag = (off) => String.fromCharCode(v.getUint8(off), v.getUint8(off + 1),
                                              v.getUint8(off + 2), v.getUint8(off + 3));
    eq(buf.byteLength, 44,               'WAV header is 44 bytes');
    eq(tag(0),  'RIFF',                  'RIFF magic');
    eq(v.getUint32(4, true), 36 + 1000,  'RIFF chunk size = 36 + data');
    eq(tag(8),  'WAVE',                  'WAVE magic');
    eq(tag(12), 'fmt ',                  'fmt  magic');
    eq(v.getUint32(16, true), 16,        'fmt chunk size 16');
    eq(v.getUint16(20, true), 1,         'PCM format');
    eq(v.getUint16(22, true), 1,         'mono');
    eq(v.getUint32(24, true), 16000,     'sample rate');
    eq(v.getUint32(28, true), 32000,     'byte rate = sampleRate*2');
    eq(v.getUint16(32, true), 2,         'block align 2');
    eq(v.getUint16(34, true), 16,        'bits per sample 16');
    eq(tag(36), 'data',                  'data magic');
    eq(v.getUint32(40, true), 1000,      'data size');
}

/* ── audio: encodeMonoWav structure + sample clamping ── */
async function testEncode() {
    const blob = encodeMonoWav(new Float32Array([0, 1, -1, 0.5]), 16000);
    eq(blob.type, 'audio/wav',           'encodeMonoWav blob type');
    eq(blob.size, 44 + 4 * 2,            'encodeMonoWav blob size = header + samples*2');
    const v = new DataView(await blob.arrayBuffer());
    eq(v.getInt16(44, true), 0,          'sample 0 → 0');
    eq(v.getInt16(46, true), 32767,      'sample +1 clamps to +32767');
    eq(v.getInt16(48, true), -32768,     'sample -1 clamps to -32768');
    eq(v.getInt16(50, true), 16383,      'sample 0.5 → 16383');
}

await testEncode();

/* ── audio: stitchWavChunks ──
   The pure WAV-concatenation that powers BOTH the stop-time finalize master
   blob AND the live in-recording playback preview. Each "chunk" is a full WAV
   from encodeMonoWav; stitch must drop every inner header, keep one fresh master
   header sized to the TOTAL PCM, and concatenate the bodies in order. */
async function testStitch() {
    // (a) empty list → a valid header-only, zero-sample WAV (not a throw).
    {
        const blob = stitchWavChunks([], 16000);
        eq(blob.type, 'audio/wav',        'stitch: empty list → audio/wav blob');
        eq(blob.size, 44,                 'stitch: empty list → 44-byte header-only WAV');
        const v = new DataView(await blob.arrayBuffer());
        eq(v.getUint32(40, true), 0,      'stitch: empty list → data chunk size 0');
        eq(v.getUint32(4,  true), 36,     'stitch: empty list → RIFF size 36 (header only)');
    }

    // (b) single chunk: master PCM is byte-identical to the chunk's PCM.
    {
        const chunk  = encodeMonoWav(new Float32Array([0, 0.25, -0.25, 0.5]), 16000); // 44 + 8
        const master = stitchWavChunks([chunk], 16000);
        eq(master.size, chunk.size,       'stitch: single chunk → same total size as the chunk');
        const cv = new DataView(await chunk.arrayBuffer());
        const mv = new DataView(await master.arrayBuffer());
        eq(mv.getUint32(40, true), chunk.size - 44, 'stitch: single-chunk data size = its PCM bytes');
        let identical = true;
        for (let i = 44; i < chunk.size; i++) if (cv.getUint8(i) !== mv.getUint8(i)) { identical = false; break; }
        ok(identical, 'stitch: single-chunk PCM body preserved byte-for-byte');
    }

    // (c) multi-chunk: master = one header + summed bodies, concatenated in order.
    {
        const a = encodeMonoWav(new Float32Array([0.1, 0.2]),      16000); // 44 + 4
        const b = encodeMonoWav(new Float32Array([0.3, 0.4, 0.5]), 16000); // 44 + 6
        const master     = stitchWavChunks([a, b], 16000);
        const expectData = (a.size - 44) + (b.size - 44);                  // 4 + 6 = 10
        eq(master.size, 44 + expectData,           'stitch: master size = header + summed PCM bodies');
        const mv = new DataView(await master.arrayBuffer());
        eq(mv.getUint32(40, true), expectData,     'stitch: data chunk size = summed PCM bodies');
        eq(mv.getUint32(4,  true), 36 + expectData,'stitch: RIFF size = 36 + summed PCM');

        const av = new DataView(await a.arrayBuffer());
        const bv = new DataView(await b.arrayBuffer());
        let firstOk = true;
        for (let i = 0; i < a.size - 44; i++) if (mv.getUint8(44 + i) !== av.getUint8(44 + i)) { firstOk = false; break; }
        let secondOk = true;
        const off = 44 + (a.size - 44);
        for (let i = 0; i < b.size - 44; i++) if (mv.getUint8(off + i) !== bv.getUint8(44 + i)) { secondOk = false; break; }
        ok(firstOk && secondOk, 'stitch: bodies concatenated in seq order behind a single header');
    }

    // (d) sample-level integrity across the chunk seam (decode the int16 samples).
    {
        const a = encodeMonoWav(new Float32Array([0,    0.5]), 16000);
        const b = encodeMonoWav(new Float32Array([-0.5, 1  ]), 16000);
        const mv = new DataView(await stitchWavChunks([a, b], 16000).arrayBuffer());
        eq(mv.getInt16(44, true), 0,      'stitch: seam sample 0 = a[0]');
        eq(mv.getInt16(46, true), 16383,  'stitch: seam sample 1 = a[1] (0.5)');
        eq(mv.getInt16(48, true), -16384, 'stitch: seam sample 2 = b[0] (-0.5)');
        eq(mv.getInt16(50, true), 32767,  'stitch: seam sample 3 = b[1] (+1 clamps)');
    }

    // (e) a sub-44-byte chunk (crash mid-write) contributes zero data, no corruption.
    {
        const good   = encodeMonoWav(new Float32Array([0.5]), 16000);        // 44 + 2
        const tiny   = new Blob([new Uint8Array(10)], { type: 'audio/wav' }); // 10 bytes < 44
        const master = stitchWavChunks([good, tiny], 16000);
        eq(master.size, 44 + (good.size - 44), 'stitch: sub-44-byte chunk adds zero data bytes');
        const mv = new DataView(await master.arrayBuffer());
        eq(mv.getUint32(40, true), good.size - 44, 'stitch: data size ignores the malformed chunk');
    }

    // (f) sample rate propagates into the master header; defaults to 48 kHz.
    {
        const c  = encodeMonoWav(new Float32Array([0.1]), 44100);
        const mv = new DataView(await stitchWavChunks([c], 44100).arrayBuffer());
        eq(mv.getUint32(24, true), 44100,     'stitch: master header carries the given sample rate');
        eq(mv.getUint32(28, true), 44100 * 2, 'stitch: master byte rate = sampleRate*2');

        const dv = new DataView(await stitchWavChunks([], undefined).arrayBuffer());
        eq(dv.getUint32(24, true), 48000,     'stitch: defaults to 48000 Hz when sampleRate omitted');
    }
}

await testStitch();

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
