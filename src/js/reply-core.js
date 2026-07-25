/* ==========================================================================
 * reply-core.js - Pure context sizing and prompt-budget helpers.
 * ========================================================================== */

export function estimateTokens(text, charsPerToken = 3) {
    return Math.ceil(String(text ?? '').length / charsPerToken);
}

export function estimateNumCtx(promptText, {
    charsPerToken  = 3,
    headroomTokens = 2048,
    minCtx         = 8192,
    maxCtx         = 32768
} = {}) {
    const needed = estimateTokens(promptText, charsPerToken) + headroomTokens;
    let numCtx = minCtx;
    while (numCtx < needed && numCtx < maxCtx) numCtx *= 2;
    return Math.min(numCtx, maxCtx);
}

export function truncateMiddle(text, maxChars, marker = '\n[… content condensed to fit model context …]\n') {
    const value = String(text ?? '');
    if (value.length <= maxChars) return value;
    if (maxChars <= marker.length + 2) return value.slice(0, Math.max(0, maxChars));
    const room = maxChars - marker.length;
    const head = Math.floor(room * 0.4);
    const tail = room - head;
    return value.slice(0, head) + marker + value.slice(value.length - tail);
}

function composePrompt(instructions, chain, transcript) {
    let prompt = transcript;
    if (chain.length) {
        const chainText = chain
            .map((item, index) => `[CONTEXT ${index + 1}: ${item.label || ''}]:\n${item.text || ''}`)
            .join('\n\n');
        prompt = `[PRIOR CONVERSATION CONTEXT]:\n${chainText}\n\n[NEW AUDIO TRANSCRIPT]:\n${transcript}`;
    }
    if (instructions) prompt = `[AI INSTRUCTIONS]:\n${instructions}\n\n${prompt}`;
    return prompt;
}

/**
 * Build a prompt that is guaranteed to fit inside maxCtx minus reserved output.
 * Oldest context is dropped first. If the current transcript or instructions are
 * individually too large, their middle is condensed while preserving both ends.
 */
export function buildBudgetedPrompt({ instructions = '', chain = [], transcript = '' }, {
    maxCtx = 32768,
    reserveTokens = 2048,
    charsPerToken = 3
} = {}) {
    const maxChars = Math.max(256, (maxCtx - reserveTokens) * charsPerToken);
    let keptChain = [...(chain || [])];
    let keptInstructions = String(instructions || '').trim();
    let keptTranscript = String(transcript || '');
    let prompt = composePrompt(keptInstructions, keptChain, keptTranscript);
    let droppedContext = 0;
    let truncatedTranscript = false;
    let truncatedInstructions = false;

    while (prompt.length > maxChars && keptChain.length) {
        keptChain.shift();
        droppedContext++;
        prompt = composePrompt(keptInstructions, keptChain, keptTranscript);
    }

    if (prompt.length > maxChars) {
        const withoutTranscript = composePrompt(keptInstructions, keptChain, '').length;
        const available = Math.max(128, maxChars - withoutTranscript);
        const next = truncateMiddle(keptTranscript, available);
        truncatedTranscript = next !== keptTranscript;
        keptTranscript = next;
        prompt = composePrompt(keptInstructions, keptChain, keptTranscript);
    }

    if (prompt.length > maxChars && keptInstructions) {
        const withoutInstructions = composePrompt('', keptChain, keptTranscript).length;
        const available = Math.max(64, maxChars - withoutInstructions);
        const next = truncateMiddle(keptInstructions, available);
        truncatedInstructions = next !== keptInstructions;
        keptInstructions = next;
        prompt = composePrompt(keptInstructions, keptChain, keptTranscript);
    }

    // Structural markers can make the estimate a few characters too large.
    if (prompt.length > maxChars) prompt = truncateMiddle(prompt, maxChars);

    return {
        prompt,
        droppedContext,
        truncatedTranscript,
        truncatedInstructions,
        estimatedTokens: estimateTokens(prompt, charsPerToken)
    };
}

/* ──────────────────────────────────────────────────────────────────────────
 *  Reply model selection.
 *
 *  The stored model name and the models the server actually has can disagree,
 *  and every path that disagreed silently produced the same symptom: a reply
 *  that fails with a model-not-found error while transcription works fine. A
 *  fresh profile has never opened Settings, so its stored value is the built-in
 *  default, and the Settings picker used to be the only place the two were ever
 *  reconciled - which is why replies started working only after a visit there.
 *
 *  Preference order, most specific first:
 *    1. the stored choice, if the server still has it - an explicit user pick
 *       is never silently overridden;
 *    2. the preferred default, if installed;
 *    3. any model from the same family as the preferred default, so a server
 *       carrying a different size of the intended model is chosen over an
 *       unrelated one;
 *    4. whatever is installed, because any working model beats a failed reply.
 *  ────────────────────────────────────────────────────────────────────────── */
export function chooseReplyModel(available, stored, preferred) {
    const list = (available || []).map(name => String(name || '')).filter(Boolean);
    const storedName = String(stored || '');
    const preferredName = String(preferred || '');

    // Nothing to choose from: keep what we have rather than inventing a name.
    if (list.length === 0) return storedName || preferredName;

    if (storedName && list.includes(storedName)) return storedName;
    if (preferredName && list.includes(preferredName)) return preferredName;

    const family = preferredName.split(':')[0];
    if (family) {
        const relative = list.find(name => name.split(':')[0] === family);
        if (relative) return relative;
    }
    return list[0];
}

/* ──────────────────────────────────────────────────────────────────────────
 *  Streamed NDJSON reply decoding.
 *
 *  Ollama answers /api/generate as newline-delimited JSON, and network reads cut
 *  that stream at arbitrary byte offsets: a single read can end mid-object, mid
 *  multi-byte character, or carry several complete objects at once. That framing
 *  logic used to live inline in reply.js, tangled with fetch, timeouts, abort
 *  signals and IndexedDB, so none of it could be tested. It is a pure state
 *  machine, so it lives here instead.
 *
 *  push(text) and flush() return an ordered event list:
 *    { type: 'first-token' }            once, before the first token event
 *    { type: 'token', token }           one per non-empty response fragment
 *    { type: 'done' }                   the server marked the stream complete
 *    { type: 'error', message }         the server reported a failure
 *
 *  Unparseable lines are skipped rather than fatal: a proxy injecting a keep-alive
 *  or a blank line must not abort a reply that is otherwise streaming fine.
 *  ────────────────────────────────────────────────────────────────────────── */
export function createReplyStreamReader() {
    let buffer = '';
    let text = '';
    let firstTokenSeen = false;

    function consumeLine(line, events) {
        const trimmed = line.trim();
        if (!trimmed) return;
        let obj;
        try { obj = JSON.parse(trimmed); } catch (_) { return; }
        if (obj.error) {
            events.push({ type: 'error', message: String(obj.error) });
            return;
        }
        if (obj.response) {
            if (!firstTokenSeen) {
                firstTokenSeen = true;
                events.push({ type: 'first-token' });
            }
            text += obj.response;
            events.push({ type: 'token', token: obj.response });
        }
        if (obj.done) events.push({ type: 'done' });
    }

    return {
        /** Feed decoded text from one network read. */
        push(chunkText) {
            const events = [];
            buffer += String(chunkText ?? '');
            let newline;
            while ((newline = buffer.indexOf('\n')) >= 0) {
                consumeLine(buffer.slice(0, newline), events);
                buffer = buffer.slice(newline + 1);
            }
            return events;
        },
        /** Consume a final object that arrived without a trailing newline. */
        flush() {
            const events = [];
            if (buffer.trim()) consumeLine(buffer, events);
            buffer = '';
            return events;
        },
        /** Everything received so far, concatenated. */
        get text() { return text; }
    };
}
