import { emitTestResult } from '../helpers/test-result.mjs';
import {
    inspectWebmDurationBytes,
    makeWebmSeekable,
    prepareWebmChunkSource,
    makeWebmDecodeChunk,
    estimateTruncatedDurationSec,
    webmAudioEndMs,
    WEBM_SEEKABLE_VERSION
} from '../../src/js/webm-duration.js';
import { concat, element, uintPayload, float64, unknownSegmentSize, clusterPayload, cluster, syntheticWebm }
    from '../helpers/synthetic-webm.mjs';

let assertions = 0;
function ok(value, message) {
    assertions++;
    if (!value) throw new Error(`Assertion failed: ${message}`);
}
function near(actual, expected, tolerance, message) {
    ok(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} vs ${expected}`);
}
function throws(fn, message) {
    let didThrow = false;
    try { fn(); } catch (_) { didThrow = true; }
    ok(didThrow, message);
}

async function remux(bytes, durationMs) {
    const fixed = await makeWebmSeekable(new Blob([bytes], { type: 'audio/webm;codecs=opus' }), durationMs);
    return new Uint8Array(await fixed.arrayBuffer());
}

function contains(haystack, needle) {
    outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
        for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
        return true;
    }
    return false;
}

ok(WEBM_SEEKABLE_VERSION === 3, 'container-remux schema version is explicit');

{
    const source = syntheticWebm();
    const before = inspectWebmDurationBytes(source.bytes);
    ok(!before.present && !before.finiteSegment && before.cueCount === 0,
        'MediaRecorder-style source is unknown-length and unindexed');

    const remuxed = await remux(source.bytes, 512_000);
    const meta = inspectWebmDurationBytes(remuxed);
    ok(meta.present, 'missing Duration is inserted');
    near(meta.durationMs, 512_000, 0.001, 'inserted duration matches 8m32s');
    ok(meta.finiteSegment, 'unknown-size live Segment is rewritten with a finite size');
    ok(meta.cueCount === source.clusters.length, 'one CuePoint is written for every Cluster');
    for (const rawCluster of source.clusters) {
        ok(contains(remuxed, rawCluster), 'compressed Cluster bytes are retained unchanged');
    }

    const second = await remux(remuxed, 512_000);
    ok(second.length === remuxed.length && second.every((b, i) => b === remuxed[i]),
        'remux is deterministic and idempotent');
}

{
    const source = syntheticWebm({ durationTicks: 1, scale: 2_000_000 });
    const remuxed = await remux(source.bytes, 10_000);
    const meta = inspectWebmDurationBytes(remuxed);
    near(meta.durationTicks, 5_000, 0.001, 'duration respects a non-default TimestampScale');
    near(meta.durationMs, 10_000, 0.001, 'existing Duration is replaced');
    ok(meta.cueCount === 3, 'existing stale metadata is replaced by a complete cue index');
}

{
    const source = syntheticWebm({ unknownClusterSize: true });
    const fixed = await remux(source.bytes, 12_000);
    ok(inspectWebmDurationBytes(fixed).cueCount === source.clusters.length, 'unknown-size Clusters are indexed');
    ok(!contains(fixed, concat(new Uint8Array([0x1F, 0x43, 0xB6, 0x75]), unknownSegmentSize)), 'every Cluster is written with a known size');
    for (const payload of source.payloads) ok(contains(fixed, payload), 'Cluster payloads are retained unchanged');
}

{
    const source = syntheticWebm();
    const blob = new Blob([source.bytes], { type: 'audio/webm;codecs=opus' });
    const fixed = await makeWebmSeekable(blob, 61_500);
    ok(fixed.type === blob.type, 'Blob MIME type is preserved');
    const meta = inspectWebmDurationBytes(new Uint8Array(await fixed.arrayBuffer()));
    near(meta.durationMs, 61_500, 0.001, 'Blob helper writes a finite duration');
    ok(meta.finiteSegment && meta.cueCount === 3, 'Blob helper produces a finite indexed file');
}

{
    const source = syntheticWebm({ clusterTimes: [0, 3_600_000, 5_400_000, 7_199_000] });
    const blob = new Blob([source.bytes], { type: 'audio/webm;codecs=opus' });
    const prepared = await prepareWebmChunkSource(blob, 7_200_000);
    ok(prepared.durationSec === 7200, 'multi-hour WebM source retains its declared duration');
    ok(prepared.clusters.length === 4, 'multi-hour WebM preparation indexes Clusters without decoding audio');

    const range = await makeWebmDecodeChunk(prepared, 5_400, 5_460);
    ok(range.clusterCount === 1, 'decode window includes only overlapping compressed Clusters');
    ok(range.requestedDurationSec === 60, 'decode window retains the requested 60-second duration');
    const reparsed = await prepareWebmChunkSource(range.blob, range.requestedDurationSec * 1000);
    near(reparsed.clusters[0].startSec, 0, 0.000001, 'standalone decode chunk rebases its first Cluster to zero');
    const meta = inspectWebmDurationBytes(new Uint8Array(await range.blob.arrayBuffer()));
    ok(meta.finiteSegment && meta.present, 'standalone decode chunk has finite Segment and Duration metadata');
}

{
    const source = syntheticWebm({ clusterTimes: [0, 60_000, 120_000, 180_000] });
    const cut = source.bytes.slice(0, source.bytes.length - 6);
    const blob = new Blob([cut], { type: 'audio/webm;codecs=opus' });

    let strictThrew = false;
    try { await prepareWebmChunkSource(blob, 240_000); } catch (_) { strictThrew = true; }
    ok(strictThrew, 'a truncated container is refused by default');

    let remuxThrew = false;
    try { await makeWebmSeekable(blob, 240_000); } catch (_) { remuxThrew = true; }
    ok(remuxThrew, 'the destructive remux path never rewrites a master from a prefix');

    const tolerant = await prepareWebmChunkSource(blob, 240_000, { tolerateTruncation: true });
    ok(tolerant && tolerant.truncatedAt && Number.isFinite(tolerant.truncatedAt.offset),
       'read-only indexing recovers the readable prefix and reports where it stopped');
    ok(tolerant.clusters.length >= 2, 'the recovered prefix keeps its indexed Clusters');
    ok(tolerant.durationSec <= 240,
       'a truncated index never claims the declared recording length');
    const last = tolerant.clusters[tolerant.clusters.length - 1];
    ok(last.endSec > last.startSec,
       'every fully indexed Cluster, including the last one, spans a decodable window');
    ok(tolerant.durationSec >= last.endSec,
       'a truncated index reaches the end of the last Cluster it fully indexed');
    const tail = await makeWebmDecodeChunk(tolerant, last.startSec, tolerant.durationSec);
    ok(tail.clusterCount >= 1,
       'the tail of an interrupted recording stays reachable for review');
    const window = await makeWebmDecodeChunk(tolerant, 0, tolerant.durationSec);
    ok(window.includedEndSec <= tolerant.durationSec,
       'decode windows stay inside the bytes that were actually indexed');
}

{
    const source = syntheticWebm({ clusterTimes: [0] });
    const cut = source.bytes.slice(0, source.bytes.length - 6);
    const blob = new Blob([cut], { type: 'audio/webm;codecs=opus' });
    let threw = false;
    try { await prepareWebmChunkSource(blob, 60_000, { tolerateTruncation: true }); }
    catch (_) { threw = true; }
    ok(threw, 'tolerance still refuses a file with no usable amount of audio indexed');
}

function chromeStyleWebm({ clusterTimes = [0, 4000, 8000], blocks = 200, step = 20, scale = 1_000_000 } = {}) {
    const ebml = element([0x1A, 0x45, 0xDF, 0xA3], new Uint8Array(0));
    const info = element([0x15, 0x49, 0xA9, 0x66], element([0x2A, 0xD7, 0xB1], uintPayload(scale, 4)));
    const tracks = element([0x16, 0x54, 0xAE, 0x6B], element([0xAE], concat(
        element([0xD7], new Uint8Array([1])), element([0x83], new Uint8Array([2])))));
    const clusters = clusterTimes.map((time, c) => {
        const timestampBytes = time > 0xFFFF ? 3 : time > 0xFF ? 2 : 1;
        const parts = [element([0xE7], uintPayload(time, timestampBytes))];
        for (let b = 0; b < blocks; b++) {
            const relative = b * step;
            parts.push(element([0xA3], new Uint8Array([0x81, relative >> 8, relative & 0xff, 0x80, c, b & 0xff, 0x55])));
        }
        return concat(new Uint8Array([0x1F, 0x43, 0xB6, 0x75]), unknownSegmentSize, ...parts);
    });
    const segment = concat(new Uint8Array([0x18, 0x53, 0x80, 0x67]), unknownSegmentSize, info, tracks, ...clusters);
    return { bytes: concat(ebml, segment), clusters };
}

async function remuxOrNull(bytes, durationMs = 12_000) {
    try {
        const fixed = await makeWebmSeekable(new Blob([bytes], { type: 'audio/webm;codecs=opus' }), durationMs);
        return new Uint8Array(await fixed.arrayBuffer());
    } catch (_) {
        return null;
    }
}

{
    const source = chromeStyleWebm();
    const lastBlock = source.clusters[2].slice(-9);
    const recovered = concat(source.bytes, new Uint8Array([0xA3]));
    const blob = new Blob([recovered], { type: 'audio/webm;codecs=opus' });
    const fixed = await remuxOrNull(recovered);
    const meta = fixed ? inspectWebmDurationBytes(fixed) : {};
    ok(meta.finiteSegment && meta.cueCount === 3,
       'recovery: pieces saved before a tab was closed, which end one byte into the next block, still become a seekable file with every Cluster indexed');
    ok(fixed && contains(fixed, lastBlock), 'recovery: the last complete block of the last Cluster is kept');
    const tolerant = await prepareWebmChunkSource(blob, 12_000, { tolerateTruncation: true });
    ok(tolerant.clusters.length === 3 && !tolerant.truncatedAt,
       'recovery: transcription reads the last Cluster too, instead of dropping its four seconds');
    near(await webmAudioEndMs(blob), 12_000, 0.001,
         'recovery: the length is read from the last block in the file, not from the last heartbeat');

    const cutFixed = await remuxOrNull(concat(source.bytes, new Uint8Array([0x1F])));
    ok(cutFixed && inspectWebmDurationBytes(cutFixed).cueCount === 3,
       'recovery: a piece that ends with the first byte of a new Cluster is repaired the same way');

    const cutBlockFixed = await remuxOrNull(source.bytes.slice(0, source.bytes.length - 4));
    const withoutLastBlock = await remuxOrNull(source.bytes.slice(0, source.bytes.length - 9));
    ok(cutBlockFixed && withoutLastBlock && cutBlockFixed.length === withoutLastBlock.length && cutBlockFixed.every((byte, i) => byte === withoutLastBlock[i])
       && contains(cutBlockFixed, source.clusters[2].slice(-18, -9)),
       'recovery: a block cut in the middle is left out, and the complete blocks before it are kept');

    const begunCluster = concat(source.bytes, new Uint8Array([0x1F, 0x43, 0xB6, 0x75]), unknownSegmentSize, new Uint8Array([0xE7]));
    const begunFixed = await remuxOrNull(begunCluster);
    ok(begunFixed && inspectWebmDurationBytes(begunFixed).cueCount === 3,
       'recovery: a Cluster that was only just begun when the tab closed is left out, and everything before it is kept');

    const scaled = chromeStyleWebm({ clusterTimes: [0, 2000], blocks: 100, step: 10, scale: 2_000_000 });
    near(await webmAudioEndMs(new Blob([scaled.bytes], { type: 'audio/webm;codecs=opus' })), 6_000, 0.001,
         'recovery: the length respects a non-default TimestampScale');
}

{
    const ogg = new Blob([new Uint8Array([0x4f, 0x67, 0x67, 0x53])], { type: 'audio/ogg;codecs=opus' });
    ok(await makeWebmSeekable(ogg, 5000) === ogg, 'non-WebM Opus is left untouched');
}

{
    const source = syntheticWebm({ includeClusters: false });
    throws(() => remuxWebmSeekableBytes(source.bytes, 5000), 'files without audio Clusters are rejected');
}

{
    near(estimateTruncatedDurationSec([0, 60, 120]), 180, 1e-9,
         'a truncated tail is estimated from the observed Cluster cadence');
    ok(estimateTruncatedDurationSec([0, 60, 120]) > 120,
       'a truncated duration always reaches past the final Cluster start');
    near(estimateTruncatedDurationSec([0, 10, 20, 200]), 210, 1e-9,
         'one abnormally long gap does not drag the estimate with it');
    ok(estimateTruncatedDurationSec([5]) > 5,
       'a single indexed Cluster still spans a decodable window');
    ok(estimateTruncatedDurationSec([]) === 0,
       'no indexed Clusters means no claimable duration');
}

console.log(`✓ all ${assertions} WebM seekability assertions passed`);
emitTestResult('webm-remux-unit', 'pass', { assertions });
