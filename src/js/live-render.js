import { seamTrim } from './dedup.js';

const TAIL_WORDS = 40;
const TIMESTAMP_PREFIX = /^(\[[\d:]+\s*[\u2013-]\s*[\d:]+\])\s+/;

const AUTOSCROLL_SLACK_PX = 80;

function fmtTime(sec) {
    const s = Math.max(0, Math.floor(Number(sec) || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = s % 60;
    const pad = n => String(n).padStart(2, '0');
    return h ? `${pad(h)}:${pad(m)}:${pad(ss)}` : `${pad(m)}:${pad(ss)}`;
}

function setText(el, value) {
    if (el) el.textContent = value;
}

function stickToBottom(el, wasAtBottom) {
    if (!el || !wasAtBottom) return;
    el.scrollTop = el.scrollHeight;
}

function atBottom(el) {
    if (!el) return false;
    return (el.scrollHeight - el.scrollTop - el.clientHeight) < AUTOSCROLL_SLACK_PX;
}

const FRAME_FALLBACK_TIMER_MS = 100;

function oncePerFrameScheduler(frame) {
    if (typeof frame === 'function') return frame;
    const runImmediately = fn => fn();
    if (typeof requestAnimationFrame !== 'function') return runImmediately;
    return fn => {
        let done = false;
        const runOnce = () => { if (done) return; done = true; fn(); };
        requestAnimationFrame(runOnce);
        setTimeout(runOnce, FRAME_FALLBACK_TIMER_MS);
    };
}

function tailAfter(tail, added) {
    const words = (tail + ' ' + added).trim().split(/\s+/).filter(Boolean);
    return words.slice(-TAIL_WORDS).join(' ');
}

export function createLiveLogRenderer({ transcriptEl, statusEl, footerEl, frame = null }) {
    const chunks = new Map();
    const views = new Map();
    let order = [];
    const schedule = oncePerFrameScheduler(frame);
    let stickPending = false;
    let follow = false;

    const doc = () => transcriptEl.ownerDocument || document;

    function block(tsPart, textPart) {
        const node = doc().createElement('div');
        node.className = 'chunk-block';
        if (tsPart) {
            const ts = doc().createElement('span');
            ts.className = 'ts';
            ts.textContent = tsPart;
            node.appendChild(ts);
            node.appendChild(doc().createTextNode(' '));
        }
        node.appendChild(doc().createTextNode(textPart));
        return node;
    }

    function renderChunk(chunk, tailBefore, first) {
        const nodes = [];
        if (!first) {
            const sep = doc().createElement('div');
            sep.className = 'chunk-sep';
            nodes.push(sep);
        }
        let tail = tailBefore;
        const text = chunk.text || '';
        if (chunk.hasSeg) {
            for (const line of text.split('\n')) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                const stamp = TIMESTAMP_PREFIX.exec(trimmed);
                const tsPart   = stamp ? stamp[1] : '';
                const textPart = stamp ? trimmed.slice(stamp[0].length) : trimmed;
                if (!textPart) continue;
                const kept = (chunk.final || !tail) ? textPart : seamTrim(tail, textPart);
                if (!kept.trim()) continue;
                tail = tailAfter(tail, kept);
                nodes.push(block(tsPart, kept));
            }
        } else {
            const kept = tail ? seamTrim(tail, text) : text;
            if (kept.trim()) {
                tail = tailAfter(tail, kept);
                nodes.push(block(`[${fmtTime(chunk.startSec)} – ${fmtTime(chunk.endSec)}]`, kept));
            }
        }
        return { nodes, tail };
    }

    const detach = node => {
        if (typeof node.remove === 'function') node.remove();
        else if (node.parentNode && typeof node.parentNode.removeChild === 'function') node.parentNode.removeChild(node);
    };
    const insert = (node, anchor) => (anchor ? transcriptEl.insertBefore(node, anchor) : transcriptEl.appendChild(node));

    function firstNodeFrom(position) {
        for (let i = position; i < order.length; i++) {
            const view = views.get(order[i]);
            if (view && view.nodes.length) return view.nodes[0];
        }
        return null;
    }

    function place(key) {
        const chunk = chunks.get(key);
        const at = order.findIndex(other => {
            const c = chunks.get(other);
            return c.startSec > chunk.startSec || (c.startSec === chunk.startSec && other > key);
        });
        if (at < 0) order.push(key); else order.splice(at, 0, key);
    }

    function rerenderFrom(position) {
        for (let i = position; i < order.length; i++) {
            const key = order[i];
            const before = i > 0 ? views.get(order[i - 1]).tail : '';
            const old = views.get(key);
            const next = renderChunk(chunks.get(key), before, i === 0);
            const anchor = firstNodeFrom(i + 1);
            if (old) for (const node of old.nodes) detach(node);
            for (const node of next.nodes) insert(node, anchor);
            views.set(key, next);
            const laterChunksUnaffected = i > position && old && old.tail === next.tail;
            if (laterChunksUnaffected) break;
        }
    }

    function rerenderAll() {
        for (const view of views.values()) for (const node of view.nodes) detach(node);
        views.clear();
        rerenderFrom(0);
    }

    function stickSoon() {
        if (stickPending) return;
        stickPending = true;
        follow = atBottom(transcriptEl);
        schedule(() => {
            stickPending = false;
            stickToBottom(transcriptEl, follow);
        });
    }

    function clear() {
        chunks.clear();
        views.clear();
        order = [];
        transcriptEl.textContent = '';
    }

    return {
        handle(msg) {
            if (msg.type === 'meta') {
                const line = String(msg.line ?? '');
                setText(footerEl, line);
                if (line.includes('✅') && line.includes('Done')) setText(statusEl, '✅ Complete');
            } else if (msg.type === 'text') {
                const key = Number(msg.chunkIndex);
                const known = chunks.has(key);
                const previous = known ? chunks.get(key) : null;
                const chunk = {
                    startSec: msg.startSec ?? (key * 60),
                    endSec:   msg.endSec   ?? (key * 60 + 60),
                    text:     msg.text,
                    hasSeg:   !!msg.hasSeg,
                    final:    !!msg.final
                };
                stickSoon();
                chunks.set(key, chunk);
                if (known && previous.startSec !== chunk.startSec) {
                    order = order.filter(other => other !== key);
                    place(key);
                    rerenderAll();
                } else {
                    if (!known) place(key);
                    rerenderFrom(order.indexOf(key));
                }
                setText(statusEl, `${chunks.size} chunk(s) received - assembling timeline...`);
            } else if (msg.type === 'reset') {
                clear();
                setText(statusEl, '⏳ Processing...');
                setText(footerEl, 'Restarted...');
            }
        }
    };
}

const REPLY_TEXT_NODE_MAX_CHARS = 4096;

export function createReplyRenderer({ replyEl, textEl, cursorEl, statusEl, footerEl, frame = null }) {
    let charCount = 0;
    let tokenCount = 0;
    let elapsedMs = 0;
    let model = '';
    let gatheredTokens = '';
    let writeScheduled = false;
    let generation = 0;
    const schedule = oncePerFrameScheduler(frame);

    const rate = () => {
        if (tokenCount < 2 || elapsedMs <= 0) return null;
        return (tokenCount / (elapsedMs / 1000));
    };

    const progressLine = () => {
        const parts = [`${charCount} chars`];
        if (tokenCount) parts.push(`${tokenCount} tok`);
        const perSecond = rate();
        if (perSecond !== null) parts.push(`${perSecond.toFixed(1)} tok/s`);
        return parts.join(' · ');
    };

    const generatingLabel = () => (model ? `⏳ Generating - ${model}` : '⏳ Generating...');
    const streamingLabel  = () => (model ? `⚡ Streaming - ${model}`  : '⚡ Streaming...');
    const completeLabel   = () => {
        const base = `✅ Complete - ${charCount} chars`;
        return model ? `${base} - ${model}` : base;
    };

    function appendToGrowingTextNode(text) {
        const last = textEl.lastChild;
        if (last && last.nodeType === 3 && typeof last.appendData === 'function' && last.length < REPLY_TEXT_NODE_MAX_CHARS) {
            last.appendData(text);
        } else {
            textEl.appendChild((textEl.ownerDocument || document).createTextNode(text));
        }
    }

    function writeGatheredTokens() {
        writeScheduled = false;
        if (!gatheredTokens) return;
        const follow = atBottom(replyEl);
        appendToGrowingTextNode(gatheredTokens);
        gatheredTokens = '';
        setText(footerEl, progressLine());
        stickToBottom(replyEl, follow);
    }

    function writeGatheredTokensOnNextFrame() {
        if (writeScheduled) return;
        writeScheduled = true;
        const scheduledFor = generation;
        schedule(() => { if (scheduledFor === generation) writeGatheredTokens(); });
    }

    return {
        handle(msg) {
            if (msg.type === 'token') {
                const token = String(msg.token ?? '');
                const wasEmpty = charCount === 0;
                gatheredTokens += token;
                charCount += token.length;
                if (wasEmpty && token.length) setText(statusEl, streamingLabel());
                if (Number.isFinite(msg.count))     tokenCount = msg.count;
                if (Number.isFinite(msg.elapsedMs)) elapsedMs  = msg.elapsedMs;
                writeGatheredTokensOnNextFrame();
            } else if (msg.type === 'model') {
                model = String(msg.model ?? '');
                setText(statusEl, charCount ? streamingLabel() : generatingLabel());
            } else if (msg.type === 'done') {
                writeGatheredTokens();
                if (cursorEl) cursorEl.style.display = 'none';
                setText(statusEl, completeLabel());
                setText(footerEl, progressLine());
            } else if (msg.type === 'reset') {
                generation++;
                gatheredTokens = '';
                writeScheduled = false;
                textEl.textContent = '';
                charCount = 0;
                tokenCount = 0;
                elapsedMs = 0;
                if (cursorEl) cursorEl.style.display = '';
                setText(statusEl, generatingLabel());
                setText(footerEl, 'Waiting for tokens...');
            }
        }
    };
}
