// Band-limited resampling to the 16 kHz the transcription server takes.
//
// Chromium plays an AudioBuffer into an OfflineAudioContext of another rate by interpolating
// between samples, with no low-pass filter first. From a 48 kHz recording everything between 8 and
// 24 kHz (sibilants, breath, fan and keyboard noise) then folds back into 0-8 kHz, where speech is.
// Here the signal is low-passed just below the new Nyquist frequency with a Kaiser-windowed sinc,
// and each output sample is read through that filter at its own position in the input.

export const TARGET_RATE = 16000;

const ZERO_CROSSINGS = 16;
const CUTOFF_SHARE = 0.9;
const KAISER_BETA = 7;
const MAX_PHASES = 1024;

function gcd(a, b) {
    let x = Math.abs(a);
    let y = Math.abs(b);
    while (y) [x, y] = [y, x % y];
    return x;
}

// The modified Bessel function of the first kind, order zero, by its power series.
function besselI0(x) {
    let sum = 1;
    let term = 1;
    const quarterSquare = (x * x) / 4;
    for (let k = 1; k < 64; k++) {
        term *= quarterSquare / (k * k);
        sum += term;
        if (term < sum * 1e-12) break;
    }
    return sum;
}

const _resamplers = new Map();

// A resampler from one rate to another. Its kernel is `taps` input samples wide; `margin` is how
// many input samples on each side of a stretch it reads, so a caller that resamples a long signal
// in pieces hands each piece that much of its neighbours and the pieces join without a seam.
export function resamplerFor(fromRate, toRate = TARGET_RATE) {
    const from = Math.round(Number(fromRate));
    const to = Math.round(Number(toRate));
    if (!(from > 0) || !(to > 0)) throw new RangeError(`Cannot resample from ${fromRate} Hz to ${toRate} Hz.`);
    const key = `${from}>${to}`;
    if (_resamplers.has(key)) return _resamplers.get(key);

    const divisor = gcd(from, to);
    const step = from / divisor;
    const cycle = to / divisor;
    const exact = cycle <= MAX_PHASES;
    const phases = exact ? cycle : MAX_PHASES;
    // Cutoff in cycles per input sample, below the lower of the two Nyquist frequencies.
    const cutoff = CUTOFF_SHARE * 0.5 * Math.min(1, to / from);
    const halfWidth = ZERO_CROSSINGS / (2 * cutoff);
    const half = Math.ceil(halfWidth);
    const taps = 2 * half;
    const table = new Float32Array(phases * taps);
    const norm = besselI0(KAISER_BETA);
    for (let p = 0; p < phases; p++) {
        const frac = p / phases;
        let sum = 0;
        for (let j = 0; j < taps; j++) {
            const t = frac + half - 1 - j;
            const ratio = t / halfWidth;
            if (Math.abs(ratio) >= 1) continue;
            const x = 2 * cutoff * t;
            const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
            const value = 2 * cutoff * sinc * besselI0(KAISER_BETA * Math.sqrt(1 - ratio * ratio)) / norm;
            table[p * taps + j] = value;
            sum += value;
        }
        // Each phase passes a constant through unchanged, so the level does not ripple from one
        // output sample to the next.
        if (sum !== 0) for (let j = 0; j < taps; j++) table[p * taps + j] /= sum;
    }

    const resampler = {
        fromRate: from,
        toRate: to,
        taps,
        margin: half,
        outputIndexAt: frame => Math.round((frame * to) / from),
        // Output samples firstOutput .. firstOutput + count - 1 of the whole signal, read from
        // `input`, which holds its frames inputStart .. inputStart + input.length - 1. Frames outside
        // it count as silence.
        render(input, { inputStart = 0, firstOutput = 0, count } = {}) {
            const out = new Float32Array(Math.max(0, count | 0));
            const length = input.length;
            for (let n = 0; n < out.length; n++) {
                const index = firstOutput + n;
                let whole;
                let phase;
                if (exact) {
                    const position = index * step;
                    whole = Math.floor(position / cycle);
                    phase = position - whole * cycle;
                } else {
                    const position = (index * from) / to;
                    whole = Math.floor(position);
                    phase = Math.round((position - whole) * phases);
                    if (phase === phases) { whole += 1; phase = 0; }
                }
                const base = whole - half + 1 - inputStart;
                const row = phase * taps;
                let acc = 0;
                if (base >= 0 && base + taps <= length) {
                    for (let j = 0; j < taps; j++) acc += input[base + j] * table[row + j];
                } else {
                    const fromTap = Math.max(0, -base);
                    const toTap = Math.min(taps, length - base);
                    for (let j = fromTap; j < toTap; j++) acc += input[base + j] * table[row + j];
                }
                out[n] = acc;
            }
            return out;
        }
    };
    _resamplers.set(key, resampler);
    return resampler;
}

// A whole signal at another rate, as many samples as it lasts.
export function resampleBandLimited(input, fromRate, toRate = TARGET_RATE) {
    const samples = input || new Float32Array(0);
    if (Math.round(fromRate) === Math.round(toRate)) return Float32Array.from(samples);
    const resampler = resamplerFor(fromRate, toRate);
    const count = Math.max(1, resampler.outputIndexAt(samples.length));
    return resampler.render(samples, { count });
}

// Frames fromFrame .. toFrame - 1 of a longer signal at another rate. `input` holds its frames
// inputStart .. inputStart + input.length - 1, and should reach `margin` frames past both ends of the
// stretch where the signal goes on, so the result joins its neighbours without a seam.
export function resampleStretch(input, fromRate, { inputStart = 0, fromFrame, toFrame, count = null, toRate = TARGET_RATE }) {
    const resampler = resamplerFor(fromRate, toRate);
    const firstOutput = resampler.outputIndexAt(fromFrame);
    const wanted = count != null ? count : resampler.outputIndexAt(toFrame) - firstOutput;
    return resampler.render(input, { inputStart, firstOutput, count: wanted });
}

// The level at one frequency, by correlating with a sine and a cosine at it. Used to measure how
// much of a tone comes through a resampler.
export function toneLevel(samples, frequency, rate) {
    let sin = 0;
    let cos = 0;
    const omega = (2 * Math.PI * frequency) / rate;
    for (let i = 0; i < samples.length; i++) {
        sin += samples[i] * Math.sin(omega * i);
        cos += samples[i] * Math.cos(omega * i);
    }
    return (2 * Math.hypot(sin, cos)) / Math.max(1, samples.length);
}
