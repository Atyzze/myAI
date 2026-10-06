export const ZIP_MAX_BYTES = 0xFFFFFFFF;

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        table[n] = c >>> 0;
    }
    return table;
})();

export function crc32Init() { return 0xFFFFFFFF; }
export function crc32Update(crc, bytes) {
    let c = crc >>> 0;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return c >>> 0;
}
export function crc32Final(crc) { return (crc ^ 0xFFFFFFFF) >>> 0; }

const encoder = new TextEncoder();

function writer(length) {
    const bytes = new Uint8Array(length);
    const view = new DataView(bytes.buffer);
    let offset = 0;
    return {
        bytes,
        u16(value) { view.setUint16(offset, value, true); offset += 2; return this; },
        u32(value) {
            if (!Number.isInteger(value) || value < 0 || value > ZIP_MAX_BYTES) throw new RangeError(`ZIP field out of range: ${value}`);
            view.setUint32(offset, value, true); offset += 4; return this;
        },
        raw(part) { bytes.set(part, offset); offset += part.length; return this; }
    };
}

export function dosDateTime(timestamp) {
    const value = Number(timestamp);
    const date = new Date(Number.isFinite(value) ? value : Date.now());
    const year = Math.max(1980, date.getFullYear());
    return {
        time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
        date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
    };
}

export function localHeader(entry) {
    const name = encoder.encode(entry.name);
    const { time, date } = dosDateTime(entry.timestamp);
    const out = writer(30 + name.length);
    out.u32(0x04034B50).u16(20).u16(0x0800)
       .u16(0).u16(time).u16(date)
       .u32(entry.crc).u32(entry.size).u32(entry.size)
       .u16(name.length).u16(0).raw(name);
    return out.bytes;
}

export function centralHeader(entry) {
    const name = encoder.encode(entry.name);
    const { time, date } = dosDateTime(entry.timestamp);
    const out = writer(46 + name.length);
    out.u32(0x02014B50).u16(20).u16(20).u16(0x0800)
       .u16(0).u16(time).u16(date)
       .u32(entry.crc).u32(entry.size).u32(entry.size)
       .u16(name.length).u16(0).u16(0)
       .u16(0).u16(0).u32(0)
       .u32(entry.offset).raw(name);
    return out.bytes;
}

export function endOfCentralDirectory(count, directorySize, directoryOffset) {
    const out = writer(22);
    out.u32(0x06054B50).u16(0).u16(0).u16(count).u16(count)
       .u32(directorySize).u32(directoryOffset).u16(0);
    return out.bytes;
}

export function uniqueEntryName(name, taken) {
    const cleaned = String(name || 'file')
        .replace(/[\u0000-\u001F]/g, '')
        .split(/[\\/]+/)
        .map(segment => segment.trim())
        .filter(segment => segment && segment !== '.' && segment !== '..')
        .join('-')
        .replace(/^\.+/, '')
        .trim() || 'file';
    if (!taken.has(cleaned)) { taken.add(cleaned); return cleaned; }
    const dot = cleaned.lastIndexOf('.');
    const stem = dot > 0 ? cleaned.slice(0, dot) : cleaned;
    const ext = dot > 0 ? cleaned.slice(dot) : '';
    for (let n = 2; ; n++) {
        const candidate = `${stem} (${n})${ext}`;
        if (!taken.has(candidate)) { taken.add(candidate); return candidate; }
    }
}

export function zipArchiveBytes(entries) {
    const list = entries || [];
    const probe = entry => ({ name: entry.name, size: 0, crc: 0, offset: 0, timestamp: 0 });
    const locals = list.reduce((sum, entry) => sum + localHeader(probe(entry)).length + entry.size, 0);
    const central = list.reduce((sum, entry) => sum + centralHeader(probe(entry)).length, 0);
    return locals + central + endOfCentralDirectory(list.length, 0, 0).length;
}
