// A small namespace-aware XML reader, enough for WebDAV and CalDAV responses. It runs the same in the
// browser and under node (where there is no DOMParser), which is what lets the sync engine be tested
// against a real server without a browser.

const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decodeEntities(text) {
    return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body) => {
        if (body[0] === '#') {
            const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
            return Number.isFinite(code) ? String.fromCodePoint(code) : match;
        }
        return Object.prototype.hasOwnProperty.call(ENTITIES, body.toLowerCase()) ? ENTITIES[body.toLowerCase()] : match;
    });
}

export function escapeXml(text) {
    return String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// { ns, local, attrs: { name: value }, children: [element], text } for each element; text is the
// element's own character data (CDATA included), trimmed only by the caller.
export function parseXml(source) {
    const text = String(source ?? '');
    const root = { ns: null, local: '#document', attrs: {}, children: [], text: '', nsMap: { xml: 'http://www.w3.org/XML/1998/namespace' } };
    const stack = [root];
    let i = 0;
    const top = () => stack[stack.length - 1];
    while (i < text.length) {
        const lt = text.indexOf('<', i);
        if (lt < 0) { top().text += decodeEntities(text.slice(i)); break; }
        if (lt > i) top().text += decodeEntities(text.slice(i, lt));
        if (text.startsWith('<!--', lt)) { const end = text.indexOf('-->', lt + 4); i = end < 0 ? text.length : end + 3; continue; }
        if (text.startsWith('<![CDATA[', lt)) {
            const end = text.indexOf(']]>', lt + 9);
            top().text += text.slice(lt + 9, end < 0 ? text.length : end);
            i = end < 0 ? text.length : end + 3;
            continue;
        }
        if (text.startsWith('<?', lt)) { const end = text.indexOf('?>', lt + 2); i = end < 0 ? text.length : end + 2; continue; }
        if (text.startsWith('<!', lt)) { const end = text.indexOf('>', lt + 2); i = end < 0 ? text.length : end + 1; continue; }
        // A tag: find its end, minding quoted attribute values that may hold '>'.
        let j = lt + 1;
        let quote = null;
        while (j < text.length) {
            const ch = text[j];
            if (quote) { if (ch === quote) quote = null; }
            else if (ch === '"' || ch === "'") quote = ch;
            else if (ch === '>') break;
            j++;
        }
        const body = text.slice(lt + 1, j);
        i = j + 1;
        if (body.startsWith('/')) {
            if (stack.length > 1) stack.pop();
            continue;
        }
        const selfClosing = body.endsWith('/');
        const content = selfClosing ? body.slice(0, -1) : body;
        const nameMatch = /^\s*([^\s/>]+)/.exec(content);
        if (!nameMatch) continue;
        const qname = nameMatch[1];
        const attrs = {};
        const attrRe = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
        let m;
        while ((m = attrRe.exec(content.slice(nameMatch[0].length)))) {
            attrs[m[1]] = decodeEntities(m[3] !== undefined ? m[3] : m[4]);
        }
        const parent = top();
        const nsMap = { ...parent.nsMap };
        for (const [name, value] of Object.entries(attrs)) {
            if (name === 'xmlns') nsMap[''] = value;
            else if (name.startsWith('xmlns:')) nsMap[name.slice(6)] = value;
        }
        const colon = qname.indexOf(':');
        const prefix = colon >= 0 ? qname.slice(0, colon) : '';
        const local = colon >= 0 ? qname.slice(colon + 1) : qname;
        const element = { ns: nsMap[prefix] ?? null, local, attrs, children: [], text: '', nsMap };
        parent.children.push(element);
        if (!selfClosing) stack.push(element);
    }
    return root.children[0] || null;
}

export function children(element, ns, local) {
    return element ? element.children.filter(c => (ns == null || c.ns === ns) && (local == null || c.local === local)) : [];
}

export function child(element, ns, local) {
    return children(element, ns, local)[0] || null;
}

export function descendants(element, ns, local, out = []) {
    for (const c of (element ? element.children : [])) {
        if ((ns == null || c.ns === ns) && c.local === local) out.push(c);
        descendants(c, ns, local, out);
    }
    return out;
}

export function textOf(element) {
    if (!element) return '';
    return (element.text + element.children.map(textOf).join('')).trim();
}
