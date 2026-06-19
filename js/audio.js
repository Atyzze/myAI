/* ==========================================================================
   audio.js — WAV encoding, header building, memory-bounded resampling, worklet
   ========================================================================== */

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
   reference as Blob slices — no decode, no per-sample copy, O(chunks) allocs.

   This is the exact concatenation the finalize step performs at STOP and the
   live-preview build performs MID-recording, so it lives here once, pure and
   unit-tested, with both callers delegating to it (see js/recorder.js).

   `chunkBlobs` MUST already be in playback (seq) order. An empty list yields a
   valid header-only, zero-sample WAV (44 bytes) rather than throwing, so callers
   can treat the result uniformly. Sub-44-byte chunks (a crash mid-write) add
   zero data bytes and an empty slice — byte-identical to dropping them. */
export function stitchWavChunks(chunkBlobs, sampleRate) {
    const blobs     = chunkBlobs || [];
    const dataBytes = blobs.reduce((sum, b) => sum + Math.max(0, b.size - 44), 0);
    const parts     = [buildWavHeader(dataBytes, sampleRate || 48000)];
    for (const b of blobs) parts.push(b.slice(44));
    return new Blob(parts, { type: 'audio/wav' });
}

// ── AudioWorklet processor source ──
export function getWorkletCode() {
    return `
      class RecorderWorklet extends AudioWorkletProcessor {
        process(inputs) {
          if (inputs[0] && inputs[0][0])
            this.port.postMessage(new Float32Array(inputs[0][0]));
          return true;
        }
      }
      registerProcessor('recorder-worklet', RecorderWorklet);
    `;
}

/* ──────────────────────────────────────────────────────────────────────────
   Resample any recording to mono 16 kHz Float32 — MEMORY-BOUNDED.

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
   safely below — never a crash, at worst a couple of inaudible samples). This is
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

export async function resampleTo16k(blob) {
    try {
        const hv = new DataView(await blob.slice(0, 44).arrayBuffer());
        const isWav = hv.byteLength >= 44
            && hv.getUint32(0, true) === 0x46464952
            && hv.getUint32(8, true) === 0x45564157;
        const bits     = isWav ? hv.getUint16(34, true) : 0;
        const channels = isWav ? (hv.getUint16(22, true) || 1) : 0;
        const srcRate  = isWav ? (hv.getUint32(24, true) || 48000) : 0;

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
