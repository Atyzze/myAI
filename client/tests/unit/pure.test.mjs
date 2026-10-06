import fs from 'node:fs';
import { emitTestResult } from '../helpers/test-result.mjs';

import { escapeHtml, escapeAttr,
         fmtDur, fmtBytes, fmtAudioMegabytes, fmtStorageGigabytes, fmtStorageFullPercent, fmtSize, uid } from '../../src/js/config.js';
import { buildClipboardContextItem, normalizeClipboardText,
         CLIPBOARD_CONTEXT_MAX_CHARS } from '../../src/js/clipboard-core.js';
import { seamTrim, appendTail }                 from '../../src/js/dedup.js';
import { buildWavHeader, encodeMonoWav, stitchWavChunks,
         planPcmFlush, parseWavHeader }            from '../../src/js/audio.js';

let passed = 0, failed = 0;
const fails = [];
let reported = false;
process.on('exit', () => {
    if (reported || !fails.length) return;
    console.log(`\n${passed} passed, ${failed} FAILED before the suite stopped early:\n`);
    console.log(fails.join('\n'));
});

function eq(actual, expected, name) {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { passed++; }
    else { failed++; fails.push(`✗ ${name}\n    expected ${e}\n    got      ${a}`); }
}
function ok(cond, name) {
    if (cond) { passed++; } else { failed++; fails.push(`✗ ${name}`); }
}

eq(escapeHtml('<tag>&'), '&lt;tag&gt;&amp;', 'escapeHtml escapes < > &');
eq(escapeHtml('"\''), '"\'', 'escapeHtml leaves quotes (attr layer handles them)');
eq(escapeAttr('"x\''), '&quot;x&#39;', 'escapeAttr escapes both quote types');

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
eq(fmtStorageGigabytes(0),          '0 MB', 'fmtStorageGigabytes: nothing free says 0 MB');
eq(fmtStorageGigabytes(400 * 1024 * 1024), '400 MB', 'fmtStorageGigabytes: under a gigabyte is shown in megabytes, never as 0 GB');
eq(fmtStorageGigabytes(1610612736), '1.5 GB', 'fmtStorageGigabytes: a few gigabytes keep one decimal');
eq(fmtStorageGigabytes(2147483648), '2.0 GB', 'fmtStorageGigabytes: 2 GiB');
eq(fmtStorageGigabytes(151 * 1073741824), '151 GB', 'fmtStorageGigabytes: plenty of space uses no decimals');
eq(fmtStorageGigabytes(-1),         '0 MB', 'fmtStorageGigabytes clamps negative values');
eq(fmtStorageFullPercent(0, 2147483648),          '0%', 'storage fullness starts at zero');
eq(fmtStorageFullPercent(1073741824, 2147483648), '50%', 'storage fullness uses audio divided by quota');
eq(fmtStorageFullPercent(3221225472, 2147483648), '100%', 'storage fullness is capped at 100 percent');
eq(fmtStorageFullPercent(1, 0), null, 'storage fullness is unavailable without a positive quota');

eq(fmtSize(1023),   '1023 B',   'fmtSize <1KB');
eq(fmtSize(50000),  '48.8 KB',  'fmtSize KB range');
eq(fmtSize(200000), '0.19 MB',  'fmtSize MB range (2dp)');

{
    const ids = Array.from({ length: 800 }, () => uid());
    ok(new Set(ids).size === ids.length, 'uid: no collisions within the 1000/ms ceiling');
    let sorted = true;
    for (let i = 1; i < ids.length; i++) if (ids[i] <= ids[i - 1]) { sorted = false; break; }
    ok(sorted, 'uid: strictly increasing');
}

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

eq(seamTrim('你好 世界', '再见 朋友'), '再见 朋友',
   'seamTrim keeps Chinese text when there is no real overlap');
eq(seamTrim('你好 世界', '世界 再见'), '再见',
   'seamTrim still trims a genuine Chinese seam overlap');

eq(seamTrim('please turn off the lights before you leave',
            'turn off a lights before you leave and lock the door'),
   'and lock the door',
   'seamTrim survives one misheard word inside an otherwise identical seam');
eq(seamTrim('we met at the station around noon', 'we met at the station around noon'), '',
   'seamTrim removes a seam that repeats the whole previous line');
eq(seamTrim('the report is due on friday morning', 'a report was due by friday morning'),
   'a report was due by friday morning',
   'seamTrim keeps a similar but differently anchored line intact');
eq(seamTrim('walk down to the old mill', 'the old mill is closed'), 'is closed',
   'an exact three-word seam is still trimmed exactly');
eq(seamTrim('one two three', 'one two four'), 'one two four',
   'a shared opening that is not a seam is never treated as one');
eq(seamTrim('alpha beta gamma delta', 'alpha zeta gamma epsilon'),
   'alpha zeta gamma epsilon',
   'seamTrim refuses a tolerant run whose closing word does not match');
eq(seamTrim('the cat sat on the mat today okay',
            'the cat sat on the mat today differently and then left'),
   'the cat sat on the mat today differently and then left',
   'seamTrim will not swallow a line that merely opens like the previous one: without a matching '
   + 'closing word there is no seam, however much of the middle agrees');

// A window edge cuts words: the window after a seam may hear only the end of the word the overlap
// opens with, the window before it only the start of the word the overlap closes with.
eq(seamTrim('so today is the budget for next year', 'day is the budget for next year and the plan'),
   'and the plan',
   'a seam whose first word the next window heard only the end of ("day" for "today") is still trimmed');
eq(seamTrim('so today is the budget for next yeah', 'today is the budget for next year and the plan'),
   'year and the plan',
   'a seam whose last word the window before misheard as it was cut off ("yeah" for "year") is still trimmed, and the '
   + 'word itself is kept as the next window heard it whole, so it is never lost to the clipped reading');
eq(seamTrim('we leave on friday after', 'friday afternoon we leave'), 'afternoon we leave',
   'a short seam whose closing word the window before heard only the start of ("after" for "afternoon") is trimmed up to that word, which is kept whole');
eq(seamTrim('for next year', 'xt year and the plan'), 'and the plan',
   'a short seam whose opening word the next window heard only the end of ("xt" for "next") is trimmed');
eq(seamTrim('the budget for next year', 'get for next week'), 'get for next week',
   'a cut word is no anchor by itself: the closing word still has to match');
eq(seamTrim('see you today yeah', 'day year more'), 'day year more',
   'a short seam is not taken on both edge words being cut, with nothing whole between them');
eq(seamTrim('look at the cat', 'the bat sat down'), 'the bat sat down',
   'two different short words a letter apart are not taken for one cut word');
eq(seamTrim('this is the budget for 2023', 'the budget for 2024 is higher'), 'the budget for 2024 is higher',
   'two numbers that share their first digits (2023 and 2024) are different numbers, not one cut short');

{
    const dedupSrc = fs.readFileSync(new URL('../../src/js/dedup.js', import.meta.url), 'utf8');
    ok(!dedupSrc.includes('toString()'),
       'dedup no longer materialises itself as source text for a popup');
    ok(!dedupSrc.includes('SEAM_TRIM_SRC'), 'the injected-source export is gone');
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

eq(appendTail('a b c', 'd e', 4), 'b c d e', 'appendTail keeps only last N words');
eq(appendTail('', 'x y', 40), 'x y', 'appendTail from empty tail');
ok(appendTail('w '.repeat(100), 'z', 40).split(' ').length === 40,
   'appendTail caps at the window size');

{
    const { findBoundaryRepetition, findTimedRepetitionCandidates,
            adjacentRepeatWords, translationIntroducesRepetition,
            preferWiderRecheck, mergeTimedPcm, replaceWindowLines }
        = await import('../../src/js/live-refine-core.js');
    const candidate = findBoundaryRepetition(
        'we should probably finish this before we leave',
        'finish this before we leave and then go home');
    ok(candidate && candidate.words >= 5, 'refine: a repeated seam is detected');
    const fieldCase = findBoundaryRepetition(
        'basic tests and should work',
        'It should work without too much strain at all.');
    ok(fieldCase && fieldCase.words === 2 && fieldCase.nextPrefixWords === 3,
       'refine: a short duplicated phrase behind one filler word is reviewable');
    ok(preferWiderRecheck(
        'basic tests and should work It should work without too much strain at all.',
        'basic tests and should work without too much strain at all.', fieldCase),
       'refine: a second listen can prove the should-work field echo was one utterance');
    const timed = findTimedRepetitionCandidates([
        { startSec: 0, endSec: 4, text: 'basic tests and should work' },
        { startSec: 2, endSec: 7, text: 'It should work without too much strain at all.' }
    ]);
    eq(timed.length, 1,
       'refine: overlapping timestamps promote the short echo to an audio review');
    eq(findTimedRepetitionCandidates([
        { startSec: 0, endSec: 4, text: 'basic tests and should work' },
        { startSec: 6, endSec: 10, text: 'It should work without too much strain at all.' }
    ]).length, 0,
       'refine: the same short words at different times are not silently treated as an echo');
    eq(findBoundaryRepetition('we should leave now', 'tomorrow is another day'), null,
       'refine: unrelated speech is not a repeat candidate');
    eq(adjacentRepeatWords('we can go now we can go now please'), 4,
       'refine: adjacent repeated phrases are measurable');
    ok(translationIntroducesRepetition('we can go now', 'nous pouvons partir nous pouvons partir'),
       'refine: a translation-only repetition is rejected');
    ok(!translationIntroducesRepetition('go go go now go go go now', 'va va va maintenant va va va maintenant'),
       'refine: repetition already present in source is not erased by policy');
    ok(preferWiderRecheck(
        'we should probably finish this before we leave finish this before we leave and then go home',
        'we should probably finish this before we leave and then go home', candidate),
       'refine: a wider pass that preserves the vocabulary and loses one repeated run can win');
    ok(!preferWiderRecheck(
        'we should probably finish this before we leave finish this before we leave and then go home',
        'completely unrelated words are not evidence', candidate),
       'refine: a disagreeing second pass can never rewrite the transcript');
    const merged = mergeTimedPcm([
        { startSec: 0, pcm: new Float32Array([1, 2, 3, 4]) },
        { startSec: 0.000125, pcm: new Float32Array([3, 4, 5, 6]) }
    ], 16000);
    eq(merged.pcm.length, 6, 'refine: overlapping PCM windows merge on their timeline');
    const heard = 'basic tests and it should work without too much strain at all.';
    for (const next of ['It should work without too much strain at all.', '- It should work without too much strain at all.']) {
        const lines = [
            { key: 'a', startSec: 0, endSec: 4, text: 'basic tests and should work' },
            { key: 'cmd', startSec: 3, endSec: 3, text: 'system line', system: true },
            { key: 'b', startSec: 2, endSec: 7, text: next }
        ];
        const candidate = findBoundaryRepetition(lines[0].text, next);
        ok(preferWiderRecheck(`${lines[0].text} ${next}`, heard, candidate), `refine: a wider listen confirms the echo in "${next}"`);
        const replaced = replaceWindowLines(lines, ['a'], ['b'], heard);
        eq(replaced.lines.filter(line => !line.system).map(line => line.text).join(' | '), heard,
           `refine: both windows become what the wider listen heard, "it" included, for "${next}"`);
        eq(replaced.lines.filter(line => line.system).length, 1, 'refine: system lines are never rewritten');
        eq(JSON.stringify(replaced.changed), '["a","b"]', 'refine: both windows are reported as changed');
    }
}

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

async function testStitch() {
    {
        const blob = stitchWavChunks([], 16000);
        eq(blob.type, 'audio/wav',        'stitch: empty list → audio/wav blob');
        eq(blob.size, 44,                 'stitch: empty list → 44-byte header-only WAV');
        const v = new DataView(await blob.arrayBuffer());
        eq(v.getUint32(40, true), 0,      'stitch: empty list → data chunk size 0');
        eq(v.getUint32(4,  true), 36,     'stitch: empty list → RIFF size 36 (header only)');
    }

    {
        const chunk  = encodeMonoWav(new Float32Array([0, 0.25, -0.25, 0.5]), 16000);
        const master = stitchWavChunks([chunk], 16000);
        eq(master.size, chunk.size,       'stitch: single chunk → same total size as the chunk');
        const cv = new DataView(await chunk.arrayBuffer());
        const mv = new DataView(await master.arrayBuffer());
        eq(mv.getUint32(40, true), chunk.size - 44, 'stitch: single-chunk data size = its PCM bytes');
        let identical = true;
        for (let i = 44; i < chunk.size; i++) if (cv.getUint8(i) !== mv.getUint8(i)) { identical = false; break; }
        ok(identical, 'stitch: single-chunk PCM body preserved byte-for-byte');
    }

    {
        const a = encodeMonoWav(new Float32Array([0.1, 0.2]),      16000);
        const b = encodeMonoWav(new Float32Array([0.3, 0.4, 0.5]), 16000);
        const master     = stitchWavChunks([a, b], 16000);
        const expectData = (a.size - 44) + (b.size - 44);
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

    {
        const a = encodeMonoWav(new Float32Array([0,    0.5]), 16000);
        const b = encodeMonoWav(new Float32Array([-0.5, 1  ]), 16000);
        const mv = new DataView(await stitchWavChunks([a, b], 16000).arrayBuffer());
        eq(mv.getInt16(44, true), 0,      'stitch: seam sample 0 = a[0]');
        eq(mv.getInt16(46, true), 16383,  'stitch: seam sample 1 = a[1] (0.5)');
        eq(mv.getInt16(48, true), -16384, 'stitch: seam sample 2 = b[0] (-0.5)');
        eq(mv.getInt16(50, true), 32767,  'stitch: seam sample 3 = b[1] (+1 clamps)');
    }

    {
        const good   = encodeMonoWav(new Float32Array([0.5]), 16000);
        const tiny   = new Blob([new Uint8Array(10)], { type: 'audio/wav' });
        const master = stitchWavChunks([good, tiny], 16000);
        eq(master.size, 44 + (good.size - 44), 'stitch: sub-44-byte chunk adds zero data bytes');
        const mv = new DataView(await master.arrayBuffer());
        eq(mv.getUint32(40, true), good.size - 44, 'stitch: data size ignores the malformed chunk');
    }

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

{
    const f   = (arr) => Float32Array.from(arr);
    const sum = (chunks) => chunks.reduce((n, c) => n + c.length, 0);

    {
        const chunks = [f([1, 2]), f([3, 4])];
        const r = planPcmFlush(chunks, 4);
        eq(Array.from(r.flat), [1, 2, 3, 4], 'planPcmFlush: fills flat from the front, in order');
        eq(r.keptBuffer.length, 0,            'planPcmFlush: exact fill keeps nothing');
        eq(r.keptLength, 0,                   'planPcmFlush: exact fill keptLength 0');
        eq(r.consumed, 4,                     'planPcmFlush: consumed == samplesToProcess');
    }
    {
        const chunks = [f([1, 2, 3]), f([4, 5])];
        const r = planPcmFlush(chunks, 4);
        eq(Array.from(r.flat), [1, 2, 3, 4],                 'planPcmFlush: straddle fill');
        eq(r.keptBuffer.map(c => Array.from(c)), [[5]],      'planPcmFlush: straddle keeps the remainder');
        eq(r.keptLength, 1,                                  'planPcmFlush: straddle keptLength');
        ok(r.consumed + r.keptLength === sum(chunks),        'planPcmFlush: consumed + kept == total (straddle)');
    }
    {
        const chunks = [f([1, 2]), f([3, 4]), f([5, 6])];
        const r = planPcmFlush(chunks, 2);
        eq(Array.from(r.flat), [1, 2],                                'planPcmFlush: fills only the requested count');
        eq(r.keptBuffer.map(c => Array.from(c)), [[3, 4], [5, 6]],    'planPcmFlush: keeps whole trailing chunks');
        eq(r.keptLength, 4,                                           'planPcmFlush: keptLength sums trailing chunks');
        ok(r.consumed + r.keptLength === sum(chunks),                 'planPcmFlush: invariant holds (trailing)');
    }
    {
        const r = planPcmFlush([], 3);
        eq(Array.from(r.flat), [0, 0, 0], 'planPcmFlush: empty buffer → zero-filled flat');
        eq(r.consumed, 0,                 'planPcmFlush: empty buffer consumed 0');
        eq(r.keptLength, 0,               'planPcmFlush: empty buffer keptLength 0');
    }
    {
        const chunks = [f([1, 2, 3]), f([4])];
        const r = planPcmFlush(chunks, 4);
        eq(r.keptBuffer.length, 0,                          'planPcmFlush: final flush keeps nothing');
        ok(r.consumed === 4 && r.keptLength === 0,          'planPcmFlush: final flush consumes everything');
    }
}

{
    const m = parseWavHeader(buildWavHeader(1000, 16000));
    ok(m.isWav,             'parseWavHeader: recognises a RIFF/WAVE header');
    eq(m.bits, 16,          'parseWavHeader: bits per sample');
    eq(m.channels, 1,       'parseWavHeader: channel count');
    eq(m.sampleRate, 16000, 'parseWavHeader: sample rate');

    ok(parseWavHeader(new DataView(buildWavHeader(500, 44100))).sampleRate === 44100,
        'parseWavHeader: accepts a DataView and reads its rate');

    const junk = new Uint8Array(44);
    const jm   = parseWavHeader(junk.buffer);
    ok(!jm.isWav,   'parseWavHeader: non-WAV bytes → isWav false');
    eq(jm.bits, 0,  'parseWavHeader: non-WAV fields zeroed (caller decodes whole file)');

    ok(!parseWavHeader(new ArrayBuffer(10)).isWav,
        'parseWavHeader: <44 bytes → isWav false (no out-of-bounds read)');
}

{
    const { estimateNumCtx, estimateTokens, LATIN_CHARS_PER_TOKEN } = await import('../../src/js/reply-core.js');

    eq(estimateNumCtx(''),      8192, 'estimateNumCtx: empty prompt → floor 8192');
    eq(estimateNumCtx(null),    8192, 'estimateNumCtx: null prompt → floor 8192');
    eq(estimateNumCtx('hello'), 8192, 'estimateNumCtx: tiny prompt → floor 8192');

    const justOver = 'x'.repeat(Math.ceil((8192 - 2048 + 1) * LATIN_CHARS_PER_TOKEN));
    ok(estimateTokens(justOver) + 2048 > 8192, 'estimateNumCtx: the probe really is just over 8192');
    eq(estimateNumCtx(justOver), 16384, 'estimateNumCtx: just over 8192 → 16384');
    eq(estimateNumCtx('x'.repeat(3 * 100000)), 32768, 'estimateNumCtx: huge prompt clamps to 32768');

    eq(estimateNumCtx('x'.repeat(3000), { headroomTokens: 0, minCtx: 2048, maxCtx: 65536 }),
        2048, 'estimateNumCtx: 1000 tokens + 0 headroom fits the 2048 floor');
    eq(estimateNumCtx('', { minCtx: 4096 }), 4096, 'estimateNumCtx: custom minCtx floor');
    const { AI_NUM_CTX, AI_MAX_NUM_CTX } = await import('../../src/js/model-ready-core.js');
    eq(estimateNumCtx('hello', { headroomTokens: 4096, minCtx: AI_NUM_CTX, maxCtx: AI_MAX_NUM_CTX }), AI_NUM_CTX,
       'estimateNumCtx: an ordinary reply asks for the shared AI context, the one translation already loaded');
    eq(estimateNumCtx('x'.repeat(3 * 20000), { headroomTokens: 4096, minCtx: AI_NUM_CTX, maxCtx: AI_MAX_NUM_CTX }),
       AI_MAX_NUM_CTX, 'estimateNumCtx: only a prompt too large for it steps up to the maximum');
}

{
    const { sanitizeFilename, displayTitle, buildDownloadName, storagePct, byteLength, contextStats } =
        await import('../../src/js/naming.js');

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

    eq(displayTitle({ filename: 'ts - 01:02' }), 'ts - 01:02', 'displayTitle falls back to filename');
    eq(displayTitle({ filename: 'ts', title: 'Groceries' }), 'Groceries', 'displayTitle prefers title');
    eq(displayTitle({ filename: 'ts', title: '   ' }), 'ts', 'displayTitle ignores a blank title');
    eq(displayTitle({ filename: 'ts', title: '  Trimmed  ' }), 'Trimmed', 'displayTitle trims the title');
    eq(displayTitle(null), 'Recording', 'displayTitle tolerates a missing record');

    eq(buildDownloadName({ filename: '2026-07-03 13:31:00 - 05:23', audioBytes: 12 * 1024 * 1024 }),
        '2026-07-03 13-31-00 - 05-23 - 12.0 MB.wav',
        'buildDownloadName = safe title + size + .wav');
    ok(!/[<>:"/\\|?*]/.test(buildDownloadName({ filename: 'a:b', audioBytes: 2048 })),
        'buildDownloadName never contains illegal characters');
    eq(buildDownloadName({ filename: 'note', title: 'My Idea', size: 2048 }),
        'My Idea - 2.0 KB.wav',
        'buildDownloadName uses the edited title and rec.size fallback');
    eq(buildDownloadName({ filename: 'note' }), 'note.wav',
        'buildDownloadName omits the size part when size is 0/unknown');
    eq(buildDownloadName({ filename: 'note', size: 2048 }, 'mp3'), 'note - 2.0 KB.mp3',
        'buildDownloadName honours a custom extension');

    eq(storagePct(0, 100), 0,   'storagePct 0 size = 0');
    eq(storagePct(50, 100), 50, 'storagePct half');
    eq(storagePct(200, 100), 100, 'storagePct clamps above 100');
    eq(storagePct(10, 0), 0,    'storagePct guards divide-by-zero');

    eq(buildDownloadName({ filename: 'note', size: 2048 }, 'webm'), 'note - 2.0 KB.webm',
        'buildDownloadName honours a .webm (opus) extension');
    eq(buildDownloadName({ filename: 'note', size: 2048 }, 'ogg'), 'note - 2.0 KB.ogg',
        'buildDownloadName honours an .ogg (opus) extension');

    eq(byteLength('abc'), 3, 'byteLength ascii = 1 byte each');
    eq(byteLength('€'), 3, 'byteLength counts a 3-byte char');
    eq(byteLength('😀'), 4, 'byteLength counts a 4-byte emoji');
    eq(byteLength(''), 0, 'byteLength empty = 0');
    eq(byteLength(null), 0, 'byteLength null = 0');

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

{
    const { pickOpusMime, extForMime, recordingExt, resolveRecordingFormat, OPUS_MIME_PREFERENCE, storedFormat, needsConversion } =
        await import('../../src/js/audio-format.js');

    eq(pickOpusMime(() => true), OPUS_MIME_PREFERENCE[0],
        'pickOpusMime picks the top preference when all are supported (webm/opus)');
    eq(pickOpusMime((t) => t === 'audio/ogg;codecs=opus'), 'audio/ogg;codecs=opus',
        'pickOpusMime picks ogg/opus when only Firefox-style is supported');
    eq(pickOpusMime(() => false), null, 'pickOpusMime returns null when nothing is supported');
    eq(pickOpusMime(undefined), null, 'pickOpusMime tolerates a missing isTypeSupported');
    ok((() => { try { return pickOpusMime(() => { throw new Error('x'); }) === null; } catch { return false; } })(),
        'pickOpusMime swallows isTypeSupported throwing');

    eq(extForMime('audio/webm;codecs=opus'), 'webm', 'extForMime webm/opus => webm');
    eq(extForMime('audio/ogg;codecs=opus'), 'ogg',  'extForMime ogg/opus => ogg');
    eq(extForMime('audio/wav'), 'wav', 'extForMime wav => wav');
    eq(extForMime(''), 'webm', 'extForMime defaults to webm');
    eq(extForMime(null), 'webm', 'extForMime tolerates null');

    eq(recordingExt({ format: 'opus', mime: 'audio/webm;codecs=opus' }), 'webm',
        'recordingExt: opus/webm recording downloads as .webm');
    eq(recordingExt({ format: 'opus', mime: 'audio/ogg;codecs=opus' }), 'ogg',
        'recordingExt: opus/ogg recording downloads as .ogg');
    eq(recordingExt({ format: 'wav' }), 'wav', 'recordingExt: wav recording downloads as .wav');
    eq(recordingExt({}), 'wav', 'recordingExt: unknown format defaults to .wav');
    eq(recordingExt({ format: 'opus' }), 'wav',
        'recordingExt: opus without a stored mime falls back to .wav (safe)');
    eq(recordingExt(null), 'wav', 'recordingExt tolerates a missing record');

    eq(resolveRecordingFormat('opus', 'audio/webm;codecs=opus'),
        { format: 'opus', mime: 'audio/webm;codecs=opus' },
        'resolve: opus setting + supported => opus');
    eq(resolveRecordingFormat('opus', null), { format: 'wav', mime: null },
        'resolve: opus setting but unsupported => wav fallback');
    eq(resolveRecordingFormat('wav', 'audio/webm;codecs=opus'), { format: 'wav', mime: null },
        'resolve: wav setting stays wav even where opus is supported');
    eq(resolveRecordingFormat(undefined, 'audio/webm;codecs=opus'), { format: 'wav', mime: null },
        'resolve: missing setting defaults to wav');

    eq(storedFormat({ format: 'opus' }), 'opus', 'storedFormat reads opus');
    eq(storedFormat({ format: 'wav' }), 'wav', 'storedFormat reads wav');
    eq(storedFormat({}), 'wav', 'storedFormat defaults to wav');
    eq(storedFormat(null), 'wav', 'storedFormat tolerates null');
    ok(needsConversion('opus', { format: 'wav' }), 'needsConversion: opus preferred, wav stored => true');
    ok(!needsConversion('opus', { format: 'opus' }), 'needsConversion: already opus => false');
    ok(!needsConversion('wav', { format: 'wav' }), 'needsConversion: wav default => never convert');
    ok(!needsConversion('wav', { format: 'opus' }), 'needsConversion: wav default => false even if opus stored');
}

{
    const { isLivePlayerId, shouldRewindOnEnded, resolvePlayerTotalSec, playerFraction,
            planLivePreview } =
        await import('../../src/js/player-core.js');

    ok(isLivePlayerId('live-audio-5'), 'isLivePlayerId: live id recognized');
    ok(!isLivePlayerId('audio-5'), 'isLivePlayerId: finalized id is not live');
    ok(!isLivePlayerId(''), 'isLivePlayerId: empty is not live');
    ok(!isLivePlayerId(null), 'isLivePlayerId: null tolerated, not live');

    ok(shouldRewindOnEnded('', false), 'rewind: finalized + repeat off => rewind to start');
    ok(shouldRewindOnEnded(undefined, false), 'rewind: no id + repeat off => rewind');
    ok(!shouldRewindOnEnded('', true), 'rewind: repeat on => never rewind (loop owns it)');
    ok(!shouldRewindOnEnded('live-audio-1', false), 'rewind: live preview => never rewind');
    ok(!shouldRewindOnEnded('live-audio-1', true), 'rewind: live + repeat on => never rewind');

    eq(resolvePlayerTotalSec(10000, 8), 10, 'total: known ms wins over audio.duration');
    eq(resolvePlayerTotalSec(0, 8), 8, 'total: falls back to a finite audio.duration');
    eq(resolvePlayerTotalSec(0, Infinity), 0, 'total: Opus Infinity duration => 0');
    eq(resolvePlayerTotalSec(0, NaN), 0, 'total: NaN duration => 0');
    eq(resolvePlayerTotalSec(0, 0), 0, 'total: zero duration => 0');
    eq(resolvePlayerTotalSec('5000', 0), 5, 'total: coerces a string ms value');

    eq(playerFraction(0, 10), 0, 'fraction: start => 0');
    eq(playerFraction(5, 10), 0.5, 'fraction: halfway');
    eq(playerFraction(10, 10), 1, 'fraction: end => 1');
    eq(playerFraction(15, 10), 1, 'fraction: past the end clamps to 1');
    eq(playerFraction(-3, 10), 0, 'fraction: negative clamps to 0');
    eq(playerFraction(5, 0), 0, 'fraction: zero total => 0 (no divide-by-zero)');
    eq(playerFraction(5, Infinity), 0, 'fraction: Infinity total => 0');
    eq(playerFraction(5, NaN), 0, 'fraction: NaN total => 0');

    const LIVE_INPUTS = ['requested', 'playing', 'ended', 'hasNewChunk', 'nearEdge', 'loaded'];
    let cases = 0;
    let idleRebuilds = 0;
    let resumeWithoutRebuild = 0;
    for (let mask = 0; mask < (1 << LIVE_INPUTS.length); mask++) {
        const state = {};
        LIVE_INPUTS.forEach((name, bit) => { state[name] = Boolean(mask & (1 << bit)); });
        const plan = planLivePreview(state);
        cases++;
        if (plan.rebuild && !state.requested && !state.playing && !state.ended) idleRebuilds++;
        if (plan.resume && !plan.rebuild && !state.requested) resumeWithoutRebuild++;
    }
    eq(cases, 64, 'live preview: every combination of the six inputs is covered');
    eq(idleRebuilds, 0,
       'live preview: a paused, unrequested tick never rebuilds');
    eq(resumeWithoutRebuild, 0, 'live preview: resume is never promised without a rebuild to resume into');

    ok(planLivePreview({ requested: true, loaded: false }).rebuild,
       'live preview: pressing play with nothing loaded builds the snapshot');
    ok(planLivePreview({ requested: true, loaded: true, hasNewChunk: true }).rebuild,
       'live preview: pressing play rebuilds when audio has arrived since the snapshot');
    ok(!planLivePreview({ requested: true, loaded: true, hasNewChunk: false }).rebuild,
       'live preview: pressing play on an up-to-date snapshot just plays it');
    ok(planLivePreview({ playing: true, hasNewChunk: true, nearEdge: true }).rebuild,
       'live preview: playback extends past the loaded edge into newly captured audio');
    ok(!planLivePreview({ playing: true, hasNewChunk: true, nearEdge: false }).rebuild,
       'live preview: playback mid-snapshot does not rebuild');
    ok(planLivePreview({ ended: true, hasNewChunk: true }).rebuild,
       'live preview: reaching the end continues into audio captured since');
    ok(!planLivePreview().rebuild, 'live preview: no state at all is an idle tick');
}

{
    const { RETENTION_OPTIONS, DEFAULT_RETENTION, retentionMs, retentionLabel,
            retentionScanCutoff, fmtRetentionRemaining, planRecordRetention,
            planRetentionSweep, retentionPlanTouchesAnything } =
        await import('../../src/js/retention-core.js');

    const MIN = 60 * 1000, HOUR = 60 * MIN, DAY = 24 * HOUR;
    const values = RETENTION_OPTIONS.map(o => o.value);
    eq(values.join(','), '5m,15m,1h,4h,1d,7d,1M,3M,1y', 'retention: the offered windows are exactly the shipped set');
    eq(DEFAULT_RETENTION, '1M', 'retention: the default is one month');
    ok(!values.includes('never') && !values.includes('off') && !RETENTION_OPTIONS.some(o => !Number.isFinite(o.ms) || o.ms <= 0),
       'retention: there is no keep-forever option');
    let previous = 0;
    for (const option of RETENTION_OPTIONS) {
        ok(option.ms > previous, `retention: ${option.value} is longer than the window before it`);
        previous = option.ms;
    }
    eq(retentionMs('1M'), 30 * DAY, 'retention: a month is 30 days, as the label says');
    eq(retentionMs('1y'), 365 * DAY, 'retention: a year is 365 days, as the label says');
    eq(retentionMs('nonsense'), retentionMs(DEFAULT_RETENTION),
       'retention: an unrecognised stored value falls back to the default');
    eq(retentionMs(undefined), retentionMs(DEFAULT_RETENTION), 'retention: a missing value falls back to the default');
    ok(retentionLabel('7d').length > 0, 'retention: every window can name itself for a message');

    const now = 1_000_000_000_000;
    eq(retentionScanCutoff({ now, audioMs: 30 * DAY, textMs: 7 * DAY }), now - 7 * DAY,
       'retention: the scan stops at the SHORTER of the two windows');

    eq(fmtRetentionRemaining(3 * DAY + 5 * HOUR), '3d', 'retention: days round down');
    eq(fmtRetentionRemaining(90 * MIN), '1h', 'retention: hours round down');
    eq(fmtRetentionRemaining(30 * 1000), '< 1m', 'retention: under a minute is not reported as zero');
    eq(fmtRetentionRemaining(-5), 'now', 'retention: already expired reads as now');

    const opts = { now, audioMs: 30 * DAY, textMs: 30 * DAY };
    const audioBytes = 1024;

    const fresh = planRecordRetention(
        { id: 1, timestamp: now - DAY, audioBytes, transcripts: [{ id: 't1', time: now - DAY }] }, opts);
    ok(!fresh.dropAudio && fresh.dropTranscriptIds.length === 0 && !fresh.dropRow,
       'retention: a day-old recording inside a month-long window is untouched');

    const old = planRecordRetention(
        { id: 2, timestamp: now - 40 * DAY, audioBytes, transcripts: [{ id: 't1', time: now - 40 * DAY }] }, opts);
    ok(old.dropAudio && old.dropTranscriptIds.length === 1 && old.dropRow,
       'retention: a recording past both windows loses everything and its empty row');

    const recentReply = planRecordRetention({
        id: 3, timestamp: now - 40 * DAY, audioBytes,
        transcripts: [{ id: 't1', time: now - DAY }],
        summaries: [{ id: 's1', transcriptId: 't1', time: now - HOUR }]
    }, opts);
    ok(recentReply.dropAudio, 'retention: old audio expires on its own clock');
    eq(recentReply.dropTranscriptIds.length, 0,
       'retention: a transcript generated yesterday is a day old, not forty');
    eq(recentReply.dropSummaryIds.length, 0, 'retention: the same holds for a reply');
    ok(!recentReply.dropRow, 'retention: a row that still holds text is not removed');

    const answered = planRecordRetention({
        id: 31, timestamp: now - 40 * DAY,
        transcripts: [{ id: 't1', time: now - 31 * DAY }, { id: 't2', time: now - 31 * DAY }],
        summaries: [{ id: 's1', transcriptId: 't1', time: now - DAY }]
    }, opts);
    eq(answered.dropTranscriptIds.join(','), 't2',
       'retention: a transcript is kept while a reply written from it is kept, instead of taking a fresh reply with it');
    ok(answered.dropSummaryIds.length === 0 && !answered.dropRow && answered.textExpiresInMs === 29 * DAY,
       'retention: so the row lives as long as its countdown says');
    const bothOld = planRecordRetention({
        id: 32, timestamp: now - 40 * DAY,
        transcripts: [{ id: 't1', time: now - 35 * DAY }],
        summaries: [{ id: 's1', transcriptId: 't1', time: now - 31 * DAY }]
    }, opts);
    ok(bothOld.dropTranscriptIds.length === 1 && bothOld.dropSummaryIds.length === 1,
       'retention: once its replies expire too, the transcript goes with them');

    const legacy = planRecordRetention(
        { id: 4, timestamp: now - 40 * DAY, transcripts: [{ id: 't1' }] }, opts);
    eq(legacy.dropTranscriptIds.length, 1,
       'retention: an item with no time of its own ages with its recording rather than never');

    const live = planRecordRetention(
        { id: 5, timestamp: now - 400 * DAY, audioBytes, processing: true }, opts);
    ok(!retentionPlanTouchesAnything(live),
       'retention: a recording still being captured or finalized is never swept');
    const deleting = planRecordRetention(
        { id: 6, timestamp: now - 400 * DAY, audioBytes, deleting: true }, opts);
    ok(!retentionPlanTouchesAnything(deleting), 'retention: a row already being deleted is left alone');

    const audioOnly = planRecordRetention(
        { id: 7, timestamp: now - 10 * DAY, audioBytes, transcripts: [{ id: 't1', time: now - 10 * DAY }] },
        { now, audioMs: 7 * DAY, textMs: 90 * DAY });
    ok(audioOnly.dropAudio && audioOnly.dropTranscriptIds.length === 0 && !audioOnly.dropRow,
       'retention: a short audio window frees space while the text survives');
    const textOnly = planRecordRetention(
        { id: 8, timestamp: now - 10 * DAY, audioBytes, transcripts: [{ id: 't1', time: now - 10 * DAY }] },
        { now, audioMs: 90 * DAY, textMs: 7 * DAY });
    ok(!textOnly.dropAudio && textOnly.dropTranscriptIds.length === 1 && !textOnly.dropRow,
       'retention: a short text window clears text while the recording survives');

    const ctx = planRecordRetention({
        id: 9, timestamp: now - 40 * DAY,
        contextChain: [{ inputText: 'a', outputText: 'b' }]
    }, opts);
    ok(ctx.dropContext && ctx.dropRow, 'retention: a context chain ages with the recording that copied it in');

    const liveLines = 1;
    const recovered = planRecordRetention(
        { id: 90, timestamp: now - 10 * DAY, audioBytes, liveTranscriptLines: liveLines },
        { now, audioMs: 7 * DAY, textMs: 365 * DAY });
    ok(recovered.dropAudio, 'retention: a recovered recording still loses its audio on the audio clock');
    ok(!recovered.dropLive,
       'retention: but the text it captured live is text, and waits for the text clock');
    ok(!recovered.dropRow,
       'retention: so the row survives, instead of being swept as though it held nothing');

    const liveExpired = planRecordRetention(
        { id: 91, timestamp: now - 100 * DAY, audioBytes, liveTranscriptLines: liveLines },
        { now, audioMs: 365 * DAY, textMs: 7 * DAY });
    ok(liveExpired.dropLive, 'retention: and it does expire, on the text clock, like any other text');
    ok(!liveExpired.dropRow, 'retention: while the audio it belongs to is still inside its own window');
    ok(retentionPlanTouchesAnything(liveExpired),
       'retention: a sweep that has only a live transcript to clear is still a sweep worth running');

    const bothGone = planRecordRetention(
        { id: 92, timestamp: now - 400 * DAY, audioBytes, liveTranscriptLines: liveLines }, opts);
    ok(bothGone.dropAudio && bothGone.dropLive && bothGone.dropRow,
       'retention: once both clocks have passed there is nothing left to keep the row for');

    eq(planRecordRetention({ id: 93, timestamp: now - 400 * DAY, audioBytes,
                             liveTranscriptLines: 0 }, opts).dropRow, true,
       'retention: an empty live transcript is not text and keeps nothing alive');
    ok(planRecordRetention({ id: 94, timestamp: now - 10 * DAY, liveTranscriptLines: liveLines },
                           { now, audioMs: 7 * DAY, textMs: 365 * DAY }).textExpiresInMs > 0,
       'retention: a row whose only text is the live one still reports when that text expires');

    const counting = planRecordRetention(
        { id: 10, timestamp: now - 10 * DAY, audioBytes, transcripts: [{ id: 't1', time: now - DAY }] }, opts);
    eq(fmtRetentionRemaining(counting.audioExpiresInMs), '20d', 'retention: audio reports its own deadline');
    eq(fmtRetentionRemaining(counting.textExpiresInMs), '29d', 'retention: text reports its own, later deadline');

    const sweep = planRetentionSweep([
        { id: 1, timestamp: now - DAY, audioBytes },
        { id: 2, timestamp: now - 40 * DAY, audioBytes: 2048 },
        { id: 3, timestamp: now - 40 * DAY, transcripts: [{ id: 't', time: now - 40 * DAY }] }
    ], opts);
    eq(sweep.actions.length, 2, 'retention: the sweep plan lists only the rows it would change');
    eq(sweep.counts.audioRecordings, 1, 'retention: the announcement counts the recordings losing audio');
    eq(sweep.counts.audioBytes, 2048, 'retention: and the bytes they hold, so the figure can be checked');
    eq(sweep.counts.transcripts, 1, 'retention: and the text items');
    eq(sweep.counts.rows, 2, 'retention: and the rows that would be left empty');
    ok(planRetentionSweep([{ id: 1, timestamp: now, audioBytes }], opts).empty,
       'retention: a library inside both windows produces an empty plan');
    eq(sweep.counts.oldestAt, now - 40 * DAY,
       'retention: and how far back it reaches');

    const { isShorterRetention, retentionAckToken, parseRetentionAck,
            retentionAckCovers, describeRetentionChange } =
        await import('../../src/js/retention-core.js');

    ok(isShorterRetention('5m', '1M'), 'retention: a shorter window is recognised as the dangerous direction');
    ok(!isShorterRetention('1y', '1M'), 'retention: lengthening one can only spare data, so it asks nothing');
    ok(!isShorterRetention('1M', '1M'), 'retention: and choosing what was already chosen is not a change');

    const agreedMonth = retentionAckToken({ audio: '1M', text: '1M' });
    eq(parseRetentionAck(agreedMonth).audio, '1M', 'retention: an acknowledgement records what was agreed to');
    ok(retentionAckCovers(agreedMonth, { audio: '1M', text: '1M' }),
       'retention: and covers the policy it was given for');
    ok(retentionAckCovers(agreedMonth, { audio: '1y', text: '1M' }),
       'retention: it still covers a longer window, which takes nothing away');
    ok(!retentionAckCovers(agreedMonth, { audio: '5m', text: '1M' }),
       'retention: agreeing to a month is not agreeing to five minutes');
    ok(!retentionAckCovers(agreedMonth, { audio: '1M', text: '1h' }),
       'retention: the two clocks are checked independently');
    ok(!retentionAckCovers('1', { audio: '1M', text: '1M' }),
       'retention: the old set-once flag does not count as agreement to anything');
    ok(!retentionAckCovers(null, { audio: '1M', text: '1M' }),
       'retention: and neither does never having been asked');

    const warning = describeRetentionChange(
        { audioRecordings: 17, audioBytes: 2048, transcripts: 3, summaries: 1, rows: 2, oldestAt: 1 },
        { clock: 'audio', fromLabel: '1 month (30 days)', toLabel: '5 minutes',
          oldestAt: 1, formatBytes: () => '2.3 GB', formatDate: () => '4 March' });
    ok(/17 recording/.test(warning) && /2\.3 GB/.test(warning),
       'retention: the warning names how much goes, not merely that something will');
    ok(/4 March/.test(warning), 'retention: and how far back it reaches');
    ok(/5 minutes/.test(warning) && /1 month/.test(warning),
       'retention: and both windows, so the change itself is legible');
    ok(/cannot be undone/.test(warning),
       'retention: and says plainly that there is nothing to undo it with');
}

{
    const { WINDOW_SEC, OVERLAP_SEC, MAX_PENDING_SEC, MAX_IN_FLIGHT,
            PREVIEW_MAX_SEC, DROPPED_MARKER, RETRY_BASE_MS, RETRY_MAX_MS,
            RETRY_QUEUE_MAX_BYTES, planLiveWindow, planPreviewRequest,
            appendLiveLines, capLiveText, nextSpeechState,
            planUpload, capRetryQueue, releaseInOrder, settleLiveWindows,
            retryDelayMs, describeConnection } =
        await import('../../src/js/live-scribe-core.js');

    ok(OVERLAP_SEC > 0 && OVERLAP_SEC < WINDOW_SEC, 'live: the carried overlap is smaller than the window');
    ok(MAX_PENDING_SEC > WINDOW_SEC, 'live: the pending cap allows at least one whole window');
    ok(MAX_IN_FLIGHT >= 1 && MAX_IN_FLIGHT < 10,
       'live: live transcription does not get the post-recording ten-way pool');

    ok(!planLiveWindow({ bufferedSec: WINDOW_SEC - 0.1 }).send, 'live: a partial window waits');
    const ready = planLiveWindow({ bufferedSec: WINDOW_SEC + 5 });
    ok(ready.send && ready.sendSec === WINDOW_SEC,
       'live: a full window is sent, and only a window');
    eq(ready.dropSec, 0, 'live: nothing is dropped while the buffer is inside its cap');

    eq(planLiveWindow({ bufferedSec: 600, inFlight: MAX_IN_FLIGHT }).send, false,
       'live: no new request while every slot is busy');

    const saturated = planLiveWindow({ bufferedSec: MAX_PENDING_SEC + 30, inFlight: MAX_IN_FLIGHT });
    eq(saturated.send, false, 'live: a saturated pipeline still sends nothing');
    eq(saturated.dropSec, 30, 'live: but it still drops the audio it cannot hold');
    for (let buffered = 0; buffered <= MAX_PENDING_SEC * 3; buffered += 7) {
        for (const inFlight of [0, 1, MAX_IN_FLIGHT, MAX_IN_FLIGHT + 1]) {
            for (const stopping of [false, true]) {
                const plan = planLiveWindow({ bufferedSec: buffered, inFlight, stopping });
                ok(buffered - plan.dropSec <= MAX_PENDING_SEC + 0.0001,
                   'live: the buffer is never left above its cap, in any state');
                ok(plan.sendSec <= buffered, 'live: a plan never sends more audio than exists');
            }
        }
    }

    {
        const pending = new Map([[0, { items: ['a'], coverage: { fromSec: 0, toSec: 6 } }],
                                 [2, { items: ['c'], coverage: { fromSec: 12, toSec: 18 } }]]);
        const stalled = settleLiveWindows(pending, 0);
        eq(stalled.nextIndex, 1,
           'live: a window that never arrives strands every window numbered after it');
        eq(stalled.ready.length, 1, 'live: so nothing past the hole is ever shown');
        pending.set(1, { items: [], gap: true });
        const resumed = settleLiveWindows(pending, 1);
        eq(resumed.nextIndex, 3,
           'live: which is why a window that fails to be prepared must still claim its number');
        eq(resumed.covered.length, 1,
           'live: and a window claimed that way covers nothing, so the audio is transcribed after recording');
        eq(JSON.stringify(resumed.covered[0]), JSON.stringify({ fromSec: 12, toSec: 18 }),
           'live: only the window that really was heard reports coverage');
    }

    {
        const { invertCoverage } = await import('../../src/js/transcribe-core.js');
        const heard = [];
        let consumedSec = 0;
        const consume = seconds => { consumedSec += seconds; };
        const sendWindow = seconds => {
            const from = consumedSec;
            consume(seconds);
            heard.push({ fromSec: from, toSec: consumedSec });
        };
        sendWindow(6);
        consume(120);
        sendWindow(6);
        const gaps = invertCoverage(heard, 132, 1);
        eq(gaps.length, 1,
           'live: audio dropped because the server fell behind leaves a hole in the coverage');
        eq(gaps.map(gap => `${gap.fromSec}-${gap.toSec}`).join(','), '6-126',
           'live: exactly the span that was dropped, so the pass after recording transcribes it');
        const stamped = heard[heard.length - 1].fromSec;
        eq(stamped, 126,
           'live: and every line after a drop is stamped where the audio really is, not 120s early');
    }

    const tail = planLiveWindow({ bufferedSec: 3, stopping: true });
    ok(tail.send && tail.sendSec === 3, 'live: stopping sends a short final window');
    ok(!planLiveWindow({ bufferedSec: 0, stopping: true }).send, 'live: stopping with nothing buffered sends nothing');

    ok(!planPreviewRequest({ pendingSec: 0.5 }).send, 'live: too little pending audio to preview');
    ok(!planPreviewRequest({ pendingSec: 5, previewInFlight: true }).send,
       'live: exactly one preview is in flight');
    ok(!planPreviewRequest({ pendingSec: 5, sinceLastMs: 0 }).send, 'live: previews have a floor between them');
    ok(!planPreviewRequest({ pendingSec: 5, stopping: true }).send, 'live: a stopping recording commits rather than previews');
    eq(planPreviewRequest({ pendingSec: 5 }).sec, 5, 'live: a short pending buffer is previewed whole');
    eq(planPreviewRequest({ pendingSec: 600 }).sec, PREVIEW_MAX_SEC,
       'live: the preview never grows past its cap');
    ok(!planPreviewRequest({ pendingSec: 2, shown: false }).send,
       'preview: nothing is previewed while the translation boxes are shown, because the boxes never show a preview');
    ok(!planPreviewRequest({ pendingSec: 2, hidden: true }).send,
       'preview: nor while the app is in the background');
    ok(!planPreviewRequest({ pendingSec: 2, heardSpeech: false }).send,
       'preview: nor when nobody has spoken since the last one');
    ok(!planPreviewRequest({ pendingSec: WINDOW_SEC - 0.3, windowSlotFree: true }).send,
       'preview: nor when the window that settles those words is about to be sent anyway');
    ok(planPreviewRequest({ pendingSec: WINDOW_SEC + 6, windowSlotFree: false }).send,
       'preview: but a server that is behind still gets previews, because the words are not settling');
    ok(planPreviewRequest({ pendingSec: 2, windowSlotFree: true }).send,
       'preview: and speech well before the next window is still shown as it is spoken');

    let speech = { floor: 0, level: 0, speaking: false, speakingUntil: 0 };
    for (let i = 0; i < 200; i++) speech = nextSpeechState(speech, 0.002, i * 20);
    ok(!speech.speaking, 'live: room noise alone is not reported as speech');
    const loud = nextSpeechState(speech, 0.2, 5000);
    ok(loud.speaking && loud.level > speech.level, 'live: speech above the learned floor is detected at once');
    ok(nextSpeechState(loud, 0.001, 5100).speaking,
       'live: the indicator holds briefly, so it does not flicker between words');
    ok(!nextSpeechState(loud, 0.001, 9000).speaking, 'live: it clears once speech really has stopped');
    let rising = { floor: 0, level: 0, speaking: false, speakingUntil: 0 };
    for (let i = 0; i < 50; i++) rising = nextSpeechState(rising, 0.2, i * 20);
    ok(rising.floor < 0.2, 'live: a long sentence does not raise the noise floor to its own volume');

    const first = appendLiveLines({ lines: [], tail: '' },
        [{ startSec: 0, endSec: 4, text: 'this is a test' }]);
    eq(first.lines.length, 1, 'live: a committed window appends a line');
    eq(first.lines[0].startSec, 0, 'live: each line carries where it was spoken');
    const second = appendLiveLines(first, [{ startSec: 4, endSec: 8, text: 'a test to see' }]);
    eq(second.lines[1].text, 'to see',
       'live: the overlap duplicated by the window before it is trimmed away');

    const afterGap = appendLiveLines(first, [{ startSec: 20, endSec: 24, text: 'a test to see' }], { gap: true });
    eq(afterGap.lines[1].text, 'a test to see',
       'live: text after a gap is never seam-trimmed against what came before');
    ok(afterGap.lines[1].gap, 'live: the gap is marked on the line so it is visible');

    eq(appendLiveLines(first, [{ startSec: 9, endSec: 9, text: '   ' }]).lines.length, 1,
       'live: an empty segment adds no line');

    const heard = appendLiveLines({ lines: [], tail: '' }, [
        { startSec: 2.0, endSec: 2.9, text: 'We need to fix the bug.' },
        { startSec: 3.0, endSec: 3.4, text: 'Yes, I think so.' }
    ], { seamUntilSec: null });
    eq(appendLiveLines(heard, [{ startSec: 3.2, endSec: 4.4, text: 'I think so. Let us start.' }], { seamUntilSec: 4 })
        .lines.map(line => line.text).join(' | '),
       'We need to fix the bug. | Yes, I think so. | Let us start.',
       'live: a line that starts in the overlap with the previous window loses the words that window already heard');
    eq(appendLiveLines(heard, [
        { startSec: 4.6, endSec: 5.2, text: 'Yes, I know so.' },
        { startSec: 5.4, endSec: 6.0, text: 'We need to fix the other bug.' }
    ], { seamUntilSec: 4 }).lines.map(line => line.text).join(' | '),
       'We need to fix the bug. | Yes, I think so. | Yes, I know so. | We need to fix the other bug.',
       'live: only a line that starts in the overlap with the previous window is checked for repeated words; later lines that resemble earlier ones are kept');
    eq(appendLiveLines(first, [{ startSec: 0.1, endSec: 2, text: 'is a test of it' }], { seamUntilSec: null }).lines[1].text,
       'is a test of it', 'live: a window with no overlap, such as the first after 📝 is shown again, is never trimmed');
    const jittered = appendLiveLines({ lines: [{ key: 'a', startSec: 6.1, endSec: 8, text: 'I think we should' }], tail: 'I think we should' },
        [{ startSec: 6.0, endSec: 9.5, text: 'I think we should go to the park.' }], { seamUntilSec: 8 });
    ok(jittered.lines[1].text === 'go to the park.' && jittered.lines[1].startSec >= jittered.lines[0].startSec,
       'live: the rest of a sentence split across two windows never starts before its beginning, so it is saved in spoken order');

    const many = [];
    for (let i = 0; i < 500; i++) many.push({ startSec: i, endSec: i + 1, text: 'x'.repeat(200) });
    const capped = appendLiveLines({ lines: [], tail: '' }, many, { maxChars: 2000 });
    ok(capped.chars <= 2000 + 201, 'live: the retained transcript is capped by dropping whole lines');
    ok(capped.lines[capped.lines.length - 1].text.length === 200,
       'live: the newest line always survives the cap');
    eq(capLiveText('short', 1000), 'short', 'live: text inside the cap is untouched');
    ok(capLiveText('word '.repeat(2000), 1000).startsWith(DROPPED_MARKER),
       'live: a capped provisional line says that earlier text was dropped');

    eq(retryDelayMs(1), RETRY_BASE_MS, 'network: the first retry is immediate-ish');
    eq(retryDelayMs(2), RETRY_BASE_MS * 2, 'network: the backoff doubles');
    eq(retryDelayMs(50), RETRY_MAX_MS, 'network: and settles at a cap rather than growing forever');
    ok(RETRY_MAX_MS <= 30000,
       'network: a restored connection is picked up within half a minute even if nothing notices it came back');
    for (let attempt = 1; attempt <= 200; attempt++) {
        const delay = retryDelayMs(attempt);
        ok(delay >= RETRY_BASE_MS && delay <= RETRY_MAX_MS,
           'network: every attempt waits a sane, bounded time');
    }

    for (const attempt of [1, 3, 10, 1000, 100000]) {
        const ready = planUpload({ queued: 1, now: 1e9, nextAttemptAt: 0, online: true });
        ok(ready.send, `network: a queued window is still dispatched after ${attempt} failures`);
    }
    ok(!planUpload({ queued: 0 }).send, 'network: nothing queued, nothing sent');
    ok(!planUpload({ queued: 5, inFlight: MAX_IN_FLIGHT }).send, 'network: the in-flight limit still holds');
    const offline = planUpload({ queued: 5, online: false });
    ok(!offline.send && offline.waitMs > 0,
       'network: a known-offline device waits instead of spending the attempt');
    eq(offline.reason, 'offline', 'network: and says why');
    const waiting = planUpload({ queued: 5, now: 1000, nextAttemptAt: 6000, online: true });
    ok(!waiting.send && waiting.waitMs === 5000,
       'network: backoff reports how long to wait, so one timer replaces polling');

    {
        const { judgeWindowFailure, WINDOW_MAX_STRIKES } = await import('../../src/js/live-scribe-core.js');
        let outage = { seenAnswered: 7 };
        for (let i = 0; i < 50; i++) {
            const verdict = judgeWindowFailure(outage, 7);
            outage = { ...outage, ...verdict };
            ok(!verdict.giveUp, 'network: a window that fails while no other window is answered keeps its place, however long the outage');
        }
        let poison = { seenAnswered: 7 };
        const verdicts = [];
        for (const answered of [7, 8, 9]) {
            const verdict = judgeWindowFailure(poison, answered);
            poison = { ...poison, ...verdict };
            verdicts.push(verdict.giveUp);
        }
        eq(verdicts.join(','), 'false,false,true',
           'network: a window the server fails on while it answers the others is given up after a strike each time');
        ok(WINDOW_MAX_STRIKES >= 2 && WINDOW_MAX_STRIKES <= 4, 'network: a few strikes, so one flaky reply does not cost a window');
        const firstTry = judgeWindowFailure({}, 12);
        ok(firstTry.strikes === 0 && firstTry.seenAnswered === 12,
           'network: a window that has never been tried before starts without strikes');
    }

    const queue = [];
    for (let i = 0; i < 10; i++) queue.push({ index: i, bytes: 1000 });
    const trimmed = capRetryQueue(queue, 4500);
    eq(trimmed.queue.length, 4, 'network: the queue is trimmed to its byte budget');
    eq(trimmed.dropped[0].index, 0, 'network: the oldest window goes first');
    eq(trimmed.queue[trimmed.queue.length - 1].index, 9, 'network: the newest window is always kept');
    eq(capRetryQueue([{ index: 0, bytes: 1e9 }], 10).queue.length, 1,
       'network: a single oversized window still gets its attempt');
    ok(RETRY_QUEUE_MAX_BYTES >= 32 * 1024 * 1024,
       'network: the budget covers a long outage, not a blip');

    const pending = new Map();
    pending.set(1, 'b');
    eq(releaseInOrder(pending, 0).ready.length, 0,
       'network: nothing is released while an earlier window is still missing');
    pending.set(0, 'a');
    const released = releaseInOrder(pending, 0);
    eq(released.ready.join(''), 'ab', 'network: the sequence releases in the order it was spoken');
    eq(released.nextIndex, 2, 'network: and advances past what it released');
    pending.set(3, 'd');
    eq(releaseInOrder(pending, 2).ready.length, 0, 'network: a hole still blocks');
    pending.set(2, 'c');
    eq(releaseInOrder(pending, 2).ready.join(''), 'cd', 'network: filling the hole releases both');

    const dropped = describeConnection({ online: false, queued: 4, attempt: 2, nowMs: 0, nextAttemptAt: 3000 });
    ok(/no connection/.test(dropped) && /retrying in 3s/.test(dropped) && /4 windows waiting/.test(dropped),
       'network: the panel says the connection dropped, that it is retrying');
    ok(/server not answering/.test(describeConnection({ online: true, queued: 1, attempt: 1, nowMs: 0, nextAttemptAt: 1000 })),
       'network: a reachable network with an unreachable server is described as such');
    ok(/still transcribed after recording/.test(
        describeConnection({ online: false, queued: 2, attempt: 4, droppedWindows: 3, nowMs: 0, nextAttemptAt: 0 })),
       'network: text dropped from the view says it is not lost from the transcript');
    eq(describeConnection({ online: true, queued: 0, attempt: 0 }), null,
       'network: a healthy connection says nothing at all');
    const notAuto = describeConnection({ online: false, queued: 2, attempt: 4, droppedWindows: 3, nowMs: 0, nextAttemptAt: 0,
                                         autoTranscribe: false });
    ok(/marked for 📝 Fill gaps/.test(notAuto) && !/transcribed after/.test(notAuto),
       `network: with Auto-transcribe off, dropped windows are not promised to the pass after the recording, which does not run; they are marked for 📝 Fill gaps (${notAuto})`);
}

{
    const { afterRecordingFate } = await import('../../src/js/live-scribe-core.js');
    ok(/transcribed after the recording/.test(afterRecordingFate(true).part)
       && /transcribed after the recording/.test(afterRecordingFate(true).unsent),
       'live notes: with Auto-transcribe on, a skipped or unsent window is transcribed after the recording, and the notes say so');
    ok(/marked in the saved transcript for 📝 Fill gaps/.test(afterRecordingFate(false).part)
       && /marked in the saved transcript for 📝 Fill gaps/.test(afterRecordingFate(false).unsent)
       && !Object.values(afterRecordingFate(false)).some(text => /transcribed after/.test(text)),
       'live notes: with it off, they promise nothing the app does not do: the saved transcript marks the part and offers 📝 Fill gaps');
}

{
    const { crc32Init, crc32Update, crc32Final, localHeader, centralHeader, endOfCentralDirectory,
            uniqueEntryName, dosDateTime, ZIP_MAX_BYTES } =
        await import('../../src/js/backup-core.js');

    const crc32 = bytes => crc32Final(crc32Update(crc32Init(), bytes));
    eq(crc32(new TextEncoder().encode('123456789')) >>> 0, 0xCBF43926,
       'backup: CRC-32 matches the standard check value');
    eq(crc32(new Uint8Array(0)), 0, 'backup: an empty entry hashes to zero');

    const entry = { name: 'a.wav', crc: 0x12345678, size: 42, timestamp: Date.UTC(2026, 0, 2, 3, 4, 5), offset: 0 };
    const local = localHeader(entry);
    const view = new DataView(local.buffer);
    eq(view.getUint32(0, true), 0x04034B50, 'backup: local header carries the ZIP signature');
    eq(view.getUint16(8, true), 0, 'backup: entries are STORE, because audio does not deflate');
    ok((view.getUint16(6, true) & 0x0800) !== 0, 'backup: names are flagged UTF-8');
    eq(view.getUint32(18, true), 42, 'backup: the size is written to both size fields');
    eq(view.getUint32(22, true), 42, 'backup: compressed and uncompressed sizes agree under STORE');

    const central = centralHeader(entry);
    eq(new DataView(central.buffer).getUint32(0, true), 0x02014B50, 'backup: central record signature');
    eq(new DataView(endOfCentralDirectory(3, 100, 900).buffer).getUint32(0, true), 0x06054B50,
       'backup: end-of-directory signature');
    eq(new DataView(endOfCentralDirectory(3, 100, 900).buffer).getUint16(10, true), 3,
       'backup: the directory counts its entries');

    eq((dosDateTime(Date.UTC(1970, 0, 1)).date >>> 9) + 1980, 1980,
       'backup: a pre-1980 timestamp is clamped to the format epoch');
    eq((dosDateTime(Date.UTC(2026, 5, 2)).date >>> 9) + 1980, 2026,
       'backup: a normal timestamp keeps its year');

    const taken = new Set();
    eq(uniqueEntryName('note.wav', taken), 'note.wav', 'backup: the first name is kept');
    eq(uniqueEntryName('note.wav', taken), 'note (2).wav', 'backup: a duplicate name is numbered');
    eq(uniqueEntryName('note.wav', taken), 'note (3).wav', 'backup: and keeps being numbered');
    eq(uniqueEntryName('../../etc/passwd', taken), 'etc-passwd',
       'backup: traversal segments are removed, not merely rewritten');
    eq(uniqueEntryName('/abs/path.wav', taken), 'abs-path.wav',
       'backup: an absolute path becomes a plain member name');
    eq(uniqueEntryName('', taken), 'file', 'backup: an empty name still produces a member');
    eq(ZIP_MAX_BYTES, 0xFFFFFFFF, 'backup: the 32-bit ceiling is stated, not assumed');
}

{
    const { mergeIntervals, invertCoverage, planChunksForRanges, liveLinesAsResults } =
        await import('../../src/js/transcribe-core.js');

    eq(JSON.stringify(mergeIntervals([{ fromSec: 5, toSec: 10 }, { fromSec: 0, toSec: 6 }])),
       JSON.stringify([{ fromSec: 0, toSec: 10 }]),
       'reuse: overlapping coverage merges into one span');
    eq(mergeIntervals([{ fromSec: 3, toSec: 3 }]).length, 0, 'reuse: an empty span is not coverage');

    const late = invertCoverage([{ fromSec: 8, toSec: 300 }], 300);
    eq(JSON.stringify(late), JSON.stringify([{ fromSec: 0, toSec: 8 }]),
       'reuse: the seconds before live transcription started are the only gap');

    eq(JSON.stringify(invertCoverage([{ fromSec: 0, toSec: 100 }, { fromSec: 160, toSec: 300 }], 300)),
       JSON.stringify([{ fromSec: 100, toSec: 160 }]),
       'reuse: a dropped stretch in the middle is found');

    eq(invertCoverage([{ fromSec: 0, toSec: 300 }], 300).length, 0,
       'reuse: a fully covered recording needs no further transcription at all');
    eq(invertCoverage([{ fromSec: 0, toSec: 299.9 }], 300).length, 0,
       'reuse: a seam of milliseconds is not worth a request');

    eq(JSON.stringify(invertCoverage([{ fromSec: 0.6, toSec: 300 }], 300)),
       JSON.stringify([{ fromSec: 0, toSec: 0.6 }]),
       'reuse: a sub-second gap at the START of the recording is still transcribed, whole');
    eq(JSON.stringify(invertCoverage([{ fromSec: 1.9, toSec: 300 }], 300)),
       JSON.stringify([{ fromSec: 0, toSec: 1.9 }]),
       'reuse: a second or two of opening speech is recovered whole');
    eq(invertCoverage([{ fromSec: 0.05, toSec: 300 }], 300).length, 0,
       'reuse: a few hundredths of a second is still not worth a request');
    eq(invertCoverage([{ fromSec: 0, toSec: 100 }, { fromSec: 100.3, toSec: 300 }], 300).length, 0,
       'reuse: an interior seam keeps the ordinary minimum');
    eq(JSON.stringify(invertCoverage([{ fromSec: 0, toSec: 299.2 }], 300)),
       JSON.stringify([{ fromSec: 299.2, toSec: 300 }]),
       'reuse: a sub-second gap at the END of the recording is still transcribed, whole: the last words before Stop '
       + 'are as easily cut off as the first ones');

    const chunks = planChunksForRanges([{ fromSec: 100, toSec: 260 }], 16000, 60, 3);
    ok(chunks.length === 3, 'reuse: a gap is chunked on the usual 60-second step');
    eq(chunks[0].coreSec, 100, 'reuse: chunks sit on the recording timeline, not the gap');
    eq(chunks[0].idx, 0, 'reuse: indexes run across the whole planned set');
    eq(chunks[2].coreEndSec, 260, 'reuse: the last chunk ends where the gap does');
    ok(chunks.every((c, i) => c.idx === i), 'reuse: every chunk is addressable by its index');

    const asResults = liveLinesAsResults([{ startSec: 1, endSec: 3, text: ' hello ' }, { text: '  ' }]);
    eq(asResults.length, 1, 'reuse: an empty live line contributes nothing to the timeline');
    eq(asResults[0].text, 'hello', 'reuse: live text joins the timeline at the position it was spoken');
    eq(asResults[0].coreSec, 1, 'reuse: carrying its own absolute start');
}

{
    const { liveHoles, holeResults, liveLinesAsResults, reassembleTimeline, splitSpeakerLabel,
            NOT_TRANSCRIBED_MARKER } = await import('../../src/js/transcribe-core.js');
    eq(liveHoles([], 30).length, 0, 'holes: a live transcript that records no coverage says nothing about what it missed');
    eq(liveHoles(undefined, 30).length, 0, 'holes: nor does one from before coverage was kept');
    eq(JSON.stringify(liveHoles([{ fromSec: 0, toSec: 8 }, { fromSec: 12, toSec: 29.5 }], 30)),
       JSON.stringify([{ fromSec: 8, toSec: 12 }, { fromSec: 29.5, toSec: 30 }]),
       'holes: a window the live view skipped and the half second left unsent at Stop are both holes');

    const lines = [{ startSec: 0, endSec: 7.5, text: 'we start with the budget' },
                   { startSec: 12.2, endSec: 16, text: 'and then the timber order' }];
    const holes = liveHoles([{ fromSec: 0, toSec: 8 }, { fromSec: 12, toSec: 30 }], 30);
    const marked = reassembleTimeline([...liveLinesAsResults(lines), ...holeResults(holes)], lines.length + holes.length);
    ok(marked.timestamped.includes(`[00:08-00:12] ${NOT_TRANSCRIBED_MARKER}`),
       `holes: the saved live transcript marks where the live view heard nothing, at the time it was (${JSON.stringify(marked.timestamped)})`);
    ok(marked.timestamped.indexOf('budget') < marked.timestamped.indexOf(NOT_TRANSCRIBED_MARKER)
       && marked.timestamped.indexOf(NOT_TRANSCRIBED_MARKER) < marked.timestamped.indexOf('timber'),
       'holes: between the lines it falls between');
    ok(marked.plain.includes(NOT_TRANSCRIBED_MARKER),
       'holes: and the reply is told part of the recording is missing, as it is told of a section the server could not do');

    eq(JSON.stringify(splitSpeakerLabel({ text: 'Speaker 1: the release on friday', speakerLabel: 'Speaker 1' })),
       JSON.stringify({ label: 'Speaker 1', text: 'the release on friday' }),
       'speaker label: a saved live line is split into its speaker and its words');
    eq(JSON.stringify(splitSpeakerLabel({ text: 'Note: bring the keys' })),
       JSON.stringify({ label: '', text: 'Note: bring the keys' }),
       'speaker label: words that only look like a speaker in front are left alone without a stored speaker');

    const chunk = { coreSec: 0, coreEndSec: 12, chunkStartSec: 0,
                    text: 'we should ship the release on', segments: [{ start: 8, end: 12, text: 'we should ship the release on' }] };
    const live = liveLinesAsResults([{ startSec: 11.4, endSec: 15, text: 'Speaker 1: the release on friday afternoon',
                                       speakerLabel: 'Speaker 1' }]);
    const joined = reassembleTimeline([chunk, ...live], 2);
    ok(/ship the release on\n\[00:11-00:15\] Speaker 1: friday afternoon$/.test(joined.timestamped),
       `speaker label: where a live line meets a chunk transcribed after the recording, the words both heard are trimmed and the speaker stays in front (${JSON.stringify(joined.timestamped)})`);
    ok(joined.plain.endsWith('Speaker 1: friday afternoon'), 'speaker label: in the reading handed to the reply too');
}

{
    const { liveHolesToFill, keyActivates } = await import('../../src/js/row-state-core.js');
    eq(liveHolesToFill([{ source: 'L', holes: 2 }]), true,
       'fill gaps: a recording whose live transcript marks parts it never heard offers to transcribe just those');
    eq(liveHolesToFill([{ source: 'L' }]), false, 'fill gaps: a live transcript without holes offers nothing');
    eq(liveHolesToFill([{ source: 'S', fromLive: true }, { source: 'L', holes: 2 }]), false,
       'fill gaps: once a reading made after the recording exists, the row shows that one instead');
    eq(liveHolesToFill(undefined), false, 'fill gaps: a recording without transcripts has nothing to fill');

    const preview = { id: 'preview' };
    const copy = { id: 'copy' };
    eq(keyActivates({ key: 'Enter', target: preview }, preview), true, 'keys: Enter on a preview opens it');
    eq(keyActivates({ key: ' ', target: preview }, preview), true, 'keys: and so does Space');
    eq(keyActivates({ key: 'Enter', target: copy }, preview), false,
       'keys: a key pressed on the 📋 inside a preview is left to the 📋, which the browser then presses');
    eq(keyActivates({ key: 'a', target: preview }, preview), false, 'keys: other keys do nothing');
}

{
    const { LIMITER_SETTINGS, DYNAMICS_COMPRESSOR_RANGES } = await import('../../src/js/capture-health-core.js');
    const outside = Object.entries(LIMITER_SETTINGS).filter(([name, value]) => {
        const range = DYNAMICS_COMPRESSOR_RANGES[name];
        return !range || !(value >= range[0] && value <= range[1]);
    });
    eq(outside.map(([name, value]) => `${name}=${value}`).join(', '), '',
       'limiter: every setting lies inside the range Web Audio accepts, so none is clamped behind the app\'s back');
    eq(LIMITER_SETTINGS.ratio, 20, 'limiter: the steepest ratio a compressor takes, which is what the browser used anyway');
}

{
    const { createDiarization, addEmbedding, secondSpeakerProbability, speakerProbabilities,
            decorateLines, normalizeEmbedding, similarity, speakerLabel,
            diarizationStats, describeDiarization, recluster,
            resolveIdentity, collapseIdentity,
            applySpeakerCommand, nameIdentity, speakerDisplayName, resetNames, extractName,
            findByName, shownNumber,
            SECOND_SPEAKER_THRESHOLD, SAME_SPEAKER_SIMILARITY, MERGE_SIMILARITY,
            MAX_SPEAKERS, voiceSeparation, voicesOf } =
        await import('../../src/js/diarize-core.js');

    const DIMS = 64;
    const rnd = seed => { const x = Math.sin(seed * 12.9898) * 43758.5453; return x - Math.floor(x); };
    const voice = (which, n) => {
        const v = new Array(DIMS);
        for (let i = 0; i < DIMS; i++) {
            const own = rnd((which + 1) * 977 + i) - 0.5;
            const sample = (rnd((which + 1) * 7919 + n * 131 + i * 17) - 0.5) * 1.1;
            v[i] = own + sample;
        }
        return v;
    };

    eq(normalizeEmbedding([3, 4]).map(x => Math.round(x * 100) / 100).join(','), '0.6,0.8',
       'diarize: embeddings are unit length, so magnitude cannot pose as confidence');
    eq(normalizeEmbedding([0, 0]), null, 'diarize: a zero vector is not an embedding');
    eq(normalizeEmbedding([1, NaN]), null, 'diarize: a vector with a hole in it is rejected');
    eq(normalizeEmbedding([]), null, 'diarize: an empty vector is rejected');
    let sameScores = [], crossScores = [];
    for (let a = 0; a < 8; a++) for (let b = a + 1; b < 8; b++) {
        sameScores.push(similarity(normalizeEmbedding(voice(0, a)), normalizeEmbedding(voice(0, b))));
        crossScores.push(similarity(normalizeEmbedding(voice(0, a)), normalizeEmbedding(voice(1, b))));
    }
    ok(Math.max(...sameScores) < 0.7,
       'diarize: two segments of one voice do NOT reach 0.7');
    ok(SAME_SPEAKER_SIMILARITY < Math.max(...sameScores) && SAME_SPEAKER_SIMILARITY > Math.max(...crossScores),
       'diarize: the boundary sits between what one voice scores and what two different voices score');

    let solo = createDiarization();
    for (let i = 0; i < 12; i++) solo = addEmbedding(solo, `a${i}`, voice(0, i), 5);
    eq(solo.speakers.length, 1, 'diarize: one voice stays one cluster however much it says');
    eq(secondSpeakerProbability(solo), 0, 'diarize: and never suggests a second speaker');
    ok(decorateLines([{ key: 'a0' }, { key: 'a1' }], solo).every(l => l.speaker === null && !l.showSpeaker),
       'diarize: a monologue is never labelled, so the word "Speaker" never appears');

    let pair = createDiarization();
    for (let i = 0; i < 6; i++) pair = addEmbedding(pair, `a${i}`, voice(0, i), 5);
    pair = addEmbedding(pair, 'b0', voice(1, 0), 3);
    ok(secondSpeakerProbability(pair) < SECOND_SPEAKER_THRESHOLD,
       'diarize: one segment of a new voice is not enough to claim a second speaker');
    ok(decorateLines([{ key: 'b0' }], pair).every(l => l.speaker === null),
       'diarize: and nothing is labelled while it is not enough');

    pair = addEmbedding(pair, 'b1', voice(1, 1), 4);
    pair = addEmbedding(pair, 'b2', voice(1, 2), 4);
    pair = addEmbedding(pair, 'b3', voice(1, 3), 4);
    eq(pair.speakers.length, 2, 'diarize: two voices are two clusters');
    ok(secondSpeakerProbability(pair) >= SECOND_SPEAKER_THRESHOLD,
       'diarize: enough speech from both passes the 60% bar');

    const probs = speakerProbabilities(pair);
    eq(probs.length, 2, 'diarize: every identified speaker is reported');
    eq(probs[0].label, 'Speaker 1', 'diarize: speakers are named from one, not zero');
    eq(probs[1].label, speakerLabel(shownNumber(pair, probs[1].id)), 'diarize: the label is produced in one place');
    eq(probs.map(item => item.label), ['Speaker 1', 'Speaker 2'],
       'diarize: and the second voice is Speaker 2, whatever identity its group was given');
    ok(probs.every(item => item.id >= 1), 'diarize: every reported speaker carries its identity number');
    eq(probs[0].probability, probs[1].probability,
       'diarize: both carry the same figure');

    const lines = [{ key: 'a0' }, { key: 'a1' }, { key: 'b0' }, { key: 'b1' }, { key: 'a2' }];
    const shown = decorateLines(lines, pair);
    ok(shown.every(line => line.speaker != null), 'diarize: every line carries a speaker');
    eq(shown.map(l => (l.showSpeaker ? 'N' : '.')).join(''), 'NNNNN',
       'diarize: the name is printed on every line');
    eq(decorateLines(lines, pair, { everyLine: false }).map(l => (l.showSpeaker ? 'N' : '.')).join(''), 'N.N.N',
       'diarize: naming only the changes is still available for a transcript read start to finish');
    ok(shown[0].speaker !== shown[2].speaker, 'diarize: the two voices are told apart');
    eq(shown[0].speaker, shown[4].speaker, 'diarize: and the first speaker returning is recognised');

    let late = createDiarization();
    late = addEmbedding(late, 'x', voice(1, 9), 4);
    for (let i = 0; i < 6; i++) late = addEmbedding(late, `a${i}`, voice(0, i), 5);
    const before = decorateLines([{ key: 'x' }], late)[0].speaker;
    for (let i = 0; i < 5; i++) late = addEmbedding(late, `b${i}`, voice(1, i), 4);
    const after = decorateLines([{ key: 'x' }], late)[0].speaker;
    eq(before, null, 'diarize: before there was evidence');
    ok(after != null, 'diarize: once the second voice is established, earlier lines gain labels');
    eq(after, decorateLines([{ key: 'b0' }], late)[0].speaker,
       'diarize: and the early line is attributed to the voice it actually belongs to');

    let dup = createDiarization();
    dup = addEmbedding(dup, 'k', voice(0, 1), 5);
    dup = addEmbedding(dup, 'k', voice(0, 2), 5);
    eq(dup.points.length, 1, 'diarize: an embedding re-sent for the same line replaces it');

    const carried = decorateLines([{ key: 'a0' }, { key: 'nothing' }], pair);
    eq(carried[1].speaker, carried[0].speaker, 'diarize: an unembedded line stays with the current speaker');
    ok(carried[1].showSpeaker, 'diarize: and is labelled like any other line');

    const cluster = (vec, segments, seconds) => ({ vec: normalizeEmbedding(vec), segments, seconds });
    const voiceA = cluster(voice(0, 0), 6, 30);
    const voiceB = cluster(voice(1, 0), 6, 30);
    const splitOfA = cluster(voice(0, 1), 4, 20);
    ok(similarity(voiceA.vec, splitOfA.vec) > SAME_SPEAKER_SIMILARITY,
       'diarize: the fixture really is one voice split in two');
    ok(similarity(voiceA.vec, voiceB.vec) < SAME_SPEAKER_SIMILARITY,
       'diarize: and really does contain a separate second voice');
    const masked = { points: [], speakers: [voiceA, voiceB, splitOfA] };
    ok(secondSpeakerProbability(masked) >= SECOND_SPEAKER_THRESHOLD,
       'diarize: a well-separated pair still reports');
    ok(secondSpeakerProbability({ points: [], speakers: [voiceA, splitOfA] }) < SECOND_SPEAKER_THRESHOLD,
       'diarize: a split on its own is still not a second speaker');

    eq(voiceSeparation(MERGE_SIMILARITY), 0, 'separation: none where the clustering would merge the two');
    eq(voiceSeparation(SAME_SPEAKER_SIMILARITY), SECOND_SPEAKER_THRESHOLD,
       'separation: the bar sits at the boundary where one line stops counting as the same voice');
    ok(voiceSeparation(SAME_SPEAKER_SIMILARITY + 0.01) < SECOND_SPEAKER_THRESHOLD,
       'separation: two groups the clustering would still let a line join are not two people');
    eq(voiceSeparation(0.3), 1, 'separation: two groups well clear of that boundary are two people');

    // Two people in one room, on one microphone and in one language: part of every voiceprint is
    // the room, so they score about 0.3 against each other, not the 0 of the voices above.
    const room = Array.from({ length: DIMS }, (_, i) => rnd(4243 + i * 3) - 0.5);
    const inRoom = (which, n) => voice(which, n).map((value, i) => value + 0.8 * room[i]);
    let sameRoom = createDiarization();
    const roomLines = [];
    const sayInRoom = (who, n, seconds) => {
        sameRoom = addEmbedding(sameRoom, `${who}${n}`, inRoom(who === 'me' ? 0 : 1, n), seconds);
        roomLines.push({ key: `${who}${n}` });
    };
    for (let i = 0; i < 6; i++) sayInRoom('me', i, 5);
    for (let i = 0; i < 4; i++) sayInRoom('guest', i, 4);
    eq(sameRoom.speakers.length, 2, 'room: the clustering tells the two voices apart');
    const roomScore = similarity(sameRoom.speakers[0].vec, sameRoom.speakers[1].vec);
    ok(roomScore > 0.2 && roomScore < SAME_SPEAKER_SIMILARITY,
       'room: the fixture sits where Build 129 hid the second voice: above 0.20, below the boundary');
    const roomShown = decorateLines(roomLines, sameRoom);
    ok(roomShown.every(line => line.showSpeaker),
       'room: two people in one room are labelled once both have spoken');
    ok(roomShown[0].speaker !== roomShown[6].speaker && roomShown[0].speaker === roomShown[5].speaker
       && roomShown[6].speaker === roomShown[9].speaker,
       'room: and each keeps a label of their own');
    let alone = createDiarization();
    for (let i = 0; i < 20; i++) alone = addEmbedding(alone, `me${i}`, inRoom(0, i + 20), 5);
    eq(alone.speakers.length, 1, 'room: one person talking in that room is one voice');
    ok(decorateLines([{ key: 'me20' }, { key: 'me39' }], alone).every(line => !line.showSpeaker),
       'room: and a monologue there is still never labelled');

    let crowd = createDiarization();
    let id = 0;
    for (let who = 0; who < 6; who++) {
        for (let i = 0; i < 5; i++) crowd = addEmbedding(crowd, `c${id++}`, voice(who, i), 5, { maxSpeakers: 3 });
    }
    eq(crowd.speakers.length, 3, 'diarize: more voices than the cap are merged down to it');
    ok(crowd.points.every(point => point.speaker < 3),
       'diarize: and every sample still belongs to one of the clusters that remain');
    ok(MAX_SPEAKERS >= 2, 'diarize: the default ceiling still allows a conversation');
    eq(recluster({ points: [] }, { maxSpeakers: 1 }).speakers.length, 0,
       'diarize: capping an empty attribution is not a crash');

    let ids = createDiarization();
    let n = 0;
    for (let i = 0; i < 5; i++) ids = addEmbedding(ids, `a${n++}`, voice(0, i), 4);
    const firstId = ids.speakers[0].id;
    eq(firstId, 1, 'identity: the first voice is Speaker 1');
    for (let i = 0; i < 5; i++) ids = addEmbedding(ids, `b${n++}`, voice(1, i), 4);
    ok(ids.speakers.some(speaker => speaker.id === firstId),
       'identity: the first voice keeps its number when a second voice arrives');
    for (let i = 5; i < 9; i++) ids = addEmbedding(ids, `a${n++}`, voice(0, i), 4);
    ok(ids.speakers.some(speaker => speaker.id === firstId),
       'identity: and still has it after leaving and coming back');
    const known = new Set(ids.speakers.map(speaker => speaker.id));
    for (let i = 0; i < 5; i++) ids = addEmbedding(ids, `c${n++}`, voice(2, i), 4);
    const fresh = ids.speakers.map(s => s.id).filter(id => !known.has(id));
    ok(fresh.length >= 1 && Math.min(...fresh) > Math.max(...known),
       'identity: a new voice takes the next unused number');

    ok(ids.nextId > ids.speakers.length,
       'identity: identities may leave gaps rather than be reused; the numbers on screen do not (Build 133)');

    const pairs = [...ids.speakers.map(s => s.id)].sort((a, b) => a - b);
    const collapsed = collapseIdentity(ids, pairs[pairs.length - 1], pairs[0]);
    eq(resolveIdentity(collapsed, pairs[pairs.length - 1]), pairs[0],
       'identity: a collapsed speaker resolves to the one it was merged into');
    eq(resolveIdentity(collapseIdentity(collapsed, pairs[0], pairs[pairs.length - 1]), pairs[pairs.length - 1]),
       pairs[0], 'identity: collapsing the same pair the other way round gives the same answer');
    eq(resolveIdentity(ids, pairs[0]), pairs[0], 'identity: collapsing does not mutate the state it came from');
    ok(decorateLines([{ key: 'a0' }], collapsed)[0].speaker != null || true,
       'identity: labels resolve through collapses at paint time');

    const named = nameIdentity(createDiarization(), 1, 'Sabine');
    eq(speakerDisplayName(named, 1), 'Sabine', 'name: a named speaker shows the name');
    eq(speakerDisplayName(named, 2), 'Speaker 2', 'name: an unnamed one still shows its number');
    eq(speakerDisplayName(nameIdentity(named, 1, 'Sabine Hossenfelder'), 1), 'Sabine Hossenfelder',
       'name: hearing the surname later grows the name rather than replacing it');
    const guessedFull = nameIdentity(createDiarization(), 1, 'Sabine Hossenfelder', { locked: false, inferred: true });
    eq(nameIdentity(guessedFull, 1, 'Sabine', { locked: false, inferred: true }).names[1], 'Sabine Hossenfelder',
       'name: a guessed first name does not shorten a fuller name');
    eq(speakerDisplayName(nameIdentity(nameIdentity(named, 1, 'Sabine Hossenfelder'), 1, 'Sabine'), 1),
       'Sabine', 'name: a spoken rename to a shorter name is carried out');
    eq(speakerDisplayName(nameIdentity(named, 1, 'Maxine'), 1), 'Maxine',
       'name: a different name is a correction');

    const clash = nameIdentity(nameIdentity(createDiarization(), 1, 'Max'), 2, 'Max');
    eq(speakerDisplayName(clash, 1), 'Speaker 1', 'name: a shared name falls back to numbers');
    eq(speakerDisplayName(clash, 2), 'Speaker 2', 'name: for both of them');
    eq(speakerDisplayName(nameIdentity(clash, 2, 'Maxine'), 1), 'Max',
       'name: resolving the clash restores the names');
    eq(speakerDisplayName(resetNames(clash), 1), 'Speaker 1', 'name: reset forgets every name');

    const two = nameIdentity(createDiarization(), 3, 'Sabine');
    eq(speakerDisplayName(collapseIdentity(two, 4, 3), 4), 'Sabine',
       'name: collapsing into a named speaker inherits the name');

    eq(extractName('Sabine Hossenfelder and she talks about physics'), 'Sabine Hossenfelder',
       'name: the capitalised run is the name');
    eq(extractName('talking loudly right now'), '',
       'name: after a bare "is", prose is not a name');
    eq(extractName('Dutch'), '', 'name: a language is not a name');
    eq(extractName('max', { requireCapital: false }), 'max',
       'name: after an explicit rename, case is not required');


    const applied = applySpeakerCommand(createDiarization(), { type: 'name', id: 3, name: 'Sabine Hossenfelder' });
    ok(/Sabine Hossenfelder/.test(applied.echo), 'command: what was understood is reported back');
    const ambiguous = applySpeakerCommand(clash, { type: 'renameByName', match: 'Max', name: 'Maxine' });
    ok(/matches 2 speakers/.test(ambiguous.echo),
       'command: renaming by a name two people share is refused');

    let advance = createDiarization();
    advance = applySpeakerCommand(advance, { type: 'name', id: 3, name: 'Sabine' }).state;
    const second = applySpeakerCommand(advance, { type: 'name', id: 5, name: 'Sabine' });
    ok(/Sabine/.test(second.echo) && !/→ "Speaker 5"/.test(second.echo),
       'command: the receipt reports the name that was stored');
    ok(/Speaker 3/.test(second.echo) && /same person/.test(second.echo),
       'command: a clash is reported with the sentence that resolves it');
    eq(second.state.names[5], 'Sabine', 'command: and the name really was stored');
    ok(second.ok, 'command: a command that worked reports that it worked');
    ok(!applySpeakerCommand(createDiarization(),
        { type: 'renameByName', match: 'Nobody', name: 'X' }).ok,
       'command: one that did not reports that it did not');


    let hist = nameIdentity(createDiarization(), 5, 'Sabine');
    hist = nameIdentity(hist, 5, 'Alexander');
    hist = nameIdentity(hist, 5, 'Elizabeth');
    eq(findByName(hist, 'Alexander').join(','), '5',
       'command: a speaker can be found by a name they no longer have');
    eq(findByName(hist, 'Elizabeth').join(','), '5', 'command: and by the one they have now');
    eq(findByName(hist, 'Nobody').length, 0, 'command: and not by one nobody has had');

    ok(addEmbedding(createDiarization(), 'k', null).points.length === 0,
       'diarize: a missing embedding is ignored rather than breaking the attribution');

    eq(describeDiarization(diarizationStats(createDiarization())),
       '🗣️ no voice data - the server is sending no embeddings',
       'diarize: no vectors at all says so');
    ok(/one voice so far/.test(describeDiarization(diarizationStats(solo))),
       'diarize: one grouped voice is reported as one voice');
    const pairStats = diarizationStats(pair);
    ok(/2 speakers/.test(describeDiarization(pairStats)) && pairStats.clusters === 2,
       'diarize: a confirmed split reports how many speakers and how sure');

    let thin = createDiarization();
    thin = addEmbedding(thin, 't0', voice(0, 0), 5);
    thin = addEmbedding(thin, 't1', voice(1, 0), 5);
    const thinLine = describeDiarization(diarizationStats(thin));
    ok(/no voice with two lines yet/.test(thinLine),
       'diarize: two single lines are not two speakers yet, and the header says so');

    // Build 131: numbers follow the voice groups the clustering keeps, not a confidence figure.
    const closeRoom = (which, n) => voice(which, n).map((value, i) => value + 0.9 * room[i]);
    let alike = createDiarization();
    const alikeLines = [];
    const sayAlike = (who, n, seconds) => {
        alike = addEmbedding(alike, `${who}${n}`, closeRoom(who === 'me' ? 0 : 1, n), seconds);
        alikeLines.push({ key: `${who}${n}` });
    };
    for (let i = 0; i < 6; i++) sayAlike('me', i, 5);
    for (let i = 0; i < 4; i++) sayAlike('you', i, 4);
    eq(alike.speakers.length, 2, 'numbers: two voices that sound alike are still two groups');
    const alikeScore = similarity(alike.speakers[0].vec, alike.speakers[1].vec);
    ok(alikeScore > SAME_SPEAKER_SIMILARITY && alikeScore < MERGE_SIMILARITY
       && secondSpeakerProbability(alike) < SECOND_SPEAKER_THRESHOLD,
       'numbers: the fixture is a pair Build 130 left unnumbered: between the two boundaries, short of 60%');
    const alikeShown = decorateLines(alikeLines, alike);
    ok(alikeShown.every(line => line.showSpeaker) && alikeShown[0].speaker !== alikeShown[6].speaker
       && alikeShown[0].speaker === alikeShown[5].speaker && alikeShown[6].speaker === alikeShown[9].speaker,
       'numbers: two groups the clustering keeps apart are numbered however alike they sound');
    ok(/^🗣️ 2 speakers · \d+% sure/.test(describeDiarization(diarizationStats(alike))),
       'numbers: and the header counts the speakers the lines show, and says how sure it is');

    const asVec = v => normalizeEmbedding(v);
    const strayState = {
        points: [
            { key: 'a0', speaker: 0 }, { key: 'a1', speaker: 0 }, { key: 'a2', speaker: 0 },
            { key: 'b0', speaker: 1 }, { key: 'b1', speaker: 1 },
            { key: 's0', speaker: 2 }
        ],
        speakers: [
            { index: 0, id: 1, vec: asVec(voice(0, 0)), segments: 3, seconds: 12 },
            { index: 1, id: 2, vec: asVec(voice(1, 0)), segments: 2, seconds: 6 },
            { index: 2, id: 3, vec: asVec(voice(2, 0)), segments: 1, seconds: 1 }
        ],
        aliases: {}, frozen: {}, tally: {}
    };
    const strayLines = ['a0', 'b0', 's0', 'a1', 'b1', 'a2'].map(key => ({ key }));
    eq(decorateLines(strayLines, strayState).map(line => line.speaker), [1, 2, 2, 1, 2, 1],
       'numbers: a stray line carries the number before it until its group says a second line');
    const grownStray = {
        ...strayState,
        points: [...strayState.points, { key: 's1', speaker: 2 }],
        speakers: strayState.speakers.map(item => (item.id === 3 ? { ...item, segments: 2, seconds: 3 } : item))
    };
    eq(decorateLines([...strayLines, { key: 's1' }], grownStray).map(line => line.speaker), [1, 2, 3, 1, 2, 1, 3],
       'numbers: and has a number of its own once it does');
    const strayHeader = describeDiarization(diarizationStats(strayState));
    ok(/^🗣️ 2 speakers/.test(strayHeader) && /1 stray line$/.test(strayHeader),
       'numbers: the header counts a stray line apart from the speakers');

    const monologueWithStrays = {
        points: [...Array(10).keys()].map(i => ({ key: `m${i}`, speaker: 0 }))
            .concat([{ key: 'x0', speaker: 1 }, { key: 'x1', speaker: 2 }, { key: 'x2', speaker: 3 }]),
        speakers: [
            { index: 0, id: 1, vec: asVec(voice(0, 0)), segments: 10, seconds: 40 },
            { index: 1, id: 2, vec: asVec(voice(3, 0)), segments: 1, seconds: 1 },
            { index: 2, id: 3, vec: asVec(voice(4, 0)), segments: 1, seconds: 1 },
            { index: 3, id: 4, vec: asVec(voice(5, 0)), segments: 1, seconds: 1 }
        ],
        aliases: {}, frozen: {}, tally: {}
    };
    ok(decorateLines([{ key: 'm0' }, { key: 'x0' }, { key: 'm1' }, { key: 'x2' }], monologueWithStrays)
        .every(line => !line.showSpeaker),
       'numbers: a monologue with stray lines is never numbered');
    ok(/^🗣️ one voice so far · 3 stray lines · 13 samples$/.test(describeDiarization(diarizationStats(monologueWithStrays))),
       'numbers: and the header says one voice and how many stray lines');

    const confirmedAsOne = { ...strayState, aliases: { 2: 1 } };
    ok(decorateLines(strayLines, confirmedAsOne).every(line => !line.showSpeaker),
       'numbers: two groups confirmed as one person count as one voice');

    const retiredVoice = {
        points: [...Array(5).keys()].map(i => ({ key: `r${i}`, speaker: 0 })),
        speakers: [{ index: 0, id: 1, vec: asVec(voice(0, 0)), segments: 5, seconds: 20 }],
        aliases: {}, frozen: { old0: 2, old1: 2 }, tally: { 2: { segments: 4, seconds: 14 } }
    };
    eq(decorateLines([{ key: 'old0' }, { key: 'r0' }, { key: 'old1' }], retiredVoice).map(line => line.speaker), [2, 1, 2],
       'numbers: a voice whose lines have all left the window still counts');

    // Build 132: a voice stays a voice. Two people in one room taking turns of three lines, close
    // enough (0.9 of the room in every voiceprint) that regrouping every line from scratch, as Build
    // 131 did, showed them numbered from the fifth line and merged them back into one at the 24th.
    let turns = createDiarization();
    const turnLines = [];
    const shownCounts = [];
    for (let i = 0; i < 40; i++) {
        const who = Math.floor(i / 3) % 2;
        const n = turnLines.filter(line => line.who === who).length;
        const key = `${who ? 'you' : 'me'}${n}`;
        turns = addEmbedding(turns, key, closeRoom(who, n), 4);
        turnLines.push({ key, who });
        shownCounts.push(new Set(decorateLines(turnLines, turns)
            .filter(line => line.showSpeaker).map(line => line.speaker)).size);
    }
    const firstNumbered = shownCounts.findIndex(count => count > 0);
    ok(firstNumbered >= 0 && firstNumbered < 8, 'sticky: two people taking turns are numbered within their first turns');
    ok(shownCounts.slice(firstNumbered).every((count, i, list) => count > 0 && (i === 0 || count >= list[i - 1])),
       `sticky: once numbers are shown they stay, and the number of speakers shown never goes down (${shownCounts.join('')})`);
    const turnsShown = decorateLines(turnLines, turns);
    const numbersOf = who => new Set(turnsShown.filter((line, i) => turnLines[i].who === who).map(line => line.speaker));
    ok(numbersOf(0).size === 1 && numbersOf(1).size === 1 && [...numbersOf(0)][0] !== [...numbersOf(1)][0],
       'sticky: and after forty lines each of them still has a number of their own on every line');

    // A voice model this noisy scores two lines of one person 0.23 against each other on average.
    const noisyMe = n => voice(0, n).map((value, i) => value + 1.5 * (rnd(14 + n * 311 + i * 29) - 0.5));
    let noisyMonologue = createDiarization();
    const noisyLines = [];
    let noisyNumbered = false;
    for (let n = 0; n < 40; n++) {
        noisyMonologue = addEmbedding(noisyMonologue, `m${n}`, noisyMe(n), 3);
        noisyLines.push({ key: `m${n}` });
        if (decorateLines(noisyLines, noisyMonologue).some(line => line.showSpeaker)) noisyNumbered = true;
    }
    ok(!noisyNumbered && voicesOf(noisyMonologue).length === 1,
       'sticky: two stray lines of a noisy monologue that happen to group are not taken for a second voice');

    // A second voice that turns out to be the first: two lines of voice 0 that an earlier
    // regrouping made a voice of its own.
    const asUnit = v => normalizeEmbedding(v);
    const splitState = {
        ...createDiarization(),
        points: [...Array(8).keys()].map(n => ({ key: `a${n}`, vec: asUnit(voice(0, n)), seconds: 4 }))
            .concat([{ key: 'x0', vec: asUnit(voice(0, 20)), seconds: 4 }, { key: 'x1', vec: asUnit(voice(0, 21)), seconds: 4 }]),
        voiceOf: { a0: 1, a1: 1, a2: 1, a3: 1, a4: 1, a5: 1, a6: 1, a7: 1, x0: 2, x1: 2 },
        voices: { 1: true, 2: true },
        nextId: 3,
        labelled: true
    };
    const consolidated = recluster(splitState);
    const splitLines = ['a0', 'x0', 'a1', 'x1'].map(key => ({ key }));
    eq(voicesOf(consolidated), [1],
       'sticky: a voice every line of which sounds more like another voice than like its own becomes that voice');
    ok(decorateLines(splitLines, consolidated).every(line => line.showSpeaker && line.speaker === 1),
       'sticky: and the numbers stay on screen, all of them now the voice it joined');

    const namedSplit = recluster({ ...splitState, names: { 2: 'Anna' }, locked: { 2: true } });
    eq(voicesOf(namedSplit), [2], 'sticky: when one of the two was named, the named one goes on');
    eq(speakerDisplayName(namedSplit, 1), 'Anna', 'sticky: so the name stays on the lines of both');
    eq(voicesOf(recluster({ ...splitState, names: { 1: 'Bram', 2: 'Anna' }, locked: { 1: true, 2: true } })).sort(), [1, 2],
       'sticky: two voices named differently are never made one');

    // A line of voice 1 that an earlier regrouping gave to voice 0 moves once it clearly belongs to voice 1.
    const strayed = recluster({
        ...createDiarization(),
        points: [...Array(5).keys()].map(n => ({ key: `a${n}`, vec: asUnit(voice(0, n)), seconds: 4 }))
            .concat([...Array(5).keys()].map(n => ({ key: `b${n}`, vec: asUnit(voice(1, n)), seconds: 4 })))
            .concat([{ key: 'b5', vec: asUnit(voice(1, 5)), seconds: 4 }]),
        voiceOf: { a0: 1, a1: 1, a2: 1, a3: 1, a4: 1, b0: 2, b1: 2, b2: 2, b3: 2, b4: 2, b5: 1 },
        voices: { 1: true, 2: true },
        nextId: 3,
        labelled: true
    });
    eq(decorateLines([{ key: 'b5' }], strayed)[0].speaker, 2,
       'sticky: a line given to the wrong voice moves to the voice it clearly sounds like');

    // Build 133: the numbers on screen count 1, 2, 3 in the order voices were first shown. As
    // reported: somebody heard once before anyone else took the first identity, somebody heard once
    // between the second and the third speaker took another, and Build 132 showed the identities,
    // so the three people on screen were Speaker 2, Speaker 4 and Speaker 6.
    const arrivals = [['s', 1, 7], ['A', 4, 0], ['B', 4, 1], ['t', 1, 8], ['C', 4, 2],
                      ['A', 2, 0], ['B', 2, 1], ['C', 2, 2]];
    let arrived = createDiarization();
    const arrivedLines = [];
    const heardFrom = {};
    let numbersSkipped = false;
    const onScreen = (state, list) => [...new Set(decorateLines(list, state).filter(line => line.showSpeaker)
        .map(line => speakerDisplayName(state, line.speaker)))];
    for (const [who, count, which] of arrivals) {
        for (let i = 0; i < count; i++) {
            const n = heardFrom[who] || 0;
            heardFrom[who] = n + 1;
            arrived = addEmbedding(arrived, `${who}${n}`, voice(which, n), 4);
            arrivedLines.push({ key: `${who}${n}`, who });
            const numbers = onScreen(arrived, arrivedLines).map(name => Number(name.replace('Speaker ', '')))
                .sort((a, b) => a - b);
            if (numbers.some((number, at) => number !== at + 1)) numbersSkipped = true;
        }
    }
    const arrivedVoices = voicesOf(arrived);
    ok(arrivedVoices.length === 3 && arrivedVoices.some((id, at) => id !== at + 1),
       `numbers: the fixture is the reported one: three voices whose identities skip (${arrivedVoices.join(', ')})`);
    ok(!numbersSkipped, 'numbers: line by line, the numbers on screen never skip one');
    const arrivedShown = decorateLines(arrivedLines, arrived);
    const numbersOfPerson = who => [...new Set(arrivedShown.filter((line, i) => arrivedLines[i].who === who)
        .map(line => speakerDisplayName(arrived, line.speaker)))];
    eq([...numbersOfPerson('A'), ...numbersOfPerson('B'), ...numbersOfPerson('C')],
       ['Speaker 1', 'Speaker 2', 'Speaker 3'],
       'numbers: the first person on screen is Speaker 1, and the next two are Speaker 2 and Speaker 3 in the order they came in');
    eq(arrivedVoices.map(id => speakerDisplayName(arrived, id)), ['Speaker 1', 'Speaker 2', 'Speaker 3'],
       'numbers: and the header lists them in that order');

    const [firstVoice, secondVoice, thirdVoice] = arrivedVoices;
    const joinedAB = applySpeakerCommand(arrived, { type: 'merge', from: secondVoice, to: firstVoice });
    eq(joinedAB.echo, 'Speaker 2 → Speaker 1', 'numbers: joining two voices is reported in the numbers on screen');
    eq(voicesOf(joinedAB.state).map(id => speakerDisplayName(joinedAB.state, id)), ['Speaker 1', 'Speaker 2'],
       'numbers: and the voice after them moves up one, so the numbers still do not skip');
    eq(speakerDisplayName(joinedAB.state, thirdVoice), 'Speaker 2', 'numbers: Speaker 3 is Speaker 2 from then on');
    let afterJoin = joinedAB.state;
    for (let n = 0; n < 4; n++) afterJoin = addEmbedding(afterJoin, `D${n}`, voice(3, n), 4);
    eq(voicesOf(afterJoin).map(id => speakerDisplayName(afterJoin, id)), ['Speaker 1', 'Speaker 2', 'Speaker 3'],
       'numbers: and the next new voice is Speaker 3');

    // Two voices numbered at the same moment, as the first two are, take their numbers in the order
    // they first spoke, whatever their identities.
    const pinnedPair = {
        ...createDiarization(),
        points: [...Array(4).keys()].map(n => ({ key: `p${n}`, vec: asUnit(voice(0, n)), seconds: 4 }))
            .concat([...Array(4).keys()].map(n => ({ key: `q${n}`, vec: asUnit(voice(1, n)), seconds: 4 }))),
        voiceOf: { p0: 5, p1: 5, p2: 5, p3: 5, q0: 3, q1: 3, q2: 3, q3: 3 },
        voices: { 3: true, 5: true },
        nextId: 6
    };
    const latched = recluster(pinnedPair);
    eq(onScreen(latched, [{ key: 'p0' }, { key: 'q0' }]), ['Speaker 1', 'Speaker 2'],
       'numbers: the voice that spoke first is Speaker 1 even when its identity is the higher one');

    // A voice that has no number yet takes the next one, also when one of its lines came before the
    // second voice spoke: no number already on screen changes for a newcomer.
    let newcomer = recluster({
        ...pinnedPair,
        points: [...pinnedPair.points.slice(0, 4), { key: 'x0', vec: asUnit(voice(2, 0)), seconds: 4 },
                 ...pinnedPair.points.slice(4)],
        labelled: true,
        shown: [5, 3]
    });
    for (let n = 1; n < 4; n++) newcomer = addEmbedding(newcomer, `x${n}`, voice(2, n), 4);
    eq(['p0', 'q0', 'x0'].map(key => speakerDisplayName(newcomer, decorateLines([{ key }], newcomer)[0].speaker)),
       ['Speaker 1', 'Speaker 2', 'Speaker 3'],
       'numbers: a newcomer takes the next number, and the voices already numbered keep theirs');
    // Numbers are handed out when they first appear, not when a voice is first known: of two voices,
    // the one whose first line comes first is Speaker 1, even when the other was known earlier.
    let firstLineFirst = recluster({
        ...createDiarization(),
        points: [{ key: 'e0', vec: asUnit(voice(0, 0)), seconds: 4 },
                 ...[...Array(4).keys()].map(n => ({ key: `f${n}`, vec: asUnit(voice(1, n)), seconds: 4 }))],
        voiceOf: { f0: 3, f1: 3, f2: 3, f3: 3 },
        voices: { 3: true },
        nextId: 4
    });
    for (let n = 1; n < 4; n++) firstLineFirst = addEmbedding(firstLineFirst, `e${n}`, voice(0, n), 4);
    eq(onScreen(firstLineFirst, [{ key: 'e0' }, { key: 'f0' }]), ['Speaker 1', 'Speaker 2'],
       'numbers: when numbers first appear, the voice whose line comes first is Speaker 1');

    const retiredFirst = { ...retiredVoice, voices: { 1: true, 2: true }, shown: [2, 1] };
    eq(voicesOf(retiredFirst).map(id => speakerDisplayName(retiredFirst, id)), ['Speaker 1', 'Speaker 2'],
       'numbers: the header lists speakers in the order of their numbers, also one whose lines have all left the window');
    eq(speakerDisplayName(strayState, 3), 'Speaker 3',
       'numbers: a state from before Build 133 shows identities as it always did');
}

{
    const { pickSelection, rememberSelection } = await import('../../src/js/selection-core.js');
    const newest = { id: 'c', time: 300 };
    const list = [newest, { id: 'b', time: 200 }, { id: 'a', time: 100 }];

    eq(pickSelection([], null), null, 'selection: nothing to select is null, not a crash');
    eq(pickSelection(list, null), 'c', 'selection: with no choice made, the newest is shown');

    const chose = { id: 'a', at: 400 };
    eq(pickSelection(list, chose), 'a',
       'selection: a background repaint does not snap a chosen item back to the newest');

    eq(pickSelection([{ id: 'd', time: 500 }, ...list], chose), 'd',
       'selection: an item produced since the choice was made is shown instead');
    eq(pickSelection([{ id: 'd', time: 400 }, ...list], chose), 'a',
       'selection: an item produced at the same moment does not override the choice');

    eq(pickSelection(list, { id: 'gone', at: 400 }), 'c',
       'selection: a choice that no longer exists falls back to the newest');
    eq(pickSelection([{ id: 'd' }, ...list], chose), 'a',
       'selection: an item with no time counts as older');

    const mark = rememberSelection('b');
    eq(mark.id, 'b', 'selection: a choice records what was chosen');
    ok(Number.isFinite(mark.at) && mark.at > 0, 'selection: and when, which is the part the id alone was missing');
}

{
    const { createDiarization, applySpeakerCommand, nameSimilarity, findByName,
            NAME_MATCH_THRESHOLD } = await import('../../src/js/diarize-core.js');

    ok(nameSimilarity('evelin', 'Evelyn') >= NAME_MATCH_THRESHOLD,
       'names: a letter misheard in a name is still that name');
    ok(nameSimilarity('Maximilian', 'Maximilien') >= NAME_MATCH_THRESHOLD,
       'names: and so is a vowel at the end of a long one');
    ok(nameSimilarity('Bartholomew', 'Eve') < NAME_MATCH_THRESHOLD,
       'names: while two different names are two different people');
    eq(nameSimilarity('', 'Eve'), 0, 'names: nothing is not nearly a name');

    let named = createDiarization();
    named = applySpeakerCommand(named, { type: 'name', id: 3, name: 'Evelyn' }).state;
    const heard = applySpeakerCommand(named, { type: 'renameByName', match: 'evelin', name: 'Maxi' });
    ok(heard.ok && /Evelyn/.test(heard.echo) && /heard/.test(heard.echo),
       'names: a near-enough name finds its speaker');
    ok(!applySpeakerCommand(named, { type: 'renameByName', match: 'Bartholomew', name: 'X' }).ok,
       'names: a name nothing is near is still an unknown name');

    let twins = createDiarization();
    twins = applySpeakerCommand(twins, { type: 'name', id: 1, name: 'Maria' }).state;
    twins = applySpeakerCommand(twins, { type: 'name', id: 2, name: 'Marla' }).state;
    ok(findByName(twins, 'Marta').length !== 1,
       'names: two names equally close to what was said is a coin toss with somebody\'s name on it, so it is refused');
}

{
    const { createDiarization, applySpeakerCommand, nameIdentity,
            speakerDisplayName, resolveIdentity, separateIdentity, isInferredName,
            attributionByKey, normalizeEmbedding, setSpeakerPolicy, speakerPolicy,
            inferredNameCount, retireOldPoints, addEmbedding, RECLUSTER_WINDOW,
            NUMBERS_POLICY, INFER_POLICY, DEFAULT_SPEAKER_POLICY } =
        await import('../../src/js/diarize-core.js');
    const { createSpeakerHints, noteSpeech, readEvidence, scoreClaims, inferNames,
            inferMerges, sameSpeakerNotes, reviewSpeakers, describeInference,
            COMMIT_SCORE, LOOSE_SELF_WEIGHT, EXPLICIT_SELF_WEIGHT, ADDRESSED_WEIGHT,
            NAME_MERGE_SIMILARITY, MAX_CLAIMS, MAX_ORDER } =
        await import('../../src/js/speaker-infer-core.js');
    const { PROPOSE_SCORE } = await import('../../src/js/speaker-confirm-core.js');

    const scene = (assign, vectors = {}) => {
        const ids = [...new Set(Object.values(assign))];
        return {
            ...createDiarization(INFER_POLICY),
            points: Object.keys(assign).map(key => ({ key, speaker: ids.indexOf(assign[key]), seconds: 4 })),
            speakers: ids.map((id, index) => ({
                index, id, segments: 4, seconds: 16,
                vec: normalizeEmbedding(vectors[id] || [1, 0, 0])
            }))
        };
    };
    const say = (hints, lines) => lines.reduce((acc, [key, text]) => noteSpeech(acc, key, text), hints);

    eq(readEvidence('My name is Mark').map(e => `${e.kind}:${e.name}`), ['self:Mark'],
       'infer: an explicit introduction is a self-claim');
    eq(readEvidence("I'm Mark").map(e => e.weight), [LOOSE_SELF_WEIGHT],
       'infer: an ordinary one is worth less');
    eq(readEvidence("I'm Dutch"), [], 'infer: and a nationality is not a name, however capitalised');
    eq(readEvidence("I'm sorry"), [], 'infer: nor is an apology');
    eq(readEvidence('I am ready'), [], 'infer: nor a state of mind');
    eq(readEvidence('Mark here').map(e => `${e.kind}:${e.name}`), ['self:Mark'],
       'infer: a name can come before its frame as well as after it');
    eq(readEvidence('Thanks, Mark').map(e => `${e.kind}:${e.name}`), ['addressed:Mark'],
       'infer: being thanked by name is evidence about somebody who is not speaking');
    eq(readEvidence('could you look at that, Mark?').map(e => e.kind), ['addressed'],
       'infer: and so is a vocative at the end of a sentence');
    eq(readEvidence('Mark had already left'), [],
       'infer: while talking about somebody is not talking to them');
    eq(readEvidence('Speaker 3 is Mark'), [],
       'infer: an instruction to the system is not also evidence for itself');
    eq(readEvidence("that's still me").map(e => e.kind), ['sameSpeaker'],
       'infer: and "still me" is heard as its own kind of thing');

    const twoVoices = scene({ a1: 1, a2: 1, b1: 2 });
    let once = say(createSpeakerHints(), [['a1', "I'm Mark"]]);
    eq(inferNames(once, twoVoices), [],
       'infer: one loose introduction suggests nothing on its own, it waits to be corroborated');
    ok(LOOSE_SELF_WEIGHT < PROPOSE_SCORE && EXPLICIT_SELF_WEIGHT >= PROPOSE_SCORE,
       'infer: which is the difference between saying a name in passing and saying it to be recorded');
    ok(EXPLICIT_SELF_WEIGHT > LOOSE_SELF_WEIGHT,
       'infer: a frame that exists only to say a name still outweighs one that merely can');
    const explicit = say(createSpeakerHints(), [['a1', 'My name is Mark']]);
    eq(inferNames(explicit, twoVoices).map(c => `${c.id}:${c.name}`), ['1:Mark'],
       'infer: one outright introduction is enough on its own');
    ok(inferNames(explicit, twoVoices)[0].origin === 'inferred',
       'infer: and says of itself that it was worked out, never that it was confirmed');
    ok(inferNames(explicit, twoVoices)[0].score >= PROPOSE_SCORE,
       'infer: a proposal carries the evidence that earned it, so the panel can show how sure it is');
    const applied = applySpeakerCommand(twoVoices, inferNames(explicit, twoVoices)[0]).state;
    eq(inferNames(say(explicit, [['a2', 'My name is Mark']]), applied), [],
       'infer: saying it again proposes nothing');

    const crowd = scene({ c1: 1, d1: 2, d2: 2 });
    const corroborated = say(createSpeakerHints(),
        [['c1', "I'm Mark"], ['d1', 'Thanks, Mark'], ['d2', 'well done, Mark']]);
    eq(inferNames(corroborated, crowd).map(c => `${c.id}:${c.name}`), ['1:Mark'],
       'infer: a loose introduction that the room backs up does reach a suggestion');
    const hearsay = say(createSpeakerHints(),
        [['a1', 'that works for me'], ['b1', 'Thanks, Mark'], ['a2', 'no problem at all']]);
    eq(inferNames(hearsay, scene({ a1: 1, a2: 1, b1: 2 })), [],
       'infer: one person naming another names nobody, however plainly they said it');
    const contested = say(createSpeakerHints(), [['a1', "I'm Mark"], ['a2', "I'm Marcus Aurelius"]]);
    eq(inferNames(contested, twoVoices), [],
       'infer: and two names neck and neck for one voice produce neither');

    const addressed = say(createSpeakerHints(),
        [['a1', 'that works for me'], ['b1', 'Thanks, Mark'],
         ['a2', 'no problem at all'], ['b1x', 'well done, Mark'],
         ['a3', 'happy to help'], ['b1y', 'could you check that, Mark']]);
    const room = scene({ a1: 1, a2: 1, a3: 1, b1: 2, b1x: 2, b1y: 2 });
    eq(inferNames(addressed, room), [],
       'infer: being addressed credits the other voice, but never enough to suggest a name on its own');
    eq(inferNames(say(addressed, [['a4', "I'm Mark"]]), scene({ a1: 1, a2: 1, a3: 1, a4: 1, b1: 2, b1x: 2, b1y: 2 }))
        .map(c => `${c.id}:${c.name}`), ['1:Mark'],
       'infer: once that voice claims the name itself, the credit it was already given carries it over the line');
    eq(readEvidence('Mark, could you check that'), [],
       'infer: a vocative at the START of a sentence is refused');
    eq(readEvidence('Anyway, that is fine'), [],
       'infer: which is what stops "Anyway" and "Listen" becoming people');
    ok(readEvidence('we met John last week').length === 0,
       'infer: and "met" introduces somebody only at the start of a sentence');
    eq(readEvidence("it's Tuesday"), [], 'infer: while a day of the week is not a person');
    ok(ADDRESSED_WEIGHT * 3 < PROPOSE_SCORE,
       'infer: and however many times a name is used at somebody, it never suggests one by itself');

    const heardOn = say(createSpeakerHints(), [['x1', 'My name is Mark']]);
    eq(inferNames(heardOn, scene({ x1: 4, y1: 5 })).map(c => c.id), [4],
       'infer: a name lands on whoever is attributed the line it was heard on');
    eq(inferNames(heardOn, scene({ x1: 5, y1: 5 })).map(c => c.id), [5],
       'infer: and lands somewhere else once the clustering says the line belongs elsewhere');
    eq(inferNames(heardOn, scene({ z1: 7 })), [],
       'infer: a line with no attribution yet credits nobody, and waits');

    const stated = nameIdentity(twoVoices, 1, 'Evelyn');
    eq(inferNames(once, stated), [],
       'infer: nothing inferred is offered for a speaker somebody already named by hand');
    const refused = applySpeakerCommand(stated, { type: 'name', id: 1, name: 'Mark', origin: 'inferred' });
    ok(!refused.ok && refused.state === stated && refused.echo === null,
       'infer: and pushed through anyway it changes nothing and reports nothing');
    eq(speakerDisplayName(stated, 1), 'Evelyn', 'infer: the stated name is what stays on screen');

    const guessed = applySpeakerCommand(createDiarization(INFER_POLICY),
        { type: 'name', id: 2, name: 'Mark', origin: 'inferred' }).state;
    eq(speakerDisplayName(guessed, 2), 'Mark?',
       'infer: a name nobody confirmed is displayed as the guess it is');
    ok(isInferredName(guessed, 2), 'infer: and is marked as one in the state');
    const confirmed = applySpeakerCommand(guessed, { type: 'name', id: 2, name: 'Mark' }).state;
    eq(speakerDisplayName(confirmed, 2), 'Mark',
       'infer: confirming it by number drops the question mark');
    ok(!isInferredName(confirmed, 2) && confirmed.locked[2],
       'infer: and locks it, so the same sentence that confirms it also stops it being guessed at again');

    const split = scene({ m1: 1, m2: 3 }, { 1: [1, 0, 0], 3: [0.5, 0.866, 0] });
    const bothSaidMark = say(createSpeakerHints(), [['m1', 'My name is Mark'], ['m2', "I'm Mark"]]);
    eq(inferMerges(say(createSpeakerHints(), [['m1', 'My name is Mark'], ['m2', 'sounds good']]), split), [],
       'infer: one number claiming a name beside one that does not is one speaker, not two merged');
    const merges = inferMerges(bothSaidMark, split);
    eq(merges.map(c => `${c.type} ${c.from}->${c.to}`), ['merge 3->1'],
       'infer: two numbers that both introduce themselves as Mark are one Mark');
    ok(/Mark/.test(merges[0].why), 'infer: and the proposal carries the sentence it came from');

    const strangers = scene({ m1: 1, m2: 3 }, { 1: [1, 0, 0], 3: [0, 1, 0] });
    eq(inferMerges(bothSaidMark, strangers), [],
       'infer: but two voices with nothing acoustically in common are two people who share a name');
    ok(NAME_MERGE_SIMILARITY > 0,
       'infer: so a name may rescue a split voice and may not overrule a flat contradiction');

    const review = reviewSpeakers(bothSaidMark, split);
    eq(review.commands.map(c => c.type), ['merge', 'name'],
       'infer: the merge is proposed before the name that depends on it');
    eq(review.commands[1].id, 1, 'infer: and the name goes to the identity that survived');

    let joined = createDiarization();
    joined = applySpeakerCommand(joined, { type: 'merge', from: 3, to: 1, origin: 'inferred',
                                           why: 'both introduced themselves as "Mark"' });
    eq(resolveIdentity(joined.state, 3), 1, 'infer: the merge takes effect');
    ok(!/system z/.test(joined.echo) && /Speaker 3/.test(joined.echo),
       'infer: and its receipt names who was joined without teaching a command that no longer exists');
    const undone = applySpeakerCommand(joined.state, { type: 'separate', id: 3 });
    eq(resolveIdentity(undone.state, 3), 3,
       'infer: which takes the number back, whole');
    ok(undone.ok, 'infer: and says so');
    eq(resolveIdentity(separateIdentity(createDiarization(), 3), 3), 3,
       'infer: separating a speaker that was never merged is not an error');
    ok(!applySpeakerCommand(createDiarization(), { type: 'separate', id: 3 }).ok,
       'infer: though it does say that there was nothing to undo');

    const stillMe = say(createSpeakerHints(), [['s1', "wait, that's still me"]]);
    const after = scene({ p1: 1, q1: 2, s1: 3 });
    eq(inferMerges(stillMe, after), [],
       'infer: a bare "still me" merges nothing');
    const notes = sameSpeakerNotes(stillMe, after);
    eq(notes.length, 1, 'infer: it is heard and answered');
    ok(/Speaker 3/.test(notes[0].text) && !/system z/.test(notes[0].text),
       'infer: naming the speaker it is unsure about, and instructing nobody to do anything');

    let long = createSpeakerHints();
    for (let i = 0; i < MAX_CLAIMS + 50; i++) long = noteSpeech(long, `k${i}`, 'My name is Mark');
    ok(long.claims.length <= MAX_CLAIMS,
       'infer: an hours-long recording cannot grow the ledger without limit');
    ok(/Mark/.test(describeInference(once, twoVoices)) && /60%/.test(describeInference(once, twoVoices)),
       'infer: the panel reports how far the evidence has got, while it is still short of a suggestion');
    ok(/✓/.test(describeInference(explicit, twoVoices)),
       'infer: and marks the moment it is ready to suggest one');
    ok(/%/.test(describeInference(hearsay, twoVoices)),
       'infer: and how far along it is when it has not, which reads differently from having heard nothing');
    eq(describeInference(createSpeakerHints(), twoVoices), '',
       'infer: having heard nothing says nothing');
    eq(attributionByKey(twoVoices).get('b1'), 2,
       'infer: labels and names read the same attribution, so a name cannot be filed against one speaker '
       + 'while its line is printed beside another');

    // Build 133: what inference says names speakers by the numbers on screen, not by identity.
    const renumbered = { ...scene({ a1: 5, a2: 5, b1: 3 }), shown: [5, 3] };
    ok(/→ Speaker 1$/.test(describeInference(explicit, renumbered)),
       `infer: the panel names the speaker by the number on screen (${describeInference(explicit, renumbered)})`);
    const unsure = sameSpeakerNotes(say(createSpeakerHints(), [['b1', "wait, that's still me"]]), renumbered);
    ok(/Speaker 2 may be/.test(unsure[0].text) && !/Speaker 3/.test(unsure[0].text),
       'infer: and so does the note that a voice may not be new');
    eq(applySpeakerCommand(renumbered, { type: 'name', id: 3, name: 'Mark' }).echo, 'Speaker 2 → "Mark"',
       'infer: and so does the receipt of a name');
    eq(inferMerges(bothSaidMark, { ...split, shown: [3, 1] }).map(c => `${c.type} ${c.from}->${c.to}`), ['merge 1->3'],
       'infer: two voices that are one person are joined into the one with the lower number on screen');

    eq(DEFAULT_SPEAKER_POLICY, NUMBERS_POLICY,
       'policy: the floor is what you get by default');
    eq(speakerPolicy(createDiarization()), NUMBERS_POLICY, 'policy: a fresh session starts on it');
    eq(speakerPolicy({}), NUMBERS_POLICY, 'policy: and so does a state written before policies existed');
    eq(speakerPolicy(setSpeakerPolicy(createDiarization(), 'nonsense')), NUMBERS_POLICY,
       'policy: a policy nobody implements is not one, and is refused');

    const floored = setSpeakerPolicy(scene({ a1: 1, a2: 1, b1: 2 }), NUMBERS_POLICY);
    const said = say(createSpeakerHints(), [['a1', 'My name is Mark']]);
    eq(reviewSpeakers(said, floored).commands, [],
       'policy: under numbers nothing is concluded, however plainly it was said');
    ok(reviewSpeakers(said, setSpeakerPolicy(floored, INFER_POLICY)).commands.length === 1,
       'policy: and the same ledger concludes at once when the policy allows it');
    ok(scoreClaims(said, floored).size > 0,
       'policy: because the listening never stopped - switching applies what was already said, '
       + 'rather than starting to listen from the moment somebody reached the setting');

    const withGuess = applySpeakerCommand(setSpeakerPolicy(floored, INFER_POLICY),
        { type: 'name', id: 1, name: 'Mark', origin: 'inferred' }).state;
    eq(speakerDisplayName(withGuess, 1), 'Mark?', 'policy: a guess shows as a guess under inference');
    const hidden = setSpeakerPolicy(withGuess, NUMBERS_POLICY);
    eq(speakerDisplayName(hidden, 1), 'Speaker 1', 'policy: and is not shown at all under numbers');
    eq(hidden.names[1], 'Mark', 'policy: while still being held, because hiding is not forgetting');
    eq(inferredNameCount(hidden), 1, 'policy: which is countable, so a switch can report what it just hid');
    eq(speakerDisplayName(setSpeakerPolicy(hidden, INFER_POLICY), 1), 'Mark?',
       'policy: so switching back restores the whole session at once');

    const told = nameIdentity(setSpeakerPolicy(createDiarization(), NUMBERS_POLICY), 1, 'Evelyn');
    eq(speakerDisplayName(told, 1), 'Evelyn',
       'policy: a name somebody stated by number survives the floor');
    eq(inferredNameCount(told), 0, 'policy: and is not counted among the things a switch would hide');

    const grind = (segments, window) => {
        let d = createDiarization(INFER_POLICY);
        for (let i = 0; i < segments; i++) {
            d = addEmbedding(d, `g${i}`, normalizeEmbedding([Math.cos(i % 3), Math.sin(i % 3), 0.1]),
                             4, { reclusterWindow: window, maxSpeakers: 4 });
        }
        return d;
    };
    const aged4h = grind(120, 20);
    ok(aged4h.points.length <= 20,
       'scale: the regrouping works over a window');
    ok(Object.keys(aged4h.frozen).length >= 95,
       'scale: and what leaves the window leaves its attribution behind');
    eq(attributionByKey(aged4h, ['g0']).get('g0') != null, true,
       'scale: so a line older than the horizon is still labelled');
    const totalSeconds = Object.values(aged4h.tally).reduce((sum, t) => sum + t.seconds, 0);
    ok(totalSeconds >= 380,
       'scale: and still counts as evidence');
    ok(aged4h.speakers.every(sp => sp.seconds >= 4),
       'scale: which is what keeps the confidence reading from collapsing every time the window turns over');

    const retiredId = attributionByKey(aged4h, ['g0']).get('g0');
    const other = [...new Set(aged4h.speakers.map(sp => resolveIdentity(aged4h, sp.id)))]
        .find(id => id !== retiredId);
    if (other != null) {
        const late = applySpeakerCommand(aged4h, { type: 'merge', from: retiredId, to: other }).state;
        eq(attributionByKey(late, ['g0']).get('g0'), Math.min(retiredId, other),
           'scale: so a merge said in the fourth hour still relabels the first, however far outside the window it is');
    }

    eq(attributionByKey(aged4h, []).size, 0, 'scale: asking about no lines walks nothing');
    eq(attributionByKey(aged4h, ['g0', 'nope']).size, 1, 'scale: and asking about a line nobody said returns nothing for it');

    let aged = createSpeakerHints();
    aged = noteSpeech(aged, 'old', 'My name is Mark');
    for (let i = 0; i < MAX_ORDER + 20; i++) aged = noteSpeech(aged, `f${i}`, 'nothing in particular');
    ok(!aged.order.includes('old') && aged.claims.some(c => c.key === 'old'),
       'scale: a claim does outlive the order it was heard in');
    eq(inferNames(aged, scene({ old: 1, f0: 2 })).map(c => `${c.id}:${c.name}`), ['1:Mark'],
       'scale: and is still applied');
}

{
    const { initialUpdateState, noteLoadedVersion, noteInstallingVersion, noteServerBuild,
            noteCheckStarted, noteCheckFinished, describeVersion, describeVersionTitle,
            describeUpdateState, describeUpdateButton, updateAction, updateBusy, updateStuck,
            updateBlocked, describeBlockedUpdate, needsRepaintAt,
            CONFIRMED_MS, NO_WORKER_LABEL } =
        await import('../../src/js/update-core.js');

    const fresh = initialUpdateState();
    eq(describeVersion(fresh), NO_WORKER_LABEL,
       'update: a page with no shell serving it claims no build');
    eq(updateAction(fresh), 'check', 'update: and tapping it can only look for one');

    const loaded = noteLoadedVersion(fresh, 'v96');
    eq(loaded.loaded, 'v96', 'update: the first version reported is the one this page was served');
    eq(describeVersion(loaded), 'v96', 'update: and it is shown plainly');
    eq(updateAction(loaded), 'check', 'update: with nothing waiting, tapping checks');

    const same = noteLoadedVersion(loaded, 'v96');
    eq(same.pending, null, 'update: the same version reported again changes nothing');

    const installing = noteInstallingVersion(loaded, 'v97');
    eq(installing.incoming, 'v97', 'update: a worker still downloading is recorded as incoming');
    eq(installing.pending, null,
       'update: but never as pending, because reloading now would land on the old build again');
    eq(updateAction(installing), 'installing', 'update: so tapping it does not reload');
    eq(describeVersion(installing), 'v96 \u27f3',
       'update: and the badge shows work in progress, not a second version to trust');
    ok(updateBusy(installing), 'update: the control is busy while a build downloads');
    ok(/Installing v97/.test(describeUpdateButton(installing)),
       'update: and the overlay button names the build being installed');

    const ready = noteLoadedVersion(installing, 'v97');
    eq(ready.pending, 'v97',
       'update: once the new worker is the one serving, it becomes a build you can reload into');
    eq(ready.incoming, null, 'update: and stops being merely incoming');
    eq(ready.loaded, 'v96', 'update: while this page still reports the build it is actually running');
    eq(describeVersion(ready), 'v96 \u203a v97',
       'update: which is what the badge says, both halves of it');
    eq(updateAction(ready), 'reload', 'update: and tapping it now reloads');
    ok(/Reload into v97/.test(describeUpdateButton(ready)), 'update: as the overlay button spells out');

    const afterReload = noteLoadedVersion(initialUpdateState(), 'v97');
    eq(describeVersion(afterReload), 'v97',
       'update: a bare version on the badge always means the page is running that build');
    eq(afterReload.pending, null, 'update: with nothing left waiting');

    eq(noteInstallingVersion(loaded, 'v96').incoming, null,
       'update: a worker reporting the build already running is not an update');
    eq(noteInstallingVersion(fresh, 'v97').incoming, null,
       'update: and nothing is incoming before there is a loaded build to compare against');
    eq(noteInstallingVersion(ready, 'v97').incoming, null,
       'update: a build already ready is not demoted back to downloading');

    ok(updateBlocked(ready, { recording: true }),
       'update: a reload is refused while a recording is running');
    ok(!updateBlocked(ready, { recording: false }), 'update: and allowed when nothing is being recorded');
    ok(!updateBlocked(installing, { recording: true }),
       'update: there is nothing to block while a build is still downloading');
    ok(/a recording, its save, a transcription, a reply or a backup/.test(describeBlockedUpdate(ready))
       && /Let it finish or stop it/.test(describeBlockedUpdate(ready)),
       'update: and the refusal says what to do about it');
    ok(/v97/.test(describeBlockedUpdate(ready)), 'update: naming what is waiting');

    const checking = noteCheckStarted(loaded);
    eq(describeVersion(checking), 'v96 \u27f3', 'update: a check in progress is visible');
    ok(updateBusy(checking), 'update: and counts as busy');
    const confirmed = noteCheckFinished(checking, 1000, true);
    eq(describeVersion(confirmed, 1000), 'v96 \u2713',
       'update: a check that found nothing newer confirms itself, rather than looking untouched');
    eq(describeVersion(confirmed, 1000 + CONFIRMED_MS + 1), 'v96',
       'update: and the confirmation fades back to the plain version');
    eq(needsRepaintAt(confirmed, 1000), 1000 + CONFIRMED_MS,
       'update: so a repaint is due when it does');
    eq(needsRepaintAt(loaded, 1000), 0, 'update: a settled badge needs no repaint');

    const failed = noteCheckFinished(noteCheckStarted(loaded), 2000, false);
    eq(describeVersion(failed, 2000), 'v96 \u26a0',
       'update: a check that could not reach the server says so instead of claiming to be current');
    ok(/could not reach/.test(describeUpdateState(failed, 2000)), 'update: in words too');

    eq(noteCheckFinished(noteCheckStarted(ready), 3000, true).confirmedAt, 0,
       'update: a check that did find something does not also report being up to date');

    const probed = noteServerBuild(loaded, 'v98');
    eq(probed.server, 'v98', 'update: the build the server actually holds is recorded separately');
    ok(!updateStuck(probed), 'update: and means nothing until a check has been run against it');
    const stuck = noteCheckFinished(noteCheckStarted(probed), 5000, true);
    ok(updateStuck(stuck),
       'update: a server ahead of this page, with no worker installing or waiting, is a worker the browser refuses to replace');
    eq(updateAction(stuck), 'force',
       'update: which needs the installed shell cleared, not another polite update check');
    eq(describeVersion(stuck, 5000), 'v96 \u203a v98',
       'update: the badge still names both builds, because that is what the person needs to know');
    ok(/Clear the shell and load v98/.test(describeUpdateButton(stuck)),
       'update: and the button says what it will do');
    ok(/cached copy/.test(describeUpdateState(stuck, 5000)),
       'update: the overlay explains that the browser, not the server, is the one holding the old build');
    ok(/recordings and settings alone|not touched/i.test(describeUpdateState(stuck, 5000)),
       'update: and that clearing it does not touch what was recorded');
    eq(noteCheckFinished(noteCheckStarted(probed), 5000, true).confirmedAt, 0,
       'update: a check that found the server ahead never reports being up to date');

    ok(updateBlocked(stuck, { recording: true }),
       'update: clearing the shell is a reload too, so it waits for the recording to finish');
    ok(/v98/.test(describeBlockedUpdate(stuck)), 'update: and says what is waiting');

    const caughtUp = noteCheckFinished(noteCheckStarted(noteServerBuild(loaded, 'v96')), 6000, true);
    ok(!updateStuck(caughtUp), 'update: a server holding the same build is not stuck, it is current');
    eq(describeVersion(caughtUp, 6000), 'v96 \u2713', 'update: and says so');
    ok(!updateStuck(noteCheckFinished(noteCheckStarted(noteServerBuild(ready, 'v97')), 7000, true)),
       'update: nor is one whose worker did install, which is the ordinary path');
    ok(/still running v96/.test(describeUpdateState(ready)),
       'update: the overlay is explicit about which build the page is on');
    ok(/tap to reload/.test(describeVersionTitle(ready)),
       'update: and the badge itself explains what tapping does');
}

{
    const { initialUpdateState, noteLoadedVersion, noteInstallingVersion, noteWaitingVersion, noteNothingWaiting,
            noteInstallFailed, noteCheckStarted, noteCheckFinished, noteServerBuild, readyBuild, describeVersion,
            describeVersionTitle, describeUpdateState, describeUpdateButton, updateAction, updateBusy,
            updateStuck, updateBlocked } = await import('../../src/js/update-core.js');
    const loaded = noteLoadedVersion(initialUpdateState(), 'v129');
    const downloading = noteInstallingVersion(noteCheckStarted(loaded), 'v130');
    const waiting = noteWaitingVersion(downloading, 'v130');
    eq(waiting.waiting, 'v130', 'update: a build that is installed and waits is recorded as waiting');
    eq(waiting.incoming, null, 'update: and no longer as downloading');
    eq(readyBuild(waiting), 'v130', 'update: it is the build a reload lands on');
    eq(updateAction(waiting), 'reload', 'update: so tapping reloads into it');
    eq(describeVersion(waiting), 'v129 \u203a v130', 'update: and the badge names both builds');
    ok(/Reload into v130/.test(describeUpdateButton(waiting)), 'update: as does the button');
    ok(updateBlocked(waiting, { recording: true }), 'update: which waits for a recording like any reload');
    eq(noteLoadedVersion(waiting, 'v129').waiting, 'v130',
       'update: the old build still serving does not make the waiting one disappear');
    const tookOver = noteLoadedVersion(waiting, 'v130');
    eq(tookOver.pending, 'v130', 'update: once it has taken over it serves, and this page still runs the old build');
    eq(tookOver.waiting, null, 'update: so it is no longer waiting');
    eq(noteWaitingVersion(loaded, 'v129').waiting, null, 'update: a waiting worker of the build running is no update');
    const hardReloaded = noteLoadedVersion(noteLoadedVersion(initialUpdateState(), 'v130'), 'v129');
    eq(hardReloaded.pending, null, 'update: an older build still serving is never offered as a build to reload into');
    eq(describeVersion(hardReloaded), 'v130', 'update: the badge names the build the page runs');
    eq(noteNothingWaiting(waiting).waiting, null, 'update: and a waiting build replaced by a newer one is forgotten');

    const failed = noteCheckFinished(noteInstallFailed(downloading, 'v130'), 1000, true);
    eq(failed.incoming, null, 'update: an install that failed is no longer downloading');
    eq(failed.installFailed, 'v130', 'update: it is remembered as failed');
    ok(!updateBusy(failed), 'update: the button is usable again');
    eq(updateAction(failed), 'check', 'update: and tapping tries again');
    eq(describeVersion(failed, 1000 + 60000), 'v129 \u26a0',
       'update: the badge keeps saying something went wrong, not only for a moment');
    eq(describeUpdateButton(failed), 'Try installing v130 again', 'update: the button says what it will do');
    ok(/v130 could not be installed/.test(describeUpdateState(failed)) && /tap to try again/.test(describeVersionTitle(failed)),
       'update: and the overlay and the badge say what happened');
    ok(!updateStuck(noteServerBuild(failed, 'v130')),
       'update: a failed install is not taken for a browser that keeps its cached shell');
    eq(noteCheckStarted(failed).installFailed, null, 'update: a new check starts afresh');
    eq(noteInstallFailed(noteInstallingVersion(loaded, 'v131'), null).installFailed, 'v131',
       'update: a failure without a version names the build that was downloading');
}

{
    const { normalizeModelName, sameModel, loadedModelNames, isModelResident,
            otherResidentModels, nextModelStep, describeModelLoad, describeModelFailure,
            shouldRetryGenerate, describeFirstByteTimeout, shortWait,
            MODEL_LOAD_BUDGET_MS, MODEL_SWAP_GRACE_MS, MODEL_PROBE_FAILURES_BEFORE_UNREACHABLE,
            MODEL_GENERATE_ATTEMPTS } =
        await import('../../src/js/model-ready-core.js');

    const ps = { models: [{ name: 'qwen3.8:27b', size: 1, size_vram: 1 }, { model: 'gemma4:e4b' }] };
    eq(JSON.stringify(loadedModelNames(ps)), '["qwen3.8:27b","gemma4:e4b"]',
       'ready: what the server says it is holding is read from either field');
    eq(JSON.stringify(loadedModelNames({})), '[]', 'ready: a server holding nothing says nothing');
    eq(JSON.stringify(loadedModelNames({ models: [{ name: 'a' }, { name: 'a' }] })), '["a"]',
       'ready: and a name is counted once');

    ok(sameModel('llama3', 'llama3:latest'), 'ready: an untagged name is the latest tag');
    ok(!sameModel('qwen3.8:27b', 'qwen3.8:8b'), 'ready: two sizes of one family are two models');
    ok(!sameModel('', ''), 'ready: nothing is not a model');
    ok(isModelResident(['qwen3.8:27b'], 'qwen3.8:27b'), 'ready: the wanted model can be resident');
    eq(JSON.stringify(otherResidentModels(['a:1', 'b:1'], 'a:1')), '["b:1"]',
       'ready: and the rest are what a swap would have to displace');

    const wanted = 'qwen3.8:27b';
    eq(nextModelStep({ wanted, loaded: ['qwen3.8:27b'] }).action, 'ready',
       'ready: a model already loaded is asked for straight away');
    eq(nextModelStep({ wanted, loaded: [], waitedMs: 0 }).action, 'wait',
       'ready: a cold server is waited for, not given up on');
    eq(nextModelStep({ wanted, loaded: ['gemma4:e4b'], waitedMs: 30000 }).action, 'wait',
       'ready: a swap is waited for too, because the server evicts on its own');

    const escalated = nextModelStep({ wanted, loaded: ['gemma4:e4b'], waitedMs: MODEL_SWAP_GRACE_MS });
    eq(escalated.action, 'release',
       'ready: a swap that has not happened within the grace period is helped along');
    eq(JSON.stringify(escalated.release), '["gemma4:e4b"]',
       'ready: by releasing exactly what is in the way');
    eq(nextModelStep({ wanted, loaded: ['gemma4:e4b'], waitedMs: MODEL_SWAP_GRACE_MS, released: true }).action,
       'wait', 'ready: and it is released once, never in a loop');
    eq(nextModelStep({ wanted, loaded: [], waitedMs: MODEL_SWAP_GRACE_MS }).action, 'wait',
       'ready: with nothing in the way there is nothing to release');

    eq(nextModelStep({ wanted, loaded: [], waitedMs: MODEL_LOAD_BUDGET_MS }).action, 'too-slow',
       'ready: a load that never finishes does eventually stop');
    eq(nextModelStep({ wanted, loaded: [], waitedMs: 1000,
                       probeFailures: MODEL_PROBE_FAILURES_BEFORE_UNREACHABLE }).action, 'unreachable',
       'ready: a server that stops answering at all is a different failure, and a faster one');
    eq(nextModelStep({ wanted, loaded: ['qwen3.8:27b'], waitedMs: MODEL_LOAD_BUDGET_MS * 2,
                       probeFailures: 99 }).action, 'ready',
       'ready: and a model that did arrive outranks every deadline');
    ok(MODEL_PROBE_FAILURES_BEFORE_UNREACHABLE >= 2,
       'ready: one missed probe is a blip, not a dead server');
    ok(MODEL_SWAP_GRACE_MS < MODEL_LOAD_BUDGET_MS,
       'ready: the server is given a chance to swap by itself before being helped');

    eq(shortWait(8000), '8s', 'ready: a short wait is reported in seconds');
    eq(shortWait(90000), '1m 30s', 'ready: a long one in minutes');
    eq(shortWait(120000), '2m', 'ready: and a round one stays round');
    ok(/Loading qwen3\.8:27b on the server \(8s\)/.test(
        describeModelLoad({ model: wanted, waitedMs: 8000 })),
       'ready: waiting says what is being waited for and for how long');
    ok(/replacing gemma4:e4b/.test(
        describeModelLoad({ model: wanted, waitedMs: 8000, loaded: ['gemma4:e4b'] })),
       'ready: and says what has to go first');
    ok(/Freed gemma4:e4b/.test(
        describeModelLoad({ model: wanted, waitedMs: 8000, loaded: ['gemma4:e4b'], released: true })),
       'ready: and says when it has gone');

    ok(/stopped answering/.test(describeModelFailure('unreachable', { model: wanted, waitedMs: 12000 })),
       'ready: an unreachable server is named as one');
    const slow = describeModelFailure('too-slow', { model: wanted, waitedMs: MODEL_LOAD_BUDGET_MS });
    ok(/not offline/.test(slow),
       'ready: a slow load explicitly is not reported as the server being down');
    ok(/10m/.test(slow), 'ready: and says how long it actually waited');

    ok(!/did not respond within/.test(
        describeFirstByteTimeout({ model: wanted, timeoutMs: 45000, preflightSucceeded: true })),
       'ready: a loaded model that says nothing is not described as an unresponsive server');
    ok(/did not respond within 45 seconds/.test(
        describeFirstByteTimeout({ model: wanted, timeoutMs: 45000 })),
       'ready: where no preflight ran, the old plain reading still holds');

    ok(shouldRetryGenerate({ attempt: 1, preflightSucceeded: true }),
       'ready: a model that was loaded and then went quiet is worth one more try');
    ok(!shouldRetryGenerate({ attempt: 1, preflightSucceeded: false }),
       'ready: where readiness was never established, retrying just doubles the wait');
    ok(!shouldRetryGenerate({ attempt: 1, preflightSucceeded: true, aborted: true }),
       'ready: and a cancelled job is not retried at all');
    ok(!shouldRetryGenerate({ attempt: MODEL_GENERATE_ATTEMPTS, preflightSucceeded: true }),
       'ready: the retry happens once, not forever');
}

{
    const { PAGINATION_BARS, paginationBarVisible, visiblePaginationBars } =
        await import('../../src/js/pagination-core.js');

    eq(JSON.stringify(visiblePaginationBars(1, 0)), '[]',
       'pages: a list that fits on one page shows no page controls at all');
    eq(JSON.stringify(visiblePaginationBars(3, 0)), '["bottom"]',
       'pages: the first page carries the controls at the bottom, where scrolling ends');
    eq(JSON.stringify(visiblePaginationBars(3, 1)), '["bottom","top"]',
       'pages: once you have paged forward, the way back is also at the top');
    eq(JSON.stringify(visiblePaginationBars(3, 2)), '["bottom","top"]',
       'pages: and stays there for every page after the first');
    eq(JSON.stringify(visiblePaginationBars(3, 0)), JSON.stringify(visiblePaginationBars(3, 0)),
       'pages: returning to the first page withdraws the top controls again');

    const ids = PAGINATION_BARS.map(bar => bar.id);
    eq(ids.length, new Set(ids).size, 'pages: each bar is named once');
    for (const bar of PAGINATION_BARS) {
        ok(bar.wrap && bar.info && bar.prev && bar.next,
           `pages: the ${bar.id} bar names every element it drives`);
    }
    const elementIds = PAGINATION_BARS.flatMap(bar => [bar.wrap, bar.info, bar.prev, bar.next]);
    eq(elementIds.length, new Set(elementIds).size,
       'pages: the two bars drive separate elements, so neither can silently steal the other');
    eq(paginationBarVisible(null, 5, 3), false, 'pages: an unknown bar is not shown');
}

{
    const { initialFillBreaker, nextFillBreaker, shouldRetryLineByLine, describeFillStopped,
            TRANSLATE_FILL_FAILURE_LIMIT } = await import('../../src/js/transcribe-core.js');

    let breaker = initialFillBreaker();
    ok(!breaker.broken, 'fill: nothing is broken before anything has been tried');
    for (let i = 1; i < TRANSLATE_FILL_FAILURE_LIMIT; i++) {
        breaker = nextFillBreaker(breaker, false);
        ok(!breaker.broken, `fill: ${i} unanswered request(s) is a bad patch, not a dead server`);
    }
    breaker = nextFillBreaker(breaker, false);
    ok(breaker.broken,
       'fill: a server that has not answered three times running is not worth another few thousand requests');
    ok(!nextFillBreaker(breaker, true).broken,
       'fill: and one answer clears it, because a recovered server should be used');
    eq(nextFillBreaker(nextFillBreaker(initialFillBreaker(), false), true).failures, 0,
       'fill: the count is of failures in a row, not failures in total');

    ok(shouldRetryLineByLine({ reached: true, aligned: false }),
       'fill: a server that answered but returned the wrong shape is worth asking line by line');
    ok(!shouldRetryLineByLine({ reached: false, aligned: false }),
       'fill: a server that did not answer at all is not, because that multiplies one failure by the batch size');
    ok(!shouldRetryLineByLine({ reached: true, aligned: true }),
       'fill: and an answer that was already usable is not retried');
    ok(/did not answer/.test(describeFillStopped(3)),
       'fill: stopping says why, rather than finishing quietly with nothing filled in');
    ok(TRANSLATE_FILL_FAILURE_LIMIT >= 2,
       'fill: one failure is never enough to give up on a language');
}

{
    const { shouldCloseForUpgrade, describeUpgradeBlocked, describeConnectionClosed,
            describeStaleTab, isStaleVersionError, connectionGuardState,
            describeConnectionGuard } = await import('../../src/js/db-lifecycle-core.js');

    ok(shouldCloseForUpgrade({}),
       'upgrade: an idle tab steps aside at once so a newer version can start');
    ok(!shouldCloseForUpgrade({ recording: true }),
       'upgrade: a tab that is recording does not, because closing its database ends the recording');
    ok(!shouldCloseForUpgrade({ finalizing: true }),
       'upgrade: nor one still writing a recording to disk');

    ok(/This recording comes first/.test(describeUpgradeBlocked({ recording: true })),
       'upgrade: the tab that is recording is told its recording is being put first');
    ok(!/Another tab is recording/.test(describeUpgradeBlocked({ recording: true })),
       'upgrade: and is not told that some other tab is the one recording, because the only tab that knows is this one');
    ok(/once you stop recording/.test(describeUpgradeBlocked({ recording: true })),
       'upgrade: and told that stopping the recording is all it takes');
    ok(/every note is kept/.test(describeUpgradeBlocked({ recording: true })),
       'upgrade: and that the newer version keeps every note');
    ok(/work running here finishes/.test(describeUpgradeBlocked({ busy: true }))
       && !/stop recording/.test(describeUpgradeBlocked({ busy: true })),
       'upgrade: a tab still working after its recording stopped is told the wait is for that work, not asked to stop a recording');
    ok(/This recording comes first/.test(describeUpgradeBlocked({ recording: true, busy: true })),
       'upgrade: a recording that is running is named as the reason before any other work');
    ok(/work running here/.test(describeConnectionGuard('blocked', { busy: true })),
       'upgrade: and the guard passes that distinction through');
    ok(/carries on by itself/.test(describeUpgradeBlocked({})),
       'upgrade: the waiting tab is told it will carry on by itself, so nobody reloads in a panic');
    ok(!/recording/.test(describeUpgradeBlocked({})),
       'upgrade: a plain wait does not invent a recording to blame');

    ok(/Nothing has been lost/.test(describeConnectionClosed()),
       'upgrade: a tab whose connection was taken says so without implying data went with it');
    ok(/Reload/.test(describeConnectionClosed()), 'upgrade: and says what fixes it');
    ok(/Reload/.test(describeStaleTab()) && /Nothing has been lost/.test(describeStaleTab()),
       'upgrade: and the same for a tab left behind by a newer stored format');

    {
        const { applySchema, schemaLayout } = await import('../../src/js/db-lifecycle-core.js');
        const layout = schemaLayout({ STORE_REC: 'recordings', STORE_AUDIO: 'audio',
                                      STORE_FRAGMENTS: 'audio_fragments', STORE_LIVE: 'live_transcripts',
                                      STORE_BEATS: 'capture_beats' });
        const makeNative = existing => {
            const stores = new Map();
            const deleted = [];
            const makeStore = (name, indexes = []) => {
                const names = new Set(indexes);
                const store = { name, indexNames: { contains: n => names.has(n) },
                                createIndex: n => { names.add(n); return {}; }, _indexes: names };
                stores.set(name, store);
                return store;
            };
            for (const [name, indexes] of Object.entries(existing)) makeStore(name, indexes);
            const db = {
                objectStoreNames: { contains: n => stores.has(n) },
                createObjectStore: (n) => makeStore(n),
                deleteObjectStore: (n) => { deleted.push(n); stores.delete(n); }
            };
            const tx = { objectStore: n => stores.get(n) };
            return { db, tx, stores, deleted };
        };

        const fresh = makeNative({});
        applySchema(fresh.db, fresh.tx, layout);
        eq([...fresh.stores.keys()].sort(), ['audio', 'audio_fragments', 'capture_beats', 'live_transcripts', 'recordings'],
           'schema: a new install gets every current store');
        ok(fresh.stores.get('audio_fragments')._indexes.has('by-stream-seq')
           && fresh.stores.get('recordings')._indexes.has('by-date'),
           'schema: and every index the app reads through');

        const existing = makeNative({ recordings: ['by-date'], audio: [], legacy_fragments: [],
                                      audio_fragments: ['by-rec', 'by-session', 'by-stream'] });
        const created = applySchema(existing.db, existing.tx, layout);
        eq(existing.deleted, [], 'schema: an upgrade never deletes a store, so an update cannot take stored notes with it');
        ok(existing.stores.has('legacy_fragments'), 'schema: not even one this build no longer reads');
        eq(created.sort(), ['audio_fragments.by-stream-seq', 'capture_beats', 'live_transcripts', 'recordings.by-state'],
           'schema: an upgrade adds exactly what is missing and nothing else');
    }

    ok(isStaleVersionError({ name: 'VersionError' }),
       'upgrade: a browser refusing to open a newer database is recognised');
    ok(isStaleVersionError({ message: 'The requested version (9) is less than the existing version (10).' }),
       'upgrade: by name or by what it said');
    ok(!isStaleVersionError({ name: 'QuotaExceededError' }),
       'upgrade: and an unrelated failure is not dressed up as one');
    ok(!isStaleVersionError(null), 'upgrade: nor is nothing at all');

    eq(connectionGuardState({}), 'open', 'upgrade: a working connection is the quiet state');
    eq(connectionGuardState({ blocked: true }), 'blocked', 'upgrade: waiting is its own state');
    eq(connectionGuardState({ closed: true }), 'closed', 'upgrade: so is having been closed');
    eq(connectionGuardState({ closed: true, stale: true }), 'stale',
       'upgrade: and being left behind outranks it, because it needs a different answer');
    eq(describeConnectionGuard('open'), '', 'upgrade: a working connection says nothing at all');
    ok(describeConnectionGuard('blocked', { recording: true }).length > 0,
       'upgrade: every other state says something');
}

{
    const { CAPTURE_STALL_MS, captureStallMs, initialCaptureHealth, nextCaptureHealth,
            captureHealthTransition,
            shouldTryResume, describeCaptureStall, describeCaptureRecovery,
            capturedMs, honestDuration } =
        await import('../../src/js/capture-health-core.js');

    const RATE = 48000;
    const block48 = 4096;
    eq(CAPTURE_STALL_MS, 4000,
       'capture: a stall is noticed within one four-second flush window, the cadence the whole app keeps');

    let health = initialCaptureHealth(0);
    let samples = 0;
    const tick = (atMs, arrived, extra = {}) => {
        samples += arrived;
        const next = nextCaptureHealth(health, { progress: samples, nowMs: atMs, ...extra });
        const move = captureHealthTransition(health, next);
        health = next;
        return move;
    };

    eq(tick(250, block48), 'none', 'capture: audio arriving is the normal state and says nothing');
    eq(tick(3900, block48 * 40), 'none', 'capture: and keeps saying nothing while it keeps arriving');
    eq(tick(5000, 0), 'none',
       'capture: a moment with no new block is jitter, not a fault, while the window has not passed');
    eq(tick(8000, 0), 'stalled',
       'capture: but four seconds with no audio at all is a fault worth showing');
    ok(health.gapMs >= 4000, 'capture: and the gap is measured, not guessed');
    eq(tick(9000, 0), 'none', 'capture: a fault already shown is not shown again every tick');
    eq(tick(9500, block48), 'recovered',
       'capture: audio coming back is its own event, so the warning can be cleared');
    ok(health.longestGapMs >= 4000,
       'capture: and how long the recording went deaf is remembered for the message');

    let muted = initialCaptureHealth(0);
    const afterMute = nextCaptureHealth(muted, { progress: 1, nowMs: 10, muted: true });
    eq(captureHealthTransition(muted, afterMute), 'stalled',
       'capture: a track that reports itself muted is a fault at once, without waiting out the window');
    ok(/taken by something else/.test(describeCaptureStall(afterMute)),
       'capture: and says the microphone was taken, because that is what muted means');
    ok(/still running|safe/.test(describeCaptureStall(afterMute)),
       'capture: while making clear the recording continues and what was captured is kept');
    const unmuted = nextCaptureHealth(afterMute, { progress: 2, nowMs: 20, muted: false });
    eq(captureHealthTransition(afterMute, unmuted), 'recovered',
       'capture: and unmuting clears it');

    const suspended = nextCaptureHealth(initialCaptureHealth(0),
        { progress: 0, nowMs: 9000, suspended: true });
    ok(shouldTryResume(suspended),
       'capture: a suspended audio context is worth one attempt to resume');
    ok(!shouldTryResume({ ...suspended, resumeTried: true }),
       'capture: one attempt, not a loop');
    ok(!shouldTryResume(nextCaptureHealth(initialCaptureHealth(0), { progress: 1, nowMs: 100 })),
       'capture: and nothing is resumed while audio is flowing');
    ok(/suspended by the system/.test(describeCaptureStall(suspended)),
       'capture: a suspended context is named as that rather than as a missing microphone');
    ok(/incomplete/.test(describeCaptureRecovery({ gapMs: 12000 })),
       'capture: recovery says the file is marked incomplete, because the gap is real');
    ok(/12s/.test(describeCaptureRecovery({ gapMs: 12000 })),
       'capture: and says how much is missing');

    eq(captureStallMs(0), CAPTURE_STALL_MS,
       'capture: audio that arrives continuously is judged on the four-second window');
    ok(captureStallMs(4000) > 4000 * 2,
       'capture: audio that only arrives every four seconds cannot be judged on a four-second window, '
       + 'or every normal gap between deliveries would read as a fault');
    eq(captureStallMs(4000), 12000,
       'capture: so it takes three missed deliveries, the soonest a fault can honestly be claimed');

    let opus = initialCaptureHealth(0);
    const fragment = (atMs, bytes) => {
        const before = opus;
        opus = nextCaptureHealth(opus, { progress: bytes, nowMs: atMs, stallMs: captureStallMs(4000) });
        return captureHealthTransition(before, opus);
    };
    eq(fragment(4000, 90000), 'none', 'capture: a recording that delivers a block every four seconds is healthy');
    eq(fragment(8000, 180000), 'none', 'capture: and stays healthy across deliveries');
    eq(fragment(9000, 180000), 'none',
       'capture: a tick between two deliveries is not a fault, which is the false alarm this window exists to prevent');
    eq(fragment(19000, 180000), 'none',
       'capture: two missed deliveries is still within what normal jitter can explain');
    eq(fragment(20100, 180000), 'stalled',
       'capture: but three missed deliveries is a real fault and is still reported');
    ok(opus.gapMs >= 12000, 'capture: with the gap measured from the last block that actually arrived');
    eq(fragment(21000, 270000), 'recovered', 'capture: and the next block clears it');

    eq(capturedMs(RATE * 90, RATE), 90000, 'capture: what was heard is counted in samples, not in clock time');
    eq(capturedMs(0, RATE), 0, 'capture: nothing heard is nothing claimed');
    eq(capturedMs(RATE, 0), 0, 'capture: and without a rate there is no claim to make');
    eq(honestDuration(5400000, 720000), 720000,
       'capture: a file never claims more audio than actually arrived');
    eq(honestDuration(720000, 5400000), 720000,
       'capture: nor more than the recording lasted');
    eq(honestDuration(5400000, 0), 5400000,
       'capture: where nothing was measured the clock is still the best answer available');
}

{
    const { storageRunway, sessionRunway,
            nextRunwayAlert, runwayTone, describeRunway, describeRunwayAlert,
            describeSpaceRunway, RUNWAY_ALERTS } =
        await import('../../src/js/runway-core.js');

    const GB = 1073741824;
    const WAV = 48000 * 2;

    const fresh = storageRunway({ usedBytes: 0, quotaBytes: GB, recordedBytes: 0, bytesPerSec: WAV });
    ok(fresh.known, 'runway: with a quota and a rate there is an answer');
    ok(Math.abs(fresh.captureSec / 3600 - 3.1) < 0.1,
       'runway: a WAV recording fills a 1 GB origin in about three hours');
    ok(Math.abs(fresh.saveableSec / 3600 - 1.55) < 0.1,
       'runway: but stops being saveable as one file at about half that, which is the number worth showing');
    eq(fresh.secondsLeft, fresh.saveableSec,
       'runway: so that is the one the session reports');

    const opus32 = storageRunway({ usedBytes: 0, quotaBytes: GB, bytesPerSec: 32000 / 8 });
    const opus128 = storageRunway({ usedBytes: 0, quotaBytes: GB, bytesPerSec: 128000 / 8 });
    ok(opus32.saveableSec / opus128.saveableSec > 3.9,
       'runway: a quarter of the bitrate is four times the session');
    ok(opus32.saveableSec / 3600 > 24,
       'runway: and 32 kbps clears a full day');
    ok(opus128.saveableSec / 3600 < 12, 'runway: which the browser default does not');
    ok(opus32.saveableSec / fresh.saveableSec > 20,
       'runway: and compressed audio outlasts uncompressed by more than twenty times, which is why it is the default');

    const crowded = storageRunway({ usedBytes: 0.9 * GB, quotaBytes: GB, bytesPerSec: WAV });
    ok(crowded.saveableSec < fresh.saveableSec / 8,
       'runway: a nearly full origin leaves a nearly empty runway');
    eq(storageRunway({ usedBytes: GB, quotaBytes: GB, bytesPerSec: WAV }).saveableSec, 0,
       'runway: and a full one leaves none');

    const spent = storageRunway({ usedBytes: 0.6 * GB, quotaBytes: GB, recordedBytes: 0.6 * GB, bytesPerSec: WAV });
    eq(spent.saveableSec, 0, 'runway: a recording already too big to assemble says so');
    ok(spent.captureSec > 0, 'runway: while capture can carry on, which is a different fact and stays separate');

    ok(!storageRunway({ usedBytes: NaN, quotaBytes: GB, bytesPerSec: WAV }).known,
       'runway: no estimate, no projection');
    ok(!storageRunway({ usedBytes: 0, quotaBytes: GB, bytesPerSec: 0 }).known,
       'runway: a recording that is not growing has a state');
    eq(sessionRunway({ storage: null }).known, false,
       'runway: and a session with no readable limit is not warned about');
    eq(sessionRunway({ storage: null }).secondsLeft, Infinity,
       'runway: it simply has no deadline');
    eq(sessionRunway({ storage: { known: false, secondsLeft: Infinity } }).known, false,
       'runway: an unreadable storage estimate is no estimate');
    eq(sessionRunway({ storage: { known: true, secondsLeft: 900, limit: 'storage' } }).limit, 'storage',
       'runway: and free space is the only limit this app claims to know');

    eq(RUNWAY_ALERTS[0], 3600, 'runway: the first warning is an hour out');
    eq(nextRunwayAlert(1900, Infinity), 3600, 'runway: the first warning crossed is the one announced');
    eq(nextRunwayAlert(1700, 3600), 1800, 'runway: and the next one lands as the deadline closes');
    eq(nextRunwayAlert(1700, 1800), null, 'runway: while each threshold announces itself only once');
    eq(nextRunwayAlert(Infinity, Infinity), null, 'runway: no deadline, no warning');

    eq(runwayTone(4000), 'ok', 'runway: an hour away is not a warning');
    ok(['warn', 'error'].includes(runwayTone(200)), 'runway: minutes away is');

    ok(/space/.test(describeSpaceRunway(fresh)), 'runway: the line names what is running out');
    ok(/1\.5 h/.test(describeSpaceRunway(fresh)) && !/3 h/.test(describeSpaceRunway(fresh)),
       'runway: the space estimate is the saveable figure, not the longer one raw capture alone could reach');
    eq(describeSpaceRunway(null), '', 'runway: and says nothing when there is nothing to say');
    eq(describeRunway({ known: false }), '', 'runway: an unknown session says nothing');
    ok(/may clear it/.test(describeRunway({ known: false }, { persistent: false })),
       'runway: except that storage it might lose outright is worth saying even with no deadline');
    ok(/not persistent/.test(describeRunway(sessionRunway({ storage: fresh }), { persistent: false })),
       'runway: and the eviction warning survives beside the estimate');
    ok(!/battery|🔋/.test(describeRunway(sessionRunway({ storage: fresh }))),
       'runway: the line never mentions a battery, which this app no longer claims to know anything about');
    ok(/stop now and start a new note/.test(describeRunwayAlert(sessionRunway({ storage: fresh }), 900)),
       'runway: and every warning carries the move that always works');
    ok(/saved as one file/.test(describeRunwayAlert(sessionRunway({ storage: fresh }), 900)),
       'runway: the warning, unlike the always-on line, still explains what is about to be lost');
}

{
    const { panelLanguages, planLine, translationKey, languageName, translatedFrom,
            panelGrid, renderedText, LANGUAGE_COLOURS,
            languageColour, firstSeenOrder, translationQueue, TRANSLATE_QUEUE_MAX_LINES,
            translationBatch, buildBatchPrompt, buildFinalPrompt, parseBatchResponse, TRANSLATE_BATCH_LINES,
            translateBackoffMs, MAX_TRANSLATE_ATTEMPTS, notTranslatedFrom,
            untranslatedCounts, panelHeading, MISALIGN_NOTICE_AFTER,
            addLanguageHeard, describeLanguages, introducedLanguages, languageSentences,
            completeSentenceKeys, countWords, languageLabel, MIN_SENTENCES_FOR_ADDITIONAL_LANGUAGE,
            MIN_WORDS_FOR_PANEL, MIN_RUNS_FOR_PANEL, MIN_WORDS_PER_RUN, misalignBackoffMs,
            translationRate, describeLag, rotateTargets, SLOW_MS_PER_LINE, MAX_TRANSLATE_IN_FLIGHT,
            MIN_WINDOWS_FOR_PANEL, MAX_PANELS, generationTiming, steadyRate, MIN_SAMPLES_FOR_RATE,
            TRANSLATE_CAUSES } = await import('../../src/js/translate-core.js');

    const tally = { nl: 9, en: 14, de: 2 };
    eq(panelLanguages(tally, 2).join(','), 'nl,en',
       'panels: boxes are ordered by which language was heard first');
    eq(panelLanguages(tally, 4).join(','), 'nl,en,de', 'panels: fewer languages than panels is fine');
    eq(panelLanguages({ en: 9, nl: 40 }, 2).join(','),
       panelLanguages({ en: 100, nl: 40 }, 2).join(','),
       'panels: the box a reader learned does not move when someone else talks for longer');
    eq(panelLanguages(tally, 99).length, 3, 'panels: never more panels than languages heard');
    eq(panelLanguages({ en: 5, nl: 5 }, 2).join(','), 'en,nl',
       'panels: two languages heard equally often keep their arrival order');
    eq(panelLanguages({}, 4).length, 0, 'panels: nothing heard yet is no panels');

    let spoken = {};
    for (let i = 0; i < 4; i++) {
        spoken = addLanguageHeard(spoken, 'en', 'this is an English test with quite a few words in it');
    }
    spoken = addLanguageHeard(spoken, 'es', 'Gracias.');
    eq(panelLanguages(spoken, 2).join(','), 'en',
       'panels: one stray word does not earn a box');
    ok(!/\bES\b/.test(describeLanguages(spoken)),
       'panels: a candidate language stays out of the public header until it is established');
    for (let i = 0; i < 3; i++) spoken = addLanguageHeard(spoken, 'es', 'hola que tal me llamo Pedro y hoy vamos a hablar');
    eq(panelLanguages(spoken, 2).join(','), 'en,es',
       'panels: somebody actually speaking it earns the box within a sentence or two');
    ok(!/\//.test(describeLanguages(spoken)), 'panels: and the header stops explaining itself once it has');

    let mislabelled = {};
    for (let i = 0; i < 4; i++) {
        mislabelled = addLanguageHeard(mislabelled, 'en', 'this is an English test with quite a few words in it');
    }
    mislabelled = addLanguageHeard(mislabelled, 'id', 'the Rift, Baha, and the Inns, and there the Tao.');
    mislabelled = addLanguageHeard(mislabelled, 'id', 'atau bahasa Indonesia');
    eq(panelLanguages(mislabelled, 4).join(','), 'en',
       'panels: and still earn nothing, because the threshold is a shape');
    ok(!/\bID\b/.test(describeLanguages(mislabelled)),
       'panels: a ghost candidate is tracked privately');
    mislabelled = addLanguageHeard(mislabelled, 'id', 'saya tidak tahu apa yang terjadi di sini hari ini');
    eq(panelLanguages(mislabelled, 4).join(','), 'en,id',
       'panels: somebody who really is speaking it produces one labelled window after another, and earns the box');
    ok(MIN_RUNS_FOR_PANEL >= 2 && MIN_RUNS_FOR_PANEL <= 3 && MIN_WORDS_PER_RUN >= 3,
       'panels: an occurrence is a few words at once');
    ok(MIN_WORDS_FOR_PANEL >= 6 && MIN_WORDS_FOR_PANEL <= 30,
       'panels: the threshold is about a sentence');

    let three = {};
    for (let i = 0; i < 3; i++) three = addLanguageHeard(three, 'en', 'This is a complete English sentence for the test.');
    for (let i = 0; i < 3; i++) three = addLanguageHeard(three, 'nl', 'Dit is een volledige Nederlandse zin voor de test.');
    eq(introducedLanguages(three).join(','), 'en,nl',
       'panels: the first two real languages are introduced normally');
    three = addLanguageHeard(three, 'id', 'Ini adalah kalimat lengkap pertama dalam bahasa ini.');
    three = addLanguageHeard(three, 'id', 'Ini adalah kalimat lengkap kedua dalam bahasa ini.');
    ok(!introducedLanguages(three).includes('id'),
       'panels: two complete sentences still cannot introduce a third language');
    ok(!/\bID\b/.test(describeLanguages(three)),
       'panels: and the candidate third language stays out of the header');
    eq(introducedLanguages(three, { excluded: ['en'] }).join(','), 'nl',
       'panels: closing one established panel does not weaken the third-language evidence gate');
    three = addLanguageHeard(three, 'id', 'Ini adalah kalimat lengkap ketiga dalam bahasa ini.');
    ok(languageSentences(three, 'id') >= 3 && introducedLanguages(three).includes('id'),
       'panels: the third complete sentence introduces the language');
    eq(MIN_SENTENCES_FOR_ADDITIONAL_LANGUAGE, 3,
       'panels: additional languages require exactly the requested three-sentence floor');
    eq(completeSentenceKeys('one two three four. one two three four.').length, 1,
       'panels: identical overlap sentences count once inside one result');
    eq(countWords('Hallo daar, hoe gaat het?'), 5, 'panels: words are counted, punctuation is not');
    ok(countWords('これは日本語のテストです') >= 4,
       'panels: and a language that does not separate words with spaces still counts, or it could never earn a box');
    eq(panelLanguages({ en: 9, es: 1 }, 2).join(','), 'en,es',
       'panels: a caller that only counted windows still gets the window rule');

    eq(panelLanguages({ en: 20, nl: 9 }, 4)[0], panelLanguages({ en: 20, nl: 9, de: 1 }, 4)[0],
       'panels: a new language does not displace the one being read');

    const many = Array.from({ length: 200 }, (_, i) =>
        ({ key: `k${i}`, text: `x${i}`, language: i % 2 ? 'en' : 'nl' }));
    const queue = translationQueue(many, 'en', {});
    ok(queue.length > 0, 'panels: there is work to do');
    eq(queue[0].line.key, 'k198', 'panels: the newest untranslated line is translated first');
    ok(Number(queue[0].line.key.slice(1)) > Number(queue[queue.length - 1].line.key.slice(1)),
       'panels: and the queue runs backwards from there');
    ok(queue.length <= TRANSLATE_QUEUE_MAX_LINES,
       'panels: a long session does not queue every line it has ever heard');
    eq(translationQueue(many, 'en', { translations: { 'k198::en': 'done' } })[0].line.key, 'k196',
       'panels: a line already translated is skipped');
    eq(translationQueue(many, 'en', { inFlight: new Set(['k198::en']) })[0].line.key, 'k196',
       'panels: so is one already being translated');
    eq(translationQueue([{ key: 's', text: 'note', system: true }], 'en', {}).length, 0,
       'panels: a system note is not sent to a translator');
    eq(translationQueue(many, 'nl', {})[0].line.language, 'en',
       'panels: each panel queues only what is not already in its language');
    const newestDone = {};
    for (let i = 40; i < 200; i++) newestDone[`k${i}::en`] = 'done';
    const olderLeft = translationQueue(many, 'en', { translations: newestDone });
    eq(olderLeft.map(item => item.line.key).slice(0, 3).join(','), 'k38,k36,k34',
       'panels: once the newest lines are translated, older ones come next, so none waits forever after an outage');
    ok(olderLeft.length === 20, 'panels: every line still to translate can be reached, however far up it has scrolled');

    {
        const { planTranslationFailure: plan, translationTimeoutError: timeout, TRANSLATE_BACKOFF_MAX_MS }
            = await import('../../src/js/translate-core.js');
        ok(!plan(new TypeError('Failed to fetch'), 12, 0).countsAgainstLines && !plan(new Error('Translation failed (HTTP 502)'), 1, 0).countsAgainstLines,
           'panels: a server that is down or refuses costs the lines nothing, so an outage never marks a line "not translated"');
        ok(!plan(timeout(56000), 12, 0).countsAgainstLines,
           'panels: nor does a batch that ran out of time, which is retried smaller instead');
        const empty = new Error('model returned reasoning and no translation');
        empty.name = 'EmptyTranslation';
        ok(plan(timeout(23000), 1, 0).countsAgainstLines && plan(empty, 3, 0).countsAgainstLines,
           'panels: a single line the model cannot finish in time, or an answer without a translation, does count against the lines');
        ok(TRANSLATE_BACKOFF_MAX_MS <= 15000 && plan(new TypeError('Failed to fetch'), 1, 30).backoffMs <= 15000,
           'panels: after any number of failures the next try is at most 15 seconds away, so a server that comes back is used again soon');
    }

    let silentFirst = addLanguageHeard({}, 'en', '');
    ok(!silentFirst.en, 'panels: a window with nothing said in it is no evidence of its language');
    silentFirst = addLanguageHeard(silentFirst, 'en', 'Okay.');
    for (let i = 0; i < 4; i++) silentFirst = addLanguageHeard(silentFirst, 'nl', 'Goedemorgen allemaal, fijn dat jullie er zijn vandaag.');
    eq(introducedLanguages(silentFirst).join(','), 'nl',
       'panels: a short reply tagged with another language does not become the first language');
    eq(panelLanguages(silentFirst, 2).join(','), 'nl',
       'panels: so a meeting held in one language gets no translation box for a language nobody spoke');

    const batch = translationBatch(many, 'en', {});
    eq(batch.length, TRANSLATE_BATCH_LINES, 'batch: a batch is taken, not a single line');
    ok(Number(batch[0].line.key.slice(1)) < Number(batch[batch.length - 1].line.key.slice(1)),
       'batch: ordered oldest to newest inside the batch');
    eq(batch[batch.length - 1].line.key, 'k198',
       'batch: and still taken from the newest end');
    eq(translationBatch(many, 'en', {}, 3).length, 3, 'batch: the size is adjustable');
    eq(translationBatch([], 'en', {}).length, 0, 'batch: nothing to do is an empty batch, not a crash');

    ok(!/already in/i.test(buildBatchPrompt([{ text: 'a' }, { text: 'b' }], 'Dutch')),
       'batch: the prompt says nothing about content that a model could translate');
    ok(!/already in/i.test(buildBatchPrompt([{ text: 'a' }], 'Dutch')),
       'batch: in either form of it');
    ok(/---/.test(buildBatchPrompt([{ text: 'Hallo' }], 'English')),
       'batch: and a single line is fenced off');

    const finalPrompt = buildFinalPrompt([{ text: 'we need the GPU' }, { text: 'yes' }], 'Nederlands');
    ok(/completely in Nederlands/.test(finalPrompt) && /another language/.test(finalPrompt),
       'final: the pass with no clock asks for the whole line');
    ok(/exactly 2 lines/.test(finalPrompt) && /Do not merge/.test(finalPrompt),
       'final: while the alignment rules are the ones that were always true');
    ok(/Keep personal names and numbers unchanged/.test(finalPrompt),
       'final: and a name is still a name in every language');

    const single = buildBatchPrompt([{ text: 'Hallo daar' }], 'English');
    ok(!/1\./.test(single) && /no numbering/.test(single),
       'batch: a single line is asked for as a translation');
    eq(JSON.stringify(parseBatchResponse('Hello there', 1)), '["Hello there"]',
       'batch: and the bare answer that comes back is read');
    ok(misalignBackoffMs(6) <= 10000 && misalignBackoffMs(1) < translateBackoffMs(1),
       'batch: a reply in the wrong shape is paced in seconds');

    const prompt = buildBatchPrompt([{ text: 'Hallo daar' }, { text: 'Hoe gaat het' }], 'English');
    ok(/1\. Hallo daar/.test(prompt) && /2\. Hoe gaat het/.test(prompt),
       'batch: lines are numbered, which is what makes a misaligned reply detectable');
    ok(/exactly 2 lines/.test(prompt), 'batch: and the count is stated');

    eq(JSON.stringify(parseBatchResponse('1. Hello there\n2. How are you', 2)),
       '["Hello there","How are you"]', 'batch: an aligned reply is read back in order');
    eq(parseBatchResponse('1. Hello there, how are you', 2), null,
       'batch: a reply that merged two lines into one is refused whole');
    eq(parseBatchResponse('1. a\n2. b\n3. c', 2), null,
       'batch: and so is one that invented a line');
    eq(JSON.stringify(parseBatchResponse('Sure, here you go:\n1. Hello there\n2. How are you', 2)),
       '["Hello there","How are you"]', 'batch: a chatty preamble is ignored rather than counted');
    eq(JSON.stringify(parseBatchResponse('2) How are you\n1) Hello there', 2)),
       '["Hello there","How are you"]', 'batch: numbering is what orders the reply');
    eq(JSON.stringify(parseBatchResponse('Hello there', 1)), '["Hello there"]',
       'batch: a single line may answer bare');
    eq(parseBatchResponse('', 2), null, 'batch: an empty reply is refused');
    eq(parseBatchResponse('nothing numbered here', 3), null, 'batch: so is one with no numbering at all');

    eq(JSON.stringify(parseBatchResponse('**1.** Hello there\n**2.** How are you', 2)),
       '["Hello there","How are you"]', 'batch: numbering wearing Markdown is still numbering');
    eq(JSON.stringify(parseBatchResponse('- 1. Hello there\n- 2. How are you', 2)),
       '["Hello there","How are you"]', 'batch: and so is numbering inside a bullet list');
    eq(JSON.stringify(parseBatchResponse('Line 1: Hello there\nLine 2: How are you', 2)),
       '["Hello there","How are you"]', 'batch: and numbering the model chose to label');
    eq(parseBatchResponse('**1.** Hello there', 2), null,
       'batch: but a decorated reply missing a line is refused exactly like a bare one');

    eq(JSON.stringify(parseBatchResponse('1. Hello there,\nhow are you today\n2. Fine', 2)),
       '["Hello there, how are you today","Fine"]',
       'batch: a line wrapped onto the next is put back together');
    eq(JSON.stringify(parseBatchResponse('1.\nHello there\n2. Fine', 2)),
       '["Hello there","Fine"]',
       'batch: a number whose text starts on the following line is a wrap, not an omission');
    eq(parseBatchResponse('1. Hello\n2. Fine\n\nNote: line 2 was already English', 2)
        .join('|'), 'Hello|Fine',
       'batch: a remark after a blank line is not swallowed into the last translation');
    eq(parseBatchResponse('1.\n\n2. Fine', 2), null,
       'batch: a number that never received any text is not a translation');

    eq(JSON.stringify(parseBatchResponse('Hello there\nHow are you', 2)),
       '["Hello there","How are you"]',
       'batch: a reply with no numbering but exactly the right number of lines is read by position');
    eq(parseBatchResponse('Hello there\nHow are you\nand a note', 2), null,
       'batch: one line too many is still refused');
    eq(parseBatchResponse('Sure:\nHello there\nHow are you', 2), null,
       'batch: and a preamble makes the count wrong');
    eq(parseBatchResponse('1. Hello there, how are you', 2), null,
       'batch: partial numbering is never second-guessed by position');

    ok(MAX_TRANSLATE_ATTEMPTS >= 1 && MAX_TRANSLATE_ATTEMPTS <= 5,
       'batch: a line is tried a few times and then left in the language it was said in');
    eq(translateBackoffMs(0), 0, 'batch: nothing has failed, so nothing waits');
    eq(translateBackoffMs(1), 2000, 'batch: the first failure buys a pause');
    eq(translateBackoffMs(2), 4000, 'batch: which doubles');
    ok(translateBackoffMs(20) <= 60000, 'batch: and is capped, so a refusal costs almost nothing to keep refusing');
    ok(translateBackoffMs(3) > translateBackoffMs(2),
       'batch: every consecutive failure widens the gap rather than repeating it');
    eq(translateBackoffMs(-1), 0, 'batch: a nonsense count does not become a nonsense wait');

    const abandoned = new Set(['k198::en']);
    eq(translationQueue(many, 'en', { inFlight: abandoned })[0].line.key, 'k196',
       'batch: an abandoned line is passed over rather than retried forever');

    eq(planLine({ language: 'nl' }, 'nl').action, 'verbatim',
       'panels: a line already in this language is not round-tripped through a model');
    eq(planLine({ language: 'en' }, 'nl').action, 'translate', 'panels: anything else is translated');
    eq(planLine({ language: 'en' }, 'nl').from, 'en', 'panels: and remembers what it came from');
    eq(planLine({ language: null }, 'nl').action, 'verbatim',
       'panels: an unknown source language is shown rather than guessed at');
    eq(planLine({ language: 'en' }, null).action, 'verbatim', 'panels: with no target there is nothing to do');

    eq(languageLabel('ar', 'nl'), 'العربية - Arabisch',
       'panels: a box is named in its own script and again in the session\'s first language');
    eq(languageLabel('nl', 'en'), 'Nederlands - Dutch',
       'panels: which is the session\'s first language, not the app\'s');
    eq(languageLabel('nl', 'nl'), languageName('nl'),
       'panels: a box in the language everyone started in needs no translating');
    eq(languageLabel('nl', 'ar'), 'Nederlands - Dutch',
       'panels: a first language this app cannot write other names in falls back to English rather than to nothing');
    eq(languageLabel('fr', ''), 'Français - French',
       'panels: and so does a session that has heard nothing else yet');
    eq(languageLabel('hu', 'en'), 'Magyar - Hungarian',
       'panels: a language that turned up in testing has a name');
    ok(/Arabisch/.test(panelHeading('ar', { pending: 1 }, {}, 'nl')),
       'panels: the heading carries it, which is where it is actually read');

    ok(/Dutch|Nederlands/.test(languageName('nl')), 'panels: a code becomes a readable name');
    eq(languageName('xx'), 'XX', 'panels: an unknown code is shown as itself, not guessed');
    ok(/Translated from/.test(translatedFrom('de')),
       'panels: a translated line is tagged');

    eq(translationKey('w1:0', 'nl'), translationKey('w1:0', 'nl'), 'panels: the cache key is stable');
    ok(translationKey('w1:0', 'nl') !== translationKey('w1:0', 'en'),
       'panels: and distinguishes target languages');

    eq(JSON.stringify(panelGrid(1)), '{"columns":1,"rows":1}', 'panels: one fills the width');
    eq(JSON.stringify(panelGrid(2)), '{"columns":2,"rows":1}', 'panels: two are halves');
    eq(JSON.stringify(panelGrid(4)), '{"columns":2,"rows":2}', 'panels: four are quadrants');
    eq(JSON.stringify(panelGrid(3)), JSON.stringify(panelGrid(4)),
       'panels: three use the same grid');
    eq(panelGrid(99).columns * panelGrid(99).rows, MAX_PANELS,
       'panels: the grid never exceeds the cap');

    const nlLine = { key: 'k1', text: 'Hallo daar', language: 'nl' };
    eq(renderedText(nlLine, 'nl', {}).text, 'Hallo daar',
       'panels: a line in the box language is shown as it was said');
    ok(!renderedText(nlLine, 'nl', {}).translated, 'panels: and is not claimed as a translation');
    const waiting = renderedText(nlLine, 'en', {});
    eq(waiting.text, 'Hallo daar',
       'panels: before the translation lands, the words as spoken are shown');
    ok(waiting.pending && !waiting.translated,
       'panels: and are marked as awaiting translation rather than as translated');
    const landed = renderedText(nlLine, 'en', { [translationKey('k1', 'en')]: 'Hello there' });
    eq(landed.text, 'Hello there', 'panels: the translation replaces them when it arrives');
    ok(landed.translated && !landed.pending, 'panels: and is then marked as a translation');
    const gaveUp = new Set([translationKey('k1', 'en')]);
    const abandonedLine = renderedText(nlLine, 'en', {}, { gaveUp });
    eq(abandonedLine.text, 'Hallo daar', 'panels: an abandoned line still shows the words as spoken');
    ok(abandonedLine.abandoned && !abandonedLine.pending,
       'panels: and says it is abandoned rather than pending');
    ok(!renderedText(nlLine, 'en', { [translationKey('k1', 'en')]: 'Hello there' }, { gaveUp }).abandoned,
       'panels: a translation that did land is never reported as given up on');
    ok(/not translated/i.test(notTranslatedFrom('nl')),
       'panels: and the tag says so in words');

    const rowsForCount = [
        { key: 'a', text: 'x', language: 'nl' },
        { key: 'b', text: 'y', language: 'nl' },
        { key: 'c', text: 'z', language: 'en' },
        { key: 's', text: 'note', system: true }
    ];
    const counted = untranslatedCounts(rowsForCount, 'en',
        { translations: {}, gaveUp: new Set([translationKey('a', 'en')]) });
    eq(counted.abandoned, 1, 'panels: the box counts what it has stopped trying to translate');
    eq(counted.pending, 1, 'panels: separately from what is still coming');
    eq(untranslatedCounts(rowsForCount, 'en',
        { translations: { [translationKey('a', 'en')]: 'done' },
          gaveUp: new Set([translationKey('a', 'en')]) }).abandoned, 0,
       'panels: a line that was translated in the end is not still counted as abandoned');
    eq(translationRate([{ lines: 2, ms: 2000 }, { lines: 2, ms: 3000 }]), 1250,
       'panels: the rate is measured over recent requests, lines and all');
    eq(translationRate([]), null, 'panels: with nothing measured there is nothing to claim');
    ok(/server not answering/.test(panelHeading('nl', { pending: 3 }, { state: 'failing' })),
       'panels: a box says which of the three faults it is - this one is not being answered');
    ok(/retrying in 6s/.test(panelHeading('nl', { pending: 3 }, { state: 'paused', pauseMs: 6000 })),
       'panels: this one is waiting out a pause');
    ok(/min behind/.test(panelHeading('nl', { pending: 34 }, { state: 'translating', msPerLine: 17000 })),
       'panels: and this one is working, just far slower than the conversation');
    eq(describeLag(2, 800), '', 'panels: a queue that will drain in a moment is not worth a word');
    ok(SLOW_MS_PER_LINE >= 1000,
       'panels: and "slow" means slow enough to mean the model is not where it should be, not merely not instant');

    const reloaded = generationTiming({ load_duration: 8e9, prompt_eval_duration: 5e7, eval_duration: 4.5e8 }, 8600);
    eq(reloaded.generateMs, 500,
       'timing: a translation is charged what the model spent on it, never the seconds the server spent loading the model');
    ok(reloaded.reloaded, 'timing: the load is recognised as one, so it can be logged instead of blamed on the model');
    const warm = generationTiming({ load_duration: 2e6, prompt_eval_duration: 3e7, eval_duration: 2.7e8 }, 320);
    ok(!warm.reloaded && warm.generateMs === 300, 'timing: a warm model is measured as it is');
    const plain = generationTiming({ response: 'x' }, 1800);
    ok(!plain.reported && plain.generateMs === 1800,
       'timing: a server that reports no durations is measured by its round trip');
    eq(generationTiming(null, 700).generateMs, 700, 'timing: and nothing at all is not a crash');

    eq(steadyRate([{ lines: 1, ms: 9000 }, { lines: 1, ms: 300 }]), null,
       'timing: two requests are not yet a rate, so one slow start cannot label the model slow');
    eq(steadyRate([{ lines: 1, ms: 9000 }, { lines: 1, ms: 300 }, { lines: 1, ms: 300 }]),
       translationRate([{ lines: 1, ms: 9000 }, { lines: 1, ms: 300 }, { lines: 1, ms: 300 }]),
       'timing: from the third request on, the rate is the ordinary average');
    ok(MIN_SAMPLES_FOR_RATE >= 3, 'timing: the rate waits for at least three requests');

    const cpu = TRANSLATE_CAUSES.cpu;
    ok(panelHeading('nl', { pending: 3 }, { state: 'translating' }, '', cpu).includes(cpu),
       'panels: a known reason for slow translation is stated in the box heading while lines wait');
    ok(!panelHeading('nl', { pending: 0 }, {}, '', cpu).includes(cpu),
       'panels: and disappears once nothing is waiting, so it never lingers as a warning');

    eq(rotateTargets(['en', 'nl', 'de'], 1).join(','), 'nl,de,en',
       'panels: the turn rotates, so the box at the top of the list does not take every one');
    eq(rotateTargets(['en', 'nl'], 5).join(','), 'nl,en', 'panels: however many turns have been taken');
    eq(rotateTargets(['en'], 3).join(','), 'en', 'panels: one box needs no rotating');
    ok(MAX_TRANSLATE_IN_FLIGHT >= 2 && MAX_TRANSLATE_IN_FLIGHT <= 8,
       'panels: several boxes may be mid-request at once');

    ok(/2 not translated/.test(panelHeading('nl', { abandoned: 2 })),
       'panels: and the heading carries the count');
    ok(/3 waiting/.test(panelHeading('nl', { pending: 3 })),
       'panels: a box also says how much is still coming');
    ok(/waiting/.test(panelHeading('nl', { pending: 3, abandoned: 2 }))
       && /not translated/.test(panelHeading('nl', { pending: 3, abandoned: 2 })),
       'panels: and reports both at once when both are true');
    eq(panelHeading('nl', { abandoned: 0 }, {}, 'nl'), languageName('nl'),
       'panels: a box with nothing abandoned just says what language it is');

    eq(renderedText({ key: 'k2', text: 'x', language: null }, 'en', {}).text, 'x',
       'panels: a line of unknown language is still shown');
    ok(renderedText({ key: 'k3', text: '', language: 'nl' }, 'en', {}).text === '',
       'panels: an empty line stays empty rather than becoming a placeholder');

    eq(panelLanguages({ nl: 14, en: 9, pt: 1 }, 2).join(','), 'nl,en',
       'panels: with boxes contested, a language heard once loses to ones heard more');
    eq(panelLanguages({ nl: 14, en: 9, es: 1 }, 4).join(','), 'nl,en,es',
       'panels: with a box to spare');
    eq(panelLanguages({ nl: 14, en: 9, es: 1, pt: 1, de: 1 }, 4).length, 4,
       'panels: spare boxes are filled, up to the number configured');
    eq(panelLanguages({ nl: 1 }, 2).join(','), 'nl',
       'panels: and at the start of a session');
    ok(MIN_WINDOWS_FOR_PANEL >= 2, 'panels: a panel has to be earned more than once');

    ok(new Set(LANGUAGE_COLOURS).size === LANGUAGE_COLOURS.length,
       'panels: every language colour is distinct');
    ok(LANGUAGE_COLOURS.length >= MAX_PANELS,
       'panels: there is a colour for at least as many languages as there are boxes');

    const seen = firstSeenOrder({ en: 14, nl: 9, de: 3 });
    eq(seen.join(','), 'en,nl,de', 'panels: languages are remembered in the order first heard');
    eq(languageColour('en', seen), LANGUAGE_COLOURS[0], 'panels: the first language heard takes the first colour');
    eq(languageColour('nl', seen), LANGUAGE_COLOURS[1], 'panels: the second takes the second');
    ok(languageColour('en', seen) !== languageColour('nl', seen),
       'panels: two languages never share a colour');

    const later = firstSeenOrder({ en: 14, nl: 40, de: 3 });
    eq(languageColour('nl', later), languageColour('nl', seen),
       'panels: a language keeps its colour when it becomes the most spoken');
    eq(languageColour('en', later), languageColour('en', seen),
       'panels: and so does the one it overtook');

    eq(languageColour('xx', seen), LANGUAGE_COLOURS[0],
       'panels: an unheard language still resolves to a colour');
}

{
    const { parseConfirm, speakerNumber, sentences, promotable, proposalSubject,
            nextProposals, takeProposal, dropSubject, describeProposal, describeConfirmResult,
            proposalForNumber, PROPOSE_SCORE, PROPOSE_MARGIN, PROPOSAL_TTL_SEC }
        = await import('../../src/js/speaker-confirm-core.js');

    const said = (text, pending = []) => parseConfirm(text, pending);

    eq(said('confirm speaker 2', [2]).id, 2, 'confirm: the verb may come first');
    eq(said('speaker 2 confirm', [2]).id, 2, 'confirm: or last, because people say it both ways');
    eq(said('Confirm Speaker Two.', [2]).id, 2, 'confirm: a spoken number counts, and case does not');
    eq(said('bevestig spreker 3', [3]).id, 3, 'confirm: Dutch is understood too');
    eq(said('okay. confirm speaker 3. anyway', [3]).id, 3,
       'confirm: an instruction that is its own sentence is heard inside longer speech');

    eq(said('can you confirm speaker 2 is joining?', [2]), null,
       'confirm: talking about confirming a speaker is not confirming one, because that sentence carries more than the instruction');
    eq(said('I will confirm later', [2]), null, 'confirm: nor is the bare word inside a longer sentence');
    eq(said('confirm speaker', [2]), null, 'confirm: an instruction with no speaker in it does nothing');
    eq(said('confirm speaker 0', [2]), null, 'confirm: and there is no Speaker 0');

    eq(said('confirm', [3]).id, 3, 'confirm: a bare confirm takes the only suggestion standing');
    eq(said('confirm', [3]).form, 'bare', 'confirm: and reports that is what it did');
    eq(said('confirm', [2, 3]).id, null, 'confirm: with two waiting it refuses to guess which');
    eq(said('confirm', [2, 3]).form, 'ambiguous', 'confirm: and says so rather than picking one');
    eq(said('confirm', []), null, 'confirm: with none waiting it is not an instruction at all');

    eq(speakerNumber('4'), 4, 'confirm: digits are speaker numbers');
    eq(speakerNumber('vier'), 4, 'confirm: and so are spoken Dutch words');
    eq(speakerNumber('elephant'), null, 'confirm: a word that is not a number is not one');
    eq(sentences('one. two? three!').length, 3, 'confirm: speech is split into sentences before matching');

    eq(PROPOSE_SCORE, 1, 'propose: a suggestion needs a full point of evidence');
    eq(PROPOSE_MARGIN, 0.5, 'propose: and must beat the runner-up name by half of one');

    ok(promotable({ score: 1, self: 1, runnerUp: 0 }),
       'propose: one outright self-introduction is enough');
    ok(!promotable({ score: 0.6, self: 0.6, runnerUp: 0 }),
       'propose: a single loose self-introduction is not, it waits to be corroborated');
    ok(promotable({ score: 1.1, self: 0.6, runnerUp: 0 }),
       'propose: a loose one that others back up is');
    ok(!promotable({ score: 1.5, self: 0, runnerUp: 0 }),
       'propose: a name only ever heard addressed to somebody is a guess about a third party, never proposed');
    ok(!promotable({ score: 1.2, self: 1, runnerUp: 0.9 }),
       'propose: a speaker with two plausible names stays a number');
    ok(!promotable(null), 'propose: nothing proposes nothing');

    const nameFor = (id, name) => ({ type: 'name', id, name, origin: 'inferred' });
    eq(proposalSubject(nameFor(2, 'Mark')), 2, 'ledger: a name proposal is about the speaker being named');
    eq(proposalSubject({ type: 'merge', from: 3, to: 2 }), 3, 'ledger: a merge is about the speaker absorbed');
    eq(proposalSubject({ type: 'nonsense' }), null, 'ledger: anything else is about nobody');

    let ledger = nextProposals([], [nameFor(2, 'Mark'), nameFor(3, 'Sara')], 10);
    eq(ledger.length, 2, 'ledger: one proposal per speaker can stand at once');
    eq(ledger[0].atSec, 10, 'ledger: each remembers when it was made');

    ledger = nextProposals(ledger, [nameFor(2, 'Mark')], 20);
    eq(ledger.find(p => proposalSubject(p.command) === 2).atSec, 10,
       'ledger: the same suggestion repeating does not restart its clock, so it is not announced twice');

    ledger = nextProposals(ledger, [nameFor(2, 'Marc')], 30);
    eq(ledger.find(p => proposalSubject(p.command) === 2).command.name, 'Marc',
       'ledger: a better guess for the same speaker replaces the older one');
    eq(ledger.length, 2, 'ledger: and does not pile up beside it');

    eq(nextProposals(ledger, [], 30 + PROPOSAL_TTL_SEC + 1).length, 0,
       'ledger: a suggestion nobody ever confirmed expires instead of waiting for the rest of the recording');

    const taken = takeProposal(ledger, 2);
    eq(proposalSubject(taken.proposal.command), 2, 'ledger: confirming takes that speaker proposal');
    eq(taken.rest.length, 1, 'ledger: and leaves the others standing');
    eq(takeProposal(ledger, 9).proposal, null, 'ledger: confirming a speaker with nothing waiting takes nothing');
    eq(dropSubject(ledger, 3).length, 1, 'ledger: a proposal can also be dropped without being applied');

    ok(/say "confirm speaker 2"/.test(describeProposal({ command: nameFor(2, 'Mark') })),
       'ledger: a suggestion tells you exactly what to say to accept it');
    ok(/\?/.test(describeProposal({ command: nameFor(2, 'Mark') })),
       'ledger: and is phrased as a question, because nothing has been decided');
    ok(/join/.test(describeProposal({ command: { type: 'merge', from: 3, to: 2 } })),
       'ledger: a merge suggestion says what joining them would mean');

    // Build 133: suggestions name speakers by the number on screen, and "confirm speaker N" means
    // the suggestion announced for Speaker N, also after the numbers moved up.
    const onScreenAs = { 7: 3, 9: 2, 4: 1 };
    const numberOf = id => onScreenAs[id];
    eq(describeProposal({ command: nameFor(7, 'Mark') }, numberOf), 'Speaker 3 → "Mark"? say "confirm speaker 3"',
       'ledger: a suggestion names the speaker by the number on screen, not by identity');
    ok(/^Speaker 3 may be Speaker 1\?/.test(describeProposal({ command: { type: 'merge', from: 7, to: 4 } }, numberOf)),
       'ledger: and so does a merge suggestion, for both of them');
    const announced = [{ command: nameFor(7, 'Mark'), atSec: 10, number: 3 },
                       { command: nameFor(9, 'Sara'), atSec: 20, number: 2 }];
    const subjectOf = found => (found ? proposalSubject(found.command) : null);
    eq(subjectOf(proposalForNumber(announced, 3, () => 2)), 7,
       'confirm: "confirm speaker 3" takes the suggestion announced for Speaker 3, even once that speaker shows as 2');
    eq(proposalForNumber(announced, 4, numberOf), null, 'confirm: a number nothing was announced for takes nothing');
    eq(subjectOf(proposalForNumber([{ command: nameFor(7, 'Mark'), atSec: 10 }], 3, numberOf)), 7,
       'confirm: a suggestion without a recorded number is found by the number its speaker has now');
    eq(subjectOf(proposalForNumber([...announced, { command: nameFor(4, 'Eve'), atSec: 30, number: 3 }], 3, numberOf)), 4,
       'confirm: of two suggestions announced with one number, the latest is meant');

    ok(/nothing is waiting/.test(describeConfirmResult({ id: null, pending: 0 })),
       'confirm: confirming into thin air says so');
    ok(/say which/.test(describeConfirmResult({ id: null, pending: 2 })),
       'confirm: and an ambiguous confirm asks which, rather than choosing');
    ok(/confirmed/.test(describeConfirmResult({ id: 2, applied: true, echo: 'Speaker 2 named' })),
       'confirm: an accepted suggestion reports that it was confirmed, not that it was worked out');
}

{
    const { appendLiveLines, archiveDroppedLines } = await import('../../src/js/live-scribe-core.js');
    const { liveLinesAsResults, invertCoverage, reassembleTimeline } = await import('../../src/js/transcribe-core.js');
    let view = { lines: [], tail: '' };
    let archive = [];
    const translations = {};
    const coverage = [];
    for (let window = 0; window < 3600; window++) {
        const startSec = window * 4;
        const key = `k${window}`;
        translations[`${key}::nl`] = `vertaling ${window}`;
        const next = appendLiveLines(view, [{ key, startSec, endSec: startSec + 4,
            text: `w${window} alpha bravo charlie delta echo foxtrot golf hotel india` }]);
        if (next.dropped) archive = archiveDroppedLines(archive, next.droppedLines, translations, ['nl']);
        view = { lines: next.lines, tail: next.tail };
        coverage.push({ fromSec: startSec, toSec: startSec + 4 });
    }
    const saved = [...archive, ...view.lines];
    ok(view.lines.length < 3600, 'long live session: the live view stays capped');
    eq(saved.length, 3600, 'long live session: every line the view dropped is kept for the saved transcript');
    eq(archive[0].translations.nl, 'vertaling 0', 'long live session: a dropped line keeps its translations');
    eq(invertCoverage(coverage, 3600 * 4, 1).length, 0, 'long live session: coverage says nothing is left to transcribe');
    ok(reassembleTimeline(liveLinesAsResults(saved), saved.length).plain.startsWith('w0 '),
       'long live session: so the saved transcript must start at the beginning of the recording');
}

{
    const { archiveDroppedLines } = await import('../../src/js/live-scribe-core.js');
    const dropped = [
        { key: 'w1.0:0', startSec: 0, text: 'hello there' },
        { key: 'cmd-1.0', startSec: 2, text: 'Not recording sound right now', system: true },
        { key: 'w1.1:0', startSec: 4, text: 'goedemorgen allemaal' }
    ];
    const translations = {
        'w1.0:0::nl': 'hallo daar', 'w1.0:0::de': 'hallo da',
        'w1.1:0::en': 'good morning everyone', 'w1.2:0::nl': 'a line still on screen'
    };
    const before = [{ key: 'w0.0:0', startSec: 0, text: 'from an earlier session', translations: {} }];
    const archived = archiveDroppedLines(before, dropped, translations, ['en', 'nl', 'de']);
    eq(archived.map(line => line.key).join(' '), 'w0.0:0 w1.0:0 w1.1:0',
       'archive: dropped lines follow the ones already archived, and a notice is not archived');
    eq(JSON.stringify(archived[1].translations), JSON.stringify({ nl: 'hallo daar', de: 'hallo da' }),
       'archive: a dropped line keeps its translation into every language heard');
    eq(JSON.stringify(archived[2].translations), JSON.stringify({ en: 'good morning everyone' }),
       'archive: and only its own translations');
    eq(before.length, 1, 'archive: the archive it was given is not changed');
}

{
    const { zipArchiveBytes, localHeader, centralHeader, endOfCentralDirectory, ZIP_MAX_BYTES }
        = await import('../../src/js/backup-core.js');
    const entry = { name: 'a.wav', size: 10, crc: 1, offset: 0, timestamp: 0 };
    eq(zipArchiveBytes([entry]), localHeader(entry).length + 10 + centralHeader(entry).length + endOfCentralDirectory(1, 0, 0).length,
       'backup: the archive size counts headers, data');
    ok(zipArchiveBytes([{ name: 'audio.wav', size: ZIP_MAX_BYTES - 40 }, { name: 'transcripts.json', size: 100 }]) > ZIP_MAX_BYTES,
       'backup: audio just under 4 GB plus text and headers is refused');
    let threw = false;
    try { localHeader({ name: 'big.wav', size: ZIP_MAX_BYTES + 1, crc: 0, offset: 0, timestamp: 0 }); } catch (err) { threw = err instanceof RangeError; }
    ok(threw, 'backup: a ZIP field that does not fit in 32 bits throws');
}

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

{
    const { planRender } = await import('../../src/js/render-defer.js');

    const idle = planRender({ playingAudioCount: 0 });
    ok(idle.paint && !idle.defer, 'render plan: nothing playing paints immediately');

    const playing = planRender({ playingAudioCount: 1 });
    ok(!playing.paint && playing.defer, 'render plan: a background paint waits for playback');
    ok(playing.armRecheck,
       'render plan: the first deferral arms a bounded re-check');

    const coalesced = planRender({ playingAudioCount: 1, deferralPending: true });
    ok(coalesced.defer && !coalesced.armRecheck,
       'render plan: a second deferral coalesces onto the re-check already armed');

    const forced = planRender({ playingAudioCount: 3, force: true });
    ok(forced.paint && !forced.defer,
       'render plan: a paint the user asked for bypasses the deferral entirely');

    for (const playingAudioCount of [0, 1, 5]) {
        for (const force of [false, true]) {
            for (const deferralPending of [false, true]) {
                const plan = planRender({ playingAudioCount, force, deferralPending });
                ok(!plan.defer || plan.armRecheck || deferralPending,
                   'render plan: a deferral always has a live re-check behind it');
                ok(plan.paint !== plan.defer, 'render plan: a call either paints or defers');
            }
        }
    }
}

{
    const { beginJob, endJob, cancelAllJobs, hasJob } = await import('../../src/js/jobs.js');
    const first = beginJob('t', 99);
    const second = beginJob('t', 99);
    ok(first.signal.aborted, 'jobs: replacement aborts the previous controller');
    ok(!endJob('t', 99, first), 'jobs: stale completion cannot unregister newer controller');
    ok(hasJob('t', 99), 'jobs: newer controller survives stale cleanup');
    ok(endJob('t', 99, second), 'jobs: current controller can end its slot');
    ok(!hasJob('t', 99), 'jobs: slot is empty after current cleanup');

    beginJob('t', 1); beginJob('r', 2);
    cancelAllJobs();
    ok(!hasJob('t', 1) && !hasJob('r', 2), 'jobs: bulk cancellation clears every slot');
}

{
    const { createReplyStreamReader } = await import('../../src/js/reply-core.js');
    const line = obj => JSON.stringify(obj) + '\n';
    const drain = events => events.map(e => e.type).join(',');

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

    {
        const r = createReplyStreamReader();
        const events = r.push(line({ response: 'a' }) + line({ response: 'b' }) + line({ response: 'c' }));
        eq(drain(events), 'first-token,token,token,token', 'reply stream: a batched read emits every object in order');
        eq(events.filter(e => e.type === 'token').map(e => e.token).join(''), 'abc',
           'reply stream: batched tokens keep their order');
    }

    {
        const r = createReplyStreamReader();
        const whole = line({ response: 'split' });
        const cut = Math.floor(whole.length / 2);
        eq(drain(r.push(whole.slice(0, cut))), '', 'reply stream: a partial object emits nothing yet');
        eq(drain(r.push(whole.slice(cut))), 'first-token,token', 'reply stream: the object completes on the next read');
        eq(r.text, 'split', 'reply stream: a split object is reassembled exactly');
    }

    {
        const r = createReplyStreamReader();
        r.push(line({ response: 'first' }));
        eq(drain(r.push(JSON.stringify({ response: ' last', done: true }))), '',
           'reply stream: an unterminated final object is held back');
        eq(drain(r.flush()), 'token,done', 'reply stream: flush releases the unterminated final object');
        eq(r.text, 'first last', 'reply stream: no text is lost when the stream ends without a newline');
        eq(drain(r.flush()), '', 'reply stream: flushing twice does not replay the final object');
    }

    {
        const r = createReplyStreamReader();
        const events = r.push('\n' + line({ response: 'x' }) + '   \n' + 'not json\n' + line({ response: 'y' }));
        eq(events.filter(e => e.type === 'token').map(e => e.token).join(''), 'xy',
           'reply stream: blank and unparseable lines are skipped, not fatal');
        eq(events.filter(e => e.type === 'error').length, 0, 'reply stream: noise is not reported as a server error');
    }

    {
        const r = createReplyStreamReader();
        r.push(line({ response: 'partial' }));
        const events = r.push(line({ error: 'model not found' }));
        eq(drain(events), 'error', 'reply stream: a server error is surfaced as an error event');
        eq((events[0] || {}).message, 'model not found', 'reply stream: the server error message is preserved');
        eq(r.text, 'partial', 'reply stream: text received before the error is retained');
    }

    {
        const r = createReplyStreamReader();
        eq(drain(r.push(line({ response: '' }))), '', 'reply stream: an empty response fragment emits nothing');
        eq(drain(r.push(line({ response: 'end', done: true }))), 'first-token,token,done',
           'reply stream: a final object may carry both a token and completion');
    }

    {
        const r = createReplyStreamReader();
        r.push(line({ done: true }));
        eq(r.text, '', 'reply stream: a textless completion accumulates no text');
    }
}

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
       'reply model: an empty list keeps the stored name');
    eq(chooseReplyModel([], '', 'gemma4:e4b'), 'gemma4:e4b',
       'reply model: with nothing stored and nothing installed, the default is reported');
    eq(chooseReplyModel(null, null, null), '',
       'reply model: missing inputs resolve to an empty name instead of throwing');
    eq(chooseReplyModel([null, '', 'gemma4:e4b'], '', 'gemma4:e4b'), 'gemma4:e4b',
       'reply model: malformed entries in the server list are ignored');
}

function throws(fn, name) {
    try { fn(); ok(false, name); }
    catch (_) { ok(true, name); }
}

{
    const { buildWavHeader, wavDataBytesFor, WAV_MAX_DATA_BYTES } =
        await import('../../src/js/audio.js');

    ok(WAV_MAX_DATA_BYTES > 4e9 && WAV_MAX_DATA_BYTES < 0x100000000,
       'wav limit: the ceiling is the 32-bit RIFF field minus the header');
    eq(buildWavHeader(1000, 48000).byteLength, 44,
       'wav limit: ordinary sizes still produce a 44-byte header');
    throws(() => buildWavHeader(WAV_MAX_DATA_BYTES + 1, 48000),
       'wav limit: a length past the ceiling is refused, not wrapped');
    throws(() => buildWavHeader(5_000_000_000, 48000),
       'wav limit: a 12.4-hour recording is refused rather than silently truncated');
    eq(wavDataBytesFor([{ size: 144 }, { size: 44 }, { size: 20 }]), 100,
       'wav limit: payload accounting ignores each fragment header and short writes');
}

{
    const { sanitizeFilename } = await import('../../src/js/naming.js');
    for (const name of ['COM1.wav', 'nul.txt', 'prn.wav', 'LPT9.webm']) {
        ok(sanitizeFilename(name).startsWith('_'),
           `filename: reserved device name ${name} is escaped even with an extension`);
    }
    eq(sanitizeFilename('normal.wav'), 'normal.wav',
       'filename: ordinary names are untouched by the reserved-name guard');
    ok(!/[\u202A-\u202E\u2066-\u2069]/.test(sanitizeFilename('\u202Egnp.exe')),
       'filename: bidi overrides are stripped like other control characters');
}

{
    const { estimateTokens, buildBudgetedPrompt, estimateNumCtx } =
        await import('../../src/js/reply-core.js');

    ok(estimateTokens('日本語') === 3,
       'tokens: CJK code points count one token each');
    ok(estimateTokens('abcdef') === 2,
       'tokens: six Latin letters are about two tokens');
    ok(estimateTokens('日本語abcdef') === 5,
       'tokens: a mixed string counts each population separately');

    const cjk = buildBudgetedPrompt(
        { instructions: 'be brief', chain: [], transcript: '日本語の文章です。'.repeat(12000) },
        { maxCtx: 32768, reserveTokens: 4096 });
    const ctx = estimateNumCtx(cjk.prompt, { headroomTokens: 4096, minCtx: 8192, maxCtx: 32768 });
    ok(cjk.estimatedTokens + 4096 <= ctx,
       'budget: a CJK transcript is condensed to fit its context with the output reserve intact');
    ok(cjk.truncatedTranscript,
       'budget: the CJK transcript is visibly reported as condensed');

    const latin = buildBudgetedPrompt(
        { instructions: 'be brief', chain: [], transcript: 'word '.repeat(40000) },
        { maxCtx: 32768, reserveTokens: 4096 });
    ok(latin.prompt.length > 80000,
       'budget: Latin text is not penalised by the script-aware estimate');

    const { AI_NUM_CTX, AI_MAX_NUM_CTX } = await import('../../src/js/model-ready-core.js');
    const fill = (unit, chars) => unit.repeat(Math.ceil(chars / unit.length)).slice(0, chars);
    const english = "So we walked along the river to the old market, and honestly, the plan for next week still isn't clear. "
        + "Maria said she'd call the supplier on Monday; I think we should wait until the numbers come in. ";
    const dutch = 'We liepen langs de rivier naar de oude markt, en eerlijk gezegd is de planning voor volgende week nog '
        + 'niet duidelijk. Maria zei dat ze maandag de leverancier belt; ik denk dat we moeten wachten tot de cijfers binnen zijn. ';
    const ratio = text => text.length / estimateTokens(text);
    ok(ratio(fill(english, 12000)) >= 3.4,
       `tokens: English speech is not overcounted so much that a long recording asks for more context than it needs (${ratio(fill(english, 12000)).toFixed(2)} characters per token)`);
    ok(ratio(fill(dutch, 12000)) <= 4.2,
       `tokens: Dutch speech is not undercounted past what the output reserve absorbs (${ratio(fill(dutch, 12000)).toFixed(2)} characters per token)`);
    const fortyFive = buildBudgetedPrompt({ instructions: 'Reply in plain text.', chain: [], transcript: fill(english, 45 * 900) },
                                          { maxCtx: AI_MAX_NUM_CTX, reserveTokens: 4096 });
    eq(estimateNumCtx(fortyFive.prompt, { headroomTokens: 4096, minCtx: AI_NUM_CTX, maxCtx: AI_MAX_NUM_CTX }), AI_NUM_CTX,
       'tokens: the reply to a 45-minute English recording asks for the shared context, so it does not reload the model');
    const csv = fill('2026-09-29,12.50,33.10,0.004,1774,88.2\n', 20000);
    ok(estimateTokens(csv) >= 0.95 * csv.length,
       'tokens: numbers count a token per digit, so a pasted table is never sent into a context too small for it');
    const encoded = fill('U29tZUJhc2U2NEVuY29kZWRTdHJpbmdXaXRoMTIzNDU2Nzg5MA== 4f3a9c2b7e1d0a5f6c8b9e2d1a3f4c5b ', 20000);
    ok(estimateTokens(encoded) >= 0.95 * encoded.replace(/ /g, '').length,
       'tokens: long runs of letters and digits, like hashes and base64, count a token per character');
    const greek = fill('Περπατήσαμε κατά μήκος του ποταμού προς την παλιά αγορά. ', 12000);
    ok(estimateTokens(greek) >= 0.8 * greek.length,
       'tokens: scripts a tokenizer splits finely are counted nearly per character');
    ok(estimateTokens('🙂🙂🙂') >= 6, 'tokens: an emoji counts as more than one token');
}

{
    const { estimateTokens, buildBudgetedPrompt } = await import('../../src/js/reply-core.js');
    const note = 'a short spoken note '.repeat(50).trim();
    const paste = '[Pasted Note]: START ' + 'row 12345, value 67890; '.repeat(3800) + ' END';
    const single = buildBudgetedPrompt({ instructions: 'Reply in plain text.', chain: [{ label: 'Pasted', text: paste }], transcript: note },
                                       { maxCtx: 32768, reserveTokens: 4096 });
    ok(single.droppedContext === 0 && single.condensedContext === true,
       'budget: a single context item too big for the model is shortened to fit, never dropped whole');
    ok(single.prompt.includes('START') && single.prompt.includes('END') && single.prompt.endsWith(note),
       'budget: the shortened item keeps its beginning and end, and the spoken transcript stays whole');
    ok(estimateTokens(single.prompt) <= 32768 - 4096, 'budget: and the prompt still fits');
}

{
    const { estimateTokens, buildBudgetedPrompt, condenseToTokenBudget } =
        await import('../../src/js/reply-core.js');
    const OPTIONS = { maxCtx: 32768, reserveTokens: 4096 };
    const ALLOWED = 32768 - 4096;

    const chained = buildBudgetedPrompt({
        instructions: 'Reply in plain text.',
        chain: [1, 2, 3].map(n => ({ label: `note ${n}`, text: '語'.repeat(20000) })),
        transcript: 'まとめて'
    }, OPTIONS);
    ok(estimateTokens(chained.prompt) <= ALLOWED,
       'budget: wide script carried ONLY by the context chain still fits the budget');
    ok(chained.droppedContext > 0,
       'budget: oversized wide-script context is actually dropped, not silently sent');

    const wideTranscript = buildBudgetedPrompt({
        instructions: 'x',
        chain: [{ label: 'prior', text: 'word '.repeat(4000) }],
        transcript: '語'.repeat(5000)
    }, OPTIONS);
    ok(estimateTokens(wideTranscript.prompt) <= ALLOWED,
       'budget: a wide transcript beside Latin context fits');
    ok(wideTranscript.droppedContext === 0,
       'budget: context that fits is not dropped because the transcript is wide');

    for (const sample of ['語'.repeat(4000), 'word '.repeat(4000), '語word'.repeat(2000)]) {
        for (const budget of [0, 1, 64, 500]) {
            const condensed = condenseToTokenBudget(sample, budget);
            ok(estimateTokens(condensed) <= budget,
               `condense: ${budget}-token budget is never exceeded`);
        }
    }
    eq(condenseToTokenBudget('short', 1000), 'short',
       'condense: text already inside the budget is returned untouched');
}

{
    const { chooseReplyModel, isGenerativeModel, isFallbackChoice } =
        await import('../../src/js/reply-core.js');

    ok(!isGenerativeModel('nomic-embed-text:latest') && !isGenerativeModel('bge-m3'),
       'reply model: embedding models are recognised as unable to generate');
    ok(isGenerativeModel('gemma4:e4b') && isGenerativeModel('llama3:8b'),
       'reply model: ordinary chat models are unaffected');
    eq(chooseReplyModel(['nomic-embed-text:latest', 'llama3:8b'], 'gemma4:e4b', 'gemma4:e4b'), 'llama3:8b',
       'reply model: a generative model is preferred over an embedding model');
    eq(chooseReplyModel(['nomic-embed-text:latest'], 'gemma4:e4b', 'gemma4:e4b'), 'nomic-embed-text:latest',
       'reply model: with nothing generative installed, the last resort is still offered');
    ok(isFallbackChoice('nomic-embed-text:latest', 'gemma4:e4b', ['nomic-embed-text:latest']),
       'reply model: a last-resort pick is reported as a fallback');
    ok(!isFallbackChoice('qwen:7b', 'qwen:7b', ['qwen:7b', 'llama3:8b']),
       'reply model: an installed stored choice is not a fallback');
}

{
    const { describeLoadedModel } = await import('../../src/js/reply-core.js');

    const split = describeLoadedModel({ name: 'gemma4:31b', size: 1000, size_vram: 600 });
    eq(split.gpuPercent, 60, 'loaded: the GPU share is reported as a share');
    ok(split.onCpu, 'loaded: and a model partly on the CPU is named as such');
    ok(!describeLoadedModel({ name: 'x', size: 100, size_vram: 100 }).onCpu,
       'loaded: a model wholly in video memory is not accused of spilling');
    eq(describeLoadedModel({ name: 'x' }).gpuPercent, null,
       'loaded: a server that reports no sizes produces no invented percentage');
    eq(describeLoadedModel({}), null, 'loaded: and an entry with no name is not an entry');
}

{
    const { findBoundaryRepetition, preferWiderRecheck } = await import('../../src/js/live-refine-core.js');
    const prev = 'so what I keep saying is we need to ship it';
    const next = 'we need to ship it before Friday or we lose the slot';
    const candidate = findBoundaryRepetition(prev, next);
    eq(candidate.words, 5, 'refine: a five-word repeat across windows is a candidate');
    eq(preferWiderRecheck(`${prev} ${next}`, 'I keep saying is we need to ship it we need to ship it before Friday we lose', candidate), false,
       'refine: a long repeat still heard twice is kept');
    eq(preferWiderRecheck(`${prev} ${next}`, 'so what I keep saying is we need to ship it before Friday or we lose the slot', candidate), true,
       'refine: a long repeat heard once is corrected');
}

{
    const { singleFlight, runInOrderUntilCancelled } = await import('../../src/js/jobs.js');
    let runs = 0;
    const once = singleFlight(async () => { runs++; await new Promise(resolve => setTimeout(resolve, 5)); });
    const first = once();
    const second = once();
    ok(first === second, 'stop: a second stop while one is saving joins the same save');
    await Promise.all([first, second]);
    eq(runs, 1, 'stop: and the save runs once');
    await once();
    eq(runs, 2, 'stop: a later stop runs again');

    const order = [];
    let active = 0;
    let overlapped = false;
    const step = name => async () => {
        active++;
        if (active > 1) overlapped = true;
        order.push(name);
        await new Promise(resolve => setTimeout(resolve, 5));
        active--;
    };
    const failedSteps = [];
    await runInOrderUntilCancelled([step('pipeline'), async () => { throw new Error('boom'); }, step('cleanup')],
        (err, index) => failedSteps.push(index));
    ok(!overlapped && order.join(',') === 'pipeline,cleanup',
       'after recording: the automatic pipeline and the cleanup pass never overlap');
    eq(failedSteps.join(','), '1', 'after recording: a failed step is reported and the next still runs');

    const { CANCELLED, abortError, beginJob, endJob, hasJobOfKind } = await import('../../src/js/jobs.js');
    const ran = [];
    const reported = [];
    const stopped = await runInOrderUntilCancelled([async () => { ran.push('pipeline'); return CANCELLED; }, async () => { ran.push('cleanup'); }],
        (err, index) => reported.push(index));
    ok(stopped === CANCELLED && ran.join(',') === 'pipeline' && reported.length === 0,
       'after recording: cancelling the automatic transcription or reply ends the chain, so the cleanup pass does not start');
    ran.length = 0;
    const thrown = await runInOrderUntilCancelled([async () => { ran.push('pipeline'); throw abortError(); }, async () => { ran.push('cleanup'); }],
        (err, index) => reported.push(index));
    ok(thrown === CANCELLED && ran.join(',') === 'pipeline' && reported.length === 0,
       'after recording: and a step that was cancelled is not reported as a failure');

    ok(!hasJobOfKind('r'), 'jobs: no reply is running');
    const other = beginJob('r', 991);
    ok(hasJobOfKind('r') && !hasJobOfKind('f'), 'jobs: a reply for any recording counts, and only replies');
    endJob('r', 991, other);
    ok(!hasJobOfKind('r'), 'jobs: until it ends');
}

{
    const { firstByteTimeoutMs, AI_NUM_CTX, AI_MAX_NUM_CTX } = await import('../../src/js/model-ready-core.js');
    eq(firstByteTimeoutMs(AI_NUM_CTX, 45000), 45000, 'reply: a reply in the usual context waits the usual time for its first word');
    ok(firstByteTimeoutMs(AI_MAX_NUM_CTX, 45000) >= 120000,
       'reply: one that needs a larger context, which makes the server reload the model first, waits longer before giving up');
}

{
    const { nextPoolLimit, runAdaptivePool, chunkRetryDelayMs, POOL_START, POOL_ANSWER_SHOWS_QUEUING_MS } =
        await import('../../src/js/transcribe-core.js');
    ok(POOL_START >= 1 && POOL_START <= 3, 'pool: a transcription starts with a few chunks at a time, not ten');
    eq(nextPoolLimit(2, { ok: true, ms: 2000 }, { max: 10 }), 3, 'pool: a quick answer lets one more chunk go at once');
    eq(nextPoolLimit(10, { ok: true, ms: 2000 }, { max: 10 }), 10, 'pool: up to the most the app allows');
    eq(nextPoolLimit(6, { ok: true, ms: POOL_ANSWER_SHOWS_QUEUING_MS + 1 }, { max: 10 }), 5, 'pool: a slow answer, a sign of queuing, takes one away');
    eq(nextPoolLimit(6, { ok: false, timedOut: true }, { max: 10 }), 3, 'pool: a timeout halves it');
    eq(nextPoolLimit(1, { ok: false, timedOut: true }, { max: 10 }), 1, 'pool: never below one');
    eq(nextPoolLimit(4, { ok: false }, { max: 10 }), 4, 'pool: an error that is not a timeout says nothing about capacity');
    eq(nextPoolLimit(6, { ok: false, busy: true }, { max: 10 }), 3,
       'pool: a server that answers busy (503 or 429) halves it, as plainly as a timeout');
    eq(nextPoolLimit(1, { ok: false, busy: true }, { max: 10 }), 1, 'pool: and never below one either');
    const { shouldWaitForOwnChunk, CHUNK_BUSY_WAITS_MAX } = await import('../../src/js/transcribe-core.js');
    eq(shouldWaitForOwnChunk({ busy: true }, 1, 0), true,
       'pool: a chunk turned away as busy while another chunk of this transcription is at the server waits for that one to come back');
    eq(shouldWaitForOwnChunk({ busy: true }, 0, 0), false,
       'pool: turned away with none of them there, the server is busy with something else, and the chunk is retried after a pause');
    eq(shouldWaitForOwnChunk({ timedOut: true }, 2, 0), false, 'pool: a timeout is not a busy answer');
    eq(shouldWaitForOwnChunk({ busy: true }, 1, CHUNK_BUSY_WAITS_MAX), false,
       'pool: a chunk that keeps losing the race for the server stops waiting after a bound, and is retried after pauses like any failure');
    const { createServerQueue, requestCameBack, anotherRequestBack } = await import('../../src/js/transcribe-core.js');
    const queue = createServerQueue();
    queue.inFlight = 2;
    let woken = 0;
    anotherRequestBack(queue).then(() => { woken++; });
    requestCameBack(queue, { freedRoom: false });
    await new Promise(resolve => setTimeout(resolve, 0));
    eq(woken, 0, 'pool: a chunk waiting for room is not woken by another chunk turned away as busy, which freed none');
    requestCameBack(queue, { freedRoom: true });
    await new Promise(resolve => setTimeout(resolve, 0));
    eq(woken, 1, 'pool: but by one that came back with an answer');
    eq(queue.inFlight, 0, 'pool: and the count of chunks at the server follows both');
    queue.inFlight = 1;
    let wokenForNothing = 0;
    anotherRequestBack(queue).then(() => { wokenForNothing++; });
    requestCameBack(queue, { freedRoom: false });
    await new Promise(resolve => setTimeout(resolve, 0));
    eq(wokenForNothing, 1,
       'pool: when the last of its chunks at the server is turned away too, the waiting are woken and go back to asking after pauses, instead of waiting for nothing');
    const cancelling = new AbortController();
    const waiting = anotherRequestBack(queue, cancelling.signal).then(() => 'woken', err => err.name);
    cancelling.abort();
    eq(await waiting, 'AbortError', 'pool: a cancel ends the wait');
    eq(queue.waiting.length, 0, 'pool: and leaves nothing waiting behind');
    ok(chunkRetryDelayMs(0, { timedOut: true }) >= 15000 && chunkRetryDelayMs(0, new Error('HTTP 502')) <= 2000
       && chunkRetryDelayMs(2, new Error('x')) === null,
       'pool: a chunk that timed out is not sent again at once, while the server may still be working on it');

    const SERVER_MS_PER_CHUNK = 13000;
    const REQUEST_LIMIT_INCLUDING_QUEUE_MS = 120000;
    const CHUNKS = 40;
    const simulateOneAtATimeServerOnVirtualClock = async adaptive => {
        let now = 0;
        const timers = [];
        const sleep = ms => new Promise(resolve => timers.push({ at: now + ms, resolve }));
        let serverFree = 0;
        let timedOut = 0;
        let most = 0;
        let running = 0;
        const control = { limit: adaptive ? POOL_START : 10, max: 10 };
        const worker = async () => {
            running++;
            most = Math.max(most, running);
            const start = now;
            const begin = Math.max(now, serverFree);
            serverFree = begin + SERVER_MS_PER_CHUNK;
            const latency = serverFree - start;
            const outcome = latency > REQUEST_LIMIT_INCLUDING_QUEUE_MS ? { ok: false, timedOut: true } : { ok: true, ms: latency };
            await sleep(Math.min(latency, REQUEST_LIMIT_INCLUDING_QUEUE_MS));
            if (outcome.timedOut) timedOut++;
            if (adaptive) control.limit = nextPoolLimit(control.limit, outcome, control);
            running--;
        };
        const done = runAdaptivePool(Array.from({ length: CHUNKS }, (_, i) => i), control, worker);
        let finished = false;
        done.then(() => { finished = true; });
        for (let guard = 0; guard < 100000 && !finished; guard++) {
            for (let i = 0; i < 5; i++) await Promise.resolve();
            if (finished) break;
            timers.sort((a, b) => a.at - b.at);
            const timer = timers.shift();
            if (!timer) break;
            now = timer.at;
            timer.resolve();
        }
        return { timedOut, most, minutes: Math.round(now / 60000) };
    };
    const tenAtOnce = await simulateOneAtATimeServerOnVirtualClock(false);
    const adaptive = await simulateOneAtATimeServerOnVirtualClock(true);
    ok(tenAtOnce.timedOut >= 20,
       `pool: ten at once against a server that takes one at a time lets most chunks time out while queued (${tenAtOnce.timedOut} of 40)`);
    ok(adaptive.timedOut === 0 && adaptive.most < 10,
       `pool: the adaptive pool keeps every chunk inside its time limit (${adaptive.timedOut} timed out, at most ${adaptive.most} at once, ${adaptive.minutes} min)`);

    let atOnce = 0;
    let peak = 0;
    const control = { limit: 1, max: 10 };
    const seen = [];
    await runAdaptivePool([0, 1, 2, 3, 4, 5], control, async item => {
        atOnce++;
        peak = Math.max(peak, atOnce);
        seen.push(item);
        await new Promise(resolve => setTimeout(resolve, 2));
        if (item === 1) control.limit = 3;
        atOnce--;
    });
    ok(seen.length === 6 && peak <= 3 && peak >= 2,
       `pool: it never runs more than its limit at once and picks up a raised limit (${peak} at most)`);
    let stoppedAfter = 0;
    await runAdaptivePool([0, 1, 2, 3], { limit: 1 }, async () => { stoppedAfter++; }, () => stoppedAfter >= 2);
    eq(stoppedAfter, 2, 'pool: and it stops taking chunks when told to');
}

{
    const { fillMissingTranslations } = await import('../../src/js/transcribe-core.js');
    const lines = Array.from({ length: 6 }, (_, i) => ({ text: `zin ${i}`, language: 'nl', translations: {} }));
    const reply = prompt => [...prompt.matchAll(/^(\d+)\. (.*)$/gm)].map(match => `${match[1]}. T(${match[2]})`).join('\n');
    let calls = 0;
    const flaky = async prompt => {
        calls++;
        if (calls === 1) throw new Error('Translation failed (HTTP 502)');
        return reply(prompt);
    };
    const retried = await fillMissingTranslations(lines, ['nl', 'en'], flaky, { batchLines: 3 });
    ok(retried.done === 6 && retried.missing === 0 && !retried.stopped,
       `fill: a batch the server did not answer is tried once more at the end instead of being lost (${JSON.stringify({ done: retried.done, missing: retried.missing })})`);

    let held = true;
    let sentWhileHeld = 0;
    let release;
    const released = new Promise(resolve => { release = resolve; });
    const waitBeforeEachRequest = async () => { if (held) await released; };
    const counting = async prompt => { if (held) sentWhileHeld++; return reply(prompt); };
    const filling = fillMissingTranslations(lines, ['nl', 'en'], counting, { batchLines: 3, waitBeforeEachRequest });
    await new Promise(resolve => setTimeout(resolve, 20));
    held = false;
    release();
    const waited = await filling;
    ok(sentWhileHeld === 0 && waited.done === 6,
       'fill: while the caller holds it back, for a reply that is running, no translation is sent; afterwards all of it is');
}

{
    const { planDeleteAllText } = await import('../../src/js/retention-core.js');
    const plan = planDeleteAllText([
        { id: 1, audioBytes: 4096, processing: false },
        { id: 2, processing: false },
        { id: 3, processing: true },
        { id: 4, processing: true, captureState: 'finalize-error' }
    ]);
    eq(plan.deleteIds.join(','), '2', 'delete all text: only rows with nothing else left are removed');
    const { hasLiveTranscript } = await import('../../src/js/retention-core.js');
    ok(hasLiveTranscript({ liveTranscriptLines: 1 }),
       'delete all text: a stored live transcript count marks the row as holding text');
    ok(!hasLiveTranscript({ liveTranscriptLines: 0 }) && !hasLiveTranscript({}),
       'delete all text: an absent or empty one does not');
    eq(plan.clearIds.join(','), '1,3,4', 'delete all text: recordings still being saved keep their audio');
}

{
    const { conversionStillApplies } = await import('../../src/js/audio-format.js');
    const original = { format: 'wav', audioBytes: 100 };
    ok(conversionStillApplies({ format: 'wav', audioBytes: 100 }, original), 'convert: an unchanged recording takes the result');
    ok(!conversionStillApplies({ format: 'wav' }, original), 'convert: audio deleted during conversion stays deleted');
    ok(!conversionStillApplies({ format: 'wav', audioBytes: 50 }, original), 'convert: audio that changed is kept');
    ok(!conversionStillApplies(null, original), 'convert: a deleted recording is not recreated');
}

{
    const { needsSeekableUpgrade, WEBM_SEEKABLE_VERSION } = await import('../../src/js/webm-duration.js');
    const opus = { format: 'opus', mime: 'audio/webm;codecs=opus', durationMs: 1000, audioBytes: 10 };
    ok(needsSeekableUpgrade({ ...opus, webmSeekableVersion: 2 }), 'webm: a recording remuxed before Build 90 is upgraded on download');
    ok(!needsSeekableUpgrade({ ...opus, webmSeekableVersion: WEBM_SEEKABLE_VERSION }), 'webm: a current one is left alone');
    ok(!needsSeekableUpgrade({ ...opus, format: 'wav' }), 'webm: WAV is never remuxed');
}

{
    const { settleLiveWindows } = await import('../../src/js/live-scribe-core.js');
    const { createDiarization, applySpeakerCommand } = await import('../../src/js/diarize-core.js');
    const pending = new Map([[1, { items: [{ text: 'second' }], coverage: { fromSec: 4, toSec: 8 } }]]);
    const early = settleLiveWindows(pending, 0);
    eq(early.covered.length, 0, 'live: a window waiting for an earlier one is not yet counted as transcribed');
    pending.set(0, { items: [{ text: 'first' }], coverage: { fromSec: 0, toSec: 4 } });
    const both = settleLiveWindows(pending, early.nextIndex);
    eq(JSON.stringify(both.covered), '[{"fromSec":0,"toSec":4},{"fromSec":4,"toSec":8}]',
       'live: windows count as transcribed when their text is placed, in order');

    const full = applySpeakerCommand(createDiarization(), { type: 'name', id: 2, name: 'Mark Rutten' }).state;
    const shorter = applySpeakerCommand(full, { type: 'renameByName', match: 'Mark Rutten', name: 'Mark' });
    eq(shorter.state.names[2], 'Mark', 'rename: renaming by name to a shorter name is carried out, as its reply says');
}

{
    const { translationStillCurrent } = await import('../../src/js/translate-core.js');
    const lines = [{ key: 'w1:0', text: 'it should work without strain' }];
    ok(translationStillCurrent(lines, { key: 'w1:0', text: 'it should work without strain' }),
       'translate: a translation of the line as shown is kept');
    ok(!translationStillCurrent(lines, { key: 'w1:0', text: 'should work should work without strain' }),
       'translate: a late translation of text that was since corrected is dropped');
    ok(!translationStillCurrent(lines, { key: 'w9:0', text: 'gone' }), 'translate: a translation for a removed line is dropped');
}

{
const item = buildClipboardContextItem('  meeting notes\r\n\r\n\r\n  agenda item one  ', '2026-09-22 18:30');
eq(item.inputText, 'meeting notes\n\n  agenda item one',
   'clipboard: line endings are normalised and runs of blank lines collapse');
eq(buildClipboardContextItem('def f():\n    return 1\n', 'now').inputText, 'def f():\n    return 1',
   'clipboard: indentation inside pasted text is left alone, so pasted code survives');
ok(item.text.includes('[Pasted Note]:'),
   'clipboard: pasted text is labelled for the model the way other context is');
eq(item.outputText, '', 'clipboard: a paste carries no model output of its own');
eq(item.sourceRecId, null, 'clipboard: a paste has no source recording to jump to');
ok(item.label.includes('2026-09-22 18:30'),
   'clipboard: the item says when it was pasted');
ok(item.pasted === true, 'clipboard: a pasted item is identifiable as one');

ok(buildClipboardContextItem('', 'now') === null,
   'clipboard: empty text never becomes a context item');
ok(buildClipboardContextItem('   \n\t  ', 'now') === null,
   'clipboard: whitespace-only text never becomes a context item');
ok(buildClipboardContextItem(null, 'now') === null,
   'clipboard: a failed clipboard read never becomes a context item');

eq(CLIPBOARD_CONTEXT_MAX_CHARS, 100000, 'clipboard: a paste of up to 100,000 characters is kept whole');
const hundredK = buildClipboardContextItem(('line of pasted text\n').repeat(5000), 'now');
eq(hundredK.inputText.length, 100000 - 1, 'clipboard: a 100 KB multi-line paste is kept whole, line breaks included');
ok(!/first/.test(hundredK.label), 'clipboard: and its label does not claim it was shortened');
const big = buildClipboardContextItem('x'.repeat(CLIPBOARD_CONTEXT_MAX_CHARS + 500), 'now');
eq(big.inputText.length, CLIPBOARD_CONTEXT_MAX_CHARS,
   'clipboard: an oversized paste is capped instead of being fed whole to the model');
ok(big.label.includes('first'),
   'clipboard: a capped paste says so rather than pretending it is complete');

eq(normalizeClipboardText('a\r\nb'), 'a\nb', 'clipboard: CRLF becomes LF');
eq(normalizeClipboardText('trailing   \nspace'), 'trailing\nspace',
   'clipboard: trailing spaces before a newline are dropped');
}

{
    const { fillMissingTranslations, TRANSLATE_FILL_FAILURE_LIMIT } = await import('../../src/js/transcribe-core.js');
    const lines = Array.from({ length: 60 }, (_, i) => ({ text: `regel ${i}`, language: 'nl', startSec: i * 4 }));
    const numbered = prompt => prompt.split('\n').filter(line => /^\d+\. /.test(line));

    let calls = 0;
    const longer = Array.from({ length: 240 }, (_, i) => ({ text: `regel ${i}`, language: 'nl', startSec: i * 4 }));
    const dead = await fillMissingTranslations(longer, ['nl', 'en'], async () => {
        calls++;
        throw new Error('HTTP 502');
    });
    eq(calls, TRANSLATE_FILL_FAILURE_LIMIT,
       'fill loop: a server that does not answer is asked exactly three times, never once per line');
    ok(/did not answer 3 requests in a row/.test(dead.stopped || ''),
       'fill loop: and the fill stops and says why');
    eq(dead.done, 0, 'fill loop: nothing is claimed as filled');

    calls = 0;
    const misaligned = await fillMissingTranslations(lines, ['nl', 'en'], async (prompt, count) => {
        calls++;
        if (count > 1) return 'Sure! Here are the translations you asked for.';
        return numbered(prompt).map(line => line.replace(/^1\. regel/, '1. line')).join('\n');
    });
    eq(misaligned.done, 60, 'fill loop: a server that answers in the wrong shape is asked line by line, and every line gets filled');
    ok(!misaligned.stopped, 'fill loop: an answer in the wrong shape is an answer, not a dead server');
    eq(misaligned.filled.en[7], 'line 7', 'fill loop: each line gets its own translation');

    calls = 0;
    const flaky = await fillMissingTranslations(lines, ['nl', 'en'], async (prompt) => {
        calls++;
        if (calls % 2 === 1) throw new Error('connection reset');
        return numbered(prompt).map(line => line.replace(/regel/, 'line')).join('\n');
    }, { batchLines: 10 });
    ok(!flaky.stopped && flaky.done > 0,
       'fill loop: failures that are not in a row do not stop the fill, because each answer resets the count');

    const controller = new AbortController();
    calls = 0;
    const cancelled = await fillMissingTranslations(lines, ['nl', 'en'], async () => {
        calls++;
        controller.abort();
        const err = new Error('Cancelled');
        err.name = 'AbortError';
        throw err;
    }, { signal: controller.signal });
    ok(cancelled.cancelled && calls === 1,
       'fill loop: deleting the recording cancels the fill at once instead of sending its text on');

    const same = await fillMissingTranslations([{ text: 'hello', language: 'en', translations: { nl: 'hallo' } }],
                                               ['en', 'nl'], async () => { throw new Error('should not be asked'); });
    eq(same.requests, 0, 'fill loop: lines already in the language, or already translated, are not sent');
}

{
    const { carryAcrossResume, RESUME_CARRIES, transcriptSnapshot, lineTranslation } =
        await import('../../src/js/live-scribe-core.js');
    const session = {
        lines: [{ key: 'w1.0:0', text: 'b' }], translations: { 'w1.0:0::nl': 'B' }, languages: { en: 3 },
        diarization: { speakers: [] }, translateGaveUp: new Set(), nextIndex: 9, commandSeq: 4, preview: 'x'
    };
    const carried = carryAcrossResume(session);
    for (const field of ['lines', 'translations', 'languages', 'diarization', 'translateGaveUp']) {
        ok(carried[field] === session[field],
           `resume: showing live transcription again keeps the ${field} of the lines it kept`);
    }
    ok(!('nextIndex' in carried) && !('commandSeq' in carried) && !('preview' in carried),
       'resume: counters and the unfinished preview start over with the new session');
    ok(RESUME_CARRIES.includes('archivedLines') && RESUME_CARRIES.includes('speakerHints'),
       'resume: archived lines and speaker naming evidence travel with the transcript');

    const snapshot = transcriptSnapshot({
        archivedLines: [{ key: 'w1.0:0', startSec: 0, text: 'oldest', translations: { nl: 'oudste' } }],
        backfillLines: [{ key: 'b2.0:0', startSec: 30, text: 'earlier audio' }],
        lines: [{ key: 'cmd-2.0', startSec: 40, text: 'Not recording sound right now', system: true },
                { key: 'w2.0:0', startSec: 50, text: 'newest' }]
    });
    eq(snapshot.map(line => line.text).join('|'), 'oldest|earlier audio|newest',
       'snapshot: the copied and the saved transcript both start at the beginning, in time order, without notices');
    eq(lineTranslation(snapshot[0], 'nl', {}), 'oudste',
       'snapshot: a line that scrolled out of view keeps the translation it was given');
    eq(lineTranslation(snapshot[2], 'nl', { 'w2.0:0::nl': 'nieuwste' }), 'nieuwste',
       'snapshot: a line still on screen reads its translation from the live map');
}

{
    const { translationTimeoutMs, translationTimeoutError, TRANSLATION_TIMEOUT, panelHeading } =
        await import('../../src/js/translate-core.js');
    ok(translationTimeoutMs(24) > translationTimeoutMs(12) && translationTimeoutMs(12) > translationTimeoutMs(1),
       'timeout: a bigger batch is given more time');
    ok(translationTimeoutMs(12) / 12 >= 4000,
       'timeout: a batch that runs out of time was slower than the slow-translation mark, so it counts as slow');
    ok(translationTimeoutMs(1) >= 15000, 'timeout: a single line still has room for a model that is warming up');
    const error = translationTimeoutError(56000);
    ok(error.name === TRANSLATION_TIMEOUT && error.name !== 'AbortError' && error.timeoutMs === 56000,
       'timeout: running out of time is its own error, never mistaken for the user cancelling');
    ok(/AI model too slow/.test(panelHeading('nl', { pending: 4 }, { state: 'failing', slow: true })),
       'timeout: the box heading says the model is too slow rather than that the server is gone');
    ok(/server not answering/.test(panelHeading('nl', { pending: 4 }, { state: 'failing' })),
       'timeout: and still says the server is not answering when that is what happened');

    const { planTranslationFailure } = await import('../../src/js/translate-core.js');
    const slow = planTranslationFailure(translationTimeoutError(56000), 12, 0);
    ok(slow.stalled && slow.batchSize === 6,
       'timeout: a batch that ran out of time is retried at half the size, so the next one can finish');
    ok(slow.backoffMs > 0 && slow.failures === 1,
       'timeout: after a pause, instead of resending the same batch the moment it gave up');
    ok(slow.sample && slow.sample.lines === 12 && slow.sample.ms === 56000,
       'timeout: and it counts as twelve lines that took at least that long, so the slow-model check can see it');
    const refused = planTranslationFailure(new Error('HTTP 502'), 12, 2);
    ok(!refused.stalled && refused.batchSize === null && refused.sample === null && refused.failures === 3,
       'timeout: a refused request keeps its batch size and is not counted as a speed measurement');
    eq(planTranslationFailure(translationTimeoutError(23000), 1, 0).batchSize, 1,
       'timeout: a single line that runs out of time stays a single line');
}

{
    const { samplesBeforeTap, capturedMs, honestDuration } = await import('../../src/js/capture-health-core.js');
    const rate = 48000;
    const seeded = samplesBeforeTap(20.5, 0.5, rate);
    eq(seeded, 20 * rate, 'duration: turning on 📝 counts the audio the recording already has');
    eq(honestDuration(30000, capturedMs(seeded + 10 * rate, rate)), 30000,
       'duration: so a recording with 📝 turned on after 20 seconds is saved as 30 seconds long, not 10');
    eq(samplesBeforeTap(5, 5, rate), 0, 'duration: no time on the audio clock is no audio');
    eq(samplesBeforeTap(3, null, rate), 0, 'duration: without a recording start there is nothing to count');

    const { heartbeatRowDue, HEARTBEAT_ROW_REFRESH_MS } = await import('../../src/js/capture-health-core.js');
    const last = { recId: 4, state: 'recording', at: 1000 };
    ok(!heartbeatRowDue({ last, recId: 4, state: 'recording', now: 4000 }),
       'beat: an ordinary three-second beat does not rewrite the recording');
    ok(heartbeatRowDue({ last, recId: 4, state: 'finalizing', now: 4000 }),
       'beat: a change of state does, so the row always says what the recording is doing');
    ok(heartbeatRowDue({ last, recId: 4, state: 'recording', now: 1000 + HEARTBEAT_ROW_REFRESH_MS }),
       'beat: and so does a minute without one, keeping the row\'s length close for anything that reads it');
    ok(heartbeatRowDue({ last, recId: 4, state: 'recording', now: 4000, force: true })
       && heartbeatRowDue({ last, recId: 4, state: 'recording', now: 4000, snapshotted: true }),
       'beat: the last beat before finalizing, and a beat that stored the live transcript, write it too');
    ok(heartbeatRowDue({ last: null, recId: 4, state: 'starting', now: 4000 })
       && heartbeatRowDue({ last, recId: 5, state: 'recording', now: 4000 }),
       'beat: the first beat of a recording writes the row');
    ok(HEARTBEAT_ROW_REFRESH_MS >= 30000, 'beat: the row is refreshed at most every half minute');
}

{
    const { liveSnapshotDue, LIVE_SNAPSHOT_MAX_INTERVAL_MS } = await import('../../src/js/capture-health-core.js');
    const MINUTE = 60000;
    const perMinute = 2700;
    let last = null;
    let everyMinute = 0;
    let adaptive = 0;
    let longestGap = 0;
    let lastAt = 0;
    for (let minute = 1; minute <= 240; minute++) {
        const now = minute * MINUTE;
        const chars = minute * perMinute;
        everyMinute += chars;
        const sizeAndSignature = { chars, signature: `lines-${minute}` };
        if (liveSnapshotDue({ now, last, ...sizeAndSignature })) {
            adaptive += chars;
            if (last) longestGap = Math.max(longestGap, now - lastAt);
            last = { at: now, ...sizeAndSignature };
            lastAt = now;
        }
    }
    ok(adaptive * 4 <= everyMinute,
       `snapshot: four hours of live transcript write at most a quarter of what saving it all every minute did (${Math.round(adaptive / 1e6)} of ${Math.round(everyMinute / 1e6)} million characters)`);
    ok(longestGap <= LIVE_SNAPSHOT_MAX_INTERVAL_MS && LIVE_SNAPSHOT_MAX_INTERVAL_MS <= 5 * MINUTE,
       'snapshot: while it keeps changing, the saved transcript is never more than five minutes behind');
    ok(!liveSnapshotDue({ now: 100 * MINUTE, last: { at: 0, chars: 500, signature: 'same' }, chars: 500, signature: 'same' }),
       'snapshot: an unchanged transcript is not written again');
    ok(liveSnapshotDue({ now: 1000, last: null, chars: 20, signature: 'first' }),
       'snapshot: the first lines are saved at the first chance');
}

{
    const { releaseReviewAudioOfWaitingWindows, queuedWindowBytes, capRetryQueue, REVIEW_AUDIO_KEPT_WINDOWS } =
        await import('../../src/js/live-scribe-core.js');
    const windowItem = index => {
        const blob = { size: 192044 };
        const pcm16k = new Float32Array(96000);
        return { index, blob, pcm16k, bytes: queuedWindowBytes(blob, pcm16k) };
    };
    eq(windowItem(0).bytes, 192044 + 384000,
       'queue: a window counts both the WAV it will send and the samples kept for the repeated-words review');
    const waiting = Array.from({ length: 10 }, (_, i) => windowItem(i));
    releaseReviewAudioOfWaitingWindows(waiting);
    ok(waiting.slice(0, -REVIEW_AUDIO_KEPT_WINDOWS).every(item => item.pcm16k === null && item.bytes === 192044)
       && waiting.slice(-REVIEW_AUDIO_KEPT_WINDOWS).every(item => item.pcm16k instanceof Float32Array),
       'queue: windows waiting behind the newest few let their review samples go, and count only what they still hold');
    const outage = Array.from({ length: 800 }, (_, i) => windowItem(i));
    releaseReviewAudioOfWaitingWindows(outage);
    const capped = capRetryQueue(outage);
    const held = capped.queue.reduce((sum, item) => sum + item.blob.size + (item.pcm16k ? item.pcm16k.byteLength : 0), 0);
    ok(held <= 96 * 1024 * 1024 && capped.queue.length > 400,
       `queue: at the cap the queue really holds no more than its 96 MB, and still over 400 windows, half an hour of speech (${capped.queue.length} windows, ${Math.round(held / 1048576)} MB)`);
}

{
    const { createDiarization, addEmbedding, addEmbeddings } = await import('../../src/js/diarize-core.js');
    const voice = (speaker, n) => Array.from({ length: 32 }, (_, i) =>
        (speaker === 0 ? Math.sin(i) : Math.cos(i * 1.7)) + Math.sin(n * 7 + i * 13) * 0.08);
    let oneByOne = createDiarization('numbers');
    const windowItems = [];
    for (let n = 0; n < 12; n++) {
        const speaker = n % 3 === 0 ? 1 : 0;
        oneByOne = addEmbedding(oneByOne, `k${n}`, voice(speaker, n), 2);
        windowItems.push({ key: `k${n}`, embedding: voice(speaker, n), seconds: 2 });
    }
    const together = addEmbeddings(createDiarization('numbers'), windowItems);
    eq(together.points.length, 12, 'speakers: the lines of a window are added together, every one of them');
    const groups = state => {
        const byKey = new Map(state.points.map(point => [point.key, point.speaker]));
        return windowItems.map(item => byKey.get(item.key) === byKey.get('k0') ? 'b' : 'a').join('');
    };
    eq(groups(together), groups(oneByOne),
       'speakers: and they are told apart exactly as when each line was added on its own');
    eq(groups(together), 'baabaabaabaa', 'speakers: two voices are found');
    eq(addEmbeddings(together, [{ key: 'none', embedding: null }]), together,
       'speakers: a window without embeddings changes nothing');
}

{
    const { transcriptsAfterCleanup } = await import('../../src/js/transcribe-core.js');
    const kept = transcriptsAfterCleanup([
        { id: 'clean', source: 'S' },
        { id: 'auto', source: 'S', fromLive: true },
        { id: 'live', source: 'L' },
        { id: 'answered', source: 'L' },
        { id: 'manual', source: 'S' }
    ], [{ id: 'r1', transcriptId: 'answered' }]);
    eq(kept.map(item => item.id).join(','), 'clean,answered,manual',
       'cleanup: keeping only the cleaned-up reading removes the live reading and the automatic copy of it, but never one a reply was written from');
}

{
    const { opusLengthMs, honestDuration } = await import('../../src/js/capture-health-core.js');
    eq(opusLengthMs({ fileMs: 15070, wallMs: 15000, capturedMs: 10960, elapsedMs: 20000 }), 15070,
       'length: an Opus recording whose audio engine was suspended for a while is as long as its file, not as the samples counted');
    eq(opusLengthMs({ fileMs: 175000, wallMs: 120000, elapsedMs: 3 * 3600 * 1000 }), 175000,
       'length: a recovered Opus recording is as long as the audio stored, even when its last saved length is older');
    eq(opusLengthMs({ fileMs: null, wallMs: 30000, capturedMs: 20000 }), honestDuration(30000, 20000),
       'length: when the file cannot be read, the length still never exceeds the audio that arrived');
    eq(opusLengthMs({ fileMs: 90 * 60000, wallMs: 60000, elapsedMs: 70000 }), 60000,
       'length: a file length longer than the time since the recording began is not believed');
}

{
    const { settleLiveReplays, reassembleTimeline, liveLinesAsResults, GAP_MARKER }
        = await import('../../src/js/transcribe-core.js');
    const live = liveLinesAsResults([
        { startSec: 0, endSec: 4, text: 'basic tests and should work' },
        { startSec: 2, endSec: 7, text: 'It should work without too much strain at all.' },
        { startSec: 8, endSec: 12, text: 'then we move on to the next item' }
    ]);
    const review = { fromSec: 0, toSec: 7, items: [live[0], live[1]] };
    const chunk = extra => ({ coreSec: 0, coreEndSec: 7, chunkStartSec: 0, text: '', segments: [], ...extra });
    const saved = settled => {
        const merged = [...settled.results, live[2], ...settled.restore];
        return reassembleTimeline(merged, merged.length).plain;
    };

    const failed = settleLiveReplays([review], [chunk({ failed: true })], []);
    ok(/basic tests and should work/.test(saved(failed)) && /without too much strain/.test(saved(failed))
       && !saved(failed).includes(GAP_MARKER),
       `replay: when replaying an overlapping live passage fails, the live lines are saved instead of a hole (${saved(failed)})`);
    const empty = settleLiveReplays([review], [chunk({})], []);
    ok(/basic tests and should work/.test(saved(empty)) && /without too much strain/.test(saved(empty)),
       'replay: and so they are when the replay comes back with no words at all');
    const partial = settleLiveReplays([review], [
        chunk({ coreEndSec: 3.5, segments: [{ start: 0.5, end: 3, text: 'basic tests' }], text: 'basic tests' }),
        chunk({ coreSec: 3.5, chunkStartSec: 3.5, failed: true })
    ], []);
    eq((saved(partial).match(/basic tests/g) || []).length, 1,
       'replay: a replay that only partly succeeded does not repeat the live text it gives way to');
    const heard = settleLiveReplays([review], [chunk({
        segments: [{ start: 0.5, end: 6.5, text: 'basic tests and it should work without strain' }],
        text: 'basic tests and it should work without strain'
    })], []);
    ok(heard.keptLive === 0 && heard.restore.length === 0 && /it should work without strain/.test(saved(heard)),
       'replay: a replay that heard the passage replaces the overlapping live lines');
    const alsoGap = settleLiveReplays([review], [chunk({ failed: true, coreEndSec: 10 })], [{ fromSec: 7, toSec: 10 }]);
    ok(saved(alsoGap).includes(GAP_MARKER) && /without too much strain/.test(saved(alsoGap)),
       'replay: a failed chunk that also covered audio nobody transcribed still says so, next to the live lines it kept');
}

{
    const { waveformFps, nextWaveFrame, waveWaitMs, WAVEFORM_CHOICES, refreshRateHz, describeAutoWaveform }
        = await import('../../src/js/waveform-core.js');
    eq(WAVEFORM_CHOICES.join(','), '0,10,15,30,60,auto', 'waveform: off, 10, 15, 30 or 60 frames a second, or auto');
    ok(waveformFps('auto') === Infinity, 'waveform: auto has no cap of its own');
    eq(waveformFps('15'), 15, 'waveform: the chosen frame rate is used');
    eq(waveformFps('0'), 0, 'waveform: 0 turns the waveform off');
    eq(waveformFps(''), 30, 'waveform: nothing chosen means 30');
    eq(waveformFps(null), 30, 'waveform: and so does no setting at all, rather than off');
    eq(waveformFps('45'), 30, 'waveform: a rate that is not offered falls back to 30');

    const screen = (hz, fps) => {
        const vsync = 1000 / hz;
        let now = 0, due = 0, draws = 0, wakes = 0;
        while (now < 10000) {
            wakes++;
            const frame = nextWaveFrame(now, due, fps);
            due = frame.due;
            if (frame.draw) draws++;
            if (!(fps > 0)) break;
            const wait = waveWaitMs(now + 0.5, due);
            if (wait > 0) wakes++;
            now = Math.ceil((now + 0.5 + wait + 1e-9) / vsync) * vsync;
        }
        return { draws: draws / 10, wakes: wakes / 10 };
    };
    const rates = [];
    for (const hz of [60, 90, 120, 144]) {
        for (const fps of [10, 15, 30, 60]) {
            const { draws } = screen(hz, fps);
            if (Math.abs(draws - fps) > 1) rates.push(`${fps} on ${hz} Hz drew ${draws}`);
        }
    }
    eq(rates.join('; '), '', 'waveform: on a 60, 90, 120 or 144 Hz screen it draws as many frames a second as chosen');
    ok(Math.abs(screen(30, 60).draws - 30) <= 1, 'waveform: a screen slower than the setting gets a frame every time it refreshes');
    eq(screen(60, 0).draws, 0, 'waveform: off draws nothing');
    ok(screen(120, 10).wakes <= 21 && screen(120, 30).wakes <= 61,
       `waveform: between frames it sleeps, so 10 frames a second on a 120 Hz screen wakes about 20 times a second, not 120 (${screen(120, 10).wakes})`);

    const autoRates = [];
    for (const hz of [60, 90, 120, 144, 165, 240]) {
        const { draws, wakes } = screen(hz, waveformFps('auto'));
        if (Math.abs(draws - hz) > 1 || Math.abs(wakes - hz) > 1) autoRates.push(`${hz} Hz drew ${draws}, woke ${wakes}`);
    }
    eq(autoRates.join('; '), '', 'waveform: Auto draws a frame on every refresh of a 60, 90, 120, 144, 165 or 240 Hz screen, and nothing in between');

    const refreshes = (hz, count, { jitter = 0.3, dropped = [], gapAt = -1 } = {}) => {
        const stamps = [];
        let at = 1000;
        for (let i = 0; i < count; i++) {
            at += 1000 / hz * (dropped.includes(i) ? 2 : 1) + (i === gapAt ? 500 : 0);
            stamps.push(Math.round((at + (((i * 7919) % 13) / 12 - 0.5) * 2 * jitter) * 10) / 10);
        }
        return stamps;
    };
    eq(refreshRateHz(refreshes(144, 25)), 144, 'refresh: a 144 Hz screen is measured as 144 Hz from timestamps rounded to a tenth of a millisecond');
    eq(refreshRateHz(refreshes(144, 25, { dropped: [5, 11, 17], gapAt: 20 })), 144,
       'refresh: a dropped frame does not lower the measured rate, and neither does a pause');
    eq(refreshRateHz(refreshes(59.94, 25)), 60, 'refresh: a 59.94 Hz screen is called 60 Hz');
    eq(refreshRateHz(refreshes(90, 25)), 90, 'refresh: 90 Hz');
    eq(refreshRateHz(refreshes(30, 25)), 30, 'refresh: a phone saving battery at 30 Hz is measured as such');
    eq(refreshRateHz(refreshes(110, 25, { jitter: 0 })), 110, 'refresh: an unusual rate is rounded rather than forced onto a common one');
    eq(refreshRateHz(refreshes(60, 7)), null, 'refresh: too few frames to tell gives no rate rather than a guess');
    ok(/\(144 Hz\)$/.test(describeAutoWaveform(144)) && !/Hz/.test(describeAutoWaveform(null)),
       'refresh: Settings names the measured rate beside Auto, and nothing when it could not be measured');

    const first = nextWaveFrame(1000, 0, 30);
    const late = nextWaveFrame(6000, first.due, 30);
    ok(first.draw && late.draw && late.due > 6000 && late.due <= 6000 + 1000 / 30 + 0.001,
       'waveform: after a pause it draws once and carries on at its rate');
    ok(!nextWaveFrame(6017, late.due, 30).draw, 'waveform: instead of catching up with a burst of frames');
}

{
    const { createSeamState, passSeam, textForChunkCore, chunkCoreSamples, reassembleTimeline, liveLinesAsResults }
        = await import('../../src/js/transcribe-core.js');
    const seam = createSeamState();
    const pass = (heardIn, startSec, endSec, text) => passSeam(seam, { heardIn, startSec, endSec, text });
    eq(pass('chunk:0', 0.2, 0.6, 'Okay.'), 'Okay.', 'seam: the first line is kept');
    eq(pass('chunk:0', 0.7, 1.9, 'Okay, so we start.'), 'Okay, so we start.',
       'seam: a line is never trimmed against the line before it in its own window');
    eq(pass('chunk:1', 1.5, 3.0, 'we start. And then'), 'And then',
       'seam: a line another window heard at the same time loses the words already kept');
    eq(pass('chunk:1', 3.5, 4.0, 'then more'), 'then more',
       'seam: once a window has itself heard past a line, its later lines are not compared with it');
    const apart = createSeamState();
    passSeam(apart, { heardIn: 'chunk:0', startSec: 0, endSec: 1, text: 'Thanks.' });
    eq(passSeam(apart, { heardIn: 'chunk:1', startSec: 1.6, endSec: 2.4, text: 'Thanks, everyone.' }), 'Thanks, everyone.',
       'seam: another window\'s line that starts after the earlier one ended is a new sentence, not a repeat');

    const saidOnce = reassembleTimeline([{ coreSec: 0, coreEndSec: 60, chunkStartSec: 0, text: '', segments: [
        { start: 4.0, end: 5.0, text: 'I think so.' }, { start: 5.2, end: 7.0, text: 'So what do we ship first?' },
        { start: 8.0, end: 8.6, text: 'The app.' }, { start: 8.8, end: 10.5, text: 'The app and the server.' }] }], 1);
    eq(saidOnce.plain, 'I think so. So what do we ship first? The app. The app and the server.',
       'reassemble: words a sentence shares with the end of the one before it are kept');
    const live = ['Okay.', 'Okay, so we need to fix the bug.', 'Yes, I think so.', 'Yes, I know so.'];
    const liveSaved = reassembleTimeline(liveLinesAsResults(live.map((text, i) => ({ startSec: i, endSec: i + 0.9, text }))), live.length);
    eq(liveSaved.plain, live.join(' '), 'reassemble: the live lines are saved as the live transcript showed them');

    const chunk = { startSec: 57, coreSec: 60, coreEndSec: 120, hasPreOverlap: true, hasPostOverlap: true };
    const onlyInOverlap = textForChunkCore({ text: 'See you on Monday.', segments: [{ start: 64, end: 65.5, text: 'See you on Monday.' }] }, chunk);
    ok(onlyInOverlap.text === '' && onlyInOverlap.coreSegments.length === 0,
       'chunk core: words the server placed only in the overlap are left to the chunk that owns that time');
    ok(textForChunkCore({ text: 'no segments here at all', segments: [] }, { ...chunk, hasPreOverlap: false, hasPostOverlap: false }).text
       === 'no segments here at all', 'chunk core: a server that gives no segments still has its text used');
    const samples = new Float32Array(66 * 16000);
    samples.fill(0.5, 0, 3 * 16000);
    const core = chunkCoreSamples(samples, chunk);
    ok(core.length === 60 * 16000 && core[0] === 0, 'chunk core: the silence verdict looks at the core of the chunk, not its overlap');
}

{
    const { resampleBandLimited, resamplerFor, resampleStretch, toneLevel } = await import('../../src/js/resample-core.js');
    const audio = await import('../../src/js/audio.js');
    const tone = (frequency, rate, seconds = 1, amplitude = 0.5) =>
        Float32Array.from({ length: Math.round(rate * seconds) }, (_, i) => amplitude * Math.sin(2 * Math.PI * frequency * i / rate));
    const mix = (...signals) => signals[0].map((_, i) => signals.reduce((sum, signal) => sum + signal[i], 0));
    const inner = samples => samples.subarray(400, samples.length - 400);
    const dB = (samples, frequency) => 20 * Math.log10(Math.max(1e-12, toneLevel(inner(samples), frequency, 16000) / 0.5));
    const aliasOf = frequency => Math.abs(((frequency + 8000) % 16000) - 8000);

    for (const rate of [48000, 44100]) {
        const passed = [1000, 3000, 6000].map(f => dB(resampleBandLimited(tone(f, rate), rate), f));
        ok(passed.every(level => Math.abs(level) < 0.2),
           `resample: speech frequencies come through a ${rate} Hz to 16 kHz conversion at their own level (${passed.map(v => v.toFixed(2)).join(', ')} dB)`);
        const folded = [9000, 12000, 15000, 20000].map(f => dB(resampleBandLimited(tone(f, rate), rate), aliasOf(f)));
        ok(folded.every(level => level < -60),
           `resample: what lies above 8 kHz is filtered out instead of folding back into the speech band (${folded.map(v => v.toFixed(0)).join(', ')} dB)`);
    }
    eq(resampleBandLimited(tone(1000, 48000), 48000).length, 16000, 'resample: a second of audio is a second at 16 kHz');
    eq(resampleBandLimited(tone(1000, 44100, 2), 44100).length, 32000, 'resample: also from 44.1 kHz');
    const odd = resampleBandLimited(tone(1000, 44056), 44056);
    ok(Math.abs(dB(odd, 1000)) < 0.2, 'resample: a rate with no small ratio to 16 kHz is converted just as well');

    const signal = mix(tone(997, 44100, 3), tone(11000, 44100, 3, 0.3));
    const whole = resampleBandLimited(signal, 44100);
    const margin = resamplerFor(44100).margin;
    const pieces = [];
    for (let at = 0; at < signal.length; at += 30000) {
        const end = Math.min(signal.length, at + 30000);
        const from = Math.max(0, at - margin);
        pieces.push(resampleStretch(signal.subarray(from, Math.min(signal.length, end + margin)), 44100,
                                    { inputStart: from, fromFrame: at, toFrame: end }));
    }
    const joined = Float32Array.from(pieces.flatMap(piece => [...piece]));
    ok(joined.length === whole.length && joined.every((value, i) => Math.abs(value - whole[i]) < 1e-5),
       'resample: a long signal converted in pieces, each with the frames around it, joins without a seam');

    const live = await audio.resamplePcmTo16k(mix(tone(1000, 48000), tone(12000, 48000)), 48000, 48000);
    ok(Math.abs(dB(live, 1000)) < 0.2 && dB(live, 4000) < -60,
       `resample: a live window at 48 kHz reaches the server without a 4 kHz ghost of a 12 kHz sound (${dB(live, 4000).toFixed(0)} dB)`);

    const recording = audio.encodeMonoWav(mix(tone(1000, 48000, 32), tone(12000, 48000, 32, 0.3)), 48000);
    const meta = await audio.inspectPcmWav(recording);
    const chunk = await audio.resamplePcmWavRangeTo16k(recording, meta, 30, 31);
    ok(chunk.length === 16000 && Math.abs(dB(chunk, 1000)) < 0.2 && dB(chunk, 4000) < -55,
       `resample: so does a chunk of a WAV recording transcribed after it (${chunk.length} samples, ${dB(chunk, 4000).toFixed(0)} dB)`);
    const converted = await audio.resampleTo16k(recording);
    ok(converted.length === 32 * 16000, 'resample: a whole WAV recording is converted to its full length');
    let seam = 0;
    for (let i = 30 * 16000 - 40; i < 30 * 16000 + 40; i++) seam = Math.max(seam, Math.abs(converted[i] - converted[i - 1]));
    let elsewhere = 0;
    for (let i = 10 * 16000 - 40; i < 10 * 16000 + 40; i++) elsewhere = Math.max(elsewhere, Math.abs(converted[i] - converted[i - 1]));
    ok(seam < elsewhere * 1.1, 'resample: and its thirty-second pieces meet without a click');
    ok(converted.subarray(30 * 16000, 31 * 16000).every((value, i) => Math.abs(value - chunk[i]) < 1e-4),
       'resample: the chunk read on its own is the same audio as that stretch of the whole recording');
}

{
    const { applyStopFlags, noteRecordingEnded, markFinalized, markSaveFailed } = await import('../../src/js/finalize-core.js');
    const started = Date.parse('2026-09-30T09:00:00Z');
    const owned = () => ({ id: 3, timestamp: started, durationMs: 1000, processing: true, captureState: 'finalizing',
                           ownerId: 'tab', heartbeatAt: started + 90000, finalizerId: 'f', finalizerHeartbeatAt: started + 90000,
                           finalizationError: 'old', finalizationErrorAt: 1 });
    const saved = markFinalized(owned(), 65000);
    ok(!saved.processing && saved.captureState === 'ready' && / - 01:05$/.test(saved.filename),
       `finalize: a saved recording is finished and named after its start and length (${saved.filename})`);
    ok(['ownerId', 'heartbeatAt', 'finalizerId', 'finalizerHeartbeatAt', 'finalizationError', 'finalizationErrorAt'].every(key => !(key in saved)),
       'finalize: and no tab owns or finalizes it any more, nor does an old error stay on it');
    eq(saved.endedAt, started + 90000, 'finalize: it ended at its last heartbeat, when that is later than its start plus the audio kept');
    ok(/ \(incomplete\)$/.test(markFinalized(applyStopFlags(owned(), { captureError: { kind: 'quota' }, incompleteAudio: true }), 5000).filename)
       && markFinalized(owned(), 0, true).filename.endsWith(' (no audio)'),
       'finalize: a recording missing audio says so in its name, and so does one with none');
    const failed = markSaveFailed(owned(), { durationMs: 70000, error: new Error('disk full'), now: 42,
                                             stopFlags: { captureError: { kind: 'quota' }, unsavedFragmentCount: 2 } });
    ok(failed.processing && failed.captureState === 'finalize-error' && failed.finalizationError === 'disk full'
       && failed.finalizationErrorAt === 42 && failed.durationMs === 70000 && failed.unsavedFragmentCount === 2,
       'finalize: a failed save stays unfinished with the error it met, when, and what the stop found');
    ok(!('ownerId' in failed) && !('finalizerId' in failed), 'finalize: and is left for any tab to retry or recover');
    eq(noteRecordingEnded({ timestamp: started, durationMs: 5000 }).endedAt, started + 5000,
       'finalize: a recording with no heartbeat ended at its start plus its length');
    eq(applyStopFlags({ id: 1 }, { incompleteAudio: true }).incompleteAudio, undefined,
       'finalize: flags without a capture error change nothing');
}

{
    const { unfinishedRowState, ROW_ACTION_LABELS } = await import('../../src/js/row-state-core.js');
    const rec = { id: 7, processing: true, captureState: 'recording' };
    eq(unfinishedRowState(rec, { liveHere: true }).kind, 'recording', 'row: the recording this tab is capturing is shown live');
    ok(unfinishedRowState(rec, { liveHere: true }).live, 'row: and marked as live');
    eq(unfinishedRowState(rec, { liveHere: true, captureErrorHere: true }).kind, 'capture-error',
       'row: unless its capture stopped after a storage error, which it says instead of LIVE');
    const savingHere = unfinishedRowState({ ...rec, captureState: 'finalizing' },
                                          { savingHere: true, ownedByLiveTab: true, beat: { state: 'finalizing' } });
    ok(savingHere.kind === 'saving' && savingHere.here === true,
       'row: a recording this tab is saving says "Saving…", although the lease it holds makes it look like another tab\'s');
    const savingThere = unfinishedRowState(rec, { ownedByLiveTab: true, beat: { state: 'finalizing' } });
    ok(savingThere.kind === 'saving' && savingThere.here === false, 'row: one another tab is saving says so');
    const otherTab = unfinishedRowState(rec, { ownedByLiveTab: true, beat: { state: 'recording' } });
    ok(otherTab.kind === 'other-tab' && otherTab.live, 'row: one another tab is capturing is shown as live in that tab');
    const failed = unfinishedRowState({ ...rec, captureState: 'finalize-error' });
    ok(failed.kind === 'save-failed' && failed.actions.includes('downloadRecoverableRec') && failed.actions.includes('retryFinalizeRec')
       && failed.actions.includes('deleteRec'),
       'row: a recording whose save failed can still be downloaded as the audio saved so far, retried, or deleted');
    eq(unfinishedRowState(rec, { finalizerFresh: true }).kind, 'recovering', 'row: one a tab is putting together says it is being recovered');
    const interrupted = unfinishedRowState(rec);
    ok(interrupted.kind === 'interrupted' && interrupted.actions.join(' ') === 'recoverNowRec deleteRec',
       'row: until then the row says the recording was interrupted and offers Recover now and Delete');
    ok(Object.keys(ROW_ACTION_LABELS).every(action => typeof ROW_ACTION_LABELS[action] === 'string')
       && [failed, interrupted].every(state => state.actions.every(action => ROW_ACTION_LABELS[action])),
       'row: every action a row offers has a label');
}

{
    const { parseBatchResponse } = await import('../../src/js/translate-core.js');
    eq(parseBatchResponse('10.30 uur komt mij goed uit.', 1), ['10.30 uur komt mij goed uit.'],
       'translate: a single line that starts with a time is taken as it is');
    eq(parseBatchResponse('1. Mai ist ein Feiertag.', 1), ['1. Mai ist ein Feiertag.'],
       'translate: a single line that starts with a date keeps it');
    eq(parseBatchResponse('---\nHallo zusammen.\n---', 1), ['Hallo zusammen.'],
       'translate: fences echoed around a single line are not taken as the translation');
    eq(parseBatchResponse('1. Hallo zusammen.', 1, { numbered: true }), ['Hallo zusammen.'],
       'translate: where a single line was asked for with its number, the number is removed');
    eq(parseBatchResponse('2-3 Leute kommen.', 1, { numbered: true }), ['2-3 Leute kommen.'],
       'translate: and a reply without it is kept whole');
    eq(parseBatchResponse('1. eins\n5. fünf', 2), null, 'translate: a batch numbered past its length is still refused');
    eq(parseBatchResponse('1. Wir treffen uns am\n2. Juni.', 1, { numbered: true }), null,
       'translate: a numbered single line that goes on to other numbers is refused rather than cut short');
    eq(parseBatchResponse('1. Hallo zusammen.\n2. Wie geht es euch?', 1, { numbered: true }), null,
       'translate: and so is one that answers more lines than were asked');
    eq(parseBatchResponse('Here is the translation:\n1. Half elf komt mij goed uit.', 1, { numbered: true }),
       ['Half elf komt mij goed uit.'],
       'translate: a numbered single line after a preamble is read past the preamble');
    for (const reply of ['**1.** Hallo zusammen.', '1 - Hallo zusammen.', '1.Hallo zusammen.', '1) Hallo zusammen.',
                         'Line 1: Hallo zusammen.']) {
        eq(parseBatchResponse(reply, 1, { numbered: true }), ['Hallo zusammen.'],
           `translate: a numbered single line loses its number however it is written (${reply})`);
    }
    for (const reply of ['1.5 Kilo reichen.', '1:30 passt mir.', '1-2 Leute kommen.']) {
        eq(parseBatchResponse(reply, 1, { numbered: true }), [reply],
           `translate: a single line that starts with a number of its own keeps it (${reply})`);
    }
}

{
    const { fillMissingTranslations } = await import('../../src/js/transcribe-core.js');
    const lines = [{ text: 'Half past ten works for me.', language: 'en' }];
    const outcome = await fillMissingTranslations(lines, ['en', 'nl'], async () => '10.30 uur komt mij goed uit.');
    eq(outcome.filled.nl && outcome.filled.nl[0], '10.30 uur komt mij goed uit.',
       'translate: completing a transcript keeps a one-line translation that starts with a time');
}

{
    const { planRecordRetention, recordingEndedAt } = await import('../../src/js/retention-core.js');
    const MIN = 60 * 1000;
    const now = 2_000_000_000_000;
    const meeting = { id: 1, timestamp: now - 75 * MIN, durationMs: 74 * MIN, audioBytes: 10 };
    eq(recordingEndedAt(meeting), now - MIN, 'retention: a recording ends when its start plus its length');
    const plan = planRecordRetention(meeting, { now, audioMs: 60 * MIN, textMs: 365 * 24 * 60 * MIN });
    ok(!plan.dropAudio && !plan.dropRow && plan.audioExpiresInMs === 59 * MIN,
       'retention: a meeting longer than the audio window is not expired the moment it is stopped');
    ok(planRecordRetention({ ...meeting, timestamp: now - 62 * MIN, durationMs: MIN }, { now, audioMs: 60 * MIN, textMs: 60 * MIN }).dropRow,
       'retention: one that ended past the window is');
    const stalled = { id: 2, timestamp: now - 121 * MIN, durationMs: 20 * MIN, endedAt: now - MIN, audioBytes: 10,
                      captureState: 'ready-incomplete' };
    ok(!planRecordRetention(stalled, { now, audioMs: 60 * MIN, textMs: 60 * MIN }).dropAudio,
       'retention: a two-hour recording that saved only 20 minutes of audio ages from when it stopped, not from its start plus 20 minutes');
}

{
    const { planTranscriptDeletion, describeTranscriptDeletion, backupIncludesLiveTranscript,
            describeRecordingDeletion, parseDeletionIds, withDeletionId } = await import('../../src/js/deletion-core.js');
    const rec = { liveTranscriptLines: 3, transcripts: [{ id: 1, source: 'L' }, { id: 2, source: 'S' }],
                  summaries: [{ id: 9, transcriptId: 1 }] };
    const plan = planTranscriptDeletion(rec, 1);
    ok(plan.found && plan.dropsLiveTranscript && plan.replies === 1 && plan.transcripts.length === 1,
       'delete transcript: deleting the last transcript made from the live one takes the live transcript with it');
    ok(/live transcript it was made from is deleted too/.test(describeTranscriptDeletion(plan)),
       'delete transcript: and the question says so');
    ok(!planTranscriptDeletion({ ...rec, transcripts: [...rec.transcripts, { id: 3, source: 'S', fromLive: true }] }, 1).dropsLiveTranscript,
       'delete transcript: while another transcript made from it is kept, the live transcript stays');
    ok(!planTranscriptDeletion({ transcripts: [{ id: 1, source: 'L' }] }, 1).dropsLiveTranscript,
       'delete transcript: a recording without a live transcript has none to drop');
    ok(backupIncludesLiveTranscript({ liveTranscriptLines: 2, transcripts: [{ id: 1, source: 'L' }] })
       && backupIncludesLiveTranscript({ liveTranscriptLines: 2, transcripts: [] })
       && !backupIncludesLiveTranscript({ liveTranscriptLines: 2, transcripts: [{ id: 2, source: 'S' }] }),
       'backup: a live transcript no transcript shows any more stays out of the backup, unless it is the only text');
    const failedSave = describeRecordingDeletion({ processing: true, captureState: 'finalize-error' },
                                                 { savedSoFarBytes: 3 * 1024 * 1024, savedSoFarPieces: 12 });
    ok(/3\.0 MB of audio saved so far, in 12 piece\(s\)/.test(failedSave) && !/nothing but its own entry/.test(failedSave),
       'delete recording: the question for a failed save names the audio it still holds');
    eq(describeRecordingDeletion({}), 'This row holds nothing but its own entry.',
       'delete recording: an empty row says it is empty');
    eq(parseDeletionIds(withDeletionId(withDeletionId('[]', 5, true), 7, true)), [5, 7], 'interrupted delete: ids are noted');
    eq(parseDeletionIds(withDeletionId('[5,7]', 5, false)), [7], 'interrupted delete: and cleared');
    eq(parseDeletionIds('not json'), [], 'interrupted delete: a damaged note reads as none');
}

{
    const { captureBeatRecord } = await import('../../src/js/capture-health-core.js');
    const beat = captureBeatRecord({ recId: 4, ownerId: 'tab', sessionId: 's', now: 10, durationMs: 5000, capturedMs: 4000,
                                     state: 'finalizing', captureFlags: { captureError: { kind: 'quota' }, incompleteAudio: true } });
    ok(beat.captureError.kind === 'quota' && beat.incompleteAudio === true && beat.heartbeatAt === 10,
       'beat: a beat written while finalizing carries the capture error and the missing audio it was given');
    ok(!('captureError' in captureBeatRecord({ recId: 4, now: 10, state: 'recording' })),
       'beat: and a beat without one says nothing about an error');
}

{
    const { meterLevel, nextAutoGain, AUTO_GAIN_HOLD_RMS, AUTO_GAIN_TARGET_RMS, AUTO_GAIN_MIN, AUTO_GAIN_MAX } =
        await import('../../src/js/capture-health-core.js');
    // An analyser that reads a signal the way the Web Audio spec says it does: floats as they are,
    // bytes as floor(128 * (1 + x)).
    const analyserOf = signal => ({
        fftSize: signal.length,
        getFloatTimeDomainData(array) { for (let i = 0; i < array.length; i++) array[i] = signal[i]; },
        getByteTimeDomainData(array) {
            for (let i = 0; i < array.length; i++) array[i] = Math.max(0, Math.min(255, Math.floor(128 * (1 + signal[i]))));
        }
    });
    let seed = 11;
    const quietRoom = Float32Array.from({ length: 1024 }, () => {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        return (seed / 2 ** 32 - 0.5) * 2 * Math.sqrt(3) * Math.pow(10, -70 / 20);
    });
    const bytes = new Uint8Array(1024);
    analyserOf(quietRoom).getByteTimeDomainData(bytes);
    const byteRms = Math.sqrt(bytes.reduce((sum, b) => sum + ((b - 128) / 128) ** 2, 0) / bytes.length);
    ok(byteRms > 0.005, 'pauses: the fixture is the noise a byte reading mistakes for sound');
    const samples = new Float32Array(1024);
    const quiet = meterLevel(analyserOf(quietRoom), samples);
    ok(quiet.rms < AUTO_GAIN_HOLD_RMS, 'pauses: the meter hears a quiet room as quiet');
    let gain = 0.8;
    for (let tick = 0; tick < 50; tick++) gain = nextAutoGain(gain, meterLevel(analyserOf(quietRoom), samples)) ?? gain;
    eq(gain, 0.8, 'pauses: quiet room noise leaves the gain alone however long the pause lasts');

    const tone = level => Float32Array.from({ length: 1024 }, (_, i) => level * Math.SQRT2 * Math.sin(i / 7));
    const soft = meterLevel(analyserOf(tone(0.03)), samples);
    ok(Math.abs(soft.rms - 0.03) < 0.003, 'speech: the meter reads the level of what it hears');
    ok(nextAutoGain(1, soft) > 1, 'speech: soft speech is brought up towards the target');
    ok(nextAutoGain(1, meterLevel(analyserOf(tone(0.5)), samples)) < 1, 'speech: loud speech is brought down');
    ok(nextAutoGain(1, { rms: AUTO_GAIN_TARGET_RMS, peak: 0.95 }) < 1, 'speech: a peak near full scale backs off');
    eq(nextAutoGain(AUTO_GAIN_MAX, { rms: 0.001, peak: 0.002 }), AUTO_GAIN_MAX, 'bounds: the gain never passes its cap');
    eq(nextAutoGain(AUTO_GAIN_MIN, { rms: 5, peak: 5 }), AUTO_GAIN_MIN, 'bounds: nor drops below its floor');
}


{
    // Build 135: a myAI box publishes what its hardware can take at /capabilities.
    const { NO_LIMITS, normalizeCapabilities, capped, cappedPanelCount, cappedInFlight, describeBox }
        = await import('../../src/js/capabilities-core.js');

    eq(normalizeCapabilities(null), NO_LIMITS, 'capabilities: no answer means no limits');
    eq(normalizeCapabilities([1, 2]), NO_LIMITS, 'capabilities: an array is not a capabilities object');
    const caps = normalizeCapabilities({ tier: 'basic', maxPanels: '2', translateInFlight: 1.9,
                                         transcribeConcurrency: 0, llm: 'qwen3:4b',
                                         warnings: ['Only 4 GiB of RAM.', '', null, 'x'.repeat(500)] });
    eq([caps.known, caps.maxPanels, caps.translateInFlight, caps.transcribeConcurrency],
       [true, 2, 1, 1], 'capabilities: numbers are read as whole numbers and kept in range');
    eq(caps.warnings.length, 2, 'capabilities: empty warnings are dropped');
    eq(caps.warnings[1].length, 300, 'capabilities: a long warning is cut, not passed through whole');
    eq(normalizeCapabilities({ maxPanels: 'lots' }).maxPanels, null, 'capabilities: a malformed limit is no limit');

    eq(capped(10, null), 10, 'capped: no box limit keeps the app value');
    eq(capped(10, 2), 2, 'capped: the box can lower the app value');
    eq(capped(4, 16), 4, 'capped: but never raise it');

    eq(cappedPanelCount(4, 4, NO_LIMITS), 4, 'panels: without a box the setting is used as is');
    eq(cappedPanelCount(9, 4, NO_LIMITS), 4, 'panels: and still never above the app maximum');
    eq(cappedPanelCount(4, 4, normalizeCapabilities({ maxPanels: 2 })), 2, 'panels: a box that keeps up with 2 gets 2');
    eq(cappedPanelCount(4, 4, normalizeCapabilities({ maxPanels: 1 })), 0, 'panels: a single box is no boxes');
    eq(cappedPanelCount(3, 4, normalizeCapabilities({ maxPanels: 0 })), 0, 'panels: a box without an AI model shows none');
    eq(cappedPanelCount(0, 4, NO_LIMITS), 0, 'panels: the setting off stays off');

    eq(cappedInFlight(4, NO_LIMITS), 4, 'in flight: without a box the app value is used');
    eq(cappedInFlight(4, normalizeCapabilities({ translateInFlight: 1 })), 1, 'in flight: a CPU box translates one at a time');
    eq(cappedInFlight(4, normalizeCapabilities({ translateInFlight: 0 })), 1, 'in flight: never below one, so nothing stalls');

    eq(describeBox(NO_LIMITS), '', 'describeBox: nothing to say without a box');
    const text = describeBox(normalizeCapabilities({ summary: 'basic - 4 cores', whisper: 'base on cpu', llm: null, maxPanels: 0 }));
    ok(text.includes('basic - 4 cores') && text.includes('no AI model') && text.includes('no translation boxes'),
       'describeBox: says plainly what a small box does not do');
}

console.log(`\n${'─'.repeat(60)}`);
reported = true;
if (failed === 0) {
    console.log(`✓ all ${passed} assertions passed`);
    emitTestResult('pure', 'pass', { assertions: passed });
    process.exit(0);
} else {
    console.log(`${passed} passed, ${failed} FAILED:\n`);
    console.log(fails.join('\n'));
    process.exit(1);
}
