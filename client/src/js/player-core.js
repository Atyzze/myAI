export function isLivePlayerId(id) {
    return typeof id === 'string' && id.indexOf('live-audio-') === 0;
}

export function shouldRewindOnEnded(audioId, loopOn) {
    return !loopOn && !isLivePlayerId(audioId);
}

export function resolvePlayerTotalSec(durMs, audioDurationSec) {
    const ms = Number(durMs) || 0;
    if (ms > 0) return ms / 1000;
    const d = Number(audioDurationSec);
    return (Number.isFinite(d) && d > 0) ? d : 0;
}

export function planLivePreview({
    requested = false, playing = false, ended = false,
    hasNewChunk = false, nearEdge = false, loaded = false
} = {}) {
    const rebuild = requested ? (!loaded || hasNewChunk)
        : playing ? (hasNewChunk && nearEdge)
        : ended ? hasNewChunk
        : false;

    return { rebuild, resume: rebuild };
}

export function playerFraction(curSec, totalSec) {
    const total = Number(totalSec);
    const cur   = Number(curSec);
    if (!Number.isFinite(total) || total <= 0) return 0;
    if (!Number.isFinite(cur)   || cur   <= 0) return 0;
    return Math.min(1, cur / total);
}
