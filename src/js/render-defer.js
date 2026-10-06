export function planRender({ playingAudioCount = 0, force = false, deferralPending = false } = {}) {
    if (force) return { paint: true, defer: false, armRecheck: false };

    const playing = Number(playingAudioCount) > 0;
    if (!playing) return { paint: true, defer: false, armRecheck: false };

    return { paint: false, defer: true, armRecheck: !deferralPending };
}
