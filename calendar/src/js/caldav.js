// CalDAV (RFC 4791) and WebDAV sync (RFC 6578) over fetch: finding the calendars, asking what
// changed since the last sync, fetching events, and writing them back with ETags so a change made
// meanwhile on another device is noticed instead of overwritten.

import { parseXml, children, child, descendants, textOf, escapeXml } from './xml.js';

export const NS = {
    D: 'DAV:',
    C: 'urn:ietf:params:xml:ns:caldav',
    CS: 'http://calendarserver.org/ns/',
    ICAL: 'http://apple.com/ns/ical/'
};

export class DavError extends Error {
    constructor(message, { status = 0, kind = 'server' } = {}) {
        super(message);
        this.name = 'DavError';
        this.status = status;
        this.kind = kind; // auth | offline | conflict | gone | invalid-token | unsupported | refused | server
    }
}

export function basicAuth(user, password) {
    const bytes = new TextEncoder().encode(`${user}:${password}`);
    let binary = '';
    for (const b of bytes) binary += String.fromCharCode(b);
    return `Basic ${btoa(binary)}`;
}

const XML_HEAD = '<?xml version="1.0" encoding="utf-8"?>';

function kindForStatus(status) {
    if (status === 401) return 'auth';
    if (status === 412) return 'conflict';
    if (status === 404 || status === 410) return 'gone';
    if (status === 405 || status === 501) return 'unsupported';
    if (status >= 500) return 'server';
    return 'refused';
}

export function normalizeColor(value) {
    const m = /^#?([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(String(value || '').trim());
    return m ? `#${m[1].toLowerCase()}` : null;
}

export class DavClient {
    constructor({ base, authorization = null, fetchFn = null, timeoutMs = 30000 }) {
        this.base = new URL(base, (globalThis.location && globalThis.location.href) || 'http://localhost/').href;
        this.authorization = authorization;
        this.fetchFn = fetchFn || ((...args) => globalThis.fetch(...args));
        this.timeoutMs = timeoutMs;
    }

    path(href) {
        return new URL(href, this.base).pathname;
    }

    async request(method, href, { body = null, headers = {}, depth = null, timeoutMs = this.timeoutMs, signal = null } = {}) {
        const url = new URL(href, this.base).href;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const onAbort = () => controller.abort();
        if (signal) signal.addEventListener('abort', onAbort, { once: true });
        const allHeaders = { ...headers };
        if (this.authorization) allHeaders.Authorization = this.authorization;
        if (depth != null) allHeaders.Depth = String(depth);
        if (body != null && !allHeaders['Content-Type']) allHeaders['Content-Type'] = 'application/xml; charset=utf-8';
        let response;
        try {
            // credentials 'omit': the Authorization header is the app's own, so a refused password
            // comes back to the app as a 401 instead of the browser popping up its own login box.
            response = await this.fetchFn(url, { method, headers: allHeaders, body, signal: controller.signal, cache: 'no-store', credentials: 'omit', redirect: 'follow' });
        } catch (err) {
            if (signal && signal.aborted) throw new DavError('Cancelled', { kind: 'cancelled' });
            throw new DavError(controller.signal.aborted ? 'The calendar server did not answer in time.' : 'The calendar server cannot be reached.', { kind: 'offline' });
        } finally {
            clearTimeout(timer);
            if (signal) signal.removeEventListener('abort', onAbort);
        }
        const text = await response.text().catch(() => '');
        const result = { status: response.status, headers: response.headers, text, url: response.url || url };
        if (response.status === 401) throw new DavError('The user name or password was not accepted.', { status: 401, kind: 'auth' });
        return result;
    }

    fail(result, what) {
        const kind = kindForStatus(result.status);
        const reason = kind === 'conflict' ? 'it was changed elsewhere meanwhile' : `the server answered ${result.status}`;
        return new DavError(`${what} failed: ${reason}.`, { status: result.status, kind });
    }

    parseMultistatus(text) {
        const doc = parseXml(text);
        if (!doc || doc.ns !== NS.D || doc.local !== 'multistatus') return { responses: [], syncToken: null };
        const responses = children(doc, NS.D, 'response').map(response => {
            const href = this.path(textOf(child(response, NS.D, 'href')));
            const status = statusCode(textOf(child(response, NS.D, 'status')));
            const propstats = children(response, NS.D, 'propstat').map(ps => ({
                status: statusCode(textOf(child(ps, NS.D, 'status'))),
                props: (child(ps, NS.D, 'prop') || { children: [] }).children
            }));
            const found = new Map();
            for (const ps of propstats) {
                if (ps.status && (ps.status < 200 || ps.status >= 300)) continue;
                for (const prop of ps.props) found.set(`${prop.ns}|${prop.local}`, prop);
            }
            return { href, status, propstats, prop: (ns, local) => found.get(`${ns}|${local}`) || null };
        });
        return { responses, syncToken: textOf(child(doc, NS.D, 'sync-token')) || null };
    }

    async propfind(href, propXml, depth = 0) {
        const body = `${XML_HEAD}<D:propfind xmlns:D="DAV:" xmlns:C="${NS.C}" xmlns:CS="${NS.CS}" xmlns:I="${NS.ICAL}"><D:prop>${propXml}</D:prop></D:propfind>`;
        const result = await this.request('PROPFIND', href, { body, depth });
        if (result.status !== 207) throw this.fail(result, 'Reading the calendar list');
        return this.parseMultistatus(result.text).responses;
    }

    // The signed-in user's calendar home: current-user-principal, then calendar-home-set.
    async discover() {
        let start = this.base;
        const first = await this.propfind(start, '<D:current-user-principal/><D:resourcetype/>', 0);
        const principalProp = first.length && first[0].prop(NS.D, 'current-user-principal');
        const principalHref = principalProp ? textOf(child(principalProp, NS.D, 'href')) : '';
        if (!principalHref) throw new DavError('This address does not offer a calendar account (no principal).', { kind: 'refused' });
        const principal = this.path(principalHref);
        const second = await this.propfind(principal, '<C:calendar-home-set/><D:displayname/>', 0);
        const homeProp = second.length && second[0].prop(NS.C, 'calendar-home-set');
        const home = homeProp && textOf(child(homeProp, NS.D, 'href')) ? this.path(textOf(child(homeProp, NS.D, 'href'))) : principal;
        return { principal, home };
    }

    async listCalendars(home) {
        const props = '<D:resourcetype/><D:displayname/><I:calendar-color/><CS:getctag/><D:sync-token/>'
            + '<C:supported-calendar-component-set/><D:current-user-privilege-set/><I:calendar-order/>';
        const responses = await this.propfind(home, props, 1);
        const calendars = [];
        for (const r of responses) {
            const type = r.prop(NS.D, 'resourcetype');
            if (!type || !child(type, NS.C, 'calendar')) continue;
            const compSet = r.prop(NS.C, 'supported-calendar-component-set');
            const components = compSet ? children(compSet, NS.C, 'comp').map(c => String(c.attrs.name || '').toUpperCase()) : ['VEVENT', 'VTODO'];
            const privileges = r.prop(NS.D, 'current-user-privilege-set');
            const canWrite = !privileges || descendants(privileges, NS.D, 'write').length > 0
                || descendants(privileges, NS.D, 'all').length > 0 || descendants(privileges, NS.D, 'write-content').length > 0;
            calendars.push({
                href: r.href,
                name: textOf(r.prop(NS.D, 'displayname')) || decodeURIComponent(r.href.split('/').filter(Boolean).pop() || 'Calendar'),
                color: normalizeColor(textOf(r.prop(NS.ICAL, 'calendar-color'))),
                ctag: textOf(r.prop(NS.CS, 'getctag')) || null,
                syncToken: textOf(r.prop(NS.D, 'sync-token')) || null,
                components,
                readOnly: !canWrite,
                order: parseInt(textOf(r.prop(NS.ICAL, 'calendar-order')), 10) || 0
            });
        }
        return calendars;
    }

    // What changed in a calendar since `token` ('' for everything). A token the server no longer
    // accepts is an 'invalid-token' error: the caller then lists the calendar in full.
    async syncCollection(href, token) {
        const body = `${XML_HEAD}<D:sync-collection xmlns:D="DAV:"><D:sync-token>${escapeXml(token || '')}</D:sync-token>`
            + '<D:sync-level>1</D:sync-level><D:prop><D:getetag/></D:prop></D:sync-collection>';
        const result = await this.request('REPORT', href, { body });
        if (result.status === 403 || result.status === 409 || result.status === 400) {
            if (/valid-sync-token/.test(result.text) || token) throw new DavError('The sync token expired.', { status: result.status, kind: 'invalid-token' });
        }
        if (result.status !== 207) throw this.fail(result, 'Asking what changed');
        const { responses, syncToken } = this.parseMultistatus(result.text);
        const changed = [];
        const removed = [];
        const self = this.path(href);
        for (const r of responses) {
            if (r.href === self) continue;
            if (r.status === 404) { removed.push(r.href); continue; }
            const etag = textOf(r.prop(NS.D, 'getetag'));
            if (etag) changed.push({ href: r.href, etag });
        }
        return { token: syncToken, changed, removed };
    }

    async listEtags(href) {
        const responses = await this.propfind(href, '<D:getetag/><D:resourcetype/>', 1);
        const self = this.path(href);
        return responses
            .filter(r => r.href !== self && !(r.prop(NS.D, 'resourcetype') && r.prop(NS.D, 'resourcetype').children.length))
            .map(r => ({ href: r.href, etag: textOf(r.prop(NS.D, 'getetag')) }))
            .filter(r => r.etag);
    }

    async multiget(href, hrefs) {
        if (!hrefs.length) return [];
        const body = `${XML_HEAD}<C:calendar-multiget xmlns:D="DAV:" xmlns:C="${NS.C}"><D:prop><D:getetag/><C:calendar-data/></D:prop>`
            + hrefs.map(h => `<D:href>${escapeXml(h)}</D:href>`).join('') + '</C:calendar-multiget>';
        const result = await this.request('REPORT', href, { body, depth: 1 });
        if (result.status !== 207) throw this.fail(result, 'Fetching events');
        return this.parseMultistatus(result.text).responses.map(r => {
            const dataProp = r.prop(NS.C, 'calendar-data');
            return {
                href: r.href,
                status: r.status || (dataProp ? 200 : 404),
                etag: textOf(r.prop(NS.D, 'getetag')),
                data: dataProp ? (dataProp.text + dataProp.children.map(textOf).join('')) : null
            };
        });
    }

    async get(href) {
        const result = await this.request('GET', href, { headers: { Accept: 'text/calendar' } });
        if (result.status === 404 || result.status === 410) return null;
        if (result.status !== 200) throw this.fail(result, 'Fetching an event');
        return { etag: result.headers.get('ETag'), data: result.text };
    }

    // Writes an event. With etag: only if the server still has that version (If-Match); with
    // create: only if nothing is there yet (If-None-Match: *).
    async put(href, data, { etag = null, create = false } = {}) {
        const headers = { 'Content-Type': 'text/calendar; charset=utf-8' };
        if (etag) headers['If-Match'] = etag;
        else if (create) headers['If-None-Match'] = '*';
        const result = await this.request('PUT', href, { body: data, headers });
        if (result.status !== 200 && result.status !== 201 && result.status !== 204) throw this.fail(result, 'Saving the event');
        return { etag: result.headers.get('ETag') };
    }

    async remove(href, { etag = null } = {}) {
        const headers = {};
        if (etag) headers['If-Match'] = etag;
        const result = await this.request('DELETE', href, { headers });
        if (result.status === 404 || result.status === 410) throw this.fail(result, 'Deleting the event');
        if (result.status < 200 || result.status >= 300) throw this.fail(result, 'Deleting the event');
        return true;
    }

    // Removes a whole calendar (a collection) and everything in it. One that is gone already is fine.
    async removeCollection(href) {
        const result = await this.request('DELETE', href, {});
        if (result.status === 404 || result.status === 410) return true;
        if (result.status < 200 || result.status >= 300) throw this.fail(result, 'Removing the calendar');
        return true;
    }

    async mkcalendar(href, { name, color = null }) {
        const body = `${XML_HEAD}<C:mkcalendar xmlns:D="DAV:" xmlns:C="${NS.C}" xmlns:I="${NS.ICAL}"><D:set><D:prop>`
            + `<D:displayname>${escapeXml(name)}</D:displayname>`
            + (color ? `<I:calendar-color>${escapeXml(color)}</I:calendar-color>` : '')
            + '<C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set>'
            + '</D:prop></D:set></C:mkcalendar>';
        const result = await this.request('MKCALENDAR', href, { body });
        if (result.status !== 201 && result.status !== 200) throw this.fail(result, 'Creating the calendar');
        return true;
    }

    async proppatch(href, { name = null, color = null }) {
        const props = (name != null ? `<D:displayname>${escapeXml(name)}</D:displayname>` : '')
            + (color != null ? `<I:calendar-color>${escapeXml(color)}</I:calendar-color>` : '');
        const body = `${XML_HEAD}<D:propertyupdate xmlns:D="DAV:" xmlns:I="${NS.ICAL}"><D:set><D:prop>${props}</D:prop></D:set></D:propertyupdate>`;
        const result = await this.request('PROPPATCH', href, { body });
        if (result.status !== 207 && result.status !== 200) throw this.fail(result, 'Changing the calendar');
        return true;
    }
}

function statusCode(text) {
    const m = /HTTP\/[\d.]+\s+(\d{3})/.exec(String(text || ''));
    return m ? parseInt(m[1], 10) : 0;
}
