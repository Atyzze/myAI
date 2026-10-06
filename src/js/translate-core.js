export const MAX_PANELS = 4;

export const MIN_WINDOWS_FOR_PANEL = 2;

export const MIN_WORDS_FOR_PANEL = 12;

export const MIN_RUNS_FOR_PANEL = 2;
export const MIN_WORDS_PER_RUN = 4;

export const MIN_SENTENCES_FOR_ADDITIONAL_LANGUAGE = 3;
const MIN_WORDS_PER_SENTENCE = 4;

const WIDE_SCRIPT = /[\u1100-\u11ff\u2e80-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\ua960-\ua97f\uac00-\ud7ff\uf900-\ufaff]/;

export function countWords(text) {
    const value = String(text || '');
    let wide = 0;
    let narrow = '';
    for (const ch of value) {
        if (WIDE_SCRIPT.test(ch)) wide++;
        else narrow += ch;
    }
    const spaced = narrow.split(/\s+/).filter(part => /[^\s.,;:!?'"()\[\]-]/.test(part)).length;
    return spaced + Math.floor(wide / 3);
}

function windowsOf(entry) {
    if (entry == null) return 0;
    return typeof entry === 'number' ? entry : (Number(entry.windows) || 0);
}

function wordsOf(entry) {
    if (entry == null || typeof entry === 'number') return null;
    return Number.isFinite(Number(entry.words)) ? Number(entry.words) : null;
}

function runsOf(entry) {
    if (entry == null || typeof entry === 'number') return null;
    return Number.isFinite(Number(entry.runs)) ? Number(entry.runs) : null;
}

function sentenceKeysOf(entry) {
    if (entry == null || typeof entry === 'number' || !Array.isArray(entry.sentenceKeys)) return [];
    return entry.sentenceKeys.map(String);
}

export function languageSentences(tally, code) {
    const entry = (tally || {})[code];
    if (entry == null || typeof entry === 'number') return 0;
    return Number(entry.sentences) || 0;
}

function sentenceKey(text) {
    let value = String(text || '');
    try { value = value.normalize('NFKC'); } catch (_) {}
    return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

export function completeSentenceKeys(text, { minWords = MIN_WORDS_PER_SENTENCE } = {}) {
    const value = String(text || '');
    const out = [];
    const matches = value.match(/[^.!?。！？]+[.!?。！？]+/gu) || [];
    for (const sentence of matches) {
        if (countWords(sentence) < minWords) continue;
        const key = sentenceKey(sentence);
        if (key && !out.includes(key)) out.push(key);
    }
    return out;
}

export function addLanguageHeard(tally, code, text, { minWordsPerRun = MIN_WORDS_PER_RUN } = {}) {
    if (!code) return tally || {};
    const words = countWords(text);
    const nothingSaid = words === 0;
    if (nothingSaid) return tally || {};
    const current = (tally || {})[code];
    const recent = sentenceKeysOf(current);
    const heard = completeSentenceKeys(text).filter(key => !recent.includes(key));
    const sentenceKeys = [...recent, ...heard].slice(-24);
    return {
        ...(tally || {}),
        [code]: {
            windows: windowsOf(current) + 1,
            words: (wordsOf(current) || 0) + words,
            runs: (runsOf(current) || 0) + (words >= minWordsPerRun ? 1 : 0),
            sentences: languageSentences({ [code]: current }, code) + heard.length,
            sentenceKeys
        }
    };
}

function languageEarnsPanel(entry, {
    minWindows = MIN_WINDOWS_FOR_PANEL, minWords = MIN_WORDS_FOR_PANEL, minRuns = MIN_RUNS_FOR_PANEL
} = {}) {
    const words = wordsOf(entry);
    if (words == null) return windowsOf(entry) >= minWindows;
    const runs = runsOf(entry);
    return words >= minWords && (runs == null || runs >= minRuns);
}

export function introducedLanguages(tally, {
    minWindows = MIN_WINDOWS_FOR_PANEL, minWords = MIN_WORDS_FOR_PANEL, minRuns = MIN_RUNS_FOR_PANEL,
    minAdditionalSentences = MIN_SENTENCES_FOR_ADDITIONAL_LANGUAGE, excluded = []
} = {}) {
    const counts = tally || {};
    const blocked = new Set(excluded || []);
    const heard = Object.keys(counts).filter(code => code && windowsOf(counts[code]) > 0);
    const established = [];
    for (const code of heard) {
        const entry = counts[code];
        if (typeof entry === 'number') { established.push(code); continue; }
        if (!languageEarnsPanel(entry, { minWindows, minWords, minRuns })) continue;
        if (established.length >= 2 && languageSentences(counts, code) < minAdditionalSentences) continue;
        established.push(code);
    }
    return established.filter(code => !blocked.has(code));
}

export function describeLanguages(tally, {
    minWords = MIN_WORDS_FOR_PANEL, minWindows = MIN_WINDOWS_FOR_PANEL, minRuns = MIN_RUNS_FOR_PANEL,
    minAdditionalSentences = MIN_SENTENCES_FOR_ADDITIONAL_LANGUAGE, excluded = []
} = {}) {
    const counts = tally || {};
    const codes = introducedLanguages(counts, { minWords, minWindows, minRuns, minAdditionalSentences, excluded });
    if (codes.length === 0) return '';
    const label = code => code.toUpperCase();
    if (codes.length === 1) return `🌐 ${label(codes[0])}`;
    return `🌐 ${codes.length} languages · ${codes.map(label).join(' · ')}`;
}

export const LANGUAGE_COLOURS = Object.freeze([
    '#4aa8ff', '#5cc46a', '#e0b34d', '#c48ad9', '#ff8f6b', '#57d9d0'
]);

export function languageColour(code, firstSeen) {
    const index = (firstSeen || []).indexOf(code);
    return LANGUAGE_COLOURS[(index < 0 ? 0 : index) % LANGUAGE_COLOURS.length];
}

export function firstSeenOrder(tally) {
    return Object.keys(tally || {});
}

const SYSTEM_OK_COLOUR = '#5cc46a';
const SYSTEM_WARN_COLOUR = '#e0a44d';
export const SYSTEM_HELP_COLOUR = '#ff6b68';

export const SYSTEM_TONES = Object.freeze({
    ok: SYSTEM_OK_COLOUR, warn: SYSTEM_WARN_COLOUR, error: SYSTEM_HELP_COLOUR
});

export function panelLanguages(tally, panels, {
    minWindows = MIN_WINDOWS_FOR_PANEL, minWords = MIN_WORDS_FOR_PANEL, minRuns = MIN_RUNS_FOR_PANEL,
    minAdditionalSentences = MIN_SENTENCES_FOR_ADDITIONAL_LANGUAGE, excluded = []
} = {}) {
    const cap = Math.max(1, Math.min(MAX_PANELS, Math.floor(Number(panels) || 1)));
    const counts = tally || {};
    const pool = introducedLanguages(counts, { minWindows, minWords, minRuns, minAdditionalSentences, excluded });
    const firstSeen = Object.keys(counts);
    return pool
        .slice(0, cap)
        .sort((a, b) => firstSeen.indexOf(a) - firstSeen.indexOf(b));
}

export const TRANSLATE_QUEUE_MAX_LINES = 80;

export const TRANSLATE_BATCH_LINES = 12;

export const MAX_TRANSLATE_ATTEMPTS = 3;

export const TRANSLATE_BACKOFF_MAX_MS = 15000;

export function translateBackoffMs(consecutiveFailures, base = 2000, cap = TRANSLATE_BACKOFF_MAX_MS) {
    const failures = Math.max(0, Math.floor(Number(consecutiveFailures) || 0));
    if (failures === 0) return 0;
    return Math.min(cap, base * Math.pow(2, failures - 1));
}

export function translationBatch(lines, target, options = {}, size = TRANSLATE_BATCH_LINES) {
    const queue = translationQueue(lines, target, options);
    const taken = queue.slice(0, Math.max(1, Math.floor(Number(size) || 1)));
    return taken.slice().reverse();
}

export function buildBatchPrompt(lines, targetLanguage) {
    if (lines.length === 1) {
        const only = String((lines[0] && lines[0].text) || '').replace(/\s+/g, ' ').trim();
        return `Translate the text between the fences into ${targetLanguage}.\n`
            + `Reply with the translation only: no fences, no numbering, no notes.\n`
            + `---\n${only}\n---`;
    }
    const numbered = lines.map((line, i) => `${i + 1}. ${String(line.text || '').replace(/\s+/g, ' ').trim()}`);
    return `Translate each numbered line into ${targetLanguage}.\n`
        + `Reply with exactly ${lines.length} line${lines.length === 1 ? '' : 's'}, each starting with its number and a full stop, like "1. ...".\n`
        + `Do not merge, split, reorder, renumber or omit lines. Do not add notes, quotes or explanation.\n`
        + `Keep names and numbers unchanged.\n\n`
        + numbered.join('\n');
}

export function buildFinalPrompt(lines, targetLanguage) {
    const numbered = lines.map((line, i) => `${i + 1}. ${String(line.text || '').replace(/\s+/g, ' ').trim()}`);
    return `Translate each numbered line into ${targetLanguage}.\n`
        + `Reply with exactly ${lines.length} line${lines.length === 1 ? '' : 's'}, each starting with its number and a full stop, like "1. ...".\n`
        + `Do not merge, split, reorder, renumber or omit lines. Do not add notes, quotes or explanation.\n`
        + `Render every line completely in ${targetLanguage}, including any words spoken in another language, `
        + `using the wording a ${targetLanguage} speaker would use. Keep personal names and numbers unchanged.\n\n`
        + numbered.join('\n');
}

const NUMBERED_LINE = /^\s*(?:[-*>]\s+)*\**\s*(?:line\s*)?(\d+)\s*\**\s*[.)\]:-]\s*(.*)$/i;
const FENCE_LINE = /^\s*(?:-{3,}|`{3,}|"{3,}|'{3,})\s*$/;

function cleanBatchValue(text) {
    return String(text || '').replace(/^[*_\s]+/, '').replace(/[*_\s]+$/, '').trim();
}

function replyLines(body) {
    return body.split(/\r?\n/).map(line => (FENCE_LINE.test(line) ? '' : line));
}

function parseNumberedLines(body, count) {
    const found = new Map();
    let open = null;
    for (const raw of replyLines(body)) {
        const match = raw.match(NUMBERED_LINE);
        if (!match) {
            const continuation = raw.trim();
            if (!continuation) { open = null; continue; }
            if (open !== null) found.set(open, `${found.get(open) || ''} ${cleanBatchValue(continuation)}`.trim());
            continue;
        }
        const index = Number(match[1]);
        const value = cleanBatchValue(match[2]);
        if (index < 1 || index > count) return null;
        if (!found.has(index)) {
            found.set(index, value);
            open = index;
        } else {
            open = null;
        }
    }
    for (const [index, value] of [...found]) if (!value) found.delete(index);

    if (found.size === 0 && count > 1) {
        const plain = replyLines(body).map(line => cleanBatchValue(line)).filter(Boolean);
        if (plain.length === count) return plain;
    }
    if (found.size !== count) return null;
    const out = [];
    for (let i = 1; i <= count; i++) out.push(found.get(i));
    return out;
}

// A line that reads as item 1 of a numbered reply: "1. ...", "**1.** ...", "1) ...", "1 - ...",
// "1.Hallo". A number the text itself starts with ("1.5 kilo", "1:30", "1-2 weken") is not its
// numbering.
const FIRST_ITEM = /^\s*(?:[-*>]\s+)*\**\s*(?:line\s*)?1\s*\**\s*[.)\]:-](?!\d)/i;

// A single line is asked for without numbering (buildBatchPrompt), so its reply is taken as it is:
// read as numbered, "10.30 uur komt goed uit." would be line 10 of 1, and "1. Mai" would lose its
// date. Where a single line was asked for with its number (buildFinalPrompt), a reply with a line
// that reads as item 1 is read as numbered, past a preamble such as "Here is the translation:",
// and refused like any batch if it goes on to other numbers; a reply without one is kept as it is.
export function parseBatchResponse(text, count, { numbered = count > 1 } = {}) {
    const body = String(text || '').trim();
    if (!body) return null;
    if (count === 1) {
        const lines = replyLines(body).map(line => line.trim()).filter(Boolean);
        if (!lines.length) return null;
        if (numbered && lines.some(line => FIRST_ITEM.test(line))) return parseNumberedLines(body, 1);
        return [lines[0]];
    }
    return parseNumberedLines(body, count);
}

export function translationQueue(lines, target, { translations = {}, inFlight = new Set(),
                                                  maxQueued = TRANSLATE_QUEUE_MAX_LINES } = {}) {
    const list = lines || [];
    const limit = maxQueued > 0 ? maxQueued : Infinity;
    const out = [];
    for (let i = list.length - 1; i >= 0 && out.length < limit; i--) {
        const line = list[i];
        if (!line || line.system) continue;
        if (planLine(line, target).action !== 'translate') continue;
        const key = translationKey(line.key, target);
        if (translations[key] || inFlight.has(key)) continue;
        out.push({ key, line });
    }
    return out;
}

export function planLine(line, targetLanguage) {
    const from = (line && line.language) || null;
    if (!targetLanguage || !from || from === targetLanguage) {
        return { action: 'verbatim', from };
    }
    return { action: 'translate', from };
}

export function renderedText(line, targetLanguage, translations, { gaveUp = null } = {}) {
    const plan = planLine(line, targetLanguage);
    const original = String((line && line.text) || '');
    if (plan.action === 'verbatim') {
        return { text: original, translated: false, from: plan.from, pending: false, abandoned: false };
    }
    const key = translationKey(line.key, targetLanguage);
    const done = (translations || {})[key];
    const abandoned = !!(gaveUp && typeof gaveUp.has === 'function' && gaveUp.has(key));
    return done
        ? { text: done, translated: true, from: plan.from, pending: false, abandoned: false }
        : { text: original, translated: false, from: plan.from, pending: !abandoned, abandoned };
}

export function untranslatedCounts(rows, target, { translations = {}, gaveUp = null } = {}) {
    let pending = 0;
    let abandoned = 0;
    for (const row of rows || []) {
        if (!row || row.system) continue;
        if (planLine(row, target).action !== 'translate') continue;
        const key = translationKey(row.key, target);
        if (translations && translations[key]) continue;
        if (gaveUp && typeof gaveUp.has === 'function' && gaveUp.has(key)) abandoned++;
        else pending++;
    }
    return { pending, abandoned };
}

export function translationRate(samples) {
    const list = (samples || []).filter(item => item && item.lines > 0 && item.ms >= 0);
    if (!list.length) return null;
    const lines = list.reduce((sum, item) => sum + item.lines, 0);
    const ms = list.reduce((sum, item) => sum + item.ms, 0);
    return lines > 0 ? Math.round(ms / lines) : null;
}

export const SLOW_MS_PER_LINE = 4000;

export const MIN_SAMPLES_FOR_RATE = 3;

export const TRANSLATE_TIMEOUT_BASE_MS = 20000;
export const TRANSLATE_TIMEOUT_PER_LINE_MS = 3000;
export const TRANSLATION_TIMEOUT = 'TranslationTimeout';

export function translationTimeoutMs(lines) {
    const count = Math.max(1, Math.floor(Number(lines) || 1));
    return TRANSLATE_TIMEOUT_BASE_MS + TRANSLATE_TIMEOUT_PER_LINE_MS * count;
}

export function translationTimeoutError(timeoutMs) {
    const ms = Math.max(0, Math.round(Number(timeoutMs) || 0));
    const error = new Error(`the AI model took longer than ${Math.round(ms / 1000)}s to translate`);
    error.name = TRANSLATION_TIMEOUT;
    error.timeoutMs = ms;
    return error;
}

export const RELOAD_MS = 1000;

function nanosToMs(value) {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n / 1e6 : null;
}

export function generationTiming(data, wallMs) {
    const wall = Math.max(0, Math.round(Number(wallMs) || 0));
    const load = nanosToMs(data && data.load_duration);
    const prompt = nanosToMs(data && data.prompt_eval_duration);
    const evaluate = nanosToMs(data && data.eval_duration);
    const reported = prompt !== null || evaluate !== null;
    const generateMs = reported
        ? Math.round((prompt || 0) + (evaluate || 0))
        : Math.max(0, wall - Math.round(load || 0));
    return {
        wallMs: wall,
        loadMs: load === null ? null : Math.round(load),
        generateMs,
        reported,
        reloaded: load !== null && load >= RELOAD_MS
    };
}

export function planTranslationFailure(error, batchLength, consecutiveFailures) {
    const failures = Math.max(0, Math.floor(Number(consecutiveFailures) || 0)) + 1;
    const timedOut = !!error && error.name === TRANSLATION_TIMEOUT;
    const lines = Math.max(1, Math.floor(Number(batchLength) || 1));
    return {
        failures,
        backoffMs: translateBackoffMs(failures),
        stalled: timedOut,
        batchSize: timedOut ? Math.max(1, Math.floor(lines / 2)) : null,
        sample: timedOut ? { lines, ms: Math.max(0, Number(error.timeoutMs) || 0) } : null,
        countsAgainstLines: !!error && (error.name === 'EmptyTranslation' || (timedOut && lines === 1))
    };
}

export function steadyRate(samples, minSamples = MIN_SAMPLES_FOR_RATE) {
    const list = (samples || []).filter(item => item && item.lines > 0 && item.ms >= 0);
    return list.length >= minSamples ? translationRate(list) : null;
}

export const MAX_TRANSLATE_IN_FLIGHT = 4;

export function rotateTargets(targets, turn) {
    const list = targets || [];
    if (list.length < 2) return [...list];
    const offset = ((Math.floor(Number(turn) || 0) % list.length) + list.length) % list.length;
    return [...list.slice(offset), ...list.slice(0, offset)];
}

export function describeLag(pending, msPerLine) {
    const waiting = Math.max(0, Math.floor(Number(pending) || 0));
    const rate = Number(msPerLine);
    if (!waiting || !Number.isFinite(rate) || rate <= 0) return '';
    const seconds = Math.round((waiting * rate) / 1000);
    if (seconds < 30) return '';
    if (seconds < 90) return 'about a minute behind';
    if (seconds < 3600) return `about ${Math.round(seconds / 60)} min behind`;
    return `over an hour behind`;
}

export function panelHeading(target, { abandoned = 0, pending = 0 } = {}, activity = {}, base = '', cause = '') {
    const name = languageLabel(target, base);
    const gone = Math.max(0, Math.floor(Number(abandoned) || 0));
    const waiting = Math.max(0, Math.floor(Number(pending) || 0));
    const notes = [];
    if (waiting > 0) notes.push(`${waiting} waiting`);
    if (gone > 0) notes.push(`${gone} not translated`);
    const state = activity && activity.state;
    if (waiting > 0) {
        if (state === 'failing') notes.push(activity.slow ? 'AI model too slow' : 'server not answering');
        else if (state === 'paused') {
            const seconds = Math.max(1, Math.round((Number(activity.pauseMs) || 0) / 1000));
            notes.push(`retrying in ${seconds}s`);
        } else if (state === 'translating') {
            const lag = describeLag(waiting, activity.msPerLine);
            notes.push(lag ? `translating, ${lag}` : 'translating');
        } else {
            const lag = describeLag(waiting, activity.msPerLine);
            if (lag) notes.push(lag);
        }
        if (cause) notes.push(String(cause));
    }
    return notes.length ? `${name} · ${notes.join(' · ')}` : name;
}

export const MISALIGN_NOTICE_AFTER = 3;

export const TRANSLATE_CAUSES = Object.freeze({
    cpu: 'AI model partly on CPU',
    format: 'AI model ignores the line format',
    reasoning: 'AI model answers with reasoning only'
});

export function misalignBackoffMs(consecutive) {
    return translateBackoffMs(consecutive, 500, 8000);
}

export function translationKey(lineKey, targetLanguage) {
    return `${lineKey}::${targetLanguage}`;
}

const LANGUAGE_NAMES = {
    en: 'English', nl: 'Nederlands', de: 'Deutsch', fr: 'Français', es: 'Español',
    it: 'Italiano', pt: 'Português', pl: 'Polski', ru: 'Русский', tr: 'Türkçe',
    ar: 'العربية', hi: 'हिन्दी', zh: '中文', ja: '日本語', ko: '한국어', sv: 'Svenska',
    da: 'Dansk', no: 'Norsk', fi: 'Suomi', cs: 'Čeština', el: 'Ελληνικά',
    he: 'עברית', id: 'Bahasa Indonesia', ro: 'Română', uk: 'Українська',
    hu: 'Magyar', bg: 'Български', hr: 'Hrvatski', sr: 'Српски', sk: 'Slovenčina',
    sl: 'Slovenščina', lt: 'Lietuvių', lv: 'Latviešu', et: 'Eesti', ca: 'Català',
    th: 'ไทย', vi: 'Tiếng Việt', ms: 'Bahasa Melayu', fa: 'فارسی', ur: 'اردو',
    bn: 'বাংলা', ta: 'தமிழ்', af: 'Afrikaans', sq: 'Shqip', is: 'Íslenska'
};

const LANGUAGE_NAMES_IN = {
    en: { nl: 'Dutch', de: 'German', fr: 'French', es: 'Spanish', it: 'Italian', pt: 'Portuguese',
          ar: 'Arabic', ru: 'Russian', zh: 'Chinese', ja: 'Japanese', ko: 'Korean', pl: 'Polish',
          tr: 'Turkish', uk: 'Ukrainian', id: 'Indonesian', sv: 'Swedish', el: 'Greek', he: 'Hebrew',
          hi: 'Hindi', da: 'Danish', no: 'Norwegian', fi: 'Finnish', cs: 'Czech', ro: 'Romanian',
          hu: 'Hungarian', bg: 'Bulgarian', hr: 'Croatian', sr: 'Serbian', sk: 'Slovak',
          sl: 'Slovenian', lt: 'Lithuanian', lv: 'Latvian', et: 'Estonian', ca: 'Catalan',
          th: 'Thai', vi: 'Vietnamese', ms: 'Malay', fa: 'Persian', ur: 'Urdu', bn: 'Bengali',
          ta: 'Tamil', af: 'Afrikaans', sq: 'Albanian', is: 'Icelandic' },
    nl: { en: 'Engels', de: 'Duits', fr: 'Frans', es: 'Spaans', it: 'Italiaans', pt: 'Portugees',
          hu: 'Hongaars', bg: 'Bulgaars', hr: 'Kroatisch', sk: 'Slowaaks', ca: 'Catalaans',
          th: 'Thai', vi: 'Vietnamees', fa: 'Perzisch', af: 'Afrikaans', is: 'IJslands',
          ar: 'Arabisch', ru: 'Russisch', zh: 'Chinees', ja: 'Japans', ko: 'Koreaans', pl: 'Pools',
          tr: 'Turks', uk: 'Oekraïens', id: 'Indonesisch', sv: 'Zweeds', el: 'Grieks', he: 'Hebreeuws',
          hi: 'Hindi', da: 'Deens', no: 'Noors', fi: 'Fins', cs: 'Tsjechisch', ro: 'Roemeens' },
    de: { en: 'Englisch', nl: 'Niederländisch', fr: 'Französisch', es: 'Spanisch', it: 'Italienisch',
          pt: 'Portugiesisch', ar: 'Arabisch', ru: 'Russisch', zh: 'Chinesisch', ja: 'Japanisch',
          ko: 'Koreanisch', pl: 'Polnisch', tr: 'Türkisch', uk: 'Ukrainisch', id: 'Indonesisch',
          sv: 'Schwedisch', el: 'Griechisch', he: 'Hebräisch', hi: 'Hindi', da: 'Dänisch',
          no: 'Norwegisch', fi: 'Finnisch', cs: 'Tschechisch', ro: 'Rumänisch' },
    fr: { en: 'anglais', nl: 'néerlandais', de: 'allemand', es: 'espagnol', it: 'italien',
          pt: 'portugais', ar: 'arabe', ru: 'russe', zh: 'chinois', ja: 'japonais', ko: 'coréen',
          pl: 'polonais', tr: 'turc', uk: 'ukrainien', id: 'indonésien', sv: 'suédois', el: 'grec',
          he: 'hébreu', hi: 'hindi', da: 'danois', no: 'norvégien', fi: 'finnois', cs: 'tchèque',
          ro: 'roumain' },
    es: { en: 'inglés', nl: 'neerlandés', de: 'alemán', fr: 'francés', it: 'italiano',
          pt: 'portugués', ar: 'árabe', ru: 'ruso', zh: 'chino', ja: 'japonés', ko: 'coreano',
          pl: 'polaco', tr: 'turco', uk: 'ucraniano', id: 'indonesio', sv: 'sueco', el: 'griego',
          he: 'hebreo', hi: 'hindi', da: 'danés', no: 'noruego', fi: 'finés', cs: 'checo',
          ro: 'rumano' },
    pt: { en: 'inglês', nl: 'neerlandês', de: 'alemão', fr: 'francês', es: 'espanhol',
          it: 'italiano', ar: 'árabe', ru: 'russo', zh: 'chinês', ja: 'japonês', ko: 'coreano',
          pl: 'polaco', tr: 'turco', uk: 'ucraniano', id: 'indonésio', sv: 'sueco', el: 'grego',
          he: 'hebraico', hi: 'híndi', da: 'dinamarquês', no: 'norueguês', fi: 'finlandês',
          cs: 'checo', ro: 'romeno' },
    it: { en: 'inglese', nl: 'olandese', de: 'tedesco', fr: 'francese', es: 'spagnolo',
          pt: 'portoghese', ar: 'arabo', ru: 'russo', zh: 'cinese', ja: 'giapponese',
          ko: 'coreano', pl: 'polacco', tr: 'turco', uk: 'ucraino', id: 'indonesiano',
          sv: 'svedese', el: 'greco', he: 'ebraico', hi: 'hindi', da: 'danese', no: 'norvegese',
          fi: 'finlandese', cs: 'ceco', ro: 'rumeno' }
};

export function languageLabel(code, base) {
    const own = languageName(code);
    const from = String(base || '').toLowerCase();
    const target = String(code || '').toLowerCase();
    if (from && from === target) return own;
    const exonym = (LANGUAGE_NAMES_IN[from] || {})[target]
        || (from && LANGUAGE_NAMES_IN[from] ? null : (LANGUAGE_NAMES_IN.en || {})[target]);
    return exonym && exonym.toLowerCase() !== own.toLowerCase() ? `${own} - ${exonym}` : own;
}

export function languageName(code) {
    if (!code) return 'Unknown';
    return LANGUAGE_NAMES[String(code).toLowerCase()] || String(code).toUpperCase();
}

export function translatedFrom(code) {
    return `Translated from ${languageName(code)}`;
}

export function notTranslatedFrom(code) {
    return `${languageName(code)} · not translated`;
}

export function panelGrid(count) {
    const n = Math.max(1, Math.min(MAX_PANELS, Math.floor(Number(count) || 1)));
    if (n === 1) return { columns: 1, rows: 1 };
    if (n === 2) return { columns: 2, rows: 1 };
    return { columns: 2, rows: 2 };
}

export function translationStillCurrent(lines, row) {
    return !!row && (lines || []).some(line => line && line.key === row.key && line.text === row.text);
}
