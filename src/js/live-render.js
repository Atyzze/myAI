/* ==========================================================================
 *  live-render.js - Rendering for the live transcript log and the reply token
 *                   stream, independent of WHERE it is rendered.
 *
 *  WHY THIS FILE EXISTS
 *  The renderers used to live inside live-view.js, the popup-only module. That
 *  made the popup the only possible live view, which is a problem on mobile:
 *  window.open() there hands the foreground to the new tab and backgrounds the
 *  opener, and the opener is the tab holding the fetch stream and posting the
 *  tokens across. The window that just took the screen is fed by a window the
 *  OS just throttled, so it renders nothing and sits on "Generating..." forever.
 *
 *  The fix is an in-page panel (live-inline.js) that subscribes to the same
 *  registry directly, with no second window and no postMessage hop. Both views
 *  must render identically, so the rendering lives here, takes its target
 *  elements as arguments, and knows nothing about popups, messages or origins.
 *
 *  Both factories return { handle(msg) }, accepting exactly the message shapes
 *  the registries in live-tabs.js emit:
 *    livelog:     { type:'meta', line } | { type:'text', chunkIndex, text,
 *                  startSec, endSec, hasSeg } | { type:'reset' }
 *    replystream: { type:'token', token } | { type:'done' } | { type:'reset' }
 *  ========================================================================== */
import { seamTrim } from './dedup.js';

const TAIL_WORDS = 40;

/* Follow the tail only when the reader is already at the tail. Scrolling up to
   re-read something must not be undone by the next token. */
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

/* ──────────────────────────────────────────────────────────────────────────
 *  Live transcript log
 *  ────────────────────────────────────────────────────────────────────────── */
export function createLiveLogRenderer({ transcriptEl, statusEl, footerEl }) {
    const chunks = {};

    function pushBlock(tsPart, textPart) {
        const block = document.createElement('div');
        block.className = 'chunk-block';
        if (tsPart) {
            const ts = document.createElement('span');
            ts.className = 'ts';
            ts.textContent = tsPart;
            block.appendChild(ts);
            block.appendChild(document.createTextNode(' '));
        }
        block.appendChild(document.createTextNode(textPart));
        transcriptEl.appendChild(block);
    }

    function rebuildTranscript() {
        const ordered = Object.values(chunks).sort((a, b) => a.startSec - b.startSec);
        transcriptEl.textContent = '';
        let tail = '';

        const updTail = added => {
            const words = (tail + ' ' + added).trim().split(/\s+/).filter(Boolean);
            tail = words.slice(-TAIL_WORDS).join(' ');
        };

        ordered.forEach((chunk, i) => {
            if (i > 0) {
                const sep = document.createElement('div');
                sep.className = 'chunk-sep';
                transcriptEl.appendChild(sep);
            }
            const text = chunk.text || '';

            // Use the explicit flag from the pipeline. The old heuristic sniffed
            // for a leading "[0…"/"[1…" and silently broke past 20 minutes, where
            // real timestamps look like [21:34] and start with neither.
            if (chunk.hasSeg) {
                for (const line of text.split('\n')) {
                    const trimmed = line.trim();
                    if (!trimmed) continue;
                    const bracketEnd = trimmed.indexOf('] ');
                    const textPart = bracketEnd >= 0 ? trimmed.substring(bracketEnd + 2) : trimmed;
                    const tsPart   = bracketEnd >= 0 ? trimmed.substring(0, bracketEnd + 1) : '';
                    if (!textPart) continue;
                    const kept = tail ? seamTrim(tail, textPart) : textPart;
                    if (!kept.trim()) continue;
                    updTail(kept);
                    pushBlock(tsPart, kept);
                }
            } else {
                const kept = tail ? seamTrim(tail, text) : text;
                if (!kept.trim()) return;
                updTail(kept);
                pushBlock(`[${fmtTime(chunk.startSec)} \u2013 ${fmtTime(chunk.endSec)}]`, kept);
            }
        });
    }

    return {
        handle(msg) {
            if (msg.type === 'meta') {
                const line = String(msg.line ?? '');
                setText(footerEl, line);
                if (line.includes('✅') && line.includes('Done')) setText(statusEl, '✅ Complete');
            } else if (msg.type === 'text') {
                chunks[msg.chunkIndex] = {
                    startSec: msg.startSec ?? (msg.chunkIndex * 60),
                    endSec:   msg.endSec   ?? (msg.chunkIndex * 60 + 60),
                    text:     msg.text,
                    hasSeg:   !!msg.hasSeg
                };
                const follow = atBottom(transcriptEl);
                rebuildTranscript();
                stickToBottom(transcriptEl, follow);
                setText(statusEl, `${Object.keys(chunks).length} chunk(s) received - assembling timeline...`);
            } else if (msg.type === 'reset') {
                for (const key of Object.keys(chunks)) delete chunks[key];
                rebuildTranscript();
                setText(statusEl, '⏳ Processing...');
                setText(footerEl, 'Restarted...');
            }
        }
    };
}

/* ──────────────────────────────────────────────────────────────────────────
 *  Reply token stream
 *  ────────────────────────────────────────────────────────────────────────── */
export function createReplyRenderer({ replyEl, textEl, cursorEl, statusEl, footerEl }) {
    let charCount = 0;
    let tokenCount = 0;
    let elapsedMs = 0;
    let model = '';

    /* Counters, not clocks: the numbers arrive with the tokens because only the
       registry sees every one of them (a view opened late is handed the whole
       buffer as a single message). The rate is omitted rather than shown as an
       absurd figure until there is a measurable interval to divide by. */
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

    // The model name replaces the trailing ellipsis rather than following it:
    // "Generating - gemma4:e4b" reads better than "Generating... - gemma4:e4b".
    const generatingLabel = () => (model ? `⏳ Generating - ${model}` : '⏳ Generating...');
    const streamingLabel  = () => (model ? `⚡ Streaming - ${model}`  : '⚡ Streaming...');
    const completeLabel   = () => {
        const base = `✅ Complete - ${charCount} chars`;
        return model ? `${base} - ${model}` : base;
    };

    return {
        handle(msg) {
            if (msg.type === 'token') {
                const token = String(msg.token ?? '');
                const follow = atBottom(replyEl);
                textEl.textContent += token;
                charCount += token.length;
                if (Number.isFinite(msg.count))     tokenCount = msg.count;
                if (Number.isFinite(msg.elapsedMs)) elapsedMs  = msg.elapsedMs;
                setText(footerEl, progressLine());
                stickToBottom(replyEl, follow);
            } else if (msg.type === 'model') {
                model = String(msg.model ?? '');
                setText(statusEl, charCount ? streamingLabel() : generatingLabel());
            } else if (msg.type === 'done') {
                if (cursorEl) cursorEl.style.display = 'none';
                setText(statusEl, completeLabel());
                setText(footerEl, progressLine());
            } else if (msg.type === 'reset') {
                // The same recording started a NEW reply while this view was open.
                // Clear the old answer instead of appending the new one to it.
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
