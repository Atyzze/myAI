// Small DOM helpers: building elements, the panels (overlays), questions with a few answers, and
// the toasts at the bottom of the screen.

export function h(tag, props = null, ...children) {
    const el = document.createElement(tag);
    if (props) {
        for (const [key, value] of Object.entries(props)) {
            if (value == null || value === false) continue;
            if (key === 'class') el.className = value;
            else if (key === 'style' && typeof value === 'object') {
                for (const [name, v] of Object.entries(value)) {
                    if (v == null) continue;
                    if (name.startsWith('--')) el.style.setProperty(name, String(v));
                    else el.style[name] = v;
                }
            } else if (key === 'dataset') Object.assign(el.dataset, value);
            else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
            else if (key === 'text') el.textContent = value;
            else if (['value', 'checked', 'disabled', 'selected', 'hidden', 'open', 'indeterminate'].includes(key)) el[key] = value;
            else el.setAttribute(key, value === true ? '' : String(value));
        }
    }
    append(el, children);
    return el;
}

export function append(el, children) {
    for (const child of children.flat(Infinity)) {
        if (child == null || child === false) continue;
        el.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return el;
}

export function clear(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
    return el;
}

export const byId = id => document.getElementById(id);

// ---- panels ------------------------------------------------------------------------------------------------

const openStack = [];

export function isOpen(id) {
    return openStack.some(entry => entry.id === id);
}

export function anyOpen() {
    return openStack.length > 0;
}

// Opens a panel. `onRequestClose` may answer false to keep it open (an editor with unsaved changes).
export function openOverlay(id, { onClose = null, onRequestClose = null } = {}) {
    const overlay = byId(id);
    if (!overlay) return;
    if (!isOpen(id)) openStack.push({ id, onClose, onRequestClose, returnFocus: document.activeElement });
    else Object.assign(openStack.find(e => e.id === id), { onClose, onRequestClose });
    overlay.classList.add('open');
    overlay.setAttribute('aria-hidden', 'false');
    const panel = overlay.querySelector('.panel');
    requestAnimationFrame(() => { try { panel && panel.focus({ preventScroll: true }); } catch (_) {} });
}

export function closeOverlay(id, { force = false } = {}) {
    const at = openStack.findIndex(entry => entry.id === id);
    if (at < 0) return true;
    const entry = openStack[at];
    if (!force && entry.onRequestClose && entry.onRequestClose() === false) return false;
    openStack.splice(at, 1);
    const overlay = byId(id);
    if (overlay) {
        overlay.classList.remove('open');
        overlay.setAttribute('aria-hidden', 'true');
    }
    try { entry.onClose && entry.onClose(); } catch (_) {}
    try { if (entry.returnFocus && document.contains(entry.returnFocus)) entry.returnFocus.focus({ preventScroll: true }); } catch (_) {}
    return true;
}

export function closeTopOverlay() {
    const top = openStack[openStack.length - 1];
    return top ? closeOverlay(top.id) : false;
}

export function installOverlayHandlers() {
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && openStack.length) {
            event.preventDefault();
            closeTopOverlay();
        }
    });
    for (const overlay of document.querySelectorAll('.overlay')) {
        // A tap on the dark area around a panel closes it; one that started inside (a text selection
        // dragged out) does not.
        let downOnBackdrop = false;
        overlay.addEventListener('pointerdown', event => { downOnBackdrop = event.target === overlay; });
        overlay.addEventListener('click', event => {
            if (event.target === overlay && downOnBackdrop) closeOverlay(overlay.id);
            downOnBackdrop = false;
        });
    }
    document.addEventListener('click', event => {
        const button = event.target.closest && event.target.closest('[data-close]');
        if (button) closeOverlay(button.dataset.close);
    });
}

// ---- a question with a few answers (in the scope panel) -----------------------------------------------------

let pendingChoice = null;

// Resolves with the value of the answer picked, or null when the panel is closed without one.
export function askChoice({ title, text = '', note = '', choices }) {
    if (pendingChoice) pendingChoice(null);
    const panel = byId('scopePanel');
    clear(panel);
    return new Promise(resolve => {
        let settled = false;
        const settle = value => {
            if (settled) return;
            settled = true;
            pendingChoice = null;
            closeOverlay('scopeOverlay', { force: true });
            resolve(value);
        };
        pendingChoice = settle;
        append(panel, [
            h('div', { class: 'panel-head' }, h('h2', { id: 'sc-title' }, title),
              h('button', { class: 'close-btn', type: 'button', onclick: () => settle(null) }, '✕')),
            text ? h('p', { class: 'hint', style: { fontSize: '13px', color: '#bbb' } }, text) : null,
            note ? h('div', { class: 'warn-box' }, note) : null,
            h('div', { class: 'btn-row', style: { flexDirection: 'column' } },
              choices.map(choice => h('button', {
                  class: `btn ${choice.kind || ''}`, type: 'button', 'data-choice': choice.value,
                  onclick: () => settle(choice.value)
              }, choice.label)))
        ]);
        openOverlay('scopeOverlay', { onClose: () => settle(null) });
    });
}

// ---- toasts ---------------------------------------------------------------------------------------------------

export function toast(message, { actions = [], kind = '', timeoutMs = 5000, key = null } = {}) {
    const host = byId('toasts');
    if (!host) return null;
    if (key) for (const old of host.querySelectorAll(`[data-key="${CSS.escape(key)}"]`)) old.remove();
    const el = h('div', { class: `toast ${kind}`, role: kind === 'reminder' ? 'alert' : 'status', dataset: key ? { key } : {} });
    const body = h('div', { style: { flex: '1', minWidth: '0' } });
    if (typeof message === 'string') body.textContent = message;
    else append(body, [message]);
    el.append(body);
    let timer = null;
    const dismiss = () => { clearTimeout(timer); el.remove(); };
    for (const action of actions) {
        el.append(h('button', { type: 'button', onclick: () => { dismiss(); action.run && action.run(); } }, action.label));
    }
    el.append(h('button', { type: 'button', 'aria-label': 'Dismiss', onclick: dismiss }, '✕'));
    host.append(el);
    while (host.children.length > 4) host.firstElementChild.remove();
    if (timeoutMs) timer = setTimeout(dismiss, timeoutMs);
    return { el, dismiss };
}

// ---- downloads -----------------------------------------------------------------------------------------------

export function downloadText(filename, text, type = 'text/calendar') {
    const blob = new Blob([text], { type: `${type};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: filename, style: { display: 'none' } });
    document.body.append(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 2000);
}

export async function copyText(text) {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch (_) {
        const area = h('textarea', { style: { position: 'fixed', opacity: '0' } });
        area.value = text;
        document.body.append(area);
        area.select();
        let ok = false;
        try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
        area.remove();
        return ok;
    }
}
