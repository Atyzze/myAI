/* ==========================================================================
   audio-format.js - Pure, DOM-free helpers for choosing the recording codec and
                     mapping it to a container/extension.

   The app records WAV by default (uncompressed, seekable everywhere, and what the
   whole capture/recovery/live-preview path is built around). Opus is an opt-in,
   roughly-10x-smaller alternative captured natively by MediaRecorder on Chrome/
   Firefox. When Opus is requested but unsupported, we fall back to WAV. All the
   DECISION logic lives here so it can be unit-tested without a browser; the
   actual MediaRecorder wiring lives in recorder.js.
   ========================================================================== */

// Preference order: WebM/Opus (Chrome), then Ogg/Opus (Firefox), then bare
// containers as a last resort. MediaRecorder.isTypeSupported is passed in so
// this stays pure and testable.
export const OPUS_MIME_PREFERENCE = [
    'audio/webm;codecs=opus',
    'audio/ogg;codecs=opus',
    'audio/webm',
    'audio/ogg'
];

/** First Opus mime the given isTypeSupported() accepts, or null if none. */
export function pickOpusMime(isTypeSupported) {
    if (typeof isTypeSupported !== 'function') return null;
    for (const m of OPUS_MIME_PREFERENCE) {
        try { if (isTypeSupported(m)) return m; } catch (_) {}
    }
    return null;
}

/** Container file extension for a mime string. */
export function extForMime(mime) {
    const m = String(mime || '').toLowerCase();
    if (m.includes('webm')) return 'webm';
    if (m.includes('ogg'))  return 'ogg';
    if (m.includes('wav'))  return 'wav';
    return 'webm';
}

/** Download extension for a stored recording (opus keeps its container; else wav). */
export function recordingExt(rec) {
    if (rec && rec.format === 'opus' && rec.mime) return extForMime(rec.mime);
    return 'wav';
}

/** The format a recording is actually stored in ('opus' or 'wav'). */
export function storedFormat(rec) {
    return (rec && rec.format === 'opus') ? 'opus' : 'wav';
}

/**
 * Whether a recording can be converted to the user's preferred format. Only when
 * the preference is non-default (opus) AND the recording isn't already in it.
 * Used to decide if the per-recording format badge is a convert button.
 */
export function needsConversion(setting, rec) {
    const pref = setting === 'opus' ? 'opus' : 'wav';
    if (pref === 'wav') return false;
    return storedFormat(rec) !== pref;
}

/**
 * Resolve the format actually used for a new recording from the user's setting
 * and the Opus mime the browser supports (pickOpusMime's result, or null).
 * Opus only wins when the user asked for it AND the browser can encode it;
 * otherwise WAV, which is the safe, universally-seekable fallback.
 */
export function resolveRecordingFormat(setting, opusMime) {
    if (setting === 'opus' && opusMime) return { format: 'opus', mime: opusMime };
    return { format: 'wav', mime: null };
}
