/* ==========================================================================
   config.js - Constants, formatting helpers, settings access, escaping utils
   ========================================================================== */

export const CONFIG = {
    DB_NAME:                'voice-notes-db',
    STORE_REC:              'recordings',
    STORE_WAV:              'audio_fragments_v2',
    LEGACY_STORE_WAV:       'wav_4s_chunks',
    PAGE_SIZE:              6,
    IO_FLUSH_SEC:           4,
    GUI_UPDATE_MS:          250,
    RECORDING_HEARTBEAT_MS: 3000,
    RECORDING_STALE_MS:     15000,
    OPUS_CONVERT_MAX_MS:  10 * 60 * 1000,
    REMOTE_FIRST_BYTE_TIMEOUT_MS: 45000,
    REMOTE_IDLE_TIMEOUT_MS: 60000,
    TRANSCRIBE_CONCURRENCY: 10,  // server chunk requests kept in flight

    // Fixed same-origin reverse-proxy paths. Change these only when the proxy
    // exposes the self-hosted services under different routes.
    OLLAMA_URL:             '/ollama',
    TRANSCRIBE_URL:         '/transcribe'
};

/* Default reply instructions.

   A default, not a policy: the Settings textarea is prefilled with this and can
   be replaced entirely. Emptying the box restores it, because getSetting()
   treats a blank stored value as unset.

   It exists because instruction-tuned models reach for Markdown and LaTeX
   unprompted, while this client renders replies as plain text - so an answer
   about frying onions arrives reading `$\approx 275^{\circ}F$`. Light layout
   survives plain-text rendering; heavy syntax does not, so the wording asks for
   the former and rules out the latter. */
export const DEFAULT_AI_INSTRUCTIONS =
      'Reply in plain text. Use ordinary Unicode characters for symbols and units '
    + '(°C, ≈, →, ×), never LaTeX or $...$ math notation. Light structure is welcome: '
    + 'short paragraphs, blank lines between them, and simple "- " bullet lists. '
    + 'Avoid Markdown syntax such as #, **, ``` and tables.';

/* ── Settings: single source of truth for keys + defaults (DRY) ── */
export const SETTINGS_DEFAULTS = {
    'set-auto-transcribe':  'off',
    'set-auto-reply':       'off',
    'set-compact-mode':     'on',
    'set-ai-instructions':  DEFAULT_AI_INSTRUCTIONS,
    'set-transcribe-lang':  'auto',     // 'auto' lets the server detect the language
    'set-ollama-model':     'gemma4:e4b', // soft default; reconciled against /api/tags on first use
    'set-recording-format': 'wav',      // 'wav' (seekable, default) or 'opus' (smaller)
    'set-remote-backups':   'off'       // retain uploaded chunks/results on the transcription server
};

/* v23 stored mode names in the auto settings. Remote becomes On. A previous
   on-device selection becomes Off so an upgrade never starts uploading data
   that the user had explicitly kept local. */
function normalizeLegacySetting(key, value) {
    if (key !== 'set-auto-transcribe' && key !== 'set-auto-reply') return value;
    if (value === 'remote' || value === 'on') return 'on';
    if (value === 'local' || value === 'none' || value === 'off') return 'off';
    return SETTINGS_DEFAULTS[key];
}

export function getSetting(key) {
    const value = localStorage.getItem(key);
    if (value === null || value.trim() === '') return SETTINGS_DEFAULTS[key] ?? '';
    return normalizeLegacySetting(key, value);
}

/* The application is server-only, but data transfer still deserves one explicit
   first-use acknowledgement. One decision covers both transcription and reply
   processing and is reset when site data is cleared. */
export function confirmServerProcessing() {
    const key = 'server-processing-consent-v1';
    try { if (localStorage.getItem(key) === '1') return true; } catch (_) {}
    const accepted = confirm(`AI processing uses your configured server.\n\nTranscription uploads audio chunks to /transcribe. Replies send transcript, context and AI instructions to /ollama.\n\nContinue?`);
    if (accepted) { try { localStorage.setItem(key, '1'); } catch (_) {} }
    return accepted;
}

/* ── Collision-resistant monotonic IDs (Date.now() alone collides within 1 ms) ──
   uid() = ms-since-epoch * 1000 + a per-ms counter (0-999), giving up to 1000
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

/* Legacy helper retained for safely embedding a value in a single-quoted JS
   string inside an HTML attribute. The current UI uses delegated listeners and
   does not rely on this pattern, but the helper remains tested for compatibility. */
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

/* Recorder storage is intentionally shown in stable units so the values can
   be read at a glance while capture is running. */
export function fmtAudioMegabytes(bytes) {
    const safeBytes = Number.isFinite(Number(bytes)) ? Math.max(0, Number(bytes)) : 0;
    return `${(safeBytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function fmtStorageGigabytes(bytes) {
    const safeBytes = Number.isFinite(Number(bytes)) ? Math.max(0, Number(bytes)) : 0;
    return `${(safeBytes / (1024 * 1024 * 1024)).toFixed(0)} GB`;
}

export function fmtStorageFullPercent(audioBytes, quotaBytes) {
    const audio = Number(audioBytes);
    const quota = Number(quotaBytes);
    if (!Number.isFinite(quota) || quota <= 0) return null;
    const ratio = Number.isFinite(audio) ? Math.max(0, audio) / quota : 0;
    return `${Math.min(100, ratio * 100).toFixed(0)}%`;
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
