export const OPUS_MIME_PREFERENCE = [
    'audio/webm;codecs=opus',
    'audio/ogg;codecs=opus',
    'audio/webm',
    'audio/ogg'
];

export function pickOpusMime(isTypeSupported) {
    if (typeof isTypeSupported !== 'function') return null;
    for (const m of OPUS_MIME_PREFERENCE) {
        try { if (isTypeSupported(m)) return m; } catch (_) {}
    }
    return null;
}

export function extForMime(mime) {
    const m = String(mime || '').toLowerCase();
    if (m.includes('webm')) return 'webm';
    if (m.includes('ogg'))  return 'ogg';
    if (m.includes('wav'))  return 'wav';
    return 'webm';
}

export function recordingExt(rec) {
    if (rec && rec.format === 'opus' && rec.mime) return extForMime(rec.mime);
    return 'wav';
}

export function storedFormat(rec) {
    return (rec && rec.format === 'opus') ? 'opus' : 'wav';
}

export function needsConversion(setting, rec) {
    const pref = setting === 'opus' ? 'opus' : 'wav';
    if (pref === 'wav') return false;
    return storedFormat(rec) !== pref;
}

export function resolveRecordingFormat(setting, opusMime) {
    if (setting === 'opus' && opusMime) return { format: 'opus', mime: opusMime };
    return { format: 'wav', mime: null };
}

export function conversionStillApplies(current, original) {
    return !!(current && Number(current.audioBytes) > 0 && original && Number(original.audioBytes) > 0)
        && Number(current.audioBytes) === Number(original.audioBytes)
        && storedFormat(current) !== 'opus';
}
