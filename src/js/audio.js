/* ==========================================================================
   audio.js - WAV encoding, header building, memory-bounded resampling, worklet
   ========================================================================== */

import { makeWebmDecodeChunk } from './webm-duration.js';

// ── Build just a 44-byte PCM/mono/16-bit WAV header for a given data length ──
// Used by the streaming finalize, which concatenates the (header-less) PCM of
// each stored chunk as Blob slices instead of decoding everything into RAM.
export function buildWavHeader(dataBytes, sampleRate) {
    const v = new DataView(new ArrayBuffer(44));
    v.setUint32(0,  0x46464952, true);          // "RIFF"
    v.setUint32(4,  36 + dataBytes, true);      // file length - 8
    v.setUint32(8,  0x45564157, true);          // "WAVE"
    v.setUint32(12, 0x20746d66, true);          // "fmt "
    v.setUint32(16, 16, true);                  // fmt chunk size
    v.setUint16(20, 1,  true);                  // PCM
    v.setUint16(22, 1,  true);                  // mono
    v.setUint32(24, sampleRate, true);
    v.setUint32(28, sampleRate * 2, true);      // byte rate
    v.setUint16(32, 2,  true);                  // block align
    v.setUint16(34, 16, true);                  // bits per sample
    v.setUint32(36, 0x61746164, true);          // "data"
    v.setUint32(40, dataBytes, true);
    return v.buffer;
}

// ── Encode a mono Float32Array into a WAV blob ──
export function encodeMonoWav(monoData, sampleRate) {
    const dataBytes = monoData.length * 2;
    const view      = new DataView(buildWavHeader(dataBytes, sampleRate));
    // Re-wrap into a full buffer that also holds the samples.
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

/* ── Stitch stored 4-second WAV chunks into one master WAV (pure, DOM/DB-free) ──
   Each stored chunk is itself a complete mono / 16-bit PCM WAV (its own 44-byte
   header). The master is a single FRESH header sized to the TOTAL PCM, followed
   by each chunk's PCM body (everything past its own 44-byte header), appended by
   reference as Blob slices - no decode, no per-sample copy, O(chunks) allocs.

   This is the exact concatenation the finalize step performs at STOP and the
   live-preview build performs MID-recording, so it lives here once, pure and
   unit-tested, with both callers delegating to it (see js/recorder.js).

   `chunkBlobs` MUST already be in playback (seq) order. An empty list yields a
   valid header-only, zero-sample WAV (44 bytes) rather than throwing, so callers
   can treat the result uniformly. Sub-44-byte chunks (a crash mid-write) add
   zero data bytes and an empty slice - byte-identical to dropping them. */
export function stitchWavChunks(chunkBlobs, sampleRate) {
    const blobs     = chunkBlobs || [];
    const dataBytes = blobs.reduce((sum, b) => sum + Math.max(0, b.size - 44), 0);
    const parts     = [buildWavHeader(dataBytes, sampleRate || 48000)];
    for (const b of blobs) parts.push(b.slice(44));
    return new Blob(parts, { type: 'audio/wav' });
}

/* ── Plan one PCM flush: split the buffered Float32 chunks at `samplesToProcess`
   (pure, so the subtle boundary logic behind the 4 s IO flush is unit-testable). ──

   Returns { flat, keptBuffer, keptLength, consumed }:
     • flat       - a Float32Array of exactly `samplesToProcess` samples, filled from
                    the FRONT of `chunks` in order (this becomes one WAV chunk);
     • keptBuffer - the leftover chunks AFTER that cut (a chunk straddling the cut is
                    split; whole chunks past the cut are carried by reference);
     • keptLength - total samples in keptBuffer (callers keep `pcmLength` in sync with
                    this so the invariant consumed + keptLength === sum(chunk.length)
                    always holds - a drift here would silently corrupt audio);
     • consumed   - how many samples were written into `flat` (=== samplesToProcess
                    whenever the buffer holds at least that many, which the caller
                    guarantees before flushing).

   The final flush passes samplesToProcess === total buffered, so keptBuffer is empty. */
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

/* ── Parse the first 44 bytes of a WAV (pure) into { isWav, bits, channels,
   sampleRate }. Accepts an ArrayBuffer or a DataView. Non-WAV / short input →
   isWav:false with zeroed fields, so callers can branch to a whole-file decode.
   Extracted from resampleTo16k so the header math is testable without Web Audio. */
export function parseWavHeader(headerBytes) {
    const hv = headerBytes instanceof DataView ? headerBytes : new DataView(headerBytes);
    const isWav = hv.byteLength >= 44
        && hv.getUint32(0, true) === 0x46464952    // "RIFF"
        && hv.getUint32(8, true) === 0x45564157;   // "WAVE"
    return {
        isWav,
        bits:       isWav ? hv.getUint16(34, true)        : 0,
        channels:   isWav ? (hv.getUint16(22, true) || 1) : 0,
        sampleRate: isWav ? (hv.getUint32(24, true) || 48000) : 0
    };
}

// ── AudioWorklet processor source ──
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

/* ──────────────────────────────────────────────────────────────────────────
   Resample any recording to mono 16 kHz Float32 - MEMORY-BOUNDED.

   The old version did `decodeAudioData(wholeFile)` + one OfflineAudioContext
   over the whole thing. For a 1-hour 48 kHz recording that decodes to a ~690 MB
   Float32 buffer all at once and OOM-kills mobile tabs. Since these files are
   always 16-bit PCM WAV that WE wrote, we parse the header ourselves and
   resample in 30 s source-segments, holding only one segment at a time.
   Anything that isn't our PCM/16-bit WAV falls back to the original whole-file
   decode (and the whole thing is wrapped so any failure also falls back).

   Tradeoff: each 30 s segment is resampled in its OWN OfflineAudioContext, so
   the resampling filter has edge effects at every 30 s boundary and the rounded
   per-segment output lengths can drop/duplicate a sample or two per seam (handled
   safely below - never a crash, at worst a couple of inaudible samples). This is
   a deliberate accuracy-for-memory trade: it's inaudible to Whisper/ASR, which is
   the only consumer here. It would NOT be acceptable for music-grade resampling.
   ────────────────────────────────────────────────────────────────────────── */
const TARGET_RATE = 16000;

async function decodeWholeFile(blob) {
    const tempCtx     = new (window.AudioContext || window.webkitAudioContext)();
    const arrayBuffer = await blob.arrayBuffer();
    const audioBuffer = await tempCtx.decodeAudioData(arrayBuffer);
    tempCtx.close();
    const len = Math.max(1, Math.round(audioBuffer.duration * TARGET_RATE));
    const offlineCtx = new OfflineAudioContext(1, len, TARGET_RATE);
    const source     = offlineCtx.createBufferSource();
    source.buffer    = audioBuffer;
    source.connect(offlineCtx.destination);
    source.start();
    const rendered = await offlineCtx.startRendering();
    return rendered.getChannelData(0);
}

async function resampleSegment(monoFloat, frames, sourceRate) {
    if (sourceRate === TARGET_RATE) return monoFloat.subarray(0, frames);
    const outLen   = Math.max(1, Math.round(frames * TARGET_RATE / sourceRate));
    const offline  = new OfflineAudioContext(1, outLen, TARGET_RATE);
    const buf      = offline.createBuffer(1, frames, sourceRate);
    buf.copyToChannel(monoFloat.subarray(0, frames), 0);
    const node     = offline.createBufferSource();
    node.buffer    = buf;
    node.connect(offline.destination);
    node.start();
    const rendered = await offline.startRendering();
    return rendered.getChannelData(0);
}

/** Inspect a browser Blob and return metadata for the PCM WAV format written by
 * this app. Returns null for compressed/unknown formats. */
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

/** Decode and resample only one time range from a PCM WAV. This is the bounded
 * path used by long-recording transcription, so the full 16 kHz recording never
 * needs to coexist with copies of every 60-second window. */
export async function resamplePcmWavRangeTo16k(blob, meta, startSec, endSec) {
    if (!meta || !meta.totalFrames) return new Float32Array(0);
    const startFrame = Math.max(0, Math.floor(startSec * meta.sampleRate));
    const endFrame = Math.min(meta.totalFrames, Math.ceil(endSec * meta.sampleRate));
    const frames = Math.max(0, endFrame - startFrame);
    if (!frames) return new Float32Array(0);

    const byteStart = 44 + startFrame * meta.bytesPerFrame;
    const segBuf = await blob.slice(
        byteStart,
        byteStart + frames * meta.bytesPerFrame
    ).arrayBuffer();
    const i16 = new Int16Array(segBuf);
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
    const out = await resampleSegment(mono, frames, meta.sampleRate);
    // Range boundaries are derived in source-rate space; normalize to the exact
    // target length expected from the requested interval where possible.
    const expected = Math.max(1, Math.round(frames * TARGET_RATE / meta.sampleRate));
    return out.length === expected ? out : out.slice(0, expected);
}

/** Decode and resample one bounded WebM/Opus time range. The container helper
 * supplies only the Clusters surrounding this window, so a multi-hour recording
 * never becomes one giant decoded AudioBuffer. */
export async function resampleWebmRangeTo16k(source, startSec, endSec) {
    const range = await makeWebmDecodeChunk(source, startSec, endSec);
    const decoded = await decodeWholeFile(range.blob);
    const trimStart = Math.max(0, Math.round(range.trimStartSec * TARGET_RATE));
    const wanted = Math.max(1, Math.round(range.requestedDurationSec * TARGET_RATE));
    const available = Math.max(0, decoded.length - trimStart);
    if (available >= wanted) return decoded.slice(trimStart, trimStart + wanted);

    // Decoder/container padding can make the final range a few samples short.
    // Zero-pad only that tiny tail so chunk timing remains deterministic.
    const out = new Float32Array(wanted);
    if (available > 0) out.set(decoded.subarray(trimStart, trimStart + available));
    return out;
}

export async function resampleTo16k(blob) {
    try {
        const { isWav, bits, channels, sampleRate: srcRate } =
            parseWavHeader(await blob.slice(0, 44).arrayBuffer());

        // Only handle the format we control; everything else → whole-file decode.
        if (!isWav || bits !== 16 || channels < 1) return await decodeWholeFile(blob);

        const bytesPerFrame = 2 * channels;
        const totalFrames   = Math.floor((blob.size - 44) / bytesPerFrame);
        if (totalFrames === 0) return new Float32Array(0);

        const outLen = Math.max(1, Math.round(totalFrames * TARGET_RATE / srcRate));
        const out    = new Float32Array(outLen);

        const SEG_FRAMES = srcRate * 30;     // 30 s of source per pass
        let srcFrame = 0, outPos = 0;

        while (srcFrame < totalFrames) {
            const frames    = Math.min(SEG_FRAMES, totalFrames - srcFrame);
            const byteStart = 44 + srcFrame * bytesPerFrame;
            const segBuf    = await blob.slice(byteStart, byteStart + frames * bytesPerFrame).arrayBuffer();
            const i16       = new Int16Array(segBuf);

            // Down-mix to mono Float32 (recordings are mono, but stay general).
            const mono = new Float32Array(frames);
            if (channels === 1) {
                for (let i = 0; i < frames; i++) mono[i] = i16[i] / 32768;
            } else {
                for (let i = 0; i < frames; i++) {
                    let s = 0;
                    for (let c = 0; c < channels; c++) s += i16[i * channels + c];
                    mono[i] = s / (channels * 32768);
                }
            }

            const segOut   = await resampleSegment(mono, frames, srcRate);
            const writeLen = Math.min(segOut.length, out.length - outPos);
            out.set(segOut.subarray(0, writeLen), outPos);
            outPos   += writeLen;
            srcFrame += frames;
        }

        return outPos === out.length ? out : out.slice(0, outPos);
    } catch (err) {
        // Any parsing/Web-Audio quirk → fall back to the known-good whole-file path.
        console.warn('Segmented resample failed, falling back to whole-file decode:', err);
        return decodeWholeFile(blob);
    }
}
