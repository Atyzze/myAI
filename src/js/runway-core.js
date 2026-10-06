const FINALIZE_MARGIN_MIN_BYTES = 2 * 1024 * 1024;
const FINALIZE_MARGIN_FRACTION = 0.05;

const UNKNOWN = { secondsLeft: Infinity, known: false };

export function storageRunway({ usedBytes, quotaBytes, recordedBytes = 0, bytesPerSec = 0 } = {}) {
    const used = Number(usedBytes);
    const quota = Number(quotaBytes);
    const recorded = Math.max(0, Number(recordedBytes) || 0);
    const rate = Math.max(0, Number(bytesPerSec) || 0);
    if (!Number.isFinite(used) || !Number.isFinite(quota) || quota <= 0) return { ...UNKNOWN, free: null };
    const free = Math.max(0, quota - used);
    if (rate <= 0) return { ...UNKNOWN, free, saveableSec: Infinity, captureSec: Infinity };

    const byFraction = (free - (1 + FINALIZE_MARGIN_FRACTION) * recorded)
                     / ((2 + FINALIZE_MARGIN_FRACTION) * rate);
    const byFloor = (free - recorded - FINALIZE_MARGIN_MIN_BYTES) / (2 * rate);
    const saveableSec = Math.max(0, Math.min(byFraction, byFloor));
    const captureSec = Math.max(0, free / rate);
    return {
        known: true,
        free,
        bytesPerSec: rate,
        saveableSec,
        captureSec,
        secondsLeft: saveableSec,
        limit: 'storage'
    };
}





export function sessionRunway({ storage = null } = {}) {
    if (!storage || !storage.known || !Number.isFinite(storage.secondsLeft)) {
        return { known: false, secondsLeft: Infinity, limit: null, storage };
    }
    return { known: true, secondsLeft: storage.secondsLeft, limit: storage.limit, storage };
}

export const RUNWAY_ALERTS = Object.freeze([3600, 1800, 900, 600, 300, 120]);

export function nextRunwayAlert(secondsLeft, lastAnnounced = Infinity) {
    const left = Number(secondsLeft);
    if (!Number.isFinite(left)) return null;
    const floor = Number(lastAnnounced);
    for (const threshold of [...RUNWAY_ALERTS].sort((a, b) => a - b)) {
        if (left <= threshold && threshold < floor) return threshold;
    }
    return null;
}

export function runwayTone(secondsLeft) {
    const left = Number(secondsLeft);
    if (!Number.isFinite(left)) return 'ok';
    if (left <= 600) return 'error';
    if (left <= 1800) return 'warn';
    return 'ok';
}

function shortDuration(seconds) {
    const value = Math.max(0, Math.floor(Number(seconds) || 0));
    if (value >= 7200) return `${Math.floor(value / 3600)} h`;
    if (value >= 3600) return `${(Math.floor(value / 360) / 10).toFixed(1)} h`;
    if (value >= 60) return `${Math.floor(value / 60)} min`;
    return `${value}s`;
}

export function describeSpaceRunway(storage) {
    if (!storage || !storage.known) return '';
    const seconds = Number.isFinite(storage.saveableSec) ? storage.saveableSec : storage.secondsLeft;
    if (!Number.isFinite(seconds)) return '';
    return `💾 about ${shortDuration(seconds)} of space`;
}


export function describeRunway(runway, { persistent = null } = {}) {
    if (!runway || !runway.known) {
        return persistent === false ? '⚠️ storage is not persistent - the browser may clear it' : '';
    }
    const evict = persistent === false ? ' · not persistent, the browser may clear it' : '';
    const parts = [describeSpaceRunway(runway.storage)].filter(Boolean);
    if (!parts.length) parts.push(`💾 about ${shortDuration(runway.secondsLeft)} of space`);
    return `${parts.join(' · ')}${evict}`;
}

export function describeRunwayAlert(runway, threshold) {
    const actual = runway && Number(runway.secondsLeft);
    const left = shortDuration(Number.isFinite(actual) && actual < threshold ? actual : threshold);
    return `💾 about ${left} left before this recording can still be saved as one file`
        + ' - stop now and start a new note, or free space; Opus at a lower bitrate records for far longer';
}
