// iCalendar (RFC 5545) as a tree that keeps everything it is given. A calendar object is parsed into
// components ({ name, props, components }) whose properties keep their parameters, their order and
// their raw value text; only what the app edits is ever rewritten, so a property or component this
// app does not know (an Apple structured location, an attendee list, a vendor X- property) goes back
// to the server byte for byte as it came.

const CRLF = '\r\n';
const MAX_LINE_OCTETS = 75;

// ---- lines -------------------------------------------------------------------------------------

export function unfoldLines(text) {
    return String(text ?? '')
        .replace(/\r\n|\r/g, '\n')
        .replace(/\n[ \t]/g, '')
        .split('\n');
}

function utf8Length(codePoint) {
    if (codePoint < 0x80) return 1;
    if (codePoint < 0x800) return 2;
    if (codePoint < 0x10000) return 3;
    return 4;
}

// Folds one content line at 75 octets, never inside a UTF-8 sequence; continuation lines begin with
// a space, which counts toward their 75.
export function foldLine(line) {
    const out = [];
    let current = '';
    let octets = 0;
    let limit = MAX_LINE_OCTETS;
    for (const ch of String(line)) {
        const size = utf8Length(ch.codePointAt(0));
        if (octets + size > limit) {
            out.push(current);
            current = ' ';
            octets = 1;
            limit = MAX_LINE_OCTETS;
        }
        current += ch;
        octets += size;
    }
    out.push(current);
    return out.join(CRLF);
}

// ---- parameters (RFC 5545 3.2, with RFC 6868 caret escapes) ---------------------------------------

function decodeParamValue(value) {
    return value.replace(/\^(n|\^|')/g, (_, c) => (c === 'n' ? '\n' : c === '^' ? '^' : '"'));
}

function encodeParamValue(value) {
    const encoded = String(value).replace(/\^/g, '^^').replace(/\n/g, '^n').replace(/"/g, "^'");
    return /[:;,]/.test(encoded) ? `"${encoded}"` : encoded;
}

// Splits "NAME;P1=a,"b:c";P2=x:value" at the first colon that is not inside a quoted parameter.
export function parseContentLine(line) {
    const text = String(line);
    let i = 0;
    while (i < text.length && text[i] !== ';' && text[i] !== ':') i++;
    const name = text.slice(0, i).trim().toUpperCase();
    if (!name || i >= text.length) return null;
    const params = [];
    while (text[i] === ';') {
        i++;
        let start = i;
        while (i < text.length && text[i] !== '=' && text[i] !== ';' && text[i] !== ':') i++;
        const paramName = text.slice(start, i).trim().toUpperCase();
        const values = [];
        if (text[i] === '=') {
            i++;
            for (;;) {
                let value;
                if (text[i] === '"') {
                    const close = text.indexOf('"', i + 1);
                    if (close < 0) { value = text.slice(i + 1); i = text.length; }
                    else { value = text.slice(i + 1, close); i = close + 1; }
                } else {
                    start = i;
                    while (i < text.length && text[i] !== ',' && text[i] !== ';' && text[i] !== ':') i++;
                    value = text.slice(start, i);
                }
                values.push(decodeParamValue(value));
                if (text[i] === ',') { i++; continue; }
                break;
            }
        }
        if (paramName) params.push({ name: paramName, values });
    }
    if (text[i] !== ':') return null;
    const prop = { name, params, value: text.slice(i + 1) };
    // The line as it came, for writing it back unchanged (quoting, parameter case) while nothing
    // in it has been changed.
    Object.defineProperty(prop, 'raw', { value: text, writable: true, enumerable: false, configurable: true });
    Object.defineProperty(prop, 'rawSig', { value: propSignature(prop), writable: true, enumerable: false, configurable: true });
    return prop;
}

function propSignature(prop) {
    return JSON.stringify([prop.name, prop.params, prop.value]);
}

export function formatContentLine(prop) {
    if (prop.raw && prop.rawSig === propSignature(prop)) return prop.raw;
    let line = prop.name;
    for (const param of prop.params || []) {
        line += `;${param.name}`;
        if (param.values && param.values.length) line += `=${param.values.map(encodeParamValue).join(',')}`;
    }
    return `${line}:${prop.value ?? ''}`;
}

// ---- components --------------------------------------------------------------------------------

export function component(name, props = [], components = []) {
    return { name: String(name).toUpperCase(), props, components };
}

export function property(name, value, params = {}) {
    return {
        name: String(name).toUpperCase(),
        params: Object.entries(params)
            .filter(([, v]) => v != null && v !== '')
            .map(([k, v]) => ({ name: k.toUpperCase(), values: Array.isArray(v) ? v.map(String) : [String(v)] })),
        value: String(value)
    };
}

// Every top-level component in the text, normally one VCALENDAR. Lines that are not content lines
// are skipped; a component left open at the end is closed, and an END that does not match the
// innermost open component closes up to the one it names, so a damaged file still yields what it has.
export function parseComponents(text) {
    const roots = [];
    const stack = [];
    for (const raw of unfoldLines(text)) {
        if (!raw.trim()) continue;
        const prop = parseContentLine(raw);
        if (!prop) continue;
        if (prop.name === 'BEGIN') {
            const node = component(prop.value.trim());
            if (stack.length) stack[stack.length - 1].components.push(node);
            else roots.push(node);
            stack.push(node);
        } else if (prop.name === 'END') {
            const name = prop.value.trim().toUpperCase();
            const at = stack.map(node => node.name).lastIndexOf(name);
            if (at >= 0) stack.length = at;
        } else if (stack.length) {
            stack[stack.length - 1].props.push(prop);
        }
    }
    return roots;
}

export function parseCalendar(text) {
    const roots = parseComponents(text);
    return roots.find(node => node.name === 'VCALENDAR') || null;
}

export function serializeComponent(node) {
    const lines = [`BEGIN:${node.name}`];
    for (const prop of node.props || []) lines.push(foldLine(formatContentLine(prop)));
    for (const child of node.components || []) lines.push(serializeComponent(child).replace(/\r\n$/, ''));
    lines.push(`END:${node.name}`);
    return lines.join(CRLF) + CRLF;
}

export function cloneComponent(node) {
    return {
        name: node.name,
        props: node.props.map(p => ({ name: p.name, params: p.params.map(q => ({ name: q.name, values: [...q.values] })), value: p.value })),
        components: node.components.map(cloneComponent)
    };
}

// ---- property access -----------------------------------------------------------------------------

export function getProp(node, name) {
    const upper = name.toUpperCase();
    return (node && node.props.find(p => p.name === upper)) || null;
}

export function getProps(node, name) {
    const upper = name.toUpperCase();
    return node ? node.props.filter(p => p.name === upper) : [];
}

export function paramValue(prop, name) {
    const upper = name.toUpperCase();
    const param = prop && prop.params.find(p => p.name === upper);
    return param && param.values.length ? param.values[0] : null;
}

export function setParam(prop, name, value) {
    const upper = name.toUpperCase();
    prop.params = prop.params.filter(p => p.name !== upper);
    if (value != null && value !== '') prop.params.push({ name: upper, values: [String(value)] });
}

// Replaces the first property of that name in place (so it keeps its position), or appends it.
export function setProp(node, name, value, params = null) {
    const upper = name.toUpperCase();
    const existing = node.props.find(p => p.name === upper);
    if (existing) {
        existing.value = String(value);
        if (params) {
            existing.params = property(upper, value, params).params;
        }
        node.props = node.props.filter(p => p === existing || p.name !== upper);
        return existing;
    }
    const prop = property(upper, value, params || {});
    node.props.push(prop);
    return prop;
}

export function removeProps(node, name) {
    const upper = name.toUpperCase();
    node.props = node.props.filter(p => p.name !== upper);
}

export function childComponents(node, name) {
    const upper = name.toUpperCase();
    return node ? node.components.filter(c => c.name === upper) : [];
}

// ---- TEXT values (RFC 5545 3.3.11) ---------------------------------------------------------------

export function unescapeText(value) {
    return String(value ?? '').replace(/\\([\\;,nN])/g, (_, c) => (c === 'n' || c === 'N' ? '\n' : c));
}

export function escapeText(value) {
    return String(value ?? '')
        .replace(/\\/g, '\\\\')
        .replace(/;/g, '\\;')
        .replace(/,/g, '\\,')
        .replace(/\r\n|\r|\n/g, '\\n');
}

export function getText(node, name) {
    const prop = getProp(node, name);
    return prop ? unescapeText(prop.value) : '';
}

export function setText(node, name, text) {
    const value = String(text ?? '');
    if (!value.trim()) { removeProps(node, name); return; }
    setProp(node, name, escapeText(value));
}

// ---- DATE and DATE-TIME values (RFC 5545 3.3.4, 3.3.5) ---------------------------------------------

// { year, month, day, hour, minute, second, date: bool, utc: bool }; month is 1-12.
export function parseDateValue(value) {
    const text = String(value ?? '').trim();
    let match = /^(\d{4})(\d{2})(\d{2})$/.exec(text);
    if (match) {
        return { year: +match[1], month: +match[2], day: +match[3], hour: 0, minute: 0, second: 0, date: true, utc: false };
    }
    match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/i.exec(text);
    if (match) {
        return {
            year: +match[1], month: +match[2], day: +match[3],
            hour: +match[4], minute: +match[5], second: Math.min(59, +match[6]),
            date: false, utc: match[7].toUpperCase() === 'Z'
        };
    }
    return null;
}

const pad = (n, width = 2) => String(n).padStart(width, '0');

export function formatDateValue(v) {
    const date = `${pad(v.year, 4)}${pad(v.month)}${pad(v.day)}`;
    if (v.date) return date;
    return `${date}T${pad(v.hour)}${pad(v.minute)}${pad(v.second || 0)}${v.utc ? 'Z' : ''}`;
}

// A DTSTART/DTEND/RECURRENCE-ID/EXDATE-like property: its values (EXDATE and RDATE may list several),
// whether they are dates, and the TZID they are in.
export function readDateProp(prop) {
    if (!prop) return null;
    const tzid = paramValue(prop, 'TZID');
    const valueType = (paramValue(prop, 'VALUE') || '').toUpperCase();
    const values = String(prop.value).split(',').map(part => {
        const text = part.trim();
        if (valueType === 'PERIOD' || text.includes('/')) return parseDateValue(text.split('/')[0]);
        return parseDateValue(text);
    }).filter(Boolean);
    if (!values.length) return null;
    return { values, tzid: values[0].utc ? null : tzid, date: values[0].date };
}

// ---- DURATION values (RFC 5545 3.3.6) ----------------------------------------------------------------

export function parseDuration(value) {
    const match = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i.exec(String(value ?? '').trim());
    if (!match || match.slice(2, 7).every(part => part === undefined)) return null;
    const sign = match[1] === '-' ? -1 : 1;
    return {
        sign,
        weeks: +(match[2] || 0), days: +(match[3] || 0),
        hours: +(match[4] || 0), minutes: +(match[5] || 0), seconds: +(match[6] || 0)
    };
}

// Nominal days (weeks and days) and exact seconds kept apart, because a day is not always 24 hours.
export function durationParts(d) {
    if (!d) return { days: 0, seconds: 0 };
    return {
        days: d.sign * (d.weeks * 7 + d.days),
        seconds: d.sign * (d.hours * 3600 + d.minutes * 60 + d.seconds)
    };
}

export function formatDuration({ days = 0, seconds = 0 } = {}) {
    const negative = days < 0 || (days === 0 && seconds < 0);
    let d = Math.abs(days);
    let s = Math.abs(seconds);
    let out = negative ? '-P' : 'P';
    if (d && d % 7 === 0 && !s) return `${out}${d / 7}W`;
    if (d) out += `${d}D`;
    if (s || !d) {
        const h = Math.floor(s / 3600); s -= h * 3600;
        const m = Math.floor(s / 60); s -= m * 60;
        out += 'T';
        if (h) out += `${h}H`;
        if (m) out += `${m}M`;
        if (s || (!h && !m)) out += `${s}S`;
    }
    return out;
}

// ---- RECUR values (RFC 5545 3.3.10) --------------------------------------------------------------------

const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
export const WEEKDAY_CODES = WEEKDAYS;

function numberList(text, { allowZero = false } = {}) {
    return String(text).split(',').map(s => s.trim()).filter(Boolean)
        .map(s => parseInt(s, 10))
        .filter(n => Number.isFinite(n) && (allowZero || n !== 0));
}

export function parseRecur(value) {
    const rule = { freq: null, interval: 1 };
    for (const part of String(value ?? '').trim().split(';')) {
        const eq = part.indexOf('=');
        if (eq < 0) continue;
        const key = part.slice(0, eq).trim().toUpperCase();
        const val = part.slice(eq + 1).trim();
        switch (key) {
            case 'FREQ': rule.freq = val.toUpperCase(); break;
            case 'INTERVAL': rule.interval = Math.max(1, parseInt(val, 10) || 1); break;
            case 'COUNT': rule.count = Math.max(0, parseInt(val, 10) || 0); break;
            case 'UNTIL': rule.until = parseDateValue(val); break;
            case 'WKST': rule.wkst = WEEKDAYS.includes(val.toUpperCase()) ? val.toUpperCase() : 'MO'; break;
            case 'BYSECOND': rule.bysecond = numberList(val, { allowZero: true }); break;
            case 'BYMINUTE': rule.byminute = numberList(val, { allowZero: true }); break;
            case 'BYHOUR': rule.byhour = numberList(val, { allowZero: true }); break;
            case 'BYMONTHDAY': rule.bymonthday = numberList(val); break;
            case 'BYYEARDAY': rule.byyearday = numberList(val); break;
            case 'BYWEEKNO': rule.byweekno = numberList(val); break;
            case 'BYMONTH': rule.bymonth = numberList(val); break;
            case 'BYSETPOS': rule.bysetpos = numberList(val); break;
            case 'BYDAY':
                rule.byday = val.split(',').map(s => s.trim().toUpperCase()).map(s => {
                    const m = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/.exec(s);
                    return m ? { n: m[1] ? parseInt(m[1], 10) : 0, day: m[2] } : null;
                }).filter(Boolean);
                break;
            default:
                rule.extra = rule.extra || [];
                rule.extra.push(`${key}=${val}`);
        }
    }
    const known = ['SECONDLY', 'MINUTELY', 'HOURLY', 'DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'];
    if (!known.includes(rule.freq)) return null;
    return rule;
}

export function formatRecur(rule) {
    const parts = [`FREQ=${rule.freq}`];
    if (rule.until) parts.push(`UNTIL=${formatDateValue(rule.until)}`);
    if (rule.count != null) parts.push(`COUNT=${rule.count}`);
    if (rule.interval && rule.interval !== 1) parts.push(`INTERVAL=${rule.interval}`);
    const list = (key, values) => { if (values && values.length) parts.push(`${key}=${values.join(',')}`); };
    list('BYSECOND', rule.bysecond);
    list('BYMINUTE', rule.byminute);
    list('BYHOUR', rule.byhour);
    if (rule.byday && rule.byday.length) parts.push(`BYDAY=${rule.byday.map(d => `${d.n || ''}${d.day}`).join(',')}`);
    list('BYMONTHDAY', rule.bymonthday);
    list('BYYEARDAY', rule.byyearday);
    list('BYWEEKNO', rule.byweekno);
    list('BYMONTH', rule.bymonth);
    list('BYSETPOS', rule.bysetpos);
    if (rule.wkst && rule.wkst !== 'MO') parts.push(`WKST=${rule.wkst}`);
    for (const extra of rule.extra || []) parts.push(extra);
    return parts.join(';');
}
