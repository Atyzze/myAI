// Runs the real browser modules under node: the database is the in-memory IndexedDB of
// tests/fixtures/memory-idb.mjs, and the page around them is a small fake that records what the
// app asked the user and what it downloaded. Import this before any module under src/js.
import { register } from 'node:module';
import { resolveObjectURL } from 'node:buffer';

register(new URL('./app-module-hooks.mjs', import.meta.url).href);

class MemoryStorage {
    #values = new Map();
    get length() { return this.#values.size; }
    key(i) { return [...this.#values.keys()][i] ?? null; }
    getItem(key) { return this.#values.has(String(key)) ? this.#values.get(String(key)) : null; }
    setItem(key, value) { this.#values.set(String(key), String(value)); }
    removeItem(key) { this.#values.delete(String(key)); }
    clear() { this.#values.clear(); }
}

export const page = {
    dialogs: [],
    answers: [],
    downloads: [],
    answer(...replies) { this.answers.push(...replies); },
    asked(kind) { return this.dialogs.filter(dialog => !kind || dialog.kind === kind); },
    reset() { this.dialogs = []; this.answers = []; this.downloads = []; }
};

function nextAnswer(kind, fallback) {
    if (!page.answers.length) return fallback;
    const reply = page.answers.shift();
    return typeof reply === 'function' ? reply(kind) : reply;
}

function fakeElement(tag = 'div', id = '') {
    const attributes = new Map();
    const classes = new Set();
    const found = new Map();
    const element = {
        tagName: String(tag).toUpperCase(), id, textContent: '', innerHTML: '', value: '', checked: false,
        disabled: false, hidden: false, href: '', download: '', title: '', dataset: {}, style: { setProperty() {} },
        children: [], options: [], parentNode: null, isConnected: true,
        classList: {
            add: (...names) => names.forEach(name => classes.add(name)),
            remove: (...names) => names.forEach(name => classes.delete(name)),
            toggle: (name, on) => { const want = on === undefined ? !classes.has(name) : !!on; if (want) classes.add(name); else classes.delete(name); return want; },
            contains: name => classes.has(name)
        },
        setAttribute(name, value) { attributes.set(name, String(value)); },
        getAttribute(name) { return attributes.has(name) ? attributes.get(name) : null; },
        removeAttribute(name) { attributes.delete(name); },
        hasAttribute(name) { return attributes.has(name); },
        appendChild(child) { this.children.push(child); if (child) child.parentNode = this; return child; },
        append(...nodes) { nodes.forEach(node => this.appendChild(node)); },
        prepend(...nodes) { this.children.unshift(...nodes); },
        insertBefore(child) { this.children.unshift(child); return child; },
        removeChild(child) { this.children = this.children.filter(node => node !== child); return child; },
        replaceChildren(...nodes) { this.children = [...nodes]; },
        replaceWith() {},
        remove() {},
        querySelector(selector) {
            if (!found.has(selector)) found.set(selector, fakeElement('div'));
            return found.get(selector);
        },
        querySelectorAll() { return []; },
        closest() { return null; },
        contains() { return false; },
        addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
        focus() {}, blur() {}, scrollIntoView() {}, scrollTo() {},
        getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0, right: 0, bottom: 0 }; },
        getContext() { return null; },
        click() {
            if (this.tagName === 'A' && this.href) {
                const blob = String(this.href).startsWith('blob:') ? resolveObjectURL(this.href) : null;
                page.downloads.push({ name: this.download, href: this.href, blob });
            }
        }
    };
    return element;
}

const elements = new Map();
const documentListeners = new Map();
globalThis.document = {
    body: fakeElement('body'),
    documentElement: fakeElement('html'),
    activeElement: null,
    visibilityState: 'visible',
    hidden: false,
    baseURI: 'http://localhost/',
    getElementById(id) {
        if (!elements.has(id)) elements.set(id, fakeElement('div', id));
        return elements.get(id);
    },
    createElement: tag => fakeElement(tag),
    createDocumentFragment: () => fakeElement('#fragment'),
    createTextNode: text => ({ nodeType: 3, textContent: String(text) }),
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener(type, fn) { documentListeners.set(type, [...(documentListeners.get(type) || []), fn]); },
    removeEventListener() {},
    dispatchEvent() { return true; }
};

for (const name of ['localStorage', 'sessionStorage']) {
    Object.defineProperty(globalThis, name, { value: new MemoryStorage(), configurable: true, writable: true });
}
// One tab's Web Locks: a lock asked for with ifAvailable is refused while it is held, and is
// held until the callback's promise settles, as in the browser.
const heldLocks = new Set();
const locks = {
    async request(name, options, callback) {
        const run = typeof options === 'function' ? options : callback;
        const opts = typeof options === 'function' ? {} : (options || {});
        if (heldLocks.has(name)) {
            if (opts.ifAvailable) return run(null);
            while (heldLocks.has(name)) await new Promise(resolve => setTimeout(resolve, 1));
        }
        heldLocks.add(name);
        try { return await run({ name, mode: opts.mode || 'exclusive' }); }
        finally { heldLocks.delete(name); }
    }
};

Object.defineProperty(globalThis, 'navigator', {
    value: {
        locks,
        onLine: true,
        userAgent: 'node',
        clipboard: { writeText: async () => {}, readText: async () => '' },
        storage: { estimate: async () => ({ quota: 8 * 1024 ** 3, usage: 0 }), persisted: async () => true, persist: async () => true }
    },
    configurable: true, writable: true
});

globalThis.window = globalThis;
globalThis.location = { href: 'http://localhost/', origin: 'http://localhost', reload() {} };
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.dispatchEvent = () => true;
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
globalThis.scrollTo = () => {};
globalThis.open = () => null;
globalThis.innerWidth = 1280;
globalThis.innerHeight = 800;
globalThis.devicePixelRatio = 1;
globalThis.requestAnimationFrame = fn => setTimeout(() => fn(Date.now()), 16);
globalThis.cancelAnimationFrame = id => clearTimeout(id);
globalThis.CSS = globalThis.CSS || { escape: value => String(value) };
if (typeof globalThis.CustomEvent === 'undefined') {
    globalThis.CustomEvent = class CustomEvent extends Event {
        constructor(type, init = {}) { super(type); this.detail = init.detail; }
    };
}
globalThis.alert = message => { page.dialogs.push({ kind: 'alert', message: String(message) }); };
globalThis.confirm = message => {
    page.dialogs.push({ kind: 'confirm', message: String(message) });
    return !!nextAnswer('confirm', true);
};
globalThis.prompt = (message, value = '') => {
    page.dialogs.push({ kind: 'prompt', message: String(message) });
    return nextAnswer('prompt', value);
};

localStorage.setItem('server-processing-consent-v1', '1');

export async function settle(rounds = 20) {
    for (let i = 0; i < rounds; i++) await new Promise(resolve => setTimeout(resolve, 0));
}

export const { memoryIdb } = await import('../fixtures/memory-idb.mjs');
