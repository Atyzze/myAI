// Turning what an event says into things to tap: its place on a map, and the web addresses in its
// notes. Only http and https become links; everything else stays text.

import { getProp, paramValue } from './icalendar.js';

export function safeHttpUrl(text) {
    try {
        const url = new URL(String(text || '').trim());
        return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
    } catch (_) {
        return null;
    }
}

function coordinate(lat, lon) {
    const a = Number(lat);
    const b = Number(lon);
    if (!Number.isFinite(a) || !Number.isFinite(b) || Math.abs(a) > 90 || Math.abs(b) > 180) return null;
    return { lat: a, lon: b };
}

// The coordinates an event carries: GEO, or the geo: address of Apple's structured location.
export function geoOf(vevent) {
    if (!vevent) return null;
    const geo = getProp(vevent, 'GEO');
    if (geo) {
        const [lat, lon] = String(geo.value).split(/[;,]/);
        const found = coordinate(lat, lon);
        if (found) return found;
    }
    const apple = getProp(vevent, 'X-APPLE-STRUCTURED-LOCATION');
    if (apple) {
        const m = /^geo:([-+]?\d+(?:\.\d+)?),([-+]?\d+(?:\.\d+)?)/i.exec(String(apple.value).trim());
        if (m) return coordinate(m[1], m[2]);
    }
    return null;
}

export function appleLocationTitle(vevent) {
    const apple = vevent && getProp(vevent, 'X-APPLE-STRUCTURED-LOCATION');
    return apple ? paramValue(apple, 'X-TITLE') || '' : '';
}

// Map links for a place: by its coordinates when the event has them, otherwise by its text.
export function mapLinks(location, geo = null) {
    const text = String(location || '').trim();
    if (!text && !geo) return [];
    if (safeHttpUrl(text) && !geo) return [];
    if (geo) {
        const ll = `${geo.lat},${geo.lon}`;
        return [
            { label: 'Google Maps', href: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(ll)}` },
            { label: 'Apple Maps', href: `https://maps.apple.com/?ll=${encodeURIComponent(ll)}${text ? `&q=${encodeURIComponent(text)}` : ''}` },
            { label: 'OpenStreetMap', href: `https://www.openstreetmap.org/?mlat=${geo.lat}&mlon=${geo.lon}#map=17/${geo.lat}/${geo.lon}` }
        ];
    }
    const q = encodeURIComponent(text);
    return [
        { label: 'Google Maps', href: `https://www.google.com/maps/search/?api=1&query=${q}` },
        { label: 'Apple Maps', href: `https://maps.apple.com/?q=${q}` },
        { label: 'OpenStreetMap', href: `https://www.openstreetmap.org/search?query=${q}` }
    ];
}

// Text split into plain parts and web addresses ({ text } or { text, href }). A sentence's closing
// punctuation stays outside the link.
export function linkify(text) {
    const source = String(text || '');
    const parts = [];
    const re = /\b(?:https?:\/\/|www\.)[^\s<>"]+/gi;
    let last = 0;
    let m;
    while ((m = re.exec(source))) {
        let raw = m[0];
        while (/[.,;:!?)\]'"]$/.test(raw)) {
            if (raw.endsWith(')') && (raw.match(/\(/g) || []).length >= (raw.match(/\)/g) || []).length) break;
            raw = raw.slice(0, -1);
        }
        const href = safeHttpUrl(raw.startsWith('www.') ? `https://${raw}` : raw);
        if (!href) continue;
        if (m.index > last) parts.push({ text: source.slice(last, m.index) });
        parts.push({ text: raw, href });
        last = m.index + raw.length;
        re.lastIndex = last;
    }
    if (last < source.length) parts.push({ text: source.slice(last) });
    return parts;
}
