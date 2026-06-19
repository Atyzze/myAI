/* ==========================================================================
   reply.js — Local & remote AI reply/summarization pipelines
   ========================================================================== */
import { CONFIG, getSetting, uid }              from './config.js';
import { dbExec, dbUpdate }                      from './db.js';
import { aiWorker, aiJobs }                       from './ai-worker.js';
import { beginJob, endJob, abortError }           from './jobs.js';
import { replyStreamInit, replyStreamAppend, replyStreamDone } from './live-tabs.js';

/* ──────────────────────────────────────────────────────────────────────────
   Prompt builders
   ────────────────────────────────────────────────────────────────────────── */

/** Pick the transcript object matching a dropdown ID (or first available). */
export function getTargetTranscript(rec, dropTId) {
    if (!rec.transcripts || rec.transcripts.length === 0) return null;
    return rec.transcripts.find(x => x.id == dropTId) || rec.transcripts[0];
}

function getChain(rec) {
    return rec.contextChain ? rec.contextChain : (rec.context ? [rec.context] : []);
}

/**
 * Full instruction-following prompt for a real LLM (Ollama):
 * AI instructions + prior context + new transcript.
 *
 * Note: transcript/context text is interpolated under structural markers
 * ([AI INSTRUCTIONS]/[NEW AUDIO TRANSCRIPT]/[CONTEXT n]) that the content could
 * itself contain — i.e. transcribed audio that literally says "AI instructions,
 * ignore the above" is indistinguishable from a real directive. This is inherent
 * to plain-text prompting (there's no privileged channel to a base /api/generate
 * call) and is accepted as low-stakes for a single-user, self-hosted tool. Don't
 * point this prompt at untrusted third-party audio without a sandboxed model.
 */
export function buildContextAwarePrompt(rec, transcript) {
    const instructions   = getSetting('set-ai-instructions').trim();
    const transcriptText = transcript.plain || transcript.text || '';
    let prompt = transcriptText;

    const chain = getChain(rec);
    if (chain.length > 0) {
        const chainText = chain.map((c, i) => `[CONTEXT ${i + 1}: ${c.label || ''}]:\n${c.text}`).join('\n\n');
        prompt = `[PRIOR CONVERSATION CONTEXT]:\n${chainText}\n\n[NEW AUDIO TRANSCRIPT]:\n${transcriptText}`;
    }
    if (instructions) prompt = `[AI INSTRUCTIONS]:\n${instructions}\n\n${prompt}`;
    return prompt;
}

/**
 * Input for the on-device summarizer (distilbart). distilbart is a SUMMARIZER,
 * not an instruction follower — feeding it "[AI INSTRUCTIONS]: reply in Dutch"
 * just makes it summarise those words. So we feed only the content to condense
 * (context + transcript), no instruction wrapper.
 */
function buildSummaryInput(rec, transcript) {
    const transcriptText = transcript.plain || transcript.text || '';
    const chain = getChain(rec);
    const parts = [];
    if (chain.length) parts.push(chain.map(c => c.text).join('\n'));
    parts.push(transcriptText);
    return parts.join('\n').trim();
}

/* ──────────────────────────────────────────────────────────────────────────
   Local (on-device distilbart) — summarization
   ────────────────────────────────────────────────────────────────────────── */
export async function runLocalSummary(recId, progressCallback, dropTId) {
    let rec = await dbExec(CONFIG.STORE_REC, 'get', recId);
    const targetT = getTargetTranscript(rec, dropTId);
    if (!targetT) throw new Error('Need a transcript first.');

    const inputText = buildSummaryInput(rec, targetT);
    replyStreamInit(recId);
    progressCallback('Waking AI Thread...');

    const ctrl = beginJob('r', recId);
    try {
        const finalTxt = await new Promise((resolve, reject) => {
            const onAbort = () => { delete aiJobs[`summarize-${recId}`]; reject(abortError()); };
            if (ctrl.signal.aborted) return onAbort();
            ctrl.signal.addEventListener('abort', onAbort, { once: true });

            aiJobs[`summarize-${recId}`] = {
                resolve, reject,
                // Worker progress is STATUS only — must not be streamed as reply text.
                progress: (msg) => progressCallback(msg)
            };
            aiWorker.postMessage({ action: 'summarize', id: recId, data: inputText });
        });

        // distilbart returns the whole summary at once → stream it as the body.
        progressCallback('__first_token__');
        replyStreamAppend(recId, finalTxt);
        replyStreamDone(recId);

        rec = await dbExec(CONFIG.STORE_REC, 'get', recId);
        // Atomic get→modify→put so a concurrent transcribe/reply can't clobber it.
        await dbUpdate(CONFIG.STORE_REC, recId, (cur) => {
            if (!cur) return null;
            cur.summaries = cur.summaries || [];
            cur.summaries.unshift({
                id: uid(), transcriptId: targetT.id,
                text: finalTxt, source: 'D', time: Date.now()
            });
            return cur;
        });
    } finally {
        endJob('r', recId);
    }
}

/* ──────────────────────────────────────────────────────────────────────────
   Remote (Ollama streaming) — instruction-following reply
   ────────────────────────────────────────────────────────────────────────── */
export async function runRemoteSummary(recId, progressCallback, dropTId) {
    let rec = await dbExec(CONFIG.STORE_REC, 'get', recId);
    const targetT = getTargetTranscript(rec, dropTId);
    if (!targetT) throw new Error('Need a transcript first.');

    const promptText = buildContextAwarePrompt(rec, targetT);
    const base  = CONFIG.OLLAMA_URL.replace(/\/+$/, '');
    const model = getSetting('set-ollama-model') || 'llama3.2';

    // Size the context window to fit the prompt AND leave room to generate a reply.
    // Hardcoding num_ctx:8192 meant that once the prompt grew past ~8k tokens
    // (≈ 32–36 KB of text) it filled the whole window, leaving no space to
    // generate — Ollama then truncated the prompt and the model emitted end-of-text
    // immediately, so the reply came back EMPTY. We estimate the prompt's tokens
    // (deliberately over-counting at ~3 chars/token so non-English text stays safe),
    // add headroom for the response, round UP to a power-of-2 bucket (so num_ctx
    // only takes a few distinct values — Ollama reloads the model when num_ctx
    // changes, and bucketing keeps that rare), and clamp to a VRAM-safe ceiling.
    // Raise REPLY_NUM_CTX_MAX if you have the VRAM and want even larger contexts.
    const REPLY_HEADROOM_TOKENS = 2048;    // room reserved for the generated reply
    const REPLY_NUM_CTX_MIN     = 8192;    // never below the old default
    const REPLY_NUM_CTX_MAX     = 32768;   // ceiling — KV-cache VRAM grows with this
    const estPromptTokens = Math.ceil(promptText.length / 3);
    let numCtx = REPLY_NUM_CTX_MIN;
    const neededCtx = estPromptTokens + REPLY_HEADROOM_TOKENS;
    while (numCtx < neededCtx && numCtx < REPLY_NUM_CTX_MAX) numCtx *= 2;
    numCtx = Math.min(numCtx, REPLY_NUM_CTX_MAX);

    replyStreamInit(recId);
    progressCallback('Asking Server...');

    const ctrl = beginJob('r', recId);
    let reader = null;
    try {
        const res = await fetch(`${base}/api/generate`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({
                model, prompt: promptText,
                options: { num_ctx: numCtx }, stream: true
            }),
            signal: ctrl.signal
        });
        if (!res.ok)   throw new Error(`Ollama request failed (HTTP ${res.status})`);
        if (!res.body) throw new Error('Ollama returned no response stream.');

        reader        = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer    = '';
        let fullText  = '';
        let firstTokenFired = false;

        const handleLine = (line) => {
            const t = line.trim();
            if (!t) return;
            let obj;
            try { obj = JSON.parse(t); } catch (_) { return; }
            if (obj.error) throw new Error(`Ollama: ${obj.error}`);
            if (obj.response) {
                if (!firstTokenFired) { firstTokenFired = true; progressCallback('__first_token__'); }
                fullText += obj.response;
                replyStreamAppend(recId, obj.response);
            }
            if (obj.done) { replyStreamDone(recId); progressCallback('Done'); }
        };

        // Buffer across network chunks so JSON lines split at a chunk boundary
        // aren't lost (the previous version dropped them in a silent catch).
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let nl;
            while ((nl = buffer.indexOf('\n')) >= 0) {
                const line = buffer.slice(0, nl);
                buffer = buffer.slice(nl + 1);
                handleLine(line);
            }
        }
        if (buffer.trim()) handleLine(buffer);   // flush any trailing partial line
        replyStreamDone(recId);                   // idempotent safety

        // Atomic get→modify→put so a concurrent transcribe/reply can't clobber it.
        await dbUpdate(CONFIG.STORE_REC, recId, (cur) => {
            if (!cur) return null;
            cur.summaries = cur.summaries || [];
            cur.summaries.unshift({
                id: uid(), transcriptId: targetT.id,
                text: fullText || '', source: 'C', time: Date.now()
            });
            return cur;
        });
    } catch (err) {
        // Always release the stream and CLOSE the live popup, otherwise it hangs
        // on "Asking Server..." forever on any error (bad HTTP, dropped socket,
        // Ollama {"error":...}, null body). Aborts close quietly; real errors
        // surface a short message in the popup.
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
        endJob('r', recId);
    }
}
