import { makeWebmDecodeChunk } from './webm-duration.js';
import { resamplerFor } from './resample-core.js';

export const WAV_MAX_DATA_BYTES = 0xFFFFFFFF - 44;

export function wavDataBytesFor(chunkBlobs) {
    return (chunkBlobs || []).reduce((sum, b) => sum + Math.max(0, b.size - 44), 0);
}

export function buildWavHeader(dataBytes, sampleRate) {
    if (!Number.isFinite(dataBytes) || dataBytes < 0 || dataBytes > WAV_MAX_DATA_BYTES) {
        const err = new Error(
            `A WAV file cannot describe ${dataBytes} bytes of audio: the RIFF size fields are ` +
            `32-bit, so the limit is ${WAV_MAX_DATA_BYTES} bytes (about 12 h 25 min at 48 kHz ` +
            `mono 16-bit). The recording was left in recoverable fragments.`);
        err.name = 'WavSizeLimitError';
        throw err;
    }
    const v = new DataView(new ArrayBuffer(44));
    v.setUint32(0,  0x46464952, true);
    v.setUint32(4,  36 + dataBytes, true);
    v.setUint32(8,  0x45564157, true);
    v.setUint32(12, 0x20746d66, true);
    v.setUint32(16, 16, true);
    v.setUint16(20, 1,  true);
    v.setUint16(22, 1,  true);
    v.setUint32(24, sampleRate, true);
    v.setUint32(28, sampleRate * 2, true);
    v.setUint16(32, 2,  true);
    v.setUint16(34, 16, true);
    v.setUint32(36, 0x61746164, true);
    v.setUint32(40, dataBytes, true);
    return v.buffer;
}

export function encodeMonoWav(monoData, sampleRate) {
    const dataBytes = monoData.length * 2;
    const view      = new DataView(buildWavHeader(dataBytes, sampleRate));
    const out  = new DataView(new ArrayBuffer(44 + dataBytes));
    new Uint8Array(out.buffer).set(new Uint8Array(view.buffer, 0, 44));

    let pos = 44;
    for (let i = 0; i < monoData.length; i++) {
        const sample = Math.max(-1, Math.min(1, monoData[i]));
        out.setInt16(pos, sample < 0 ? sample * 32768 : sample * 32767, true);
        pos += 2;
    }
    return new Blob([out.buffer], { type: 'audio/wav' });
}

export function stitchWavChunks(chunkBlobs, sampleRate) {
    const blobs     = chunkBlobs || [];
    const dataBytes = blobs.reduce((sum, b) => sum + Math.max(0, b.size - 44), 0);
    const parts     = [buildWavHeader(dataBytes, sampleRate || 48000)];
    for (const b of blobs) parts.push(b.slice(44));
    return new Blob(parts, { type: 'audio/wav' });
}

export function planPcmFlush(chunks, samplesToProcess) {
    const flat = new Float32Array(samplesToProcess);
    const keptBuffer = [];
    let offset = 0, keptLength = 0;
    for (const chunk of (chunks || [])) {
        if (offset < samplesToProcess) {
            const take = Math.min(chunk.length, samplesToProcess - offset);
            flat.set(chunk.subarray(0, take), offset);
            offset += take;
            if (take < chunk.length) {
                const remainder = chunk.subarray(take);
                keptBuffer.push(remainder);
                keptLength += remainder.length;
            }
        } else {
            keptBuffer.push(chunk);
            keptLength += chunk.length;
        }
    }
    return { flat, keptBuffer, keptLength, consumed: offset };
}

export function parseWavHeader(headerBytes) {
    const hv = headerBytes instanceof DataView ? headerBytes : new DataView(headerBytes);
    const isWav = hv.byteLength >= 44
        && hv.getUint32(0, true) === 0x46464952
        && hv.getUint32(8, true) === 0x45564157;
    return {
        isWav,
        bits:       isWav ? hv.getUint16(34, true)        : 0,
        channels:   isWav ? (hv.getUint16(22, true) || 1) : 0,
        sampleRate: isWav ? (hv.getUint32(24, true) || 48000) : 0
    };
}

export function getWorkletCode() {
    return `
      class RecorderWorklet extends AudioWorkletProcessor {
        constructor() {
          super();
          this.blockSize = 4096;
          this.pending = new Float32Array(this.blockSize);
          this.used = 0;
          this.port.onmessage = (event) => {
            if (event.data && event.data.type === 'flush') {
              this.emit(true);
              this.port.postMessage({ type: 'flush-complete' });
            }
          };
        }
        emit(partial = false) {
          if (this.used === 0) return;
          if (!partial && this.used < this.blockSize) return;
          const out = this.used === this.blockSize
            ? this.pending
            : this.pending.slice(0, this.used);
          this.port.postMessage({ type: 'audio', data: out }, [out.buffer]);
          this.pending = new Float32Array(this.blockSize);
          this.used = 0;
        }
        process(inputs) {
          const input = inputs[0] && inputs[0][0];
          if (!input) return true;
          let pos = 0;
          while (pos < input.length) {
            const take = Math.min(input.length - pos, this.blockSize - this.used);
            this.pending.set(input.subarray(pos, pos + take), this.used);
            this.used += take;
            pos += take;
            this.emit(false);
          }
          return true;
        }
      }
      registerProcessor('recorder-worklet', RecorderWorklet);
    `;
}

const TARGET_RATE = 16000;

// Mono by averaging the channels, as the Web Audio API mixes stereo down.
function downmixToMono(audioBuffer) {
    if (audioBuffer.numberOfChannels === 1) return audioBuffer.getChannelData(0);
    const out = new Float32Array(audioBuffer.length);
    for (let c = 0; c < audioBuffer.numberOfChannels; c++) {
        const data = audioBuffer.getChannelData(c);
        for (let i = 0; i < out.length; i++) out[i] += data[i];
    }
    const scale = 1 / audioBuffer.numberOfChannels;
    for (let i = 0; i < out.length; i++) out[i] *= scale;
    return out;
}

let _offlineDecodeSupported = typeof OfflineAudioContext === 'function';

async function decodeArrayBuffer(arrayBuffer) {
    if (_offlineDecodeSupported) {
        try {
            return await new OfflineAudioContext(1, 1, TARGET_RATE).decodeAudioData(arrayBuffer);
        } catch (err) {
            if (err && err.name === 'EncodingError') throw err;
            if (arrayBuffer.byteLength === 0) throw err;
            _offlineDecodeSupported = false;
        }
    }
    const tempCtx = new (window.AudioContext || window.webkitAudioContext)();
    try {
        return await tempCtx.decodeAudioData(arrayBuffer);
    } finally {
        try { tempCtx.close(); } catch (_) {}
    }
}

// Resampling runs in a worker, so converting a long recording does not freeze the page: on the
// main thread a 60-second chunk at 48 kHz blocks it for a quarter of a second on a desktop, and
// several times as long on a phone. Where no worker can start, it runs here, a second of audio at a
// time, handing the main thread back in between.
let _resampleWorker = null;
let _resampleWorkerFailed = false;
let _resampleSeq = 0;
const _resampleWaiting = new Map();

function startResampleWorker() {
    if (typeof Worker !== 'function') return null;
    try {
        const worker = new Worker(new URL('./resample-worker.js', import.meta.url), { type: 'module' });
        worker.onmessage = event => {
            const { id, output, error } = event.data || {};
            const waiting = _resampleWaiting.get(id);
            if (!waiting) return;
            _resampleWaiting.delete(id);
            if (error) waiting.reject(new Error(error));
            else waiting.resolve(output);
        };
        // A worker that cannot start (its script unreachable, say) leaves the work to this page.
        worker.onerror = event => {
            if (event && typeof event.preventDefault === 'function') event.preventDefault();
            _resampleWorkerFailed = true;
            _resampleWorker = null;
            try { worker.terminate(); } catch (_) {}
            const stranded = [..._resampleWaiting.values()];
            _resampleWaiting.clear();
            for (const waiting of stranded) waiting.fallback();
        };
        _resampleWorker = worker;
        return worker;
    } catch (_) {
        _resampleWorkerFailed = true;
        return null;
    }
}

// The worker starts with the page and is never started again later: its script then comes through
// the service worker that served this page. One started later could come from a newer build that
// has taken over since, into a tab still running this one.
if (typeof document !== 'undefined') startResampleWorker();

function resampleWorker() {
    return _resampleWorkerFailed ? null : _resampleWorker;
}

async function renderResampledHere(input, fromRate, { inputStart = 0, firstOutput = 0, count }) {
    const resampler = resamplerFor(fromRate, TARGET_RATE);
    const out = new Float32Array(count);
    for (let done = 0; done < count; done += TARGET_RATE) {
        const n = Math.min(TARGET_RATE, count - done);
        out.set(resampler.render(input, { inputStart, firstOutput: firstOutput + done, count: n }), done);
        if (done + n < count) await new Promise(resolve => setTimeout(resolve, 0));
    }
    return out;
}

// Output samples firstOutput .. firstOutput + count - 1 of a signal at 16 kHz, from `input`, which
// holds its frames inputStart .. inputStart + input.length - 1 at fromRate.
export function renderResampled(input, fromRate, options) {
    const worker = resampleWorker();
    const here = () => renderResampledHere(input, fromRate, options);
    if (!worker) return here();
    return new Promise((resolve, reject) => {
        const id = ++_resampleSeq;
        _resampleWaiting.set(id, { resolve, reject, fallback: () => here().then(resolve, reject) });
        // The worker gets a copy of just these samples: the caller's array may be a view of a
        // larger buffer that it goes on using.
        const copy = input.slice();
        try {
            worker.postMessage({ id, input: copy, fromRate, toRate: TARGET_RATE, ...options }, [copy.buffer]);
        } catch (_) {
            _resampleWaiting.delete(id);
            here().then(resolve, reject);
        }
    });
}

// Whether the resampling worker is running, or failed to start and left the work to this page.
export function resampleWorkerState() {
    return { running: !!_resampleWorker, failed: _resampleWorkerFailed };
}

function resampleAll(input, fromRate) {
    const count = Math.max(1, resamplerFor(fromRate, TARGET_RATE).outputIndexAt(input.length));
    return renderResampled(input, fromRate, { count });
}

// decodeAudioData on a 16 kHz context resamples as it decodes, through the browser's own
// band-limited resampler. Only where it decodes at another rate (the fallback context) is the
// result resampled here.
async function decodeWholeFile(blob) {
    const arrayBuffer = await blob.arrayBuffer();
    const audioBuffer = await decodeArrayBuffer(arrayBuffer);
    const mono = downmixToMono(audioBuffer);
    return audioBuffer.sampleRate === TARGET_RATE ? mono : resampleAll(mono, audioBuffer.sampleRate);
}

// PCM is resampled in code, not by playing it into an OfflineAudioContext: Chromium interpolates
// there without a low-pass filter, so a 12 kHz tone in 48 kHz audio came out as a 4 kHz tone at
// full level, and everything between 8 and 24 kHz folded into the speech band.
export async function resamplePcmTo16k(monoFloat, frames, sourceRate) {
    return resampleSegment(monoFloat, frames, sourceRate);
}

async function resampleSegment(monoFloat, frames, sourceRate) {
    if (sourceRate === TARGET_RATE) return monoFloat.subarray(0, frames);
    return resampleAll(monoFloat.subarray(0, frames), sourceRate);
}

// Frames [fromFrame, toFrame) of a 16-bit PCM WAV as mono floats, with `margin` frames more on each
// side where the file has them. Returns the samples and the frame the first of them is.
async function readPcmFrames(blob, meta, fromFrame, toFrame, margin = 0) {
    const readFrom = Math.max(0, fromFrame - margin);
    const readTo = Math.min(meta.totalFrames, toFrame + margin);
    const frames = Math.max(0, readTo - readFrom);
    const byteStart = 44 + readFrom * meta.bytesPerFrame;
    const i16 = new Int16Array(await blob.slice(byteStart, byteStart + frames * meta.bytesPerFrame).arrayBuffer());
    const mono = new Float32Array(frames);
    if (meta.channels === 1) {
        for (let i = 0; i < frames; i++) mono[i] = i16[i] / 32768;
    } else {
        for (let i = 0; i < frames; i++) {
            let sum = 0;
            for (let c = 0; c < meta.channels; c++) sum += i16[i * meta.channels + c];
            mono[i] = sum / (meta.channels * 32768);
        }
    }
    return { mono, readFrom };
}

export async function inspectPcmWav(blob) {
    const header = parseWavHeader(await blob.slice(0, 44).arrayBuffer());
    if (!header.isWav || header.bits !== 16 || header.channels < 1) return null;
    const bytesPerFrame = 2 * header.channels;
    const totalFrames = Math.max(0, Math.floor((blob.size - 44) / bytesPerFrame));
    return {
        ...header,
        bytesPerFrame,
        totalFrames,
        durationSec: totalFrames / header.sampleRate
    };
}

export async function resamplePcmWavRangeTo16k(blob, meta, startSec, endSec) {
    if (!meta || !meta.totalFrames) return new Float32Array(0);
    const startFrame = Math.max(0, Math.floor(startSec * meta.sampleRate));
    const endFrame = Math.min(meta.totalFrames, Math.ceil(endSec * meta.sampleRate));
    const frames = Math.max(0, endFrame - startFrame);
    if (!frames) return new Float32Array(0);
    const expected = Math.max(1, Math.round(frames * TARGET_RATE / meta.sampleRate));
    if (meta.sampleRate === TARGET_RATE) return (await readPcmFrames(blob, meta, startFrame, endFrame)).mono;
    // The frames around the range are read too, so its edges are filtered like the rest of it.
    const resampler = resamplerFor(meta.sampleRate, TARGET_RATE);
    const { mono, readFrom } = await readPcmFrames(blob, meta, startFrame, endFrame, resampler.margin);
    return renderResampled(mono, meta.sampleRate, { inputStart: readFrom, firstOutput: resampler.outputIndexAt(startFrame),
                                                     count: expected });
}

export async function resampleWebmRangeTo16k(source, startSec, endSec) {
    const range = await makeWebmDecodeChunk(source, startSec, endSec);
    const decoded = await decodeWholeFile(range.blob);
    const trimStart = Math.max(0, Math.round(range.trimStartSec * TARGET_RATE));
    const wanted = Math.max(1, Math.round(range.requestedDurationSec * TARGET_RATE));
    const available = Math.max(0, decoded.length - trimStart);
    if (available >= wanted) return decoded.slice(trimStart, trimStart + wanted);

    const out = new Float32Array(wanted);
    if (available > 0) out.set(decoded.subarray(trimStart, trimStart + available));
    return out;
}

export async function resampleTo16k(blob) {
    try {
        const { isWav, bits, channels, sampleRate: srcRate } =
            parseWavHeader(await blob.slice(0, 44).arrayBuffer());

        if (!isWav || bits !== 16 || channels < 1) return await decodeWholeFile(blob);

        const bytesPerFrame = 2 * channels;
        const totalFrames   = Math.floor((blob.size - 44) / bytesPerFrame);
        if (totalFrames === 0) return new Float32Array(0);

        const outLen = Math.max(1, Math.round(totalFrames * TARGET_RATE / srcRate));
        const out    = new Float32Array(outLen);
        const meta   = { channels, bytesPerFrame, totalFrames };
        const margin = srcRate === TARGET_RATE ? 0 : resamplerFor(srcRate, TARGET_RATE).margin;

        // Thirty seconds at a time, each read with the frames around it, so the pieces join
        // without a seam where they meet.
        const SEG_FRAMES = srcRate * 30;
        let srcFrame = 0, outPos = 0;

        while (srcFrame < totalFrames && outPos < out.length) {
            const frames = Math.min(SEG_FRAMES, totalFrames - srcFrame);
            const { mono, readFrom } = await readPcmFrames(blob, meta, srcFrame, srcFrame + frames, margin);
            let segOut = mono;
            if (srcRate !== TARGET_RATE) {
                const resampler = resamplerFor(srcRate, TARGET_RATE);
                const firstOutput = resampler.outputIndexAt(srcFrame);
                segOut = await renderResampled(mono, srcRate, {
                    inputStart: readFrom, firstOutput, count: resampler.outputIndexAt(srcFrame + frames) - firstOutput
                });
            }
            const writeLen = Math.min(segOut.length, out.length - outPos);
            out.set(segOut.subarray(0, writeLen), outPos);
            outPos   += writeLen;
            srcFrame += frames;
        }

        return outPos === out.length ? out : out.slice(0, outPos);
    } catch (err) {
        console.warn('Segmented resample failed, falling back to whole-file decode:', err);
        return decodeWholeFile(blob);
    }
}
