/* Seekable WebM remux tests. */
import { emitTestResult } from '../helpers/test-result.mjs';
import {
    remuxWebmSeekableBytes,
    inspectWebmDurationBytes,
    makeWebmSeekable,
    prepareWebmChunkSource,
    makeWebmDecodeChunk,
    WEBM_SEEKABLE_VERSION
} from '../../src/js/webm-duration.js';

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

const concat = (...parts) => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let off = 0;
    for (const part of parts) { out.set(part, off); off += part.length; }
    return out;
};
const size = n => {
    if (n <= 126) return new Uint8Array([0x80 | n]);
    if (n <= 16382) return new Uint8Array([0x40 | (n >> 8), n & 0xff]);
    throw new Error('test size too large');
};
const uintPayload = (n, bytes = 1) => {
    const out = new Uint8Array(bytes);
    for (let i = bytes - 1; i >= 0; i--) { out[i] = n & 0xff; n = Math.floor(n / 256); }
    return out;
};
const element = (id, payload) => concat(new Uint8Array(id), size(payload.length), payload);
const float64 = n => {
    const out = new Uint8Array(8);
    new DataView(out.buffer).setFloat64(0, n, false);
    return out;
};
const unknownSegmentSize = new Uint8Array([0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]);

function cluster(time, marker) {
    const timestampBytes = time > 0xFFFFFF ? 4 : time > 0xFFFF ? 3 : time > 0xFF ? 2 : 1;
    const timestamp = element([0xE7], uintPayload(time, timestampBytes));
    const simpleBlock = element([0xA3], new Uint8Array([0x81, 0x00, 0x00, 0x80, marker, marker + 1, marker + 2]));
    return element([0x1F, 0x43, 0xB6, 0x75], concat(timestamp, simpleBlock));
}

function syntheticWebm({ durationTicks = null, scale = 1_000_000, includeClusters = true, clusterTimes = [0, 4000, 8000] } = {}) {
    const ebml = element([0x1A, 0x45, 0xDF, 0xA3], new Uint8Array(0));
    const staleSeek = element([0x11, 0x4D, 0x9B, 0x74], element([0x4D, 0xBB], concat(
        element([0x53, 0xAB], new Uint8Array([0x15, 0x49, 0xA9, 0x66])),
        element([0x53, 0xAC], new Uint8Array([0x00]))
    )));
    const voidEl = element([0xEC], new Uint8Array(32));
    const infoParts = [element([0x2A, 0xD7, 0xB1], uintPayload(scale, 4))];
    if (durationTicks != null) infoParts.push(element([0x44, 0x89], float64(durationTicks)));
    infoParts.push(element([0x4D, 0x80], new TextEncoder().encode('myAI')));
    const info = element([0x15, 0x49, 0xA9, 0x66], concat(...infoParts));
    const trackEntry = element([0xAE], concat(
        element([0xD7], new Uint8Array([1])),
        element([0x83], new Uint8Array([2]))
    ));
    const tracks = element([0x16, 0x54, 0xAE, 0x6B], trackEntry);
    const clusters = includeClusters ? clusterTimes.map((time, i) => cluster(time, 0x31 + i * 0x10)) : [];
    const segment = concat(
        new Uint8Array([0x18, 0x53, 0x80, 0x67]),
        unknownSegmentSize,
        staleSeek, voidEl, info, tracks, ...clusters
    );
    return { bytes: concat(ebml, segment), clusters };
}

function contains(haystack, needle) {
    outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
        for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
        return true;
    }
    return false;
}

ok(WEBM_SEEKABLE_VERSION === 2, 'container-remux schema version is explicit');

{
    const source = syntheticWebm();
    const before = inspectWebmDurationBytes(source.bytes);
    ok(!before.present && !before.finiteSegment && before.cueCount === 0,
        'MediaRecorder-style source is unknown-length and unindexed');

    const remuxed = remuxWebmSeekableBytes(source.bytes, 512_000);
    const meta = inspectWebmDurationBytes(remuxed.bytes);
    ok(meta.present, 'missing Duration is inserted');
    near(meta.durationMs, 512_000, 0.001, 'inserted duration matches 8m32s');
    ok(meta.finiteSegment, 'unknown-size live Segment is rewritten with a finite size');
    ok(meta.cueCount === source.clusters.length, 'one CuePoint is written for every Cluster');
    ok(remuxed.cueCount === source.clusters.length, 'remux result reports its cue count');
    for (const rawCluster of source.clusters) {
        ok(contains(remuxed.bytes, rawCluster), 'compressed Cluster bytes are retained unchanged');
    }

    const second = remuxWebmSeekableBytes(remuxed.bytes, 512_000);
    ok(second.bytes.length === remuxed.bytes.length && second.bytes.every((b, i) => b === remuxed.bytes[i]),
        'remux is deterministic and idempotent');
}

{
    const source = syntheticWebm({ durationTicks: 1, scale: 2_000_000 });
    const remuxed = remuxWebmSeekableBytes(source.bytes, 10_000);
    const meta = inspectWebmDurationBytes(remuxed.bytes);
    near(meta.durationTicks, 5_000, 0.001, 'duration respects a non-default TimestampScale');
    near(meta.durationMs, 10_000, 0.001, 'existing Duration is replaced');
    ok(meta.cueCount === 3, 'existing stale metadata is replaced by a complete cue index');
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
    // A two-hour logical source proves that chunk preparation is based on
    // container coordinates, not a full-file duration cutoff or whole decode.
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
    const ogg = new Blob([new Uint8Array([0x4f, 0x67, 0x67, 0x53])], { type: 'audio/ogg;codecs=opus' });
    ok(await makeWebmSeekable(ogg, 5000) === ogg, 'non-WebM Opus is left untouched');
}

{
    const source = syntheticWebm({ includeClusters: false });
    throws(() => remuxWebmSeekableBytes(source.bytes, 5000), 'files without audio Clusters are rejected');
}

console.log(`✓ all ${assertions} WebM seekability assertions passed`);
emitTestResult('webm-remux-unit', 'pass', { assertions });
