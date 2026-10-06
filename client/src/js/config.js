export const CONFIG = {
    DB_NAME:                'voice-notes-db',
    DB_VERSION:             13,
    STORE_REC:              'recordings',
    STORE_FRAGMENTS:        'audio_fragments',
    STORE_LIVE:             'live_transcripts',
    STORE_BEATS:            'capture_beats',
    STORE_AUDIO:            'audio',
    PAGE_SIZE:              6,
    IO_FLUSH_SEC:           4,
    GUI_UPDATE_MS:          250,
    RECORDING_HEARTBEAT_MS: 3000,
    RECORDING_STALE_MS:     15000,
    RECOVERY_SWEEP_MS:      60000,
    RETENTION_SWEEP_MS:     60000,

    OPUS_CONVERT_MAX_MS:  10 * 60 * 1000,
    REMOTE_FIRST_BYTE_TIMEOUT_MS: 45000,
    REMOTE_IDLE_TIMEOUT_MS: 60000,
    MODEL_LOAD_BUDGET_MS:   600000,
    MODEL_PROBE_MS:         3000,
    MODEL_SWAP_GRACE_MS:    90000,
    TRANSCRIBE_CONCURRENCY: 10,

    OLLAMA_URL:             '/ollama',
    TRANSCRIBE_URL:         '/transcribe'
};

const DEFAULT_AI_INSTRUCTIONS =
      'Reply in plain text. Use ordinary Unicode characters for symbols and units '
    + '(°C, ≈, →, ×), never LaTeX or $...$ math notation. Light structure is welcome: '
    + 'short paragraphs, blank lines between them, and simple "- " bullet lists. '
    + 'Avoid Markdown syntax such as #, **, ``` and tables.';

export const SETTINGS_DEFAULTS = {
    'set-auto-transcribe':  'off',
    'set-auto-reply':       'off',
    'set-compact-mode':     'on',
    'set-ai-instructions':  DEFAULT_AI_INSTRUCTIONS,
    'set-transcribe-lang':  'auto',
    'set-ollama-model':     'qwen3.8:27b',
    'set-recording-format': 'opus',
    'set-live-transcribe':  'off',
    'set-speaker-detection': 'off',
    'set-speaker-policy':    'numbers',
    'set-opus-bitrate':      '32',
    'set-waveform-fps':      '30',
    'set-max-speakers':     '4',
    'set-translate-panels': 'off',
    'set-second-pass':      'off',
    'set-retention-audio':  '1M',
    'set-retention-text':   '1M'
};

export function readStored(key) {
    try { return localStorage.getItem(key); } catch (_) { return null; }
}

export function writeStored(key, value) {
    try { localStorage.setItem(key, value); return true; } catch (_) { return false; }
}

export function getSetting(key) {
    const value = readStored(key);
    if (value === null || value.trim() === '') return SETTINGS_DEFAULTS[key] ?? '';
    return value;
}

export function confirmServerProcessing() {
    const key = 'server-processing-consent-v1';
    if (readStored(key) === '1') return true;
    const accepted = confirm(`AI processing uses your configured server.\n\nTranscription uploads audio chunks to /transcribe. Replies send transcript, context and AI instructions to /ollama.\n\nContinue?`);
    if (accepted) writeStored(key, '1');
    return accepted;
}

const _uidSalt = Math.floor(Math.random() * 1000);
let _uidLast = 0;
export function uid() {
    _uidLast = Math.max(Date.now() * 1000 + _uidSalt, _uidLast + 1);
    return _uidLast;
}

export function escapeHtml(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}
export function escapeAttr(s) {
    return escapeHtml(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const pad = n => String(n).padStart(2, '0');

export function fmtDur(ms) {
    const s   = Math.floor(ms / 1000);
    const h   = Math.floor(s / 3600);
    const m   = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return h ? `${pad(h)}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

export function fmtBytes(b) {
    if (b < 1024) return b + ' B';
    const u = ['KB', 'MB', 'GB', 'TB'];
    let i = 0, n = b / 1024;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return n.toFixed(1) + ' ' + u[i];
}

export function fmtAudioMegabytes(bytes) {
    const safeBytes = Number.isFinite(Number(bytes)) ? Math.max(0, Number(bytes)) : 0;
    return `${(safeBytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function fmtStorageGigabytes(bytes) {
    const safeBytes = Number.isFinite(Number(bytes)) ? Math.max(0, Number(bytes)) : 0;
    const gib = safeBytes / (1024 * 1024 * 1024);
    if (gib >= 10) return `${gib.toFixed(0)} GB`;
    if (gib >= 1) return `${gib.toFixed(1)} GB`;
    return `${Math.floor(safeBytes / (1024 * 1024))} MB`;
}

export function fmtStorageFullPercent(audioBytes, quotaBytes) {
    const audio = Number(audioBytes);
    const quota = Number(quotaBytes);
    if (!Number.isFinite(quota) || quota <= 0) return null;
    const ratio = Number.isFinite(audio) ? Math.max(0, audio) / quota : 0;
    return `${Math.min(100, ratio * 100).toFixed(0)}%`;
}

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
