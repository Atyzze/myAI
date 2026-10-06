// Resamples for audio.js off the page's main thread, with the same code the page would run itself
// (resample-core.js), so converting a long recording cannot hold up a repaint or a click.
import { resamplerFor } from './resample-core.js';

self.onmessage = event => {
    const { id, input, fromRate, toRate, inputStart, firstOutput, count } = event.data || {};
    try {
        const output = resamplerFor(fromRate, toRate).render(input, { inputStart, firstOutput, count });
        self.postMessage({ id, output }, [output.buffer]);
    } catch (err) {
        self.postMessage({ id, error: String((err && err.message) || err) });
    }
};
