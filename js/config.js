/* ==========================================================================
   config.js — Constants, formatting helpers, settings access, escaping utils
   ========================================================================== */

export const CONFIG = {
    DB_NAME:                'voice-notes-db',
    STORE_REC:              'recordings',
    STORE_WAV:              'wav_4s_chunks',
    PAGE_SIZE:              6,
    IO_FLUSH_SEC:           4,
    GUI_UPDATE_MS:          250,
    TRANSCRIBE_CONCURRENCY: 4,   // max REMOTE chunks in parallel. Local is forced to 1
                                 // (one shared Whisper instance can't run concurrently).
    // Fixed reverse-proxy paths for the cloud endpoints. These used to be
    // editable settings, but they're deployment constants (front the real
    // Whisper/Ollama servers behind these paths), so hardcoding them here means
    // they can never be left blank — the model list and cloud transcription
    // just work out of the box. Change them here if your proxy uses other paths.
    OLLAMA_URL:             '/ollama',
    TRANSCRIBE_URL:         '/transcribe'
};

/* ── Settings: single source of truth for keys + defaults (DRY) ── */
export const SETTINGS_DEFAULTS = {
    'set-auto-transcribe': 'none',
    'set-auto-reply':      'none',
    'set-compact-mode':    'on',
    'set-ai-instructions': '',
    'set-transcribe-lang': 'auto',     // 'auto' = let Whisper detect the language
    'set-ollama-model':    'llama3.2'  // fallback only; real list comes from /api/tags
};

/* Return the saved value, or the default when nothing is saved OR a blank value
   was stored. The blank-→default fallback matters because an empty string is
   not a meaningful setting for any key here (the only key whose default is ''
   is the free-text AI-instructions box, where '' is already the default), and
   it self-heals any value a stray persistence write may have blanked out. */
export function getSetting(key) {
    const v = localStorage.getItem(key);
    if (v === null || v.trim() === '') return SETTINGS_DEFAULTS[key] ?? '';
    return v;
}

/* ── Collision-resistant monotonic IDs (Date.now() alone collides within 1 ms) ──
   uid() = ms-since-epoch * 1000 + a per-ms counter (0–999), giving up to 1000
   non-colliding ids per millisecond while staying sortable by creation time.
   Recording rows themselves use IndexedDB autoIncrement integer keys (small,
   1,2,3,…); uid() is for the SUB-items inside a row (transcripts, summaries),
   so the two id spaces never mix or need to be reconciled. All lookups compare
   with == so a legacy numeric id and a stringified one still match. */
let _uidCounter = 0;
export function uid() {
    return Date.now() * 1000 + (_uidCounter++ % 1000);
}

/* ── Escaping helpers (used everywhere we interpolate into innerHTML / attrs) ── */
export function escapeHtml(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}
export function escapeAttr(s) {
    return escapeHtml(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/* Escape a value that lands inside a SINGLE-quoted JS string which itself sits
   inside a DOUBLE-quoted HTML attribute — the inline onclick="f('…')" pattern.
   We first make it a safe JS string literal (backslash, ' , CR, LF) and then
   HTML-attribute-escape the result, so neither the JS string nor the HTML
   attribute can be broken out of. (The old version escaped ' but not " / < / >
   / & — a real attribute-injection hole if any controlled text reached it.) */
function jsStringEscape(s) {
    return String(s ?? '')
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "\\'")
        .replace(/\r/g, '')
        .replace(/\n/g, '\\n');
}
export function escapeJs(s) {
    return escapeAttr(jsStringEscape(s));
}

/* ── Formatting ── */
export const pad = n => String(n).padStart(2, '0');

export function fmtDur(ms) {
    const s   = Math.floor(ms / 1000);
    const h   = Math.floor(s / 3600);
    const m   = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return h ? `${pad(h)}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

/* Binary byte formatter for storage totals (1 decimal, KB…TB). */
export function fmtBytes(b) {
    if (b < 1024) return b + ' B';
    const u = ['KB', 'MB', 'GB', 'TB'];
    let i = 0, n = b / 1024;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return n.toFixed(1) + ' ' + u[i];
}

/* Byte formatter for small text-length labels. Kept separate from fmtBytes on
   purpose: higher precision in the MB range, and a B/KB cutoff tuned for the
   short transcript/summary previews where these are shown. */
export function fmtSize(bytes) {
    if (bytes < 1024)       return bytes + ' B';
    if (bytes < 100 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1024 / 1024).toFixed(2) + ' MB';
}

export function getLocalIso(timestamp = Date.now()) {
    const d = new Date(timestamp);
    return new Date(d.getTime() - (d.getTimezoneOffset() * 60000))
        .toISOString().slice(0, 19).replace('T', ' ');
}
