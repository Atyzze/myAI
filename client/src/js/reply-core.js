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
        if (obj.done) events.push({ type: 'done' });
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
