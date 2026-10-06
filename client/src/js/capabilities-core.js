// What the box this page is served from can take. A myAI box measures its own hardware at
// boot and publishes the result at /capabilities (see box/myai_probe.py in the repository):
// how many translation boxes it can keep up with, how many translations and transcription
// sections it can work on at once, and plain-language warnings such as "not enough RAM".
// Any other server simply has no /capabilities, and then nothing here limits anything: every
// limit falls back to the value the app has always used.

export const NO_LIMITS = Object.freeze({
    known: false,
    tier: '',
    summary: '',
    maxPanels: null,
    translateInFlight: null,
    transcribeConcurrency: null,
    llm: null,
    whisper: '',
    warnings: [],
    notes: []
});

const MAX_MESSAGES = 6;
const MAX_MESSAGE_CHARS = 300;

function wholeNumber(value, min, max) {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    return Math.max(min, Math.min(max, Math.floor(n)));
}

function messages(list) {
    return (Array.isArray(list) ? list : [])
        .map(item => String(item ?? '').trim().slice(0, MAX_MESSAGE_CHARS))
        .filter(Boolean)
        .slice(0, MAX_MESSAGES);
}

// Read what the box published, distrusting every field: anything missing or malformed
// means "no limit" for that field rather than a broken app.
export function normalizeCapabilities(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return NO_LIMITS;
    return Object.freeze({
        known: true,
        tier: String(raw.tier ?? '').slice(0, 40),
        summary: String(raw.summary ?? '').slice(0, 200),
        maxPanels: wholeNumber(raw.maxPanels, 0, 16),
        translateInFlight: wholeNumber(raw.translateInFlight, 0, 64),
        transcribeConcurrency: wholeNumber(raw.transcribeConcurrency, 1, 64),
        llm: raw.llm == null || raw.llm === '' ? null : String(raw.llm).slice(0, 120),
        whisper: String(raw.whisper ?? '').slice(0, 120),
        warnings: messages(raw.warnings),
        notes: messages(raw.notes)
    });
}

// The box's limit applied to the app's own: never above what the app allows, and never above
// what the box says it can do. A box limit of null leaves the app's value as it is.
export function capped(appValue, boxValue) {
    if (boxValue == null) return appValue;
    return Math.min(appValue, boxValue);
}

// How many translation boxes may be shown. Fewer than 2 means none: one box would only repeat
// the transcript, which is why the setting itself starts at 2.
export function cappedPanelCount(requested, appMax, caps = NO_LIMITS) {
    const n = Math.min(appMax, Math.floor(Number(requested) || 0));
    if (n < 2) return 0;
    const limited = capped(n, caps.maxPanels);
    return limited >= 2 ? limited : 0;
}

// Translations run one at a time at least, so a box that answers 0 (it has no AI model) does
// not stall the queue: there are then no boxes to fill in the first place.
export function cappedInFlight(appMax, caps = NO_LIMITS) {
    return Math.max(1, capped(appMax, caps.translateInFlight));
}

export function describeBox(caps = NO_LIMITS) {
    if (!caps.known) return '';
    const parts = [caps.summary || caps.tier];
    if (caps.whisper) parts.push(`transcription: ${caps.whisper}`);
    parts.push(caps.llm ? `AI model: ${caps.llm}` : 'no AI model on this box');
    if (caps.maxPanels != null) {
        parts.push(caps.maxPanels >= 2 ? `up to ${caps.maxPanels} translation boxes` : 'no translation boxes');
    }
    return parts.filter(Boolean).join(' · ');
}
