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
const ID_SIMPLE_BLOCK   = 0xA3n;
const OPUS_FRAME_MS     = 20;

const DEFAULT_TIMECODE_SCALE = 1_000_000;
const AUDIO_TRACK_TYPE = 2;
const SEGMENT_SIZE_BYTES = 8;
export const WEBM_SEEKABLE_VERSION = 3;

const TOP_LEVEL_IDS = new Set([
    ID_SEEK_HEAD, ID_INFO, ID_TRACKS, ID_CLUSTER, ID_CUES,
    0x1043A770n,
    0x1941A469n,
    0x1254C367n,
    ID_VOID,
    ID_CRC32
]);

const CLUSTER_TERMINATOR_IDS = new Set(
    [...TOP_LEVEL_IDS].filter(id => id !== ID_VOID && id !== ID_CRC32));

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
        if (CLUSTER_TERMINATOR_IDS.has(child.id) && offset > cluster.dataStart) return offset;
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
        const bytes = new Uint8Array(await this.blob.slice(offset, fetchEnd).arrayBuffer());
        this.cacheStart = offset;
        this.cacheEnd = fetchEnd;
        this.cache = bytes;
        return bytes.subarray(0, end - offset);
    }
}

function truncatedAtEnd(message, { header = false } = {}) {
    const err = new Error(message);
    err.truncated = true;
    err.carriesNoAudio = header;
    return err;
}

async function readBlobElement(reader, offset, logicalLimit) {
    const available = Math.min(16, logicalLimit - offset);
    const atFileEnd = logicalLimit >= reader.blob.size;
    if (available <= 0) throw truncatedAtEnd('Unexpected end of WebM data.', { header: true });
    const header = await reader.read(offset, available);
    let id;
    let size;
    try {
        id = readElementId(header, 0);
        size = readElementSize(header, id.length);
    } catch (err) {
        if (available < 16 && atFileEnd) throw truncatedAtEnd(err.message, { header: true });
        throw err;
    }
    const dataStart = offset + id.length + size.length;
    const numericSize = size.unknown ? null : Number(size.value);
    if (!size.unknown && (!Number.isSafeInteger(numericSize) || numericSize < 0)) {
        throw new Error('WebM element is too large to process safely.');
    }
    const dataEnd = size.unknown ? logicalLimit : dataStart + numericSize;
    if (!size.unknown && dataEnd > logicalLimit) {
        if (atFileEnd) throw truncatedAtEnd('Truncated WebM element payload.');
        throw new Error('Truncated WebM element payload.');
    }
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
        let child;
        try {
            child = await readBlobElement(reader, offset, segmentEnd);
        } catch (err) {
            if (err && err.truncated) {
                if (offset > cluster.dataStart) return { end: offset, cutShort: true };
                err.carriesNoAudio = true;
            }
            throw err;
        }
        if (CLUSTER_TERMINATOR_IDS.has(child.id) && offset > cluster.dataStart) return { end: offset, cutShort: false };
        if (child.unknownSize || child.dataEnd <= offset) {
            throw new Error('Unsupported unknown-size element inside WebM Cluster.');
        }
        offset = child.dataEnd;
    }
    return { end: segmentEnd, cutShort: false };
}

const CLUSTER_TIMESTAMP_PREFIX_BYTES = 4 * 1024;
const CLUSTER_TIMESTAMP_MAX_PREFIX_BYTES = 64 * 1024;

function findClusterTimestamp(bytes, clusterStart) {
    const id = readElementId(bytes, 0);
    if (id.value !== ID_CLUSTER) throw new Error('Expected a WebM Cluster.');
    const size = readElementSize(bytes, id.length);
    let offset = id.length + size.length;
    while (offset < bytes.length) {
        let child;
        try {
            child = readElement(bytes, offset, bytes.length);
        } catch (_) {
            return null;
        }
        if (child.id === ID_TIMESTAMP) {
            const ticks = readUnsigned(bytes, child.dataStart, child.size || 0);
            if (ticks == null) throw new Error('Invalid WebM Cluster timestamp.');
            return {
                ticks,
                size: child.size,
                dataStart: clusterStart + child.dataStart,
                dataEnd: clusterStart + child.dataEnd
            };
        }
        if (child.unknownSize || child.dataEnd <= offset) return null;
        offset = child.dataEnd;
    }
    return null;
}

async function clusterTimestampDetailsFromBlob(reader, cluster) {
    const span = cluster.end - cluster.start;
    const windows = [CLUSTER_TIMESTAMP_PREFIX_BYTES, CLUSTER_TIMESTAMP_MAX_PREFIX_BYTES];
    for (const want of windows) {
        const length = Math.min(span, want);
        const found = findClusterTimestamp(await reader.read(cluster.start, length), cluster.start);
        if (found) return found;
        if (length >= span) break;
    }
    throw new Error('WebM Cluster is missing its Timestamp element.');
}

async function parseBlobTopLevel(blob, reader, { tolerateTruncation = false } = {}) {
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
    let truncatedAt = null;
    let trimmedTailBytes = 0;
    offset = segment.dataStart;
    while (offset < segmentEnd) {
        try {
            const child = await readBlobElement(reader, offset, segmentEnd);
            let end = child.dataEnd;
            let cutShort = false;
            if (child.unknownSize) {
                if (child.id !== ID_CLUSTER) throw new Error('Unsupported unknown-size top-level WebM element.');
                ({ end, cutShort } = await findUnknownBlobClusterEnd(reader, child, segmentEnd));
            }
            if (end <= offset || end > segmentEnd) throw new Error('Malformed WebM top-level element.');
            const timestamp = child.id === ID_CLUSTER
                ? await clusterTimestampDetailsFromBlob(reader, { ...child, end })
                : null;
            children.push({ ...child, end, timestamp });
            offset = end;
            if (cutShort) {
                trimmedTailBytes = blob.size - end;
                break;
            }
        } catch (err) {
            if (err && err.truncated && err.carriesNoAudio && children.length > 0) {
                trimmedTailBytes = blob.size - offset;
                break;
            }
            if (!tolerateTruncation || children.length === 0) throw err;
            truncatedAt = { offset, reason: err && err.message ? err.message : String(err) };
            break;
        }
    }
    return { ebml, segment, segmentEnd, children, truncatedAt, trimmedTailBytes };
}

async function readLocalElement(reader, source) {
    const bytes = new Uint8Array(await reader.blob.slice(source.start, source.end).arrayBuffer());
    const local = readElement(bytes, 0, bytes.length);
    return { bytes, element: { ...local, end: bytes.length } };
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

export function estimateTruncatedDurationSec(startSecs) {
    const starts = (startSecs || []).map(Number).filter(Number.isFinite);
    if (starts.length === 0) return 0;
    const last = starts[starts.length - 1];
    const gaps = [];
    for (let i = 1; i < starts.length; i++) {
        const gap = starts[i] - starts[i - 1];
        if (gap > 0) gaps.push(gap);
    }
    if (gaps.length === 0) return last + 0.001;
    gaps.sort((a, b) => a - b);
    const mid = Math.floor(gaps.length / 2);
    const median = gaps.length % 2 === 1 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2;
    return last + Math.max(0.001, median);
}

export async function prepareWebmChunkSource(blob, durationMs = 0, { tolerateTruncation = false } = {}) {
    if (!(blob instanceof Blob)) throw new TypeError('Expected a Blob.');
    const type = String(blob.type || '').toLowerCase();
    if (!type.includes('webm')) return null;

    const reader = new BlobEbmlReader(blob);
    const parsed = await parseBlobTopLevel(blob, reader, { tolerateTruncation });
    const infoSource = parsed.children.find(child => child.id === ID_INFO);
    const tracksSource = parsed.children.find(child => child.id === ID_TRACKS);
    const clusterSources = parsed.children.filter(child => child.id === ID_CLUSTER);
    if (!infoSource || !tracksSource || clusterSources.length === 0) {
        throw new Error('WebM is missing Info, Tracks, or Cluster data.');
    }

    const localInfo = await readLocalElement(reader, infoSource);
    const localTracks = await readLocalElement(reader, tracksSource);
    const { timecodeScale, duration } = inspectInfo(localInfo.bytes, localInfo.element);
    findAudioTrack(localTracks.bytes, localTracks.element);

    const clusters = [];
    let previousTicks = -1;
    for (const cluster of clusterSources) {
        const timestamp = cluster.timestamp;
        if (!timestamp) throw new Error('WebM Cluster is missing its Timestamp element.');
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
    if (parsed.truncatedAt && clusters.length < 2) {
        throw new Error(`WebM container ends at byte ${parsed.truncatedAt.offset} before a usable amount of audio was indexed (${parsed.truncatedAt.reason}).`);
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
    const finalStartSec = clusters[clusters.length - 1].startSec;
    const durationSec = parsed.truncatedAt
        ? estimateTruncatedDurationSec(clusters.map(cluster => cluster.startSec))
        : Math.max(declaredDurationSec, infoDurationSec, finalStartSec + 0.001);
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
        clusters,
        truncatedAt: parsed.truncatedAt
    };
}

export async function webmAudioEndMs(blob) {
    const source = await prepareWebmChunkSource(blob, 0, { tolerateTruncation: true });
    if (!source || !source.clusters.length) return null;
    const reader = new BlobEbmlReader(blob);
    const last = source.clusters[source.clusters.length - 1];
    const ticks = [];
    let offset = last.dataStart;
    while (offset < last.end) {
        let child;
        try { child = await readBlobElement(reader, offset, last.end); } catch (_) { break; }
        if (child.id === ID_SIMPLE_BLOCK && child.dataEnd - child.dataStart >= 3) {
            const head = await reader.read(child.dataStart, Math.min(11, child.dataEnd - child.dataStart));
            const trackLength = vintLength(head[0]);
            if (head.length >= trackLength + 2) {
                const relative = ((head[trackLength] << 8) | head[trackLength + 1]) << 16 >> 16;
                ticks.push(last.timestampTicks + relative);
            }
        }
        if (child.unknownSize || child.dataEnd <= offset) break;
        offset = child.dataEnd;
    }
    const tickMs = source.timecodeScale / 1_000_000;
    if (!ticks.length) return last.timestampTicks * tickMs;
    const steps = [];
    for (let i = 1; i < ticks.length; i++) if (ticks[i] > ticks[i - 1]) steps.push(ticks[i] - ticks[i - 1]);
    steps.sort((a, b) => a - b);
    const frameMs = steps.length ? steps[Math.floor(steps.length / 2)] * tickMs : OPUS_FRAME_MS;
    return Math.max(...ticks) * tickMs + frameMs;
}

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

async function knownSizeCluster(reader, cluster) {
    const size = encodeElementSize(cluster.end - cluster.dataStart, cluster.sizeLength);
    if (size.length !== cluster.sizeLength) return reader.blob.slice(cluster.start, cluster.end);
    const id = new Uint8Array(await reader.read(cluster.start, cluster.idLength));
    return new Blob([id, size, reader.blob.slice(cluster.dataStart, cluster.end)]);
}

export function needsSeekableUpgrade(rec) {
    return !!(rec && Number(rec.audioBytes) > 0 && rec.format === 'opus')
        && String(rec.mime || '').toLowerCase().includes('webm')
        && Number(rec.durationMs) > 0
        && Number(rec.webmSeekableVersion || 0) < WEBM_SEEKABLE_VERSION;
}

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

    const clean = [];
    for (const child of parsed.children) {
        if (child.id === ID_SEEK_HEAD || child.id === ID_CUES || child.id === ID_VOID || child.id === ID_CRC32) continue;
        if (child.id === ID_INFO) {
            clean.push({ id: child.id, part: rebuiltInfo, length: rebuiltInfo.length });
        } else {
            clean.push({
                id: child.id,
                part: child.id === ID_CLUSTER && child.unknownSize
                    ? await knownSizeCluster(reader, child)
                    : blob.slice(child.start, child.end),
                length: child.end - child.start,
                clusterTime: child.id === ID_CLUSTER ? (child.timestamp ? child.timestamp.ticks : 0) : null
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
