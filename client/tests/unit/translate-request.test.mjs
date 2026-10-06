import { emitTestResult } from '../helpers/test-result.mjs';

let passed = 0;
let failed = 0;
const fails = [];
function ok(value, message) {
    if (value) { passed++; return; }
    failed++;
    fails.push(`  ✗ ${message}`);
}
function eq(actual, expected, message) {
    ok(actual === expected, `${message} (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`);
}

const store = new Map();
globalThis.localStorage = {
    getItem: key => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { store.set(key, String(value)); },
    removeItem: key => { store.delete(key); }
};
store.set('set-ollama-model', 'qwen2.5:3b');
globalThis.window = globalThis.window || {};
globalThis.indexedDB = globalThis.indexedDB || { open() { return {}; } };

let installed = ['gemma4:31b', 'qwen2.5:3b', 'nomic-embed-text:latest'];
let tagCalls = 0;
const generateCalls = [];
let generateReply = '1. Hello there\n2. How are you';
let generateStats = {};
let generateHangs = false;

globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target.endsWith('/api/tags')) {
        tagCalls++;
        return {
            ok: true,
            json: async () => ({ models: installed.map(name => ({ name })) })
        };
    }
    if (target.endsWith('/api/generate')) {
        const body = JSON.parse(options.body);
        if (generateHangs && body.prompt) {
            return new Promise((_, reject) => {
                const fail = () => reject(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }));
                if (options.signal && options.signal.aborted) fail();
                else if (options.signal) options.signal.addEventListener('abort', fail, { once: true });
            });
        }
        generateCalls.push(body);
        return { ok: true, json: async () => ({ response: generateReply, ...generateStats }) };
    }
    if (target.endsWith('/api/ps')) {
        return {
            ok: true,
            json: async () => ({ models: [{ name: 'qwen2.5:3b', size: 4_000_000_000, size_vram: 2_000_000_000 }] })
        };
    }
    throw new Error(`unexpected request to ${target}`);
};

const { translateLines, loadedModels, forgetModelChoices, warmAiModel } = await import('../../src/js/reply.js');
const { AI_NUM_CTX } = await import('../../src/js/model-ready-core.js');
const { buildBatchPrompt, parseBatchResponse } = await import('../../src/js/translate-core.js');
const translationCalls = () => generateCalls.filter(call => call && call.options);

{
    const lines = [{ text: 'Hallo daar' }, { text: 'Hoe gaat het' }];
    const prompt = buildBatchPrompt(lines, 'English');
    const reply = await translateLines(prompt, lines.length);
    const parsed = parseBatchResponse(reply, lines.length);

    eq(JSON.stringify(parsed), '["Hello there","How are you"]',
       'request: a batch goes out and comes back aligned');

    const sent = translationCalls()[0];
    eq(sent.model, 'qwen2.5:3b',
       'request: and uses the same selected AI model as replies');
    eq(sent.stream, false, 'request: a panel wants the finished sentence');
    eq(sent.options.temperature, 0, 'request: rendering is not a creative task');
    eq(sent.options.num_ctx, AI_NUM_CTX,
       'request: translation asks for the shared AI context, so it never makes the server reload the model a reply loaded');
    ok(sent.keep_alive, 'request: and asks the server to keep the model resident, as replies do');
    ok(sent.options.num_predict >= 160 * lines.length,
       'request: with room for every line in the batch plus its numbering');
    ok(sent.prompt.includes('1. Hallo daar') && sent.prompt.includes('2. Hoe gaat het'),
       'request: carrying the numbered lines the alignment check depends on');
}

{
    const before = tagCalls;
    for (let i = 0; i < 5; i++) await translateLines('x', 1);
    eq(tagCalls, before, 'request: five more batches ask the server for its model list exactly zero more times');
    ok(translationCalls().length >= 6, 'request: while every one of them is still sent');
    eq(new Set(translationCalls().map(call => call.options.num_ctx)).size, 1,
       'request: every batch asks for the same context');
}

{
    const before = translationCalls().length;
    await translateLines('y', 12);
    const calls = translationCalls();
    eq(calls[before].options.num_ctx, calls[0].options.num_ctx,
       'request: a twelve-line batch and a one-line batch ask for the same context');
    ok(calls[before].options.num_predict > calls[1].options.num_predict,
       'request: while the output allowance still follows the number of lines');
}

{
    localStorage.setItem('set-ollama-model', 'gemma4:31b');
    forgetModelChoices();
    const at = translationCalls().length;
    await translateLines('x', 1);
    eq(translationCalls()[at].model, 'gemma4:31b',
       'request: changing the single AI model changes translation too');

    localStorage.setItem('set-ollama-model', 'mistral:7b');
    installed = ['gemma4:31b', 'qwen2.5:3b'];
    forgetModelChoices();
    const before = translationCalls().length;
    await translateLines('x', 1);
    eq(translationCalls()[before].model, 'gemma4:31b',
       'request: a missing saved AI model resolves exactly as replies do');
}

{
    localStorage.setItem('set-ollama-model', 'gemma4:31b');
    forgetModelChoices();
    const previous = globalThis.fetch;
    globalThis.fetch = async url => String(url).endsWith('/api/generate')
        ? { ok: false, status: 500 }
        : previous(url);
    let message = '';
    try { await translateLines('z', 1); } catch (err) { message = err.message; }
    ok(/500/.test(message),
       'request: a server that refuses produces an error naming the status');
    globalThis.fetch = previous;
}

{
    localStorage.setItem('set-ollama-model', 'gemma4:31b');
    forgetModelChoices();
    const before = generateCalls.length;
    await warmAiModel();
    const warm = generateCalls[before];
    ok(warm && warm.prompt === '' && warm.model === 'gemma4:31b',
       'warm-up: loading the AI model ahead of translation is an empty request for the selected model');
    eq(warm && warm.options && warm.options.num_ctx, AI_NUM_CTX,
       'warm-up: it loads the model with the same context translation will ask for, so the first line does not pay for a reload');
    ok(warm && warm.keep_alive, 'warm-up: and keeps it resident');
}

{
    generateReply = '1. Hello there';
    generateStats = { load_duration: 9_000_000_000, prompt_eval_duration: 40_000_000, eval_duration: 260_000_000 };
    let timing = null;
    await translateLines('x', 1, undefined, { onTiming: measured => { timing = measured; } });
    ok(timing && timing.reported, 'timing: the server durations are read when the server reports them');
    eq(timing && timing.generateMs, 300,
       'timing: a line costs what the model spent reading and writing it, not the nine seconds spent loading the model');
    ok(timing && timing.reloaded, 'timing: and the model load is recognised as a load');
    generateStats = {};
}

{
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn, ms, ...args) => realSetTimeout(fn, ms >= 15000 ? 20 : ms, ...args);
    generateHangs = true;
    try {
        let caught = null;
        try { await translateLines('a slow batch', 12); } catch (err) { caught = err; }
        eq(caught && caught.name, 'TranslationTimeout',
           'timeout: a translation that runs out of time says so, instead of looking like the user cancelling');
        ok(caught && caught.timeoutMs >= 12 * 3000,
           'timeout: and a twelve-line batch was given time in proportion to its size');

        const user = new AbortController();
        user.abort();
        let cancelled = null;
        try { await translateLines('a cancelled batch', 1, user.signal); } catch (err) { cancelled = err; }
        eq(cancelled && cancelled.name, 'AbortError', 'timeout: while a real cancel is still a cancel');
    } finally {
        generateHangs = false;
        globalThis.setTimeout = realSetTimeout;
    }
}

{
    const loaded = await loadedModels();
    eq(loaded.length, 1, 'loaded: the server answers with what it has resident');
    eq(loaded[0].gpuPercent, 50, 'loaded: reported as a share of the model that is in video memory');
    ok(loaded[0].onCpu, 'loaded: so a model spilled onto the CPU is visible without a shell on the server');
}

console.log(`\n${'─'.repeat(60)}`);
if (failed === 0) {
    console.log(`✓ all ${passed} assertions passed`);
    emitTestResult('translate-request', 'pass', { assertions: passed });
    process.exit(0);
} else {
    console.log(`${passed} passed, ${failed} FAILED:\n`);
    console.log(fails.join('\n'));
    emitTestResult('translate-request', 'fail', { assertions: passed });
    process.exit(1);
}
