export const WAVEFORM_AUTO = 'auto';
export const WAVEFORM_HIDDEN_EVENT = 'myai-waveform-hidden';
export const WAVEFORM_CHOICES = Object.freeze(['0', '10', '15', '30', '60', WAVEFORM_AUTO]);
export const WAVEFORM_DEFAULT = '30';
export const WAVE_FRAME_SLACK_MS = 4;
export const WAVE_TIMER_MIN_MS = 20;
export const KNOWN_REFRESH_HZ = Object.freeze([
    24, 25, 30, 48, 50, 60, 72, 75, 85, 90, 100, 120, 144, 160, 165, 170, 175, 180, 200, 240, 280, 360, 480
]);

export function waveformFps(value) {
    const text = String(value ?? '').trim();
    const choice = WAVEFORM_CHOICES.includes(text) ? text : WAVEFORM_DEFAULT;
    return choice === WAVEFORM_AUTO ? Infinity : Number(choice);
}

export function nextWaveFrame(now, due, fps) {
    if (!(fps > 0)) return { draw: false, due: 0 };
    const interval = 1000 / fps;
    if (due && now < due - WAVE_FRAME_SLACK_MS) return { draw: false, due };
    return { draw: true, due: due && now - due < interval ? due + interval : now + interval };
}

export function waveWaitMs(now, due) {
    const wait = due - WAVE_FRAME_SLACK_MS - now;
    return wait >= WAVE_TIMER_MIN_MS ? Math.floor(wait) : 0;
}

export function refreshRateHz(timestamps) {
    const deltas = [];
    for (let i = 1; i < (timestamps || []).length; i++) {
        const delta = timestamps[i] - timestamps[i - 1];
        if (delta > 1 && delta < 100) deltas.push(delta);
    }
    if (deltas.length < 8) return null;
    const median = [...deltas].sort((a, b) => a - b)[Math.floor(deltas.length / 2)];
    const steady = deltas.filter(delta => Math.abs(delta - median) <= median * 0.25);
    if (steady.length < 6) return null;
    const hz = 1000 / (steady.reduce((sum, delta) => sum + delta, 0) / steady.length);
    return KNOWN_REFRESH_HZ.find(rate => Math.abs(rate - hz) <= rate * 0.02) || Math.round(hz);
}

export function describeAutoWaveform(hz) {
    return hz ? `Auto - every refresh of this screen (${hz} Hz)` : 'Auto - every refresh of this screen';
}
