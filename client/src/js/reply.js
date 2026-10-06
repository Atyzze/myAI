import { CONFIG, SETTINGS_DEFAULTS, getSetting, uid, confirmServerProcessing,
         writeStored } from './config.js';
import { dbExec, dbUpdate } from './db.js';
import { estimateNumCtx, buildBudgetedPrompt, createReplyStreamReader,
         chooseReplyModel, isFallbackChoice, describeLoadedModel } from './reply-core.js';
import { loadedModelNames, isModelResident, nextModelStep, describeModelLoad,
         describeModelFailure, shouldRetryGenerate, describeFirstByteTimeout,
         sameModel, MODEL_KEEP_ALIVE, MODEL_GENERATE_ATTEMPTS,
         AI_NUM_CTX, AI_MAX_NUM_CTX, firstByteTimeoutMs } from './model-ready-core.js';
import { generationTiming, translationTimeoutMs, translationTimeoutError } from './translate-core.js';
import { beginJob, endJob, abortError } from './jobs.js';
import { replyStreamInit, replyStreamModel, replyStreamAppend, replyStreamDone,
         replyStreamStats } from './live-tabs.js';

const NUM_PREDICT    = 4096;
const OUTPUT_RESERVE = 4096;

const TRANSLATE_LOAD_BUDGET_MS = 60000;
const TRANSLATE_LOAD_GRACE_MS = 20000;

const MODEL_LOOKUP_TIMEOUT_MS = 5000;

const TAGS_TTL_MS = 60000;
let _tags = { at: 0, models: null };

async function installedModels(base) {
    if (_tags.models && (Date.now() - _tags.at) < TAGS_TTL_MS) return _tags.models;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), MODEL_LOOKUP_TIMEOUT_MS);
    try {
        const res = await fetch(`${base}/api/tags`, { method: 'GET', signal: ctrl.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const installed = (data.models || []).map(item => item && item.name).filter(Boolean);
        _tags = { at: Date.now(), models: installed };
        return installed;
    } finally {
        clearTimeout(timer);
    }
}

let _replyChoice = { stored: null, model: null };

async function resolveReplyModel(base) {
    const stored = getSetting('set-ollama-model');
    if (_replyChoice.model && _replyChoice.stored === stored) return _replyChoice.model;

    try {
        const installed = await installedModels(base);
        const chosen = chooseReplyModel(installed, stored, SETTINGS_DEFAULTS['set-ollama-model']);
        const replacingDefault = stored === SETTINGS_DEFAULTS['set-ollama-model'];
        if (chosen && chosen !== stored && (replacingDefault || !isFallbackChoice(chosen, stored, installed))) {
            writeStored('set-ollama-model', chosen);
        }
        _replyChoice = { stored, model: chosen || stored };
        return _replyChoice.model;
    } catch (_) {
        return stored;
    }
}


export async function loadedModels() {
    const base = CONFIG.OLLAMA_URL.replace(/\/+$/, '');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), MODEL_LOOKUP_TIMEOUT_MS);
    try {
        const res = await fetch(`${base}/api/ps`, { method: 'GET', signal: ctrl.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        return (data.models || []).map(describeLoadedModel).filter(Boolean);
    } finally {
        clearTimeout(timer);
    }
}

async function readLoadedNames(base, signal) {
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    if (signal) {
        if (signal.aborted) ctrl.abort();
        else signal.addEventListener('abort', onAbort, { once: true });
    }
    const timer = setTimeout(() => ctrl.abort(), MODEL_LOOKUP_TIMEOUT_MS);
    try {
        const res = await fetch(`${base}/api/ps`, { method: 'GET', signal: ctrl.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return loadedModelNames(await res.json());
    } finally {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
    }
}

function requestModelLoad(base, model, signal, numCtx = AI_NUM_CTX) {
    return fetch(`${base}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, prompt: '', keep_alive: MODEL_KEEP_ALIVE, options: { num_ctx: numCtx } }),
        signal
    });
}

export async function warmAiModel(signal) {
    const base = CONFIG.OLLAMA_URL.replace(/\/+$/, '');
    const model = await resolveReplyModel(base);
    if (!model) return false;
    const res = await requestModelLoad(base, model, signal, AI_NUM_CTX);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    _ready = { model, at: Date.now() };
    return true;
}

function releaseModel(base, model) {
    return fetch(`${base}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, prompt: '', keep_alive: 0 })
    }).catch(() => null);
}

function sleep(ms, signal) {
    return new Promise(resolve => {
        const timer = setTimeout(resolve, ms);
        if (signal) signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
    });
}

let _ready = { model: null, at: 0 };
const READY_TTL_MS = 30000;

export function forgetModelChoices() {
    _tags = { at: 0, models: null };
    _replyChoice = { stored: null, model: null };
    _ready = { model: null, at: 0 };
}

export async function ensureModelReady(base, model, onProgress = () => {}, signal = null, limits = {}) {
    const budgetMs = Number(limits.budgetMs) || CONFIG.MODEL_LOAD_BUDGET_MS;
    const graceMs = Number(limits.graceMs) || CONFIG.MODEL_SWAP_GRACE_MS;
    const numCtx = Number(limits.numCtx) || AI_NUM_CTX;
    if (!model) return false;
    if (_ready.model && sameModel(_ready.model, model) && (Date.now() - _ready.at) < READY_TTL_MS) return true;

    let loaded = [];
    try {
        loaded = await readLoadedNames(base, signal);
    } catch (_) {
        return false;
    }
    if (isModelResident(loaded, model)) {
        _ready = { model, at: Date.now() };
        return true;
    }

    const started = Date.now();
    const loadCtrl = new AbortController();
    const onAbort = () => loadCtrl.abort();
    if (signal) {
        if (signal.aborted) throw abortError();
        signal.addEventListener('abort', onAbort, { once: true });
    }

    let settled = false;
    let loadError = null;
    const load = requestModelLoad(base, model, loadCtrl.signal, numCtx)
        .then(res => { settled = true; if (!res.ok) loadError = new Error(`HTTP ${res.status}`); })
        .catch(err => { settled = true; loadError = err; });

    let released = false;
    let probeFailures = 0;
    try {
        for (;;) {
            onProgress(describeModelLoad({
                model, waitedMs: Date.now() - started, released, loaded
            }));
            await Promise.race([load, sleep(CONFIG.MODEL_PROBE_MS, signal)]);
            if (signal && signal.aborted) throw abortError();

            try {
                loaded = await readLoadedNames(base, signal);
                probeFailures = 0;
            } catch (_) {
                probeFailures++;
            }

            const step = nextModelStep(
                { wanted: model, loaded, waitedMs: Date.now() - started, released, probeFailures },
                { budgetMs, graceMs }
            );
            if (step.action === 'ready') {
                _ready = { model, at: Date.now() };
                return true;
            }
            if (settled) {
                if (loadError) throw loadError;
                _ready = { model, at: Date.now() };
                return true;
            }
            if (step.action === 'release') {
                released = true;
                for (const other of step.release) await releaseModel(base, other);
                continue;
            }
            if (step.action === 'unreachable' || step.action === 'too-slow') {
                loadCtrl.abort();
                throw new Error(describeModelFailure(step.action, { model, waitedMs: Date.now() - started }));
            }
        }
    } finally {
        if (signal) signal.removeEventListener('abort', onAbort);
    }
}

export async function translateLines(prompt, expectedLines, signal, { onTiming = null } = {}) {
    const base = CONFIG.OLLAMA_URL.replace(/\/+$/, '');
    const model = await resolveReplyModel(base);
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    if (signal) {
        if (signal.aborted) ctrl.abort();
        else signal.addEventListener('abort', onAbort, { once: true });
    }
    try {
        await ensureModelReady(base, model, () => {}, ctrl.signal,
                               { budgetMs: TRANSLATE_LOAD_BUDGET_MS, graceMs: TRANSLATE_LOAD_GRACE_MS });
    } catch (_) {}
    const timeoutMs = translationTimeoutMs(expectedLines);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, timeoutMs);
    try {
        return await sendTranslation(base, model, prompt, expectedLines, ctrl.signal, { onTiming });
    } catch (err) {
        if (timedOut && !(signal && signal.aborted)) throw translationTimeoutError(timeoutMs);
        throw err;
    } finally {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
    }
}

async function sendTranslation(base, model, prompt, expectedLines, signal, { think = false, onTiming = null } = {}) {
    const body = {
        model,
        prompt,
        stream: false,
        keep_alive: MODEL_KEEP_ALIVE,
        ...(think === false ? { think: false } : {}),
        options: {
            temperature: 0,
            num_ctx: AI_NUM_CTX,
            num_predict: Math.min(4096, 160 * Math.max(1, expectedLines) + 128)
        }
    };
    const started = Date.now();
    const res = await fetch(`${base}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal
    });
    if (!res.ok) {
        if (res.status === 400 && think === false) {
            return sendTranslation(base, model, prompt, expectedLines, signal, { think: null, onTiming });
        }
        throw new Error(`Translation failed (HTTP ${res.status})`);
    }
    const data = await res.json();
    const text = String(data.response || '').trim();
    if (typeof onTiming === 'function') {
        try { onTiming(generationTiming(data, Date.now() - started)); } catch (_) {}
    }
    if (text) return text;

    const thinking = String(data.thinking || '').trim();
    const truncated = data.done_reason === 'length';
    const error = new Error(thinking
        ? `${model} returned reasoning and no translation`
          + `${truncated ? ' (it ran out of output budget while thinking)' : ''}`
        : `${model} returned an empty response${truncated ? ' (it ran out of output budget)' : ''}`);
    error.name = 'EmptyTranslation';
    throw error;
}

function getTargetTranscript(rec, dropTId) {
    if (!rec || !rec.transcripts || rec.transcripts.length === 0) return null;
    return rec.transcripts.find(item => item.id == dropTId) || rec.transcripts[0];
}

function getChain(rec) {
    return rec.contextChain ? rec.contextChain : (rec.context ? [rec.context] : []);
}

function fetchWithTimeout(url, options, timeoutMs, ctrl, jobSignal, timeoutMessage = '') {
    return new Promise((resolve, reject) => {
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            ctrl.abort();
        }, timeoutMs);
        fetch(url, options).then(resolve, error => {
            if (timedOut && !(jobSignal && jobSignal.aborted)) {
                const failure = new Error(timeoutMessage
                    || `Reply server did not respond within ${Math.round(timeoutMs / 1000)} seconds.`);
                failure.name = 'ReplyFirstByteTimeout';
                reject(failure);
            } else reject(error);
        }).finally(() => clearTimeout(timer));
    });
}

function readWithIdleTimeout(reader, timeoutMs, ctrl) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            ctrl.abort();
            reject(new Error(`Reply stream was idle for ${Math.round(timeoutMs / 1000)} seconds.`));
        }, timeoutMs);
        reader.read().then(resolve, reject).finally(() => clearTimeout(timer));
    });
}

export async function runSummary(recId, progressCallback, dropTId) {
    if (!confirmServerProcessing()) throw abortError('Server processing cancelled.');
    const ctrl = beginJob('r', recId);
    let rec, targetT, budget, model;
    const base = CONFIG.OLLAMA_URL.replace(/\/+$/, '');
    try {
        rec = await dbExec(CONFIG.STORE_REC, 'get', recId);
        targetT = getTargetTranscript(rec, dropTId);
        if (!targetT) throw new Error('Need a transcript first.');
        budget = buildBudgetedPrompt({
            instructions: getSetting('set-ai-instructions'),
            chain: getChain(rec),
            transcript: targetT.plain || targetT.text || ''
        }, { maxCtx: AI_MAX_NUM_CTX, reserveTokens: OUTPUT_RESERVE });
        model = await resolveReplyModel(base);
        if (ctrl.signal.aborted) throw abortError();
    } catch (err) {
        endJob('r', recId, ctrl);
        throw err;
    }
    const resultGeneration = rec.resultGeneration || 0;
    const promptText = budget.prompt;
    const numCtx = estimateNumCtx(promptText, {
        headroomTokens: OUTPUT_RESERVE, minCtx: AI_NUM_CTX, maxCtx: AI_MAX_NUM_CTX
    });
    const firstByteMs = firstByteTimeoutMs(numCtx, CONFIG.REMOTE_FIRST_BYTE_TIMEOUT_MS);

    const streamGen = replyStreamInit(recId);
    replyStreamModel(recId, model, streamGen);

    let netCtrl = new AbortController();
    const onJobAbort = () => netCtrl.abort();
    ctrl.signal.addEventListener('abort', onJobAbort, { once: true });
    let reader = null;

    const askingMessage = (budget.droppedContext || budget.condensedContext || budget.truncatedTranscript || budget.truncatedInstructions)
        ? `Context condensed to fit ${numCtx.toLocaleString()} tokens...`
        : 'Asking server...';

    try {
        let preflighted = await ensureModelReady(base, model, progressCallback, ctrl.signal, { numCtx });
        progressCallback(askingMessage);

        const body = JSON.stringify({
            model,
            prompt: promptText,
            options: { num_ctx: numCtx, num_predict: NUM_PREDICT },
            keep_alive: MODEL_KEEP_ALIVE,
            stream: true
        });

        let res = null;
        for (let attempt = 1; ; attempt++) {
            netCtrl = new AbortController();
            if (ctrl.signal.aborted) netCtrl.abort();
            try {
                res = await fetchWithTimeout(`${base}/api/generate`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body,
                    signal: netCtrl.signal
                }, firstByteMs, netCtrl, ctrl.signal,
                   describeFirstByteTimeout({
                       model, timeoutMs: firstByteMs, preflightSucceeded: preflighted
                   }));
                break;
            } catch (err) {
                if (!shouldRetryGenerate({
                    attempt, maxAttempts: MODEL_GENERATE_ATTEMPTS,
                    preflightSucceeded: preflighted, aborted: ctrl.signal.aborted
                })) throw err;
                _ready = { model: null, at: 0 };
                preflighted = await ensureModelReady(base, model, progressCallback, ctrl.signal, { numCtx });
                progressCallback(askingMessage);
            }
        }

        if (!res.ok) throw new Error(`Reply server request failed (HTTP ${res.status})`);
        if (!res.body) throw new Error('Reply server returned no response stream.');

        reader = res.body.getReader();
        const decoder = new TextDecoder();
        const parser = createReplyStreamReader();

        const applyEvents = events => {
            for (const event of events) {
                if (event.type === 'error') throw new Error(`Reply server: ${event.message}`);
                if (event.type === 'first-token') progressCallback('__first_token__');
                else if (event.type === 'token') replyStreamAppend(recId, event.token, streamGen);
                else if (event.type === 'done') progressCallback('Done');
            }
        };

        while (true) {
            const { done, value } = await readWithIdleTimeout(
                reader, CONFIG.REMOTE_IDLE_TIMEOUT_MS, netCtrl
            );
            if (done) break;
            applyEvents(parser.push(decoder.decode(value, { stream: true })));
        }
        applyEvents(parser.push(decoder.decode()));
        applyEvents(parser.flush());

        const fullText = parser.text;
        if (!fullText.trim()) throw new Error('Reply server completed without returning text.');
        replyStreamDone(recId, streamGen);

        const measured = replyStreamStats(recId);

        const stored = await dbUpdate(CONFIG.STORE_REC, recId, (current) => {
            if (!current || (current.resultGeneration || 0) !== resultGeneration) return null;
            if (!(current.transcripts || []).some(item => item.id == targetT.id)) return null;
            current.summaries = current.summaries || [];
            current.summaries.unshift({
                id: uid(), transcriptId: targetT.id,
                text: fullText, source: 'S', time: Date.now(),
                model,
                tokenCount: measured ? measured.count : 0,
                elapsedMs:  measured ? measured.elapsedMs : 0
            });
            delete current.pipelineError;
            delete current.pipelineErrorAt;
            return current;
        });
        if (!stored) throw abortError('Result discarded because its transcript changed or was deleted.');
    } catch (err) {
        try { if (reader) await reader.cancel(); } catch (_) {}
        if (err && err.name === 'AbortError') {
            replyStreamDone(recId, streamGen);
        } else {
            replyStreamAppend(recId, `\n\n⚠️ ${err.message}`, streamGen);
            replyStreamDone(recId, streamGen);
            progressCallback('Error');
        }
        throw err;
    } finally {
        ctrl.signal.removeEventListener('abort', onJobAbort);
        endJob('r', recId, ctrl);
    }
}
