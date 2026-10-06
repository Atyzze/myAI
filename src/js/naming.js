import { fmtBytes } from './config.js';

const ILLEGAL = /[<>:"/\\|?*\u0000-\u001F\u202A-\u202E\u2066-\u2069]/g;

const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

const MAX_LEN = 120;

export function sanitizeFilename(name, fallback = 'recording') {
    let s = String(name ?? '');
    s = s.replace(ILLEGAL, '-');
    s = s.replace(/\s+/g, ' ');
    s = s.replace(/-{2,}/g, '-');
    s = s.replace(/^[.\s-]+/, '')
         .replace(/[.\s-]+$/, '');
    if (s.length > MAX_LEN) {
        s = s.slice(0, MAX_LEN).replace(/[.\s-]+$/, '');
    }
    if (s === '')          return fallback;
    if (RESERVED.test(s.split('.')[0])) return '_' + s;
    return s;
}

export function displayTitle(rec) {
    const t = (rec && typeof rec.title === 'string') ? rec.title.trim() : '';
    return t || (rec && rec.filename) || 'Recording';
}

export function buildDownloadName(rec, ext = 'wav') {
    const base = sanitizeFilename(displayTitle(rec));
    const size = (rec && Number(rec.audioBytes)) || (rec && rec.size) || 0;
    const sizePart = size ? ' - ' + fmtBytes(size).replace(ILLEGAL, '-') : '';
    const cleanExt = String(ext || '').replace(/[^a-z0-9]+/gi, '').toLowerCase();
    return base + sizePart + (cleanExt ? '.' + cleanExt : '');
}

export function storagePct(size, total) {
    size  = Number(size)  || 0;
    total = Number(total) || 0;
    if (total <= 0 || size <= 0) return 0;
    return Math.max(0, Math.min(100, (size / total) * 100));
}

export function byteLength(str) {
    if (str == null) return 0;
    try { return new TextEncoder().encode(String(str)).length; }
    catch { return String(str).length; }
}

export function contextStats(chain) {
    let parts = 0, bytes = 0;
    if (Array.isArray(chain)) {
        for (const c of chain) {
            if (!c) continue;
            const inp = c.inputText || (c.text && !c.inputText && !c.outputText ? c.text : '') || '';
            const out = c.outputText || '';
            if (String(inp).trim()) { parts++; bytes += byteLength(inp); }
            if (String(out).trim()) { parts++; bytes += byteLength(out); }
        }
    }
    return { parts, bytes };
}
