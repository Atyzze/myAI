// Synthetic WebM files, built element by element the way MediaRecorder writes them (an unknown-size
// Segment, clusters of Opus blocks), for tests that need a real container without a real encoder.
export const concat = (...parts) => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let off = 0;
    for (const part of parts) { out.set(part, off); off += part.length; }
    return out;
};
export const size = n => {
    if (n <= 126) return new Uint8Array([0x80 | n]);
    if (n <= 16382) return new Uint8Array([0x40 | (n >> 8), n & 0xff]);
    throw new Error('test size too large');
};
export const uintPayload = (n, bytes = 1) => {
    const out = new Uint8Array(bytes);
    for (let i = bytes - 1; i >= 0; i--) { out[i] = n & 0xff; n = Math.floor(n / 256); }
    return out;
};
export const element = (id, payload) => concat(new Uint8Array(id), size(payload.length), payload);
export const float64 = n => {
    const out = new Uint8Array(8);
    new DataView(out.buffer).setFloat64(0, n, false);
    return out;
};
export const unknownSegmentSize = new Uint8Array([0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]);

export function clusterPayload(time, marker) {
    const timestampBytes = time > 0xFFFFFF ? 4 : time > 0xFFFF ? 3 : time > 0xFF ? 2 : 1;
    const timestamp = element([0xE7], uintPayload(time, timestampBytes));
    const simpleBlock = element([0xA3], new Uint8Array([0x81, 0x00, 0x00, 0x80, marker, marker + 1, marker + 2]));
    return concat(timestamp, simpleBlock);
}

export function cluster(time, marker, unknownSize = false) {
    const payload = clusterPayload(time, marker);
    return unknownSize
        ? concat(new Uint8Array([0x1F, 0x43, 0xB6, 0x75]), unknownSegmentSize, payload)
        : element([0x1F, 0x43, 0xB6, 0x75], payload);
}

export function syntheticWebm({ durationTicks = null, scale = 1_000_000, includeClusters = true, clusterTimes = [0, 4000, 8000], unknownClusterSize = false } = {}) {
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
    const clusters = includeClusters ? clusterTimes.map((time, i) => cluster(time, 0x31 + i * 0x10, unknownClusterSize)) : [];
    const payloads = includeClusters ? clusterTimes.map((time, i) => clusterPayload(time, 0x31 + i * 0x10)) : [];
    const segment = concat(
        new Uint8Array([0x18, 0x53, 0x80, 0x67]),
        unknownSegmentSize,
        staleSeek, voidEl, info, tracks, ...clusters
    );
    return { bytes: concat(ebml, segment), clusters, payloads };
}

