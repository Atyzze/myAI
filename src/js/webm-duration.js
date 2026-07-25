/* ============================================================================
 * webm-duration.js - Remux MediaRecorder WebM/Opus into a normal seekable file.
 *
 * Chromium writes MediaRecorder WebM in "live" mode: the Segment has an
 * unknown size, Duration is omitted, Cues are omitted, and any existing
 * SeekHead can become stale if metadata is merely inserted in-place. Some
 * browsers tolerate that stream-oriented layout, but desktop players such as
 * VLC/mpv may keep the total length unknown and disable normal seeking.
 *
 * This module performs a container-only remux. Audio packets are not decoded or
 * re-encoded. It writes a finite Segment, replaces stale SeekHead/Cues, adds a
 * Duration value, and creates one CuePoint per Cluster. Cluster bytes stay
 * byte-for-byte unchanged.
 * ========================================================================== */

const ID_EBML           = 0x1A45DFA3n;
const ID_SEGMENT        = 0x18538067n;
const ID_SEEK_HEAD      = 0x114D9B74n;
const ID_SEEK           = 0x4DBBn;
const ID_SEEK_ID        = 0x53ABn;
const ID_SEEK_POSITION  = 0x53ACn;
const ID_INFO           = 0x1549A966n;
const ID_TIMECODE_SCALE = 0x2AD7B1n;
const ID_DURATION       = 0x4489n;
const ID_TRACKS         = 0x1654AE6Bn;
const ID_TRACK_ENTRY    = 0xAEn;
const ID_TRACK_NUMBER   = 0xD7n;
const ID_TRACK_TYPE     = 0x83n;
const ID_CLUSTER        = 0x1F43B675n;
const ID_TIMESTAMP      = 0xE7n;
const ID_CUES           = 0x1C53BB6Bn;
const ID_CUE_POINT      = 0xBBn;
const ID_CUE_TIME       = 0xB3n;
const ID_CUE_TRACK_POS  = 0xB7n;
const ID_CUE_TRACK      = 0xF7n;
const ID_CUE_CLUSTER_POS = 0xF1n;
const ID_VOID           = 0xECn;
const ID_CRC32          = 0xBFn;

const DEFAULT_TIMECODE_SCALE = 1_000_000; // ns per Segment tick
const AUDIO_TRACK_TYPE = 2;
const SEGMENT_SIZE_BYTES = 8;
export const WEBM_SEEKABLE_VERSION = 2;

const TOP_LEVEL_IDS = new Set([
    ID_SEEK_HEAD, ID_INFO, ID_TRACKS, ID_CLUSTER, ID_CUES,
    0x1043A770n, // Chapters
    0x1941A469n, // Attachments
    0x1254C367n, // Tags
    ID_VOID,
    ID_CRC32
]);

const ID_BYTES = new Map([
    [ID_SEEK_HEAD, new Uint8Array([0x11, 0x4D, 0x9B, 0x74])],
    [ID_SEEK, new Uint8Array([0x4D, 0xBB])],
    [ID_SEEK_ID, new Uint8Array([0x53, 0xAB])],
    [ID_SEEK_POSITION, new Uint8Array([0x53, 0xAC])],
    [ID_INFO, new Uint8Array([0x15, 0x49, 0xA9, 0x66])],
    [ID_TRACKS, new Uint8Array([0x16, 0x54, 0xAE, 0x6B])],
    [ID_DURATION, new Uint8Array([0x44, 0x89])],
    [ID_CUES, new Uint8Array([0x1C, 0x53, 0xBB, 0x6B])],
    [ID_CUE_POINT, new Uint8Array([0xBB])],
    [ID_CUE_TIME, new Uint8Array([0xB3])],
    [ID_CUE_TRACK_POS, new Uint8Array([0xB7])],
    [ID_CUE_TRACK, new Uint8Array([0xF7])],
    [ID_CUE_CLUSTER_POS, new Uint8Array([0xF1])]
]);

function vintLength(firstByte) {
    let mask = 0x80;
    for (let length = 1; length <= 8; length++, mask >>= 1) {
        if (firstByte & mask) return length;
    }
    throw new Error('Invalid EBML variable-length integer.');
}

function readElementId(bytes, offset) {
    if (offset >= bytes.length) throw new Error('Unexpected end of WebM data.');
    const length = vintLength(bytes[offset]);
    if (offset + length > bytes.length) throw new Error('Truncated WebM element ID.');
    let value = 0n;
    for (let i = 0; i < length; i++) value = (value << 8n) | BigInt(bytes[offset + i]);
    return { value, length };
}

function readElementSize(bytes, offset) {
    if (offset >= bytes.length) throw new Error('Unexpected end of WebM size field.');
    const length = vintLength(bytes[offset]);
    if (offset + length > bytes.length) throw new Error('Truncated WebM size field.');
    const marker = 1 << (8 - length);
    let value = BigInt(bytes[offset] & (marker - 1));
    for (let i = 1; i < length; i++) value = (value << 8n) | BigInt(bytes[offset + i]);
    const unknownMarker = (1n << BigInt(7 * length)) - 1n;
    return { value, length, unknown: value === unknownMarker };
}

function readElement(bytes, offset, logicalLimit = bytes.length) {
    const id = readElementId(bytes, offset);
    const sizeOffset = offset + id.length;
    const size = readElementSize(bytes, sizeOffset);
    const dataStart = sizeOffset + size.length;
    const numericSize = size.unknown ? null : Number(size.value);
    if (!size.unknown && (!Number.isSafeInteger(numericSize) || numericSize < 0)) {
        throw new Error('WebM element is too large to process safely.');
    }
    const dataEnd = size.unknown ? logicalLimit : dataStart + numericSize;
    if (!size.unknown && dataEnd > logicalLimit) throw new Error('Truncated WebM element payload.');
    return {
        id: id.value,
        start: offset,
        idLength: id.length,
        sizeOffset,
        sizeLength: size.length,
        dataStart,
        dataEnd,
        size: numericSize,
        unknownSize: size.unknown
    };
}

function concatBytes(...parts) {
    const length = parts.reduce((sum, part) => sum + part.length, 0);
    const out = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.length;
    }
    return out;
}

function encodeElementSize(value, preferredLength = 0) {
    let n = BigInt(value);
    if (n < 0n) throw new Error('Negative EBML element size.');
    let length = preferredLength || 1;
    while (length <= 8) {
        const maxFinite = (1n << BigInt(7 * length)) - 2n;
        if (n <= maxFinite) break;
        length++;
    }
    if (length > 8) throw new Error('EBML element is too large.');
    const out = new Uint8Array(length);
    let rest = n;
    for (let i = length - 1; i >= 0; i--) {
        out[i] = Number(rest & 0xFFn);
        rest >>= 8n;
    }
    out[0] |= 1 << (8 - length);
    return out;
}

function encodeUnsigned(value, preferredLength = 0) {
    let n = BigInt(value);
    if (n < 0n) throw new Error('Negative EBML unsigned integer.');
    let length = preferredLength || 1;
    while (length < 8 && n >= (1n << BigInt(length * 8))) length++;
    const out = new Uint8Array(length);
    for (let i = length - 1; i >= 0; i--) {
        out[i] = Number(n & 0xFFn);
        n >>= 8n;
    }
    return out;
}

function readUnsigned(bytes, start, length) {
    if (length < 1 || length > 8 || start + length > bytes.length) return null;
    let value = 0n;
    for (let i = 0; i < length; i++) value = (value << 8n) | BigInt(bytes[start + i]);
    const n = Number(value);
    return Number.isSafeInteger(n) ? n : null;
}

function element(id, payload) {
    const idBytes = ID_BYTES.get(id);
    if (!idBytes) throw new Error(`No encoder registered for EBML ID ${id.toString(16)}.`);
    return concatBytes(idBytes, encodeElementSize(payload.length), payload);
}

function uintElement(id, value) {
    return element(id, encodeUnsigned(value));
}

function durationElement(durationTicks) {
    const payload = new Uint8Array(8);
    new DataView(payload.buffer).setFloat64(0, durationTicks, false);
    return element(ID_DURATION, payload);
}

function findUnknownClusterEnd(bytes, cluster, segmentEnd) {
    let offset = cluster.dataStart;
    while (offset < segmentEnd) {
        const child = readElement(bytes, offset, segmentEnd);
        if (TOP_LEVEL_IDS.has(child.id) && offset > cluster.dataStart) return offset;
        if (child.unknownSize || child.dataEnd <= offset) {
            throw new Error('Unsupported unknown-size element inside WebM Cluster.');
        }
        offset = child.dataEnd;
    }
    return segmentEnd;
}

function parseTopLevel(bytes) {
    let offset = 0;
    let ebml = null;
    let segment = null;
    while (offset < bytes.length) {
        const current = readElement(bytes, offset, bytes.length);
        if (current.id === ID_EBML) ebml = current;
        if (current.id === ID_SEGMENT) {
            segment = current;
            break;
        }
        if (current.unknownSize || current.dataEnd <= offset) break;
        offset = current.dataEnd;
    }
    if (!ebml || !segment) throw new Error('Not a valid WebM document.');

    const children = [];
    const segmentEnd = segment.unknownSize ? bytes.length : segment.dataEnd;
    offset = segment.dataStart;
    while (offset < segmentEnd) {
        const child = readElement(bytes, offset, segmentEnd);
        let end = child.dataEnd;
        if (child.unknownSize) {
            if (child.id !== ID_CLUSTER) throw new Error('Unsupported unknown-size top-level WebM element.');
            end = findUnknownClusterEnd(bytes, child, segmentEnd);
        }
        if (end <= offset || end > segmentEnd) throw new Error('Malformed WebM top-level element.');
        children.push({ ...child, end });
        offset = end;
    }
    return { ebml, segment, segmentEnd, children };
}

function inspectInfo(bytes, info) {
    let timecodeScale = DEFAULT_TIMECODE_SCALE;
    let duration = null;
    let offset = info.dataStart;
    while (offset < info.end) {
        const child = readElement(bytes, offset, info.end);
        if (child.dataEnd > info.end) throw new Error('Malformed WebM Info element.');
        if (child.id === ID_TIMECODE_SCALE) {
            timecodeScale = readUnsigned(bytes, child.dataStart, child.size) || DEFAULT_TIMECODE_SCALE;
        } else if (child.id === ID_DURATION) {
            duration = child;
        }
        offset = child.dataEnd;
    }
    return { timecodeScale, duration };
}

function rebuildInfo(bytes, info, replacementDuration) {
    const parts = [];
    let offset = info.dataStart;
    let inserted = false;
    while (offset < info.end) {
        const child = readElement(bytes, offset, info.end);
        if (child.id === ID_CRC32) {
            offset = child.dataEnd;
            continue;
        }
        if (child.id === ID_DURATION) {
            if (!inserted) parts.push(replacementDuration);
            inserted = true;
        } else {
            parts.push(bytes.slice(child.start, child.dataEnd));
        }
        offset = child.dataEnd;
    }
    if (!inserted) parts.push(replacementDuration);
    return element(ID_INFO, concatBytes(...parts));
}

function findAudioTrack(bytes, tracks) {
    let firstTrack = null;
    let audioTrack = null;
    let offset = tracks.dataStart;
    while (offset < tracks.end) {
        const entry = readElement(bytes, offset, tracks.end);
        if (entry.id === ID_TRACK_ENTRY) {
            let number = null;
            let type = null;
            let inner = entry.dataStart;
            while (inner < entry.dataEnd) {
                const child = readElement(bytes, inner, entry.dataEnd);
                if (child.id === ID_TRACK_NUMBER) number = readUnsigned(bytes, child.dataStart, child.size);
                if (child.id === ID_TRACK_TYPE) type = readUnsigned(bytes, child.dataStart, child.size);
                inner = child.dataEnd;
            }
            if (number != null && firstTrack == null) firstTrack = number;
            if (number != null && type === AUDIO_TRACK_TYPE && audioTrack == null) audioTrack = number;
        }
        offset = entry.dataEnd;
    }
    return audioTrack || firstTrack || 1;
}

function clusterTimestamp(bytes, cluster) {
    let offset = cluster.dataStart;
    while (offset < cluster.end) {
        const child = readElement(bytes, offset, cluster.end);
        if (child.id === ID_TIMESTAMP) return readUnsigned(bytes, child.dataStart, child.size) || 0;
        if (child.unknownSize || child.dataEnd <= offset) break;
        offset = child.dataEnd;
    }
    return 0;
}

function cuePoint(time, track, clusterPosition) {
    return element(ID_CUE_POINT, concatBytes(
        uintElement(ID_CUE_TIME, time),
        element(ID_CUE_TRACK_POS, concatBytes(
            uintElement(ID_CUE_TRACK, track),
            uintElement(ID_CUE_CLUSTER_POS, clusterPosition)
        ))
    ));
}

function buildCues(clusterLayouts, track) {
    return element(ID_CUES, concatBytes(...clusterLayouts.map(cluster =>
        cuePoint(cluster.time, track, cluster.position)
    )));
}

function seekEntry(targetId, position) {
    const targetBytes = ID_BYTES.get(targetId);
    return element(ID_SEEK, concatBytes(
        element(ID_SEEK_ID, targetBytes),
        uintElement(ID_SEEK_POSITION, position)
    ));
}

function buildSeekHead(positions) {
    const entries = [];
    if (positions.info != null) entries.push(seekEntry(ID_INFO, positions.info));
    if (positions.tracks != null) entries.push(seekEntry(ID_TRACKS, positions.tracks));
    if (positions.cues != null) entries.push(seekEntry(ID_CUES, positions.cues));
    return element(ID_SEEK_HEAD, concatBytes(...entries));
}

/**
 * Remux a complete WebM byte array. Audio Cluster bytes are copied unchanged;
 * only container metadata and top-level ordering are rebuilt.
 */
export function remuxWebmSeekableBytes(input, durationMs) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    const ms = Number(durationMs);
    if (!Number.isFinite(ms) || ms <= 0) throw new Error('A positive recording duration is required.');

    const parsed = parseTopLevel(bytes);
    const info = parsed.children.find(child => child.id === ID_INFO);
    const tracks = parsed.children.find(child => child.id === ID_TRACKS);
    const clusters = parsed.children.filter(child => child.id === ID_CLUSTER);
    if (!info || !tracks || clusters.length === 0) {
        throw new Error('WebM is missing Info, Tracks, or Cluster data.');
    }

    const { timecodeScale } = inspectInfo(bytes, info);
    const durationTicks = (ms * 1_000_000) / timecodeScale;
    const rebuiltInfo = rebuildInfo(bytes, info, durationElement(durationTicks));
    const track = findAudioTrack(bytes, tracks);

    const clean = [];
    for (const child of parsed.children) {
        if (child.id === ID_SEEK_HEAD || child.id === ID_CUES || child.id === ID_VOID || child.id === ID_CRC32) continue;
        if (child.id === ID_INFO) {
            clean.push({ id: child.id, bytes: rebuiltInfo, length: rebuiltInfo.length, source: child });
        } else {
            const raw = bytes.slice(child.start, child.end);
            clean.push({ id: child.id, bytes: raw, length: raw.length, source: child });
        }
    }

    let seekHead = buildSeekHead({ info: 0, tracks: 0, cues: 0 });
    let cues = new Uint8Array(0);
    let layout = null;

    for (let iteration = 0; iteration < 8; iteration++) {
        let cursor = seekHead.length;
        const positions = { info: null, tracks: null, cues: null };
        const clusterLayouts = [];
        layout = [];
        for (const item of clean) {
            if (item.id === ID_INFO && positions.info == null) positions.info = cursor;
            if (item.id === ID_TRACKS && positions.tracks == null) positions.tracks = cursor;
            if (item.id === ID_CLUSTER) {
                clusterLayouts.push({
                    position: cursor,
                    time: clusterTimestamp(bytes, item.source)
                });
            }
            layout.push({ ...item, position: cursor });
            cursor += item.length;
        }
        positions.cues = cursor;
        const nextCues = buildCues(clusterLayouts, track);
        const nextSeekHead = buildSeekHead(positions);
        const stable = nextSeekHead.length === seekHead.length && nextCues.length === cues.length;
        seekHead = nextSeekHead;
        cues = nextCues;
        if (stable) break;
    }

    // Recompute one final layout with the settled SeekHead length.
    let cursor = seekHead.length;
    const finalPositions = { info: null, tracks: null, cues: null };
    const finalClusters = [];
    layout = [];
    for (const item of clean) {
        if (item.id === ID_INFO && finalPositions.info == null) finalPositions.info = cursor;
        if (item.id === ID_TRACKS && finalPositions.tracks == null) finalPositions.tracks = cursor;
        if (item.id === ID_CLUSTER) finalClusters.push({ position: cursor, time: clusterTimestamp(bytes, item.source) });
        layout.push({ ...item, position: cursor });
        cursor += item.length;
    }
    finalPositions.cues = cursor;
    cues = buildCues(finalClusters, track);
    seekHead = buildSeekHead(finalPositions);

    // A changed SeekHead length would move every target. One final convergence
    // pass is enough in practice because EBML integer widths change only at
    // powers of 256, but assert rather than silently writing stale positions.
    if (seekHead.length !== layout[0].position) {
        cursor = seekHead.length;
        finalPositions.info = finalPositions.tracks = null;
        finalClusters.length = 0;
        for (const item of clean) {
            if (item.id === ID_INFO && finalPositions.info == null) finalPositions.info = cursor;
            if (item.id === ID_TRACKS && finalPositions.tracks == null) finalPositions.tracks = cursor;
            if (item.id === ID_CLUSTER) finalClusters.push({ position: cursor, time: clusterTimestamp(bytes, item.source) });
            cursor += item.length;
        }
        finalPositions.cues = cursor;
        cues = buildCues(finalClusters, track);
        const converged = buildSeekHead(finalPositions);
        if (converged.length !== seekHead.length) throw new Error('WebM metadata layout did not converge.');
        seekHead = converged;
    }

    const body = concatBytes(seekHead, ...clean.map(item => item.bytes), cues);
    const segmentId = bytes.slice(parsed.segment.start, parsed.segment.sizeOffset);
    const prefix = bytes.slice(0, parsed.segment.start);
    const output = concatBytes(
        prefix,
        segmentId,
        encodeElementSize(body.length, SEGMENT_SIZE_BYTES),
        body
    );

    return {
        bytes: output,
        durationMs: ms,
        durationTicks,
        timecodeScale,
        cueCount: clusters.length,
        finiteSegment: true
    };
}

/** Read the Duration and Segment-size state from a complete WebM byte array. */
export function inspectWebmDurationBytes(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    const parsed = parseTopLevel(bytes);
    const info = parsed.children.find(child => child.id === ID_INFO);
    const cues = parsed.children.find(child => child.id === ID_CUES);
    if (!info) return { durationMs: 0, durationTicks: 0, timecodeScale: DEFAULT_TIMECODE_SCALE, present: false };
    const { duration, timecodeScale } = inspectInfo(bytes, info);
    if (!duration || (duration.size !== 4 && duration.size !== 8)) {
        return {
            durationMs: 0,
            durationTicks: 0,
            timecodeScale,
            present: false,
            finiteSegment: !parsed.segment.unknownSize,
            cueCount: cues ? 1 : 0
        };
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset + duration.dataStart, duration.size);
    const durationTicks = duration.size === 4 ? view.getFloat32(0, false) : view.getFloat64(0, false);
    const durationMs = durationTicks * timecodeScale / 1_000_000;
    let cueCount = 0;
    if (cues) {
        let offset = cues.dataStart;
        while (offset < cues.end) {
            const child = readElement(bytes, offset, cues.end);
            if (child.id === ID_CUE_POINT) cueCount++;
            offset = child.dataEnd;
        }
    }
    return {
        durationMs,
        durationTicks,
        timecodeScale,
        present: Number.isFinite(durationMs) && durationMs > 0,
        finiteSegment: !parsed.segment.unknownSize,
        cueCount
    };
}

class BlobEbmlReader {
    constructor(blob, cacheBytes = 1024 * 1024) {
        this.blob = blob;
        this.cacheBytes = cacheBytes;
        this.cacheStart = 0;
        this.cacheEnd = 0;
        this.cache = new Uint8Array(0);
    }

    async read(offset, length) {
        if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0) {
            throw new RangeError('Invalid Blob read range.');
        }
        const end = Math.min(this.blob.size, offset + length);
        if (end < offset || end > this.blob.size) throw new RangeError('Blob read exceeds file size.');
        if (offset >= this.cacheStart && end <= this.cacheEnd) {
            return this.cache.subarray(offset - this.cacheStart, end - this.cacheStart);
        }
        const fetchEnd = Math.min(this.blob.size, Math.max(end, offset + this.cacheBytes));
        this.cacheStart = offset;
        this.cacheEnd = fetchEnd;
        this.cache = new Uint8Array(await this.blob.slice(offset, fetchEnd).arrayBuffer());
        return this.cache.subarray(0, end - offset);
    }
}

async function readBlobElement(reader, offset, logicalLimit) {
    const available = Math.min(16, logicalLimit - offset);
    if (available <= 0) throw new Error('Unexpected end of WebM data.');
    const header = await reader.read(offset, available);
    const id = readElementId(header, 0);
    const size = readElementSize(header, id.length);
    const dataStart = offset + id.length + size.length;
    const numericSize = size.unknown ? null : Number(size.value);
    if (!size.unknown && (!Number.isSafeInteger(numericSize) || numericSize < 0)) {
        throw new Error('WebM element is too large to process safely.');
    }
    const dataEnd = size.unknown ? logicalLimit : dataStart + numericSize;
    if (!size.unknown && dataEnd > logicalLimit) throw new Error('Truncated WebM element payload.');
    return {
        id: id.value,
        start: offset,
        idLength: id.length,
        sizeOffset: offset + id.length,
        sizeLength: size.length,
        dataStart,
        dataEnd,
        size: numericSize,
        unknownSize: size.unknown
    };
}

async function findUnknownBlobClusterEnd(reader, cluster, segmentEnd) {
    let offset = cluster.dataStart;
    while (offset < segmentEnd) {
        const child = await readBlobElement(reader, offset, segmentEnd);
        if (TOP_LEVEL_IDS.has(child.id) && offset > cluster.dataStart) return offset;
        if (child.unknownSize || child.dataEnd <= offset) {
            throw new Error('Unsupported unknown-size element inside WebM Cluster.');
        }
        offset = child.dataEnd;
    }
    return segmentEnd;
}

async function parseBlobTopLevel(blob, reader) {
    let offset = 0;
    let ebml = null;
    let segment = null;
    while (offset < blob.size) {
        const current = await readBlobElement(reader, offset, blob.size);
        if (current.id === ID_EBML) ebml = current;
        if (current.id === ID_SEGMENT) {
            segment = current;
            break;
        }
        if (current.unknownSize || current.dataEnd <= offset) break;
        offset = current.dataEnd;
    }
    if (!ebml || !segment) throw new Error('Not a valid WebM document.');

    const segmentEnd = segment.unknownSize ? blob.size : segment.dataEnd;
    const children = [];
    offset = segment.dataStart;
    while (offset < segmentEnd) {
        const child = await readBlobElement(reader, offset, segmentEnd);
        let end = child.dataEnd;
        if (child.unknownSize) {
            if (child.id !== ID_CLUSTER) throw new Error('Unsupported unknown-size top-level WebM element.');
            end = await findUnknownBlobClusterEnd(reader, child, segmentEnd);
        }
        if (end <= offset || end > segmentEnd) throw new Error('Malformed WebM top-level element.');
        children.push({ ...child, end });
        offset = end;
    }
    return { ebml, segment, segmentEnd, children };
}

async function readLocalElement(reader, source) {
    const bytes = new Uint8Array(await reader.blob.slice(source.start, source.end).arrayBuffer());
    const local = readElement(bytes, 0, bytes.length);
    return { bytes, element: { ...local, end: bytes.length } };
}

async function clusterTimestampDetailsFromBlob(reader, cluster) {
    // Timestamp is required near the beginning of every Cluster. Read only a
    // bounded prefix: long recordings may contain thousands of large Clusters,
    // and materializing each one would defeat the streaming transcription path.
    const prefixEnd = Math.min(cluster.end, cluster.start + 64 * 1024);
    const bytes = new Uint8Array(await reader.blob.slice(cluster.start, prefixEnd).arrayBuffer());
    const id = readElementId(bytes, 0);
    if (id.value !== ID_CLUSTER) throw new Error('Expected a WebM Cluster.');
    const size = readElementSize(bytes, id.length);
    let offset = id.length + size.length;
    while (offset < bytes.length) {
        const child = readElement(bytes, offset, bytes.length);
        if (child.id === ID_TIMESTAMP) {
            const ticks = readUnsigned(bytes, child.dataStart, child.size || 0);
            if (ticks == null) throw new Error('Invalid WebM Cluster timestamp.');
            return {
                ticks,
                size: child.size,
                dataStart: cluster.start + child.dataStart,
                dataEnd: cluster.start + child.dataEnd
            };
        }
        if (child.unknownSize || child.dataEnd <= offset) break;
        offset = child.dataEnd;
    }
    throw new Error('WebM Cluster is missing its Timestamp element.');
}

async function clusterTimestampFromBlob(reader, cluster) {
    return (await clusterTimestampDetailsFromBlob(reader, cluster)).ticks;
}

function buildIndexedMetadata(clean, track) {
    let seekHead = buildSeekHead({ info: 0, tracks: 0, cues: 0 });
    let cues = new Uint8Array(0);

    for (let iteration = 0; iteration < 12; iteration++) {
        let cursor = seekHead.length;
        const positions = { info: null, tracks: null, cues: null };
        const clusters = [];
        for (const item of clean) {
            if (item.id === ID_INFO && positions.info == null) positions.info = cursor;
            if (item.id === ID_TRACKS && positions.tracks == null) positions.tracks = cursor;
            if (item.id === ID_CLUSTER) clusters.push({ position: cursor, time: item.clusterTime || 0 });
            cursor += item.length;
        }
        positions.cues = cursor;
        const nextCues = buildCues(clusters, track);
        const nextSeekHead = buildSeekHead(positions);
        const stable = nextSeekHead.length === seekHead.length
            && nextSeekHead.every((byte, index) => byte === seekHead[index])
            && nextCues.length === cues.length
            && nextCues.every((byte, index) => byte === cues[index]);
        seekHead = nextSeekHead;
        cues = nextCues;
        if (stable) return { seekHead, cues };
    }
    throw new Error('WebM metadata layout did not converge.');
}

/**
 * Inspect a WebM/Opus Blob once and retain only its small container metadata and
 * Cluster coordinates. The returned source can create independent decode-sized
 * WebM windows without reading or decoding the complete recording. This is the
 * basis for multi-hour compressed transcription.
 */
export async function prepareWebmChunkSource(blob, durationMs = 0) {
    if (!(blob instanceof Blob)) throw new TypeError('Expected a Blob.');
    const type = String(blob.type || '').toLowerCase();
    if (!type.includes('webm')) return null;

    const reader = new BlobEbmlReader(blob);
    const parsed = await parseBlobTopLevel(blob, reader);
    const infoSource = parsed.children.find(child => child.id === ID_INFO);
    const tracksSource = parsed.children.find(child => child.id === ID_TRACKS);
    const clusterSources = parsed.children.filter(child => child.id === ID_CLUSTER);
    if (!infoSource || !tracksSource || clusterSources.length === 0) {
        throw new Error('WebM is missing Info, Tracks, or Cluster data.');
    }

    const localInfo = await readLocalElement(reader, infoSource);
    const localTracks = await readLocalElement(reader, tracksSource);
    const { timecodeScale, duration } = inspectInfo(localInfo.bytes, localInfo.element);
    findAudioTrack(localTracks.bytes, localTracks.element); // validate an audio track exists

    const clusters = [];
    let previousTicks = -1;
    for (const cluster of clusterSources) {
        const timestamp = await clusterTimestampDetailsFromBlob(reader, cluster);
        if (timestamp.ticks < previousTicks) {
            throw new Error('WebM Cluster timestamps are not monotonic.');
        }
        previousTicks = timestamp.ticks;
        clusters.push({
            ...cluster,
            timestampTicks: timestamp.ticks,
            timestampSize: timestamp.size,
            timestampDataStart: timestamp.dataStart,
            timestampDataEnd: timestamp.dataEnd,
            startSec: timestamp.ticks * timecodeScale / 1_000_000_000
        });
    }

    const declaredDurationSec = Number(durationMs) > 0 ? Number(durationMs) / 1000 : 0;
    const infoDurationSec = duration && (duration.size === 4 || duration.size === 8)
        ? (() => {
            const view = new DataView(localInfo.bytes.buffer,
                localInfo.bytes.byteOffset + duration.dataStart, duration.size);
            const ticks = duration.size === 4 ? view.getFloat32(0, false) : view.getFloat64(0, false);
            return Number.isFinite(ticks) ? ticks * timecodeScale / 1_000_000_000 : 0;
        })()
        : 0;
    // The recording row's elapsed duration is the most reliable value for a live
    // MediaRecorder file. Existing Duration metadata is a fallback. A final
    // Cluster has no explicit end, so retain a small conservative tail only when
    // neither source supplies one.
    const finalStartSec = clusters[clusters.length - 1].startSec;
    const durationSec = Math.max(declaredDurationSec, infoDurationSec, finalStartSec + 0.001);
    for (let i = 0; i < clusters.length; i++) {
        clusters[i].endSec = i + 1 < clusters.length
            ? Math.max(clusters[i].startSec, clusters[i + 1].startSec)
            : durationSec;
    }

    return {
        kind: 'myai-webm-chunk-source-v1',
        blob,
        type: blob.type || 'audio/webm;codecs=opus',
        prefixEnd: parsed.segment.start,
        segmentId: new Uint8Array(await reader.read(parsed.segment.start, parsed.segment.idLength)),
        infoBytes: localInfo.bytes,
        infoElement: localInfo.element,
        tracksBytes: localTracks.bytes,
        timecodeScale,
        durationSec,
        clusters
    };
}

/**
 * Create a finite standalone WebM containing only the Clusters needed to decode
 * one requested time window. Cluster timestamps are rebased to zero by replacing
 * only their Timestamp payload bytes; compressed Opus packets remain untouched.
 * The caller trims `trimStartSec` after decoding to reach the exact requested
 * boundary because Cluster boundaries usually precede it slightly.
 */
export async function makeWebmDecodeChunk(source, startSec, endSec) {
    if (!source || source.kind !== 'myai-webm-chunk-source-v1') {
        throw new TypeError('Expected a prepared WebM chunk source.');
    }
    const start = Math.max(0, Number(startSec) || 0);
    const end = Math.min(source.durationSec, Number(endSec) || 0);
    if (!(end > start)) throw new RangeError('Invalid WebM decode range.');

    const selected = source.clusters.filter(cluster =>
        cluster.endSec > start && cluster.startSec < end
    );
    if (selected.length === 0) throw new Error('No WebM Clusters overlap the requested range.');

    const first = selected[0];
    const last = selected[selected.length - 1];
    const originTicks = first.timestampTicks;
    const clusterParts = selected.map(cluster => {
        const rebasedTicks = cluster.timestampTicks - originTicks;
        const timestampBytes = encodeUnsigned(rebasedTicks, cluster.timestampSize);
        if (timestampBytes.length !== cluster.timestampSize) {
            throw new Error('Rebased WebM timestamp does not fit its original field.');
        }
        return new Blob([
            source.blob.slice(cluster.start, cluster.timestampDataStart),
            timestampBytes,
            source.blob.slice(cluster.timestampDataEnd, cluster.end)
        ], { type: source.type });
    });

    const includedDurationSec = Math.max(0.001, last.endSec - first.startSec);
    const durationTicks = includedDurationSec * 1_000_000_000 / source.timecodeScale;
    const rebuiltInfo = rebuildInfo(
        source.infoBytes,
        source.infoElement,
        durationElement(durationTicks)
    );
    const bodyLength = rebuiltInfo.length + source.tracksBytes.length
        + clusterParts.reduce((sum, part) => sum + part.size, 0);
    const chunkBlob = new Blob([
        source.blob.slice(0, source.prefixEnd),
        source.segmentId,
        encodeElementSize(bodyLength, SEGMENT_SIZE_BYTES),
        rebuiltInfo,
        source.tracksBytes,
        ...clusterParts
    ], { type: source.type });

    return {
        blob: chunkBlob,
        trimStartSec: Math.max(0, start - first.startSec),
        requestedDurationSec: end - start,
        includedStartSec: first.startSec,
        includedEndSec: last.endSec,
        clusterCount: selected.length
    };
}

/**
 * Return a standards-oriented, seekable WebM Blob. This is a container remux:
 * Opus packets are preserved exactly and are never decoded or re-encoded. The
 * Blob path scans through a 1 MiB window and returns original Cluster slices,
 * avoiding whole-file materialization for long compressed recordings.
 */
export async function makeWebmSeekable(blob, durationMs) {
    if (!(blob instanceof Blob)) throw new TypeError('Expected a Blob.');
    const type = String(blob.type || '').toLowerCase();
    if (!type.includes('webm')) return blob;
    const ms = Number(durationMs);
    if (!Number.isFinite(ms) || ms <= 0) return blob;

    const reader = new BlobEbmlReader(blob);
    const parsed = await parseBlobTopLevel(blob, reader);
    const infoSource = parsed.children.find(child => child.id === ID_INFO);
    const tracksSource = parsed.children.find(child => child.id === ID_TRACKS);
    const clusterSources = parsed.children.filter(child => child.id === ID_CLUSTER);
    if (!infoSource || !tracksSource || clusterSources.length === 0) {
        throw new Error('WebM is missing Info, Tracks, or Cluster data.');
    }

    const localInfo = await readLocalElement(reader, infoSource);
    const localTracks = await readLocalElement(reader, tracksSource);
    const { timecodeScale } = inspectInfo(localInfo.bytes, localInfo.element);
    const durationTicks = (ms * 1_000_000) / timecodeScale;
    const rebuiltInfo = rebuildInfo(localInfo.bytes, localInfo.element, durationElement(durationTicks));
    const track = findAudioTrack(localTracks.bytes, localTracks.element);

    const clusterTimes = new Map();
    for (const cluster of clusterSources) {
        clusterTimes.set(cluster.start, await clusterTimestampFromBlob(reader, cluster));
    }

    const clean = [];
    for (const child of parsed.children) {
        if (child.id === ID_SEEK_HEAD || child.id === ID_CUES || child.id === ID_VOID || child.id === ID_CRC32) continue;
        if (child.id === ID_INFO) {
            clean.push({ id: child.id, part: rebuiltInfo, length: rebuiltInfo.length });
        } else {
            clean.push({
                id: child.id,
                part: blob.slice(child.start, child.end),
                length: child.end - child.start,
                clusterTime: child.id === ID_CLUSTER ? clusterTimes.get(child.start) || 0 : null
            });
        }
    }

    const { seekHead, cues } = buildIndexedMetadata(clean, track);
    const bodyLength = seekHead.length + clean.reduce((sum, item) => sum + item.length, 0) + cues.length;
    const segmentId = await reader.read(parsed.segment.start, parsed.segment.idLength);
    return new Blob([
        blob.slice(0, parsed.segment.start),
        new Uint8Array(segmentId),
        encodeElementSize(bodyLength, SEGMENT_SIZE_BYTES),
        seekHead,
        ...clean.map(item => item.part),
        cues
    ], { type: blob.type || 'audio/webm' });
}
