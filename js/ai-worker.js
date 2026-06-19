/* ==========================================================================
   ai-worker.js — Web Worker bridge for on-device Whisper & summarizer.

   The worker now (a) memoizes each pipeline load so concurrent jobs share ONE
   instance instead of each triggering its own download, and (b) serializes all
   inference through a single mutex chain. transformers.js pipelines are not safe
   to call concurrently (shared ONNX session/tensors); the previous version let
   up to 4 transcribe jobs hit one Whisper instance at once, which double-loaded
   the model and raced its internals.

   NOTE (supply chain): transformers.js (pinned to 2.16.0) is the ONLY external
   code the app loads, and only when on-device transcription/reply is selected.
   It's loaded from jsDelivr because it pulls in WASM + many sub-resources and
   the model weights themselves come from the Hugging Face CDN at runtime —
   impractical to vendor without a bundler. The former idb and NoSleep
   dependencies have been removed entirely: idb → js/idb-min.js (a small
   hand-written IndexedDB promise wrapper) and NoSleep → js/wake-lock.js (the
   native Screen Wake Lock API). For a fully air-gapped deployment, drop the
   on-device option (cloud Whisper + remote Ollama need no third-party code) or
   self-host the transformers.js bundle + model behind an import map.
   ========================================================================== */

const WORKER_SOURCE = `
    import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.16.0';
    env.allowLocalModels = false;

    // task -> Promise<pipeline>, so concurrent jobs await the SAME load.
    const instances = {};
    function getPipeline(task, model, progress) {
        if (!instances[task]) {
            instances[task] = pipeline(task, model, { progress_callback: progress });
        }
        return instances[task];
    }

    // Single global inference mutex — one model call runs at a time. Errors are
    // swallowed on the chain itself so one failure doesn't poison later jobs.
    let chain = Promise.resolve();
    function exclusive(fn) {
        const run = chain.then(fn, fn);
        chain = run.then(() => {}, () => {});
        return run;
    }

    self.onmessage = async (e) => {
        const { action, id, data, task, language } = e.data;
        const progress = d => self.postMessage({ status: 'progress', id, action, data: d });
        try {
            if (action === 'transcribe') {
                const instance = await getPipeline(
                    'automatic-speech-recognition', 'Xenova/whisper-tiny', progress);
                self.postMessage({ status: 'update', id, action, text: 'Scribing locally...' });
                // task: 'transcribe' keeps the source language (do NOT force-translate
                // to English). language: null lets Whisper auto-detect.
                const opts = { chunk_length_s: 30, stride_length_s: 5, task: task || 'transcribe' };
                if (language) opts.language = language;
                const result = await exclusive(() => instance(data, opts));
                self.postMessage({ status: 'complete', id, action, result: result.text.trim() });
            } else if (action === 'summarize') {
                const instance = await getPipeline(
                    'summarization', 'Xenova/distilbart-cnn-6-6', progress);
                self.postMessage({ status: 'update', id, action, text: 'Thinking...' });
                const result = await exclusive(() => instance(data, { max_new_tokens: 150 }));
                self.postMessage({ status: 'complete', id, action, result: result[0].summary_text });
            }
        } catch (err) {
            self.postMessage({ status: 'error', id, action, error: err.message });
        }
    };
`;

const workerBlob = new Blob([WORKER_SOURCE], { type: 'application/javascript' });
export const aiWorker = new Worker(
    URL.createObjectURL(workerBlob), { type: 'module' }
);

// Job registry: jobKey → { resolve, reject, progress }
export const aiJobs = {};

aiWorker.onmessage = (e) => {
    const { status, id, action, result, error, data, text } = e.data;
    const jobId = `${action}-${id}`;
    const job   = aiJobs[jobId];
    if (!job) return;

    if (status === 'progress') {
        if (data.status === 'downloading' && data.total) {
            const pct = Math.round((data.loaded / data.total) * 100);
            job.progress(action === 'transcribe'
                ? `Loading Scribe: ${pct}%`
                : `Loading Brain: ${pct}%`);
        } else if (data.status === 'ready') {
            job.progress('AI Engine ready.');
        }
    } else if (status === 'update') {
        job.progress(text);
    } else if (status === 'complete') {
        job.resolve(result);
        delete aiJobs[jobId];
    } else if (status === 'error') {
        job.reject(new Error(error));
        delete aiJobs[jobId];
    }
};
