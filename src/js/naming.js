/* ==========================================================================
   naming.js - Pure, DOM-free helpers for recording titles, cross-OS-safe
               download filenames, and the storage-bar percentage.

   Kept dependency-light and side-effect-free on purpose so the whole module is
   unit-testable in plain Node (see tests/pure.test.mjs). The only import is
   fmtBytes from config.js, which is itself pure.

   WHY A SEPARATE TITLE FIELD:
   A recording's machine-readable timestamp key lives in rec.filename (other code
   recovers it with filename.split(' - ')[0] for linking and jump-to-source).
   The human-editable name lives in rec.title. displayTitle() prefers title and
   falls back to filename, so renaming a recording can never orphan a link or a
   "jump to source" match - rec.filename is never rewritten.
   ========================================================================== */
import { fmtBytes } from './config.js';

/* Characters no mainstream filesystem accepts in a name:
   Windows forbids  < > : " / \ | ? *  and control chars; macOS/Finder maps ':'
   to a separator; Linux forbids '/' and NUL. We replace the whole set with '-'
   so the same downloaded name is valid on Windows, macOS and Linux alike. */
const ILLEGAL = /[<>:"/\\|?*\u0000-\u001F]/g;

/* Windows reserved device names (case-insensitive), with or without extension.
   A file literally named e.g. "CON" or "COM1" cannot be created on Windows. */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

const MAX_LEN = 120;   // headroom under the common 255-char path-segment limit

/**
 * Make an arbitrary string safe as a filename on Windows, macOS and Linux.
 * Returns `fallback` when the input reduces to nothing usable.
 */
export function sanitizeFilename(name, fallback = 'recording') {
    let s = String(name ?? '');
    s = s.replace(ILLEGAL, '-');          // strip path separators + illegal chars
    s = s.replace(/\s+/g, ' ');           // collapse whitespace runs to one space
    s = s.replace(/-{2,}/g, '-');         // collapse hyphen runs left by replacement
    s = s.replace(/^[.\s-]+/, '')         // Windows drops leading/trailing dots &
         .replace(/[.\s-]+$/, '');        //   spaces; trim stray hyphens too
    if (s.length > MAX_LEN) {
        s = s.slice(0, MAX_LEN).replace(/[.\s-]+$/, '');
    }
    if (s === '')          return fallback;
    if (RESERVED.test(s))  return '_' + s;   // dodge reserved device names
    return s;
}

/**
 * The name shown in the list and used as the download base. Prefers the
 * user-edited rec.title; falls back to the timestamp-based rec.filename.
 */
export function displayTitle(rec) {
    const t = (rec && typeof rec.title === 'string') ? rec.title.trim() : '';
    return t || (rec && rec.filename) || 'Recording';
}

/**
 * Build the default download filename: the (sanitized) display title, plus the
 * exact file size, plus the extension. e.g.
 *   "2026-07-03 13-31-00 - 05-23 - 12.0 MB.wav"
 * Reads the byte size from rec.blob.size (falls back to rec.size for tests).
 */
export function buildDownloadName(rec, ext = 'wav') {
    const base = sanitizeFilename(displayTitle(rec));
    const size = (rec && rec.blob && rec.blob.size) || (rec && rec.size) || 0;
    const sizePart = size ? ' - ' + fmtBytes(size).replace(ILLEGAL, '-') : '';
    const cleanExt = String(ext || '').replace(/[^a-z0-9]+/gi, '').toLowerCase();
    return base + sizePart + (cleanExt ? '.' + cleanExt : '');
}

/**
 * Fraction (0-100) that `size` represents of `total`, clamped. Used for the
 * per-recording storage bar so bars are comparable across the whole app.
 */
export function storagePct(size, total) {
    size  = Number(size)  || 0;
    total = Number(total) || 0;
    if (total <= 0 || size <= 0) return 0;
    return Math.max(0, Math.min(100, (size / total) * 100));
}

/** UTF-8 byte length of a string (what actually gets fed to / stored for the AI). */
export function byteLength(str) {
    if (str == null) return 0;
    try { return new TextEncoder().encode(String(str)).length; }
    catch { return String(str).length; }
}

/**
 * Summarize a recording's context chain into the two numbers shown on the
 * collapsed row: how many parts were fed to the AI (each non-empty input and
 * each non-empty output counts as one - so a fresh "continue" is 2, dropping to
 * 1 if a side was cut/skipped) and the exact total bytes of that context.
 * Mirrors how buildContextItemHtml decides a part is present.
 */
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
