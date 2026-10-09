const WIDE_SCRIPT = /[\u1100-\u11ff\u2e80-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\ua960-\ua97f\uac00-\ud7ff\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60]/;

export const LATIN_CHARS_PER_TOKEN = 3.3;

const CODE_RUN_MIN = 16;

const SPACE_CLASS = Object.freeze({ space: true });
const NEWLINE_CLASS = Object.freeze({ newline: true });
const LATIN_CLASS = Object.freeze({ letter: true, latin: true });
const DIGIT_CLASS = Object.freeze({ digit: true, weight: 1 });
const SYMBOL_CLASS = Object.freeze({ weight: 1 });
const WIDE_CLASS = Object.freeze({ letter: true, weight: 1 });
const ASTRAL_CLASS = Object.freeze({ weight: 2 });

const SCRIPT_WEIGHTS = [
    [/\p{Script=Cyrillic}/u, 0.5],
    [/[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Syriac}\p{Script=Thaana}]/u, 0.6]
].map(([pattern, weight]) => [pattern, Object.freeze({ letter: true, weight })]);
const OTHER_LETTER_CLASS = Object.freeze({ letter: true, weight: 1 });

const nonAsciiClasses = new Map();

function classifyNonAscii(ch, code) {
    if (/\s/u.test(ch)) return ch === '\u2028' || ch === '\u2029' ? NEWLINE_CLASS : SPACE_CLASS;
    if (code > 0xFFFF) return ASTRAL_CLASS;
    if (WIDE_SCRIPT.test(ch)) return WIDE_CLASS;
    if (/\p{Nd}/u.test(ch)) return DIGIT_CLASS;
    if (/\p{Script=Latin}/u.test(ch)) return LATIN_CLASS;
    for (const [pattern, cls] of SCRIPT_WEIGHTS) if (pattern.test(ch)) return cls;
    if (/\p{L}/u.test(ch)) return OTHER_LETTER_CLASS;
    return SYMBOL_CLASS;
}

function classify(ch) {
    const code = ch.codePointAt(0);
    if (code < 128) {
        if (code === 10) return NEWLINE_CLASS;
        if (code === 32 || (code >= 9 && code <= 13)) return SPACE_CLASS;
        if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122)) return LATIN_CLASS;
        if (code >= 48 && code <= 57) return DIGIT_CLASS;
        return SYMBOL_CLASS;
    }
    let cls = nonAsciiClasses.get(code);
    if (!cls) {
        cls = classifyNonAscii(ch, code);
        if (nonAsciiClasses.size < 8192) nonAsciiClasses.set(code, cls);
    }
    return cls;
}

export function estimateTokens(text, charsPerToken = LATIN_CHARS_PER_TOKEN) {
    const value = String(text ?? '');
    const latin = 1 / Math.max(1, Number(charsPerToken) || LATIN_CHARS_PER_TOKEN);
    let total = 0;
    let run = 0;
    let runTokens = 0;
    let runLetters = false;
    let runDigits = false;
    const closeRun = () => {
        total += run >= CODE_RUN_MIN && runLetters && runDigits ? Math.max(runTokens, run) : runTokens;
        run = 0;
        runTokens = 0;
        runLetters = false;
        runDigits = false;
    };
    for (const ch of value) {
        const cls = classify(ch);
        if (cls.space) { closeRun(); continue; }
        if (cls.newline) { closeRun(); total += 1; continue; }
        run++;
        runTokens += cls.latin ? latin : cls.weight;
        if (cls.letter) runLetters = true;
        if (cls.digit) runDigits = true;
    }
    closeRun();
    return Math.ceil(total);
}

export function condenseToTokenBudget(text, maxTokens, charsPerToken = LATIN_CHARS_PER_TOKEN) {
    const value = String(text ?? '');
    const budget = Math.max(0, Math.floor(Number(maxTokens) || 0));
    if (estimateTokens(value, charsPerToken) <= budget) return value;

    let low = 0;
    let high = value.length;
    let best = '';
    while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        const candidate = truncateMiddle(value, mid);
        if (estimateTokens(candidate, charsPerToken) <= budget) {
            best = candidate;
            low = mid + 1;
        } else {
            high = mid - 1;
        }
    }
    return best;
}

export function estimateNumCtx(promptText, {
    charsPerToken  = LATIN_CHARS_PER_TOKEN,
    headroomTokens = 2048,
    minCtx         = 8192,
    maxCtx         = 32768,
    tokenScale     = 1
} = {}) {
    const scale = Math.max(1, Number(tokenScale) || 1);
    const needed = Math.ceil(estimateTokens(promptText, charsPerToken) * scale) + headroomTokens;
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

export const MIN_CONTEXT_TOKENS = 512;

export function buildBudgetedPrompt({ instructions = '', chain = [], transcript = '' }, {
    maxCtx = 32768,
    reserveTokens = 2048,
    charsPerToken = LATIN_CHARS_PER_TOKEN
} = {}) {
    const maxTokens = Math.max(1, Math.floor(maxCtx - reserveTokens));
    const tokensOf = text => estimateTokens(text, charsPerToken);

    let keptChain = [...(chain || [])];
    let keptInstructions = String(instructions || '').trim();
    let keptTranscript = String(transcript || '');
    let prompt = composePrompt(keptInstructions, keptChain, keptTranscript);
    let droppedContext = 0;
    let condensedContext = false;
    let truncatedTranscript = false;
    let truncatedInstructions = false;

    while (tokensOf(prompt) > maxTokens && keptChain.length > 1) {
        keptChain.shift();
        droppedContext++;
        prompt = composePrompt(keptInstructions, keptChain, keptTranscript);
    }

    if (tokensOf(prompt) > maxTokens && keptChain.length === 1) {
        const only = keptChain[0];
        const room = maxTokens - tokensOf(composePrompt(keptInstructions, [{ ...only, text: '' }], keptTranscript));
        if (room >= MIN_CONTEXT_TOKENS) {
            const text = condenseToTokenBudget(only.text || '', room, charsPerToken);
            condensedContext = text !== (only.text || '');
            keptChain = [{ ...only, text }];
        } else {
            keptChain = [];
            droppedContext++;
        }
        prompt = composePrompt(keptInstructions, keptChain, keptTranscript);
    }

    if (tokensOf(prompt) > maxTokens && keptTranscript) {
        const overhead = tokensOf(composePrompt(keptInstructions, keptChain, ''));
        const next = condenseToTokenBudget(keptTranscript, maxTokens - overhead, charsPerToken);
        truncatedTranscript = next !== keptTranscript;
        keptTranscript = next;
        prompt = composePrompt(keptInstructions, keptChain, keptTranscript);
    }

    if (tokensOf(prompt) > maxTokens && keptInstructions) {
        const overhead = tokensOf(composePrompt('', keptChain, keptTranscript));
        const next = condenseToTokenBudget(keptInstructions, maxTokens - overhead, charsPerToken);
        truncatedInstructions = next !== keptInstructions;
        keptInstructions = next;
        prompt = composePrompt(keptInstructions, keptChain, keptTranscript);
    }

    if (tokensOf(prompt) > maxTokens) {
        prompt = condenseToTokenBudget(prompt, maxTokens, charsPerToken);
    }

    return {
        prompt,
        droppedContext,
        condensedContext,
        truncatedTranscript,
        truncatedInstructions,
        estimatedTokens: tokensOf(prompt)
    };
}

const NON_GENERATIVE = /(^|[\/:-])(embed|embedding|reranker|rerank|bge|gte|nomic-embed|all-minilm|mxbai-embed)/i;

export function isGenerativeModel(name) {
    return !NON_GENERATIVE.test(String(name || ''));
}

export function isFallbackChoice(chosen, stored, available) {
    const list = (available || []).map(n => String(n || '')).filter(Boolean);
    const storedName = String(stored || '');
    return !(storedName && list.includes(storedName)) && chosen !== storedName;
}

export function chooseReplyModel(available, stored, preferred) {
    const all = (available || []).map(name => String(name || '')).filter(Boolean);
    const generative = all.filter(isGenerativeModel);
    const list = generative.length ? generative : all;
    const storedName = String(stored || '');
    const preferredName = String(preferred || '');

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

export function describeLoadedModel(entry) {
    const name = String((entry && (entry.name || entry.model)) || '');
    if (!name) return null;
    const size = Number(entry && entry.size);
    const vram = Number(entry && entry.size_vram);
    const measured = Number.isFinite(size) && size > 0 && Number.isFinite(vram) && vram >= 0;
    const gpuPercent = measured ? Math.round(Math.min(1, vram / size) * 100) : null;
    return {
        name,
        sizeBytes: measured ? size : null,
        gpuPercent,
        onCpu: gpuPercent !== null && gpuPercent < 100
    };
}

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
        if (obj.done) {
            events.push({
                type: 'done',
                doneReason:   String(obj.done_reason || ''),
                promptTokens: Math.max(0, Number(obj.prompt_eval_count) || 0),
                outputTokens: Math.max(0, Number(obj.eval_count) || 0)
            });
        }
    }

    return {
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
        flush() {
            const events = [];
            if (buffer.trim()) consumeLine(buffer, events);
            buffer = '';
            return events;
        },
        get text() { return text; }
    };
}

// Ollama's real token counts (prompt_eval_count, eval_count) only arrive with the final stream
// object. A reply that filled the model's context window, or used up its output budget, ends
// mid-sentence without an error, so this turns how it stopped into a notice the person can see.
// Only those two limits make Ollama stop with done_reason "length", so a "length" stop short of
// the output limit was the context window. The output count includes the model's thinking.
// The prompt count is not used to decide: when Ollama reuses a cached prompt prefix it reports
// only the part it had to read again.
const CONTEXT_FULL_MARGIN_TOKENS = 16;

export function describeReplyCutoff({ doneReason = '', promptTokens = 0, outputTokens = 0,
                                      numCtx = 0, numPredict = 0 } = {}) {
    const prompt = Math.max(0, Number(promptTokens) || 0);
    const output = Math.max(0, Number(outputTokens) || 0);
    const ctx = Math.max(0, Number(numCtx) || 0);
    const limit = Math.max(0, Number(numPredict) || 0);
    const fmt = n => n.toLocaleString('en-US');

    const outputFull = limit > 0 && output >= limit;
    const contextFull = !outputFull && (
        doneReason === 'length'
        || (ctx > 0 && prompt > 0 && prompt + output >= ctx - CONTEXT_FULL_MARGIN_TOKENS));
    if (contextFull) {
        return `⚠️ Reply cut off: the model's context window${ctx ? ` of ${fmt(ctx)} tokens` : ''} was full `
            + `after ${fmt(output)} reply tokens (thinking included). `
            + `Remove or shorten context items to leave more room for the reply.`;
    }
    if (outputFull || doneReason === 'length') {
        return `⚠️ Reply cut off: it reached the reply limit`
            + `${limit > 0 ? ` of ${fmt(limit)} tokens` : ''}, which includes the model's thinking.`;
    }
    return '';
}

// The largest context the model itself supports, from Ollama's /api/show answer
// (model_info["<architecture>.context_length"]). null when the answer does not say.
export function contextLengthFromShow(payload) {
    const info = payload && typeof payload === 'object' ? payload.model_info : null;
    if (!info || typeof info !== 'object') return null;
    for (const [key, value] of Object.entries(info)) {
        if (!/(^|\.)context_length$/.test(key)) continue;
        const n = Math.floor(Number(value));
        if (Number.isFinite(n) && n > 0) return n;
    }
    return null;
}

// The context a reply may ask for: never more than the model supports, and never more than the
// box has memory for. The box sized its limit for the model it chose, so that limit only applies
// to that model; any other model gets the app's own ceiling.
export function replyContextCeiling({ model = '', modelMax = null, boxModel = null, boxMax = null,
                                      fallback = 32768, sameModelFn = (a, b) => a === b } = {}) {
    const boxApplies = boxMax != null && Number(boxMax) > 0 && boxModel && sameModelFn(boxModel, model);
    const ceiling = boxApplies ? Math.floor(Number(boxMax)) : fallback;
    const native = Number(modelMax) > 0 ? Math.floor(Number(modelMax)) : Infinity;
    return Math.max(1, Math.min(ceiling, native));
}

// How far the app's token estimate runs under the model's real count, learned from replies.
// It rises at once when a prompt turns out larger than estimated and eases back slowly, so one
// small or cached prompt cannot undo it. Prompts too small to say much, and answers that look
// like a cache hit, leave it as it is.
export const DEFAULT_TOKEN_SCALE = 1.1;
export const MIN_TOKEN_SCALE = 1.05;
export const MAX_TOKEN_SCALE = 2;
const MIN_CALIBRATION_TOKENS = 1000;

export function nextTokenScale(previous, estimatedTokens, actualTokens) {
    const prev = Math.min(MAX_TOKEN_SCALE, Math.max(MIN_TOKEN_SCALE, Number(previous) || DEFAULT_TOKEN_SCALE));
    const estimated = Number(estimatedTokens) || 0;
    const actual = Number(actualTokens) || 0;
    if (estimated < MIN_CALIBRATION_TOKENS || actual <= 0) return prev;
    const ratio = actual / estimated;
    if (ratio < 0.5) return prev;
    const next = ratio >= prev ? ratio * 1.02 : prev * 0.8 + ratio * 0.2;
    return Math.min(MAX_TOKEN_SCALE, Math.max(MIN_TOKEN_SCALE, Math.round(next * 1000) / 1000));
}
