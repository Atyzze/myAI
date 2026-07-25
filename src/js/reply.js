/* ==========================================================================
   reply.js - Streamed replies from the configured self-hosted Ollama service.
   ========================================================================== */
import { CONFIG, SETTINGS_DEFAULTS, getSetting, uid, confirmServerProcessing } from './config.js';
import { dbExec, dbUpdate } from './db.js';
import { estimateNumCtx, buildBudgetedPrompt, createReplyStreamReader,
         chooseReplyModel } from './reply-core.js';
import { beginJob, endJob, abortError } from './jobs.js';
import { replyStreamInit, replyStreamModel, replyStreamAppend, replyStreamDone } from './live-tabs.js';

/* Output budget for one reply.

   NUM_PREDICT was 1024, which is what actually truncated long answers: the
   server stopped at exactly 1024 decoded tokens with the context slot barely
   used. It is a hard ceiling rather than -1 (unbounded) so a looping model
   cannot hold a GPU forever, but it is now large enough for a long answer.

   OUTPUT_RESERVE must be >= NUM_PREDICT: it is the room the prompt budget
   leaves free inside num_ctx. If the prompt is allowed to fill the context, the
   generated answer is what gets pushed out of it. */
const NUM_PREDICT    = 4096;
const OUTPUT_RESERVE = 4096;

/* How long to wait for the model list before giving up and sending the request
   with whatever is stored. The lookup is a convenience, not a gate: a slow
   server must delay the reply by seconds, not block it. */
const MODEL_LOOKUP_TIMEOUT_MS = 5000;

/* Reconciled once per stored value per session. */
let _confirmedModel = null;

/**
 * The model this reply will actually be sent to.
 *
 * A fresh profile has never opened Settings, so its stored model is the built-in
 * default. If the server does not have that one, /api/generate answers with a
 * model-not-found error and the whole reply feature looks broken while
 * transcription works - the exact failure this resolves. A corrected choice is
 * written back to the setting so the Settings picker shows what is really used.
 */
async function resolveReplyModel(base) {
    const stored = getSetting('set-ollama-model');
    if (_confirmedModel && _confirmedModel === stored) return stored;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), MODEL_LOOKUP_TIMEOUT_MS);
    try {
        const res = await fetch(`${base}/api/tags`, { method: 'GET', signal: ctrl.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const installed = (data.models || []).map(item => item && item.name).filter(Boolean);
        const chosen = chooseReplyModel(installed, stored, SETTINGS_DEFAULTS['set-ollama-model']);
        if (chosen && chosen !== stored) {
            try { localStorage.setItem('set-ollama-model', chosen); } catch (_) {}
        }
        _confirmedModel = chosen || stored;
        return _confirmedModel;
    } catch (_) {
        // Unreachable or slow server: send the stored name and let the generate
        // call report the real failure, rather than inventing one here.
        return stored;
    } finally {
        clearTimeout(timer);
    }
}

export function getTargetTranscript(rec, dropTId) {
    if (!rec || !rec.transcripts || rec.transcripts.length === 0) return null;
    return rec.transcripts.find(item => item.id == dropTId) || rec.transcripts[0];
}

function getChain(rec) {
    return rec.contextChain ? rec.contextChain : (rec.context ? [rec.context] : []);
}

export function buildContextAwarePrompt(rec, transcript) {
    return buildBudgetedPrompt({
        instructions: getSetting('set-ai-instructions'),
        chain: getChain(rec),
        transcript: transcript.plain || transcript.text || ''
    }).prompt;
}

function fetchWithTimeout(url, options, timeoutMs, ctrl, jobSignal) {
    return new Promise((resolve, reject) => {
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            ctrl.abort();
        }, timeoutMs);
        fetch(url, options).then(resolve, error => {
            if (timedOut && !(jobSignal && jobSignal.aborted)) {
                reject(new Error(`Reply server did not respond within ${Math.round(timeoutMs / 1000)} seconds.`));
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
    const rec = await dbExec(CONFIG.STORE_REC, 'get', recId);
    const targetT = getTargetTranscript(rec, dropTId);
    if (!targetT) throw new Error('Need a transcript first.');
    const resultGeneration = rec.resultGeneration || 0;

    const budget = buildBudgetedPrompt({
        instructions: getSetting('set-ai-instructions'),
        chain: getChain(rec),
        transcript: targetT.plain || targetT.text || ''
    }, { maxCtx: 32768, reserveTokens: OUTPUT_RESERVE });
    const promptText = budget.prompt;
    const base = CONFIG.OLLAMA_URL.replace(/\/+$/, '');
    const model = await resolveReplyModel(base);
    const numCtx = estimateNumCtx(promptText, {
        headroomTokens: OUTPUT_RESERVE, minCtx: 8192, maxCtx: 32768
    });

    replyStreamInit(recId);
    // After the init, which resets the entry: the view must learn the model of
    // the reply it is about to receive, not of the one it just discarded.
    replyStreamModel(recId, model);
    if (budget.droppedContext || budget.truncatedTranscript || budget.truncatedInstructions) {
        progressCallback(`Context condensed to fit ${numCtx.toLocaleString()} tokens...`);
    } else {
        progressCallback('Asking server...');
    }

    const ctrl = beginJob('r', recId);
    const netCtrl = new AbortController();
    const onJobAbort = () => netCtrl.abort();
    ctrl.signal.addEventListener('abort', onJobAbort, { once: true });
    let reader = null;

    try {
        const res = await fetchWithTimeout(`${base}/api/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model,
                prompt: promptText,
                options: { num_ctx: numCtx, num_predict: NUM_PREDICT },
                stream: true
            }),
            signal: netCtrl.signal
        }, CONFIG.REMOTE_FIRST_BYTE_TIMEOUT_MS, netCtrl, ctrl.signal);

        if (!res.ok) throw new Error(`Reply server request failed (HTTP ${res.status})`);
        if (!res.body) throw new Error('Reply server returned no response stream.');

        reader = res.body.getReader();
        const decoder = new TextDecoder();
        // NDJSON framing lives in reply-core.js so it can be tested against split
        // reads, partial final lines and server-reported errors without a network.
        const parser = createReplyStreamReader();

        const applyEvents = events => {
            for (const event of events) {
                if (event.type === 'error') throw new Error(`Reply server: ${event.message}`);
                if (event.type === 'first-token') progressCallback('__first_token__');
                else if (event.type === 'token') replyStreamAppend(recId, event.token);
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
        replyStreamDone(recId);

        const stored = await dbUpdate(CONFIG.STORE_REC, recId, (current) => {
            if (!current || (current.resultGeneration || 0) !== resultGeneration) return null;
            if (!(current.transcripts || []).some(item => item.id == targetT.id)) return null;
            current.summaries = current.summaries || [];
            current.summaries.unshift({
                id: uid(), transcriptId: targetT.id,
                text: fullText, source: 'S', time: Date.now()
            });
            delete current.pipelineError;
            delete current.pipelineErrorAt;
            return current;
        });
        if (!stored) throw abortError('Result discarded because its transcript changed or was deleted.');
    } catch (err) {
        try { if (reader) await reader.cancel(); } catch (_) {}
        if (err && err.name === 'AbortError') {
            replyStreamDone(recId);
        } else {
            replyStreamAppend(recId, `\n\n⚠️ ${err.message}`);
            replyStreamDone(recId);
            progressCallback('Error');
        }
        throw err;
    } finally {
        ctrl.signal.removeEventListener('abort', onJobAbort);
        endJob('r', recId, ctrl);
    }
}
