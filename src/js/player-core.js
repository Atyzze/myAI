/* ==========================================================================
   player-core.js - Pure, DOM-free decision logic for the custom audio player.

   The player's wiring (event listeners, DOM updates) lives in gui.js, but the
   DECISIONS it makes are extracted here so they can be unit-tested without a
   browser: whether reaching the end should rewind, how the seek-bar total is
   resolved (Opus reports Infinity), and the clamped fill fraction.
   ========================================================================== */

/** True when an <audio> id belongs to the live/still-recording preview player. */
export function isLivePlayerId(id) {
    return typeof id === 'string' && id.indexOf('live-audio-') === 0;
}

/**
 * Whether playback reaching the end should rewind the playhead to 0 (bar back to
 * the start, staying paused). We rewind only when repeat is OFF and it's a
 * finalized recording - never the live preview, whose extension logic owns the
 * end. When repeat is ON the browser loops and 'ended' never fires, but we still
 * return false as a guard so the two can never conflict.
 */
export function shouldRewindOnEnded(audioId, loopOn) {
    return !loopOn && !isLivePlayerId(audioId);
}

/**
 * Resolve the player's total length in seconds. Prefer the duration we already
 * know (rec.durationMs, passed as ms; also the live elapsed total) because
 * Opus/WebM reports audio.duration as Infinity. Fall back to audio.duration only
 * when it's a finite, positive number.
 */
export function resolvePlayerTotalSec(durMs, audioDurationSec) {
    const ms = Number(durMs) || 0;
    if (ms > 0) return ms / 1000;
    const d = Number(audioDurationSec);
    return (Number.isFinite(d) && d > 0) ? d : 0;
}

/** Clamped fill fraction (0..1) for the seek bar; safe on 0/negative/Infinity/NaN. */
export function playerFraction(curSec, totalSec) {
    const total = Number(totalSec);
    const cur   = Number(curSec);
    if (!Number.isFinite(total) || total <= 0) return 0;
    if (!Number.isFinite(cur)   || cur   <= 0) return 0;
    return Math.min(1, cur / total);
}
