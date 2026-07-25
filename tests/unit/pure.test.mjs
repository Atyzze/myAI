import fs from 'node:fs';
import { emitTestResult } from '../helpers/test-result.mjs';
/* ==========================================================================
   pure.test.mjs - Zero-dependency tests for the app's pure, DOM-free logic.

   Run:  node tests/unit/pure.test.mjs
   (Node 18+; uses only built-ins - no test framework, no install step.)

   Only modules with no browser-API calls at import time are covered here
   (config.js, dedup.js, audio.js, naming.js, audio-format.js, player-core.js,
   reply-core.js). The seam-trim cases include the multilingual regression that the
   Unicode-aware normalizer fixed; audio.js now also covers planPcmFlush (the 4 s
   flush buffer cut) and parseWavHeader; reply-core covers the Ollama num_ctx sizing.

   The pure transcript-assembly logic (slicing, overlap trimming, timeline
   reassembly) lives in js/transcribe-core.js and is covered by its own
   sibling suite, tests/unit/core.test.mjs - run both.
   ========================================================================== */

import { escapeHtml, escapeAttr, escapeJs,
         fmtDur, fmtBytes, fmtAudioMegabytes, fmtStorageGigabytes, fmtStorageFullPercent, fmtSize, uid } from '../../src/js/config.js';
import { seamTrim, appendTail }                 from '../../src/js/dedup.js';
import { buildWavHeader, encodeMonoWav, stitchWavChunks,
         planPcmFlush, parseWavHeader }            from '../../src/js/audio.js';

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

eq(fmtAudioMegabytes(0),       '0.00 MB', 'fmtAudioMegabytes zero stays in MB');
eq(fmtAudioMegabytes(1048576), '1.00 MB', 'fmtAudioMegabytes 1 MiB uses 2dp');
eq(fmtAudioMegabytes(1572864), '1.50 MB', 'fmtAudioMegabytes fractional MiB uses 2dp');
eq(fmtAudioMegabytes(-1),      '0.00 MB', 'fmtAudioMegabytes clamps negative values');
eq(fmtStorageGigabytes(0),          '0 GB', 'fmtStorageGigabytes zero uses no decimals');
eq(fmtStorageGigabytes(2147483648), '2 GB', 'fmtStorageGigabytes 2 GiB uses no decimals');
eq(fmtStorageGigabytes(-1),         '0 GB', 'fmtStorageGigabytes clamps negative values');
eq(fmtStorageFullPercent(0, 2147483648),          '0%', 'storage fullness starts at zero');
eq(fmtStorageFullPercent(1073741824, 2147483648), '50%', 'storage fullness uses audio divided by quota');
eq(fmtStorageFullPercent(3221225472, 2147483648), '100%', 'storage fullness is capped at 100 percent');
eq(fmtStorageFullPercent(1, 0), null, 'storage fullness is unavailable without a positive quota');

eq(fmtSize(1023),   '1023 B',   'fmtSize <1KB');
eq(fmtSize(50000),  '48.8 KB',  'fmtSize KB range');
eq(fmtSize(200000), '0.19 MB',  'fmtSize MB range (2dp)');

/* ── config: uid unique + monotonic ──
   By design uid() guarantees up to 1000 distinct ids per millisecond (the
   counter is taken mod 1000), which is far beyond this app's real rate (a
   handful of sub-items per user action). Test within that ceiling: 800 rapid
   calls - even if they all land in one millisecond - must stay unique and
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

/* dedup: seam trimming has exactly ONE implementation, imported by both the
   stored-transcript assembler and the live popup. The popup used to receive it as
   injected source text, which also meant the app could never be minified; that
   copy is gone, so assert the single source of truth stays single. */
{
    const dedupSrc = fs.readFileSync(new URL('../../src/js/dedup.js', import.meta.url), 'utf8');
    ok(!dedupSrc.includes('toString()'),
       'dedup no longer materialises itself as source text for a popup');
    ok(!dedupSrc.includes('SEAM_TRIM_SRC'), 'the injected-source export is gone');
    // live-view.js handed rendering to live-render.js, which both the popup and
    // the in-page panel use; that module is now the seam-trimming consumer.
    for (const consumer of ['src/js/transcribe-core.js', 'src/js/live-render.js']) {
        const src = fs.readFileSync(new URL('../../' + consumer, import.meta.url), 'utf8');
        ok(/import\s*\{[^}]*\bseamTrim\b[^}]*\}\s*from\s*'\.\/dedup\.js'/.test(src),
           `${consumer} imports seamTrim rather than carrying its own copy`);
    }
    const probes = [
        ['the quick brown fox', 'fox jumps over', 'jumps over'],
        ['hello world', 'world world world', 'world world'],
        ['你好 世界', '世界 再见', '再见'],
        ['', 'lonely text', 'lonely text'],
        ['anything', '', '']
    ];
    for (const [a, b, expected] of probes) {
        eq(seamTrim(a, b), expected, `seamTrim(${JSON.stringify(a)}, ${JSON.stringify(b)})`);
    }
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

/* ── audio: planPcmFlush ── the 4 s IO-flush buffer cut, extracted from recorder.js.
   The load-bearing property is the invariant consumed + keptLength === total input
   samples: if it ever drifts, recorded audio silently gains/loses samples. */
{
    const f   = (arr) => Float32Array.from(arr);
    const sum = (chunks) => chunks.reduce((n, c) => n + c.length, 0);

    // (a) exact fill across whole chunks: nothing kept.
    {
        const chunks = [f([1, 2]), f([3, 4])];
        const r = planPcmFlush(chunks, 4);
        eq(Array.from(r.flat), [1, 2, 3, 4], 'planPcmFlush: fills flat from the front, in order');
        eq(r.keptBuffer.length, 0,            'planPcmFlush: exact fill keeps nothing');
        eq(r.keptLength, 0,                   'planPcmFlush: exact fill keptLength 0');
        eq(r.consumed, 4,                     'planPcmFlush: consumed == samplesToProcess');
    }
    // (b) cut straddling a chunk: the tail of that chunk is retained.
    {
        const chunks = [f([1, 2, 3]), f([4, 5])];    // take 1,2,3 then 4; keep 5
        const r = planPcmFlush(chunks, 4);
        eq(Array.from(r.flat), [1, 2, 3, 4],                 'planPcmFlush: straddle fill');
        eq(r.keptBuffer.map(c => Array.from(c)), [[5]],      'planPcmFlush: straddle keeps the remainder');
        eq(r.keptLength, 1,                                  'planPcmFlush: straddle keptLength');
        ok(r.consumed + r.keptLength === sum(chunks),        'planPcmFlush: consumed + kept == total (straddle)');
    }
    // (c) whole chunks past the cut carried by reference.
    {
        const chunks = [f([1, 2]), f([3, 4]), f([5, 6])];
        const r = planPcmFlush(chunks, 2);
        eq(Array.from(r.flat), [1, 2],                                'planPcmFlush: fills only the requested count');
        eq(r.keptBuffer.map(c => Array.from(c)), [[3, 4], [5, 6]],    'planPcmFlush: keeps whole trailing chunks');
        eq(r.keptLength, 4,                                           'planPcmFlush: keptLength sums trailing chunks');
        ok(r.consumed + r.keptLength === sum(chunks),                 'planPcmFlush: invariant holds (trailing)');
    }
    // (d) empty buffer → zero-filled flat of the requested size, nothing kept.
    {
        const r = planPcmFlush([], 3);
        eq(Array.from(r.flat), [0, 0, 0], 'planPcmFlush: empty buffer → zero-filled flat');
        eq(r.consumed, 0,                 'planPcmFlush: empty buffer consumed 0');
        eq(r.keptLength, 0,               'planPcmFlush: empty buffer keptLength 0');
    }
    // (e) final-flush shape: samplesToProcess == total → consumes all, keeps none.
    {
        const chunks = [f([1, 2, 3]), f([4])];
        const r = planPcmFlush(chunks, 4);
        eq(r.keptBuffer.length, 0,                          'planPcmFlush: final flush keeps nothing');
        ok(r.consumed === 4 && r.keptLength === 0,          'planPcmFlush: final flush consumes everything');
    }
}

/* ── audio: parseWavHeader ── extracted from resampleTo16k so the header math is
   testable without Web Audio. Round-trips against buildWavHeader. */
{
    const m = parseWavHeader(buildWavHeader(1000, 16000));
    ok(m.isWav,             'parseWavHeader: recognises a RIFF/WAVE header');
    eq(m.bits, 16,          'parseWavHeader: bits per sample');
    eq(m.channels, 1,       'parseWavHeader: channel count');
    eq(m.sampleRate, 16000, 'parseWavHeader: sample rate');

    ok(parseWavHeader(new DataView(buildWavHeader(500, 44100))).sampleRate === 44100,
        'parseWavHeader: accepts a DataView and reads its rate');

    const junk = new Uint8Array(44);   // all-zero: no RIFF/WAVE magic
    const jm   = parseWavHeader(junk.buffer);
    ok(!jm.isWav,   'parseWavHeader: non-WAV bytes → isWav false');
    eq(jm.bits, 0,  'parseWavHeader: non-WAV fields zeroed (caller decodes whole file)');

    ok(!parseWavHeader(new ArrayBuffer(10)).isWav,
        'parseWavHeader: <44 bytes → isWav false (no out-of-bounds read)');
}

/* ── reply-core: estimateNumCtx ── Ollama context sizing, the "prompt bigger than
   the window comes back EMPTY" fix. Now fenced so a regression can't slip back. */
{
    const { estimateNumCtx } = await import('../../src/js/reply-core.js');

    eq(estimateNumCtx(''),      8192, 'estimateNumCtx: empty prompt → floor 8192');
    eq(estimateNumCtx(null),    8192, 'estimateNumCtx: null prompt → floor 8192');
    eq(estimateNumCtx('hello'), 8192, 'estimateNumCtx: tiny prompt → floor 8192');

    // ceil(len/3) = 6145 tokens → needed 8193 > 8192 ⇒ next bucket 16384.
    eq(estimateNumCtx('x'.repeat(3 * 6145)), 16384, 'estimateNumCtx: just over 8192 → 16384');
    // Very large prompt clamps to the ceiling.
    eq(estimateNumCtx('x'.repeat(3 * 100000)), 32768, 'estimateNumCtx: huge prompt clamps to 32768');

    // Custom knobs honoured.
    eq(estimateNumCtx('x'.repeat(3000), { headroomTokens: 0, minCtx: 2048, maxCtx: 65536 }),
        2048, 'estimateNumCtx: 1000 tokens + 0 headroom fits the 2048 floor');
    eq(estimateNumCtx('', { minCtx: 4096 }), 4096, 'estimateNumCtx: custom minCtx floor');
}

/* ── naming: titles, cross-OS download filenames, storage-bar % ──
   Covers the editable-title feature (rec.title preferred over rec.filename,
   which stays the immutable timestamp key) and the universal download name
   (no filesystem-illegal characters, size appended). */
{
    const { sanitizeFilename, displayTitle, buildDownloadName, storagePct, byteLength, contextStats } =
        await import('../../src/js/naming.js');

    // sanitizeFilename: every Windows/macOS/Linux-illegal char must be gone.
    ok(!/[<>:"/\\|?*]/.test(sanitizeFilename('a<b>c:d"e/f\\g|h?i*j')),
        'sanitize strips all illegal filename characters');
    eq(sanitizeFilename('2026-07-03 13:31:00 - 05:23'),
        '2026-07-03 13-31-00 - 05-23',
        'sanitize turns the default timestamp title into a valid name (no colons)');
    eq(sanitizeFilename('  . trailing dots and spaces . . '),
        'trailing dots and spaces',
        'sanitize trims leading/trailing dots & spaces (Windows drops them)');
    eq(sanitizeFilename('a///b'), 'a-b', 'sanitize collapses runs to a single hyphen');
    eq(sanitizeFilename('   '), 'recording', 'sanitize falls back when nothing usable remains');
    eq(sanitizeFilename('///'), 'recording', 'sanitize falls back when only separators remain');
    ok(sanitizeFilename('CON') !== 'CON', 'sanitize dodges the reserved name CON');
    ok(sanitizeFilename('com1') !== 'com1', 'sanitize dodges reserved COM1');
    ok(sanitizeFilename('x'.repeat(400)).length <= 120, 'sanitize caps overlong names');

    // displayTitle: prefer the edited title, else the filename, trimmed.
    eq(displayTitle({ filename: 'ts - 01:02' }), 'ts - 01:02', 'displayTitle falls back to filename');
    eq(displayTitle({ filename: 'ts', title: 'Groceries' }), 'Groceries', 'displayTitle prefers title');
    eq(displayTitle({ filename: 'ts', title: '   ' }), 'ts', 'displayTitle ignores a blank title');
    eq(displayTitle({ filename: 'ts', title: '  Trimmed  ' }), 'Trimmed', 'displayTitle trims the title');
    eq(displayTitle(null), 'Recording', 'displayTitle tolerates a missing record');

    // buildDownloadName: sanitized title + size + extension.
    eq(buildDownloadName({ filename: '2026-07-03 13:31:00 - 05:23', blob: { size: 12 * 1024 * 1024 } }),
        '2026-07-03 13-31-00 - 05-23 - 12.0 MB.wav',
        'buildDownloadName = safe title + size + .wav');
    ok(!/[<>:"/\\|?*]/.test(buildDownloadName({ filename: 'a:b', blob: { size: 2048 } })),
        'buildDownloadName never contains illegal characters');
    eq(buildDownloadName({ filename: 'note', title: 'My Idea', size: 2048 }),
        'My Idea - 2.0 KB.wav',
        'buildDownloadName uses the edited title and rec.size fallback');
    eq(buildDownloadName({ filename: 'note' }), 'note.wav',
        'buildDownloadName omits the size part when size is 0/unknown');
    eq(buildDownloadName({ filename: 'note', size: 2048 }, 'mp3'), 'note - 2.0 KB.mp3',
        'buildDownloadName honours a custom extension');

    // storagePct: clamped fraction, safe on zero/garbage.
    eq(storagePct(0, 100), 0,   'storagePct 0 size = 0');
    eq(storagePct(50, 100), 50, 'storagePct half');
    eq(storagePct(200, 100), 100, 'storagePct clamps above 100');
    eq(storagePct(10, 0), 0,    'storagePct guards divide-by-zero');

    // buildDownloadName with the Opus containers the app can now produce.
    eq(buildDownloadName({ filename: 'note', size: 2048 }, 'webm'), 'note - 2.0 KB.webm',
        'buildDownloadName honours a .webm (opus) extension');
    eq(buildDownloadName({ filename: 'note', size: 2048 }, 'ogg'), 'note - 2.0 KB.ogg',
        'buildDownloadName honours an .ogg (opus) extension');

    // byteLength: UTF-8 byte counting (not UTF-16 code units).
    eq(byteLength('abc'), 3, 'byteLength ascii = 1 byte each');
    eq(byteLength('€'), 3, 'byteLength counts a 3-byte char');
    eq(byteLength('😀'), 4, 'byteLength counts a 4-byte emoji');
    eq(byteLength(''), 0, 'byteLength empty = 0');
    eq(byteLength(null), 0, 'byteLength null = 0');

    // contextStats: each non-empty input/output part counts as one; bytes summed.
    eq(contextStats([{ inputText: 'hello', outputText: 'hi there' }]), { parts: 2, bytes: 13 },
        'contextStats: a fresh continue = 2 parts (input + output)');
    eq(contextStats([{ inputText: 'hello', outputText: '' }]), { parts: 1, bytes: 5 },
        'contextStats: reply cut => 1 part');
    eq(contextStats([{ inputText: '', outputText: '   ' }]), { parts: 0, bytes: 0 },
        'contextStats: blank/whitespace parts are not counted');
    eq(contextStats([{ text: 'legacy only' }]), { parts: 1, bytes: 11 },
        'contextStats: legacy text-only item counts as one input part');
    eq(contextStats([{ inputText: 'a', outputText: 'b' }, { inputText: 'cc', outputText: '' }]),
        { parts: 3, bytes: 4 }, 'contextStats: sums across multiple chain items');
    eq(contextStats([]), { parts: 0, bytes: 0 }, 'contextStats: empty chain');
    eq(contextStats(null), { parts: 0, bytes: 0 }, 'contextStats: null chain tolerated');
}

/* ── audio-format: codec/container selection (pure decision layer for Opus) ──
   The browser wiring lives in recorder.js; only the decisions are tested here,
   using a fake MediaRecorder.isTypeSupported so no browser is needed. */
{
    const { pickOpusMime, extForMime, recordingExt, resolveRecordingFormat, OPUS_MIME_PREFERENCE, storedFormat, needsConversion } =
        await import('../../src/js/audio-format.js');

    // pickOpusMime: returns the FIRST supported mime in preference order.
    eq(pickOpusMime(() => true), OPUS_MIME_PREFERENCE[0],
        'pickOpusMime picks the top preference when all are supported (webm/opus)');
    eq(pickOpusMime((t) => t === 'audio/ogg;codecs=opus'), 'audio/ogg;codecs=opus',
        'pickOpusMime picks ogg/opus when only Firefox-style is supported');
    eq(pickOpusMime(() => false), null, 'pickOpusMime returns null when nothing is supported');
    eq(pickOpusMime(undefined), null, 'pickOpusMime tolerates a missing isTypeSupported');
    ok((() => { try { return pickOpusMime(() => { throw new Error('x'); }) === null; } catch { return false; } })(),
        'pickOpusMime swallows isTypeSupported throwing');

    // extForMime: container extension from the mime string.
    eq(extForMime('audio/webm;codecs=opus'), 'webm', 'extForMime webm/opus => webm');
    eq(extForMime('audio/ogg;codecs=opus'), 'ogg',  'extForMime ogg/opus => ogg');
    eq(extForMime('audio/wav'), 'wav', 'extForMime wav => wav');
    eq(extForMime(''), 'webm', 'extForMime defaults to webm');
    eq(extForMime(null), 'webm', 'extForMime tolerates null');

    // recordingExt: what the Download button should name the file.
    eq(recordingExt({ format: 'opus', mime: 'audio/webm;codecs=opus' }), 'webm',
        'recordingExt: opus/webm recording downloads as .webm');
    eq(recordingExt({ format: 'opus', mime: 'audio/ogg;codecs=opus' }), 'ogg',
        'recordingExt: opus/ogg recording downloads as .ogg');
    eq(recordingExt({ format: 'wav' }), 'wav', 'recordingExt: wav recording downloads as .wav');
    eq(recordingExt({}), 'wav', 'recordingExt: unknown format defaults to .wav');
    eq(recordingExt({ format: 'opus' }), 'wav',
        'recordingExt: opus without a stored mime falls back to .wav (safe)');
    eq(recordingExt(null), 'wav', 'recordingExt tolerates a missing record');

    // resolveRecordingFormat: opus only when BOTH requested and supported.
    eq(resolveRecordingFormat('opus', 'audio/webm;codecs=opus'),
        { format: 'opus', mime: 'audio/webm;codecs=opus' },
        'resolve: opus setting + supported => opus');
    eq(resolveRecordingFormat('opus', null), { format: 'wav', mime: null },
        'resolve: opus setting but unsupported => wav fallback');
    eq(resolveRecordingFormat('wav', 'audio/webm;codecs=opus'), { format: 'wav', mime: null },
        'resolve: wav setting stays wav even where opus is supported');
    eq(resolveRecordingFormat(undefined, 'audio/webm;codecs=opus'), { format: 'wav', mime: null },
        'resolve: missing setting defaults to wav');

    // storedFormat + needsConversion: drive the per-recording format badge.
    eq(storedFormat({ format: 'opus' }), 'opus', 'storedFormat reads opus');
    eq(storedFormat({ format: 'wav' }), 'wav', 'storedFormat reads wav');
    eq(storedFormat({}), 'wav', 'storedFormat defaults to wav');
    eq(storedFormat(null), 'wav', 'storedFormat tolerates null');
    ok(needsConversion('opus', { format: 'wav' }), 'needsConversion: opus preferred, wav stored => true');
    ok(!needsConversion('opus', { format: 'opus' }), 'needsConversion: already opus => false');
    ok(!needsConversion('wav', { format: 'wav' }), 'needsConversion: wav default => never convert');
    ok(!needsConversion('wav', { format: 'opus' }), 'needsConversion: wav default => false even if opus stored');
}

/* ── player-core: custom player decisions (repeat/rewind + seek-bar math) ──
   The player's DOM wiring is in gui.js; these lock in the decisions it makes. */
{
    const { isLivePlayerId, shouldRewindOnEnded, resolvePlayerTotalSec, playerFraction } =
        await import('../../src/js/player-core.js');

    // isLivePlayerId: distinguishes the still-recording preview from finalized rows.
    ok(isLivePlayerId('live-audio-5'), 'isLivePlayerId: live id recognized');
    ok(!isLivePlayerId('audio-5'), 'isLivePlayerId: finalized id is not live');
    ok(!isLivePlayerId(''), 'isLivePlayerId: empty is not live');
    ok(!isLivePlayerId(null), 'isLivePlayerId: null tolerated, not live');

    // shouldRewindOnEnded: rewind to 0 ONLY when repeat is off AND it's finalized.
    ok(shouldRewindOnEnded('', false), 'rewind: finalized + repeat off => rewind to start');
    ok(shouldRewindOnEnded(undefined, false), 'rewind: no id + repeat off => rewind');
    ok(!shouldRewindOnEnded('', true), 'rewind: repeat on => never rewind (loop owns it)');
    ok(!shouldRewindOnEnded('live-audio-1', false), 'rewind: live preview => never rewind');
    ok(!shouldRewindOnEnded('live-audio-1', true), 'rewind: live + repeat on => never rewind');

    // resolvePlayerTotalSec: known duration wins; audio.duration only if finite.
    eq(resolvePlayerTotalSec(10000, 8), 10, 'total: known ms wins over audio.duration');
    eq(resolvePlayerTotalSec(0, 8), 8, 'total: falls back to a finite audio.duration');
    eq(resolvePlayerTotalSec(0, Infinity), 0, 'total: Opus Infinity duration => 0');
    eq(resolvePlayerTotalSec(0, NaN), 0, 'total: NaN duration => 0');
    eq(resolvePlayerTotalSec(0, 0), 0, 'total: zero duration => 0');
    eq(resolvePlayerTotalSec('5000', 0), 5, 'total: coerces a string ms value');

    // playerFraction: clamped 0..1, never divides by zero or returns junk.
    eq(playerFraction(0, 10), 0, 'fraction: start => 0');
    eq(playerFraction(5, 10), 0.5, 'fraction: halfway');
    eq(playerFraction(10, 10), 1, 'fraction: end => 1');
    eq(playerFraction(15, 10), 1, 'fraction: past the end clamps to 1');
    eq(playerFraction(-3, 10), 0, 'fraction: negative clamps to 0');
    eq(playerFraction(5, 0), 0, 'fraction: zero total => 0 (no divide-by-zero)');
    eq(playerFraction(5, Infinity), 0, 'fraction: Infinity total => 0');
    eq(playerFraction(5, NaN), 0, 'fraction: NaN total => 0');
}

/* ── reply-core: prompt budgeting ── */
{
    const { buildBudgetedPrompt, truncateMiddle } = await import('../../src/js/reply-core.js');
    const budget = buildBudgetedPrompt({
        instructions: 'Answer clearly.',
        chain: [
            { label: 'old', text: 'x'.repeat(9000) },
            { label: 'new', text: 'y'.repeat(9000) }
        ],
        transcript: 'z'.repeat(9000)
    }, { maxCtx: 4096, reserveTokens: 1024, charsPerToken: 3 });
    ok(budget.prompt.length <= (4096 - 1024) * 3, 'prompt budget: output fits reserved context');
    ok(budget.droppedContext >= 1, 'prompt budget: oldest context is dropped first');
    const truncated = truncateMiddle('abcdefghij', 8, '..');
    eq(truncated.length, 8, 'truncateMiddle: exact requested length');
    ok(truncated.startsWith('ab') && truncated.endsWith('ghij'), 'truncateMiddle: preserves both ends');
}

/* ── jobs: identity-safe controller cleanup ── */
{
    const { beginJob, endJob, cancelAllJobs, hasJob, getJobController } = await import('../../src/js/jobs.js');
    const first = beginJob('t', 99);
    const second = beginJob('t', 99);
    ok(first.signal.aborted, 'jobs: replacement aborts the previous controller');
    ok(getJobController('t', 99) === second, 'jobs: replacement controller is registered');
    ok(!endJob('t', 99, first), 'jobs: stale completion cannot unregister newer controller');
    ok(hasJob('t', 99), 'jobs: newer controller survives stale cleanup');
    ok(endJob('t', 99, second), 'jobs: current controller can end its slot');
    ok(!hasJob('t', 99), 'jobs: slot is empty after current cleanup');

    beginJob('t', 1); beginJob('r', 2);
    cancelAllJobs();
    ok(!hasJob('t', 1) && !hasJob('r', 2), 'jobs: bulk cancellation clears every slot');
}

/* ── reply-core: streamed NDJSON decoding ──
   The reply stream is the feature the live view exists to display, and its
   framing logic had no coverage at all. Network reads split NDJSON at arbitrary
   offsets, so these cases are the ones that actually happen in production. */
{
    const { createReplyStreamReader } = await import('../../src/js/reply-core.js');
    const line = obj => JSON.stringify(obj) + '\n';
    const drain = events => events.map(e => e.type).join(',');

    // Whole objects, one per read.
    {
        const r = createReplyStreamReader();
        const a = r.push(line({ response: 'Hello' }));
        eq(drain(a), 'first-token,token', 'reply stream: the first token announces itself exactly once');
        eq((a[1] || {}).token, 'Hello', 'reply stream: the first token carries its text');
        const b = r.push(line({ response: ' world' }));
        eq(drain(b), 'token', 'reply stream: later tokens do not re-announce a first token');
        const c = r.push(line({ done: true }));
        eq(drain(c), 'done', 'reply stream: completion is reported');
        eq(r.text, 'Hello world', 'reply stream: accumulated text matches the tokens emitted');
    }

    // One read carrying several objects.
    {
        const r = createReplyStreamReader();
        const events = r.push(line({ response: 'a' }) + line({ response: 'b' }) + line({ response: 'c' }));
        eq(drain(events), 'first-token,token,token,token', 'reply stream: a batched read emits every object in order');
        eq(events.filter(e => e.type === 'token').map(e => e.token).join(''), 'abc',
           'reply stream: batched tokens keep their order');
    }

    // An object split across two reads - the case that corrupts naive parsers.
    {
        const r = createReplyStreamReader();
        const whole = line({ response: 'split' });
        const cut = Math.floor(whole.length / 2);
        eq(drain(r.push(whole.slice(0, cut))), '', 'reply stream: a partial object emits nothing yet');
        eq(drain(r.push(whole.slice(cut))), 'first-token,token', 'reply stream: the object completes on the next read');
        eq(r.text, 'split', 'reply stream: a split object is reassembled exactly');
    }

    // A final object with no trailing newline (a server that closes abruptly).
    {
        const r = createReplyStreamReader();
        r.push(line({ response: 'first' }));
        eq(drain(r.push(JSON.stringify({ response: ' last', done: true }))), '',
           'reply stream: an unterminated final object is held back');
        eq(drain(r.flush()), 'token,done', 'reply stream: flush releases the unterminated final object');
        eq(r.text, 'first last', 'reply stream: no text is lost when the stream ends without a newline');
        eq(drain(r.flush()), '', 'reply stream: flushing twice does not replay the final object');
    }

    // Noise between objects must not abort a healthy stream.
    {
        const r = createReplyStreamReader();
        const events = r.push('\n' + line({ response: 'x' }) + '   \n' + 'not json\n' + line({ response: 'y' }));
        eq(events.filter(e => e.type === 'token').map(e => e.token).join(''), 'xy',
           'reply stream: blank and unparseable lines are skipped, not fatal');
        eq(events.filter(e => e.type === 'error').length, 0, 'reply stream: noise is not reported as a server error');
    }

    // A server-reported error stops that line and is surfaced.
    {
        const r = createReplyStreamReader();
        r.push(line({ response: 'partial' }));
        const events = r.push(line({ error: 'model not found' }));
        eq(drain(events), 'error', 'reply stream: a server error is surfaced as an error event');
        eq((events[0] || {}).message, 'model not found', 'reply stream: the server error message is preserved');
        eq(r.text, 'partial', 'reply stream: text received before the error is retained');
    }

    // An empty response field must not be emitted as a token, and done may ride
    // along with a final token in the same object.
    {
        const r = createReplyStreamReader();
        eq(drain(r.push(line({ response: '' }))), '', 'reply stream: an empty response fragment emits nothing');
        eq(drain(r.push(line({ response: 'end', done: true }))), 'first-token,token,done',
           'reply stream: a final object may carry both a token and completion');
    }

    // A stream that completes without any text: reply.js turns this into an
    // explicit failure rather than storing an empty reply.
    {
        const r = createReplyStreamReader();
        r.push(line({ done: true }));
        eq(r.text, '', 'reply stream: a textless completion accumulates no text');
    }
}

/* ── reply-core: which model a reply is actually sent to ──
 *
 * A fresh profile has never opened Settings, so the stored model is the built-in
 * default. When the server does not have it, the reply fails with a
 * model-not-found error while transcription keeps working - which reads as "the
 * AI reply is broken" rather than "that model is not installed". The picker used
 * to be the only place the two were reconciled.
 * ────────────────────────────────────────────────────────────────────────── */
{
    const { chooseReplyModel } = await import('../../src/js/reply-core.js');
    const installed = ['gemma4:31b', 'qwen3:8b', 'gemma4:e4b'];

    eq(chooseReplyModel(installed, 'qwen3:8b', 'gemma4:e4b'), 'qwen3:8b',
       'reply model: an explicit user choice the server still has is never overridden');
    eq(chooseReplyModel(installed, 'llama3.2', 'gemma4:e4b'), 'gemma4:e4b',
       'reply model: falls back to the preferred default when the stored model is gone');
    eq(chooseReplyModel(['gemma4:31b', 'qwen3:8b'], 'llama3.2', 'gemma4:e4b'), 'gemma4:31b',
       'reply model: prefers a different size of the intended model over an unrelated one');
    eq(chooseReplyModel(['qwen3:8b', 'phi4:14b'], 'llama3.2', 'gemma4:e4b'), 'qwen3:8b',
       'reply model: any installed model beats a reply that cannot run');
    eq(chooseReplyModel([], 'qwen3:8b', 'gemma4:e4b'), 'qwen3:8b',
       'reply model: an empty list keeps the stored name rather than inventing one');
    eq(chooseReplyModel([], '', 'gemma4:e4b'), 'gemma4:e4b',
       'reply model: with nothing stored and nothing installed, the default is reported');
    eq(chooseReplyModel(null, null, null), '',
       'reply model: missing inputs resolve to an empty name instead of throwing');
    eq(chooseReplyModel([null, '', 'gemma4:e4b'], '', 'gemma4:e4b'), 'gemma4:e4b',
       'reply model: malformed entries in the server list are ignored');
}

/* ── report ── */
console.log(`\n${'─'.repeat(60)}`);
if (failed === 0) {
    console.log(`✓ all ${passed} assertions passed`);
    emitTestResult('pure', 'pass', { assertions: passed });
    process.exit(0);
} else {
    console.log(`${passed} passed, ${failed} FAILED:\n`);
    console.log(fails.join('\n'));
    process.exit(1);
}
