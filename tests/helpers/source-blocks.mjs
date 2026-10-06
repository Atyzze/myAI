// Finds a function or block in JavaScript source by counting braces, skipping strings, template
// literals, comments and regular expressions, so a check that reads one piece of code finds it
// however that code is indented.

const REGEX_BEFORE = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^']);
const REGEX_AFTER_WORDS = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void',
                                   'throw', 'yield', 'await', 'instanceof']);

function wordBefore(source, i) {
    let end = i;
    while (end > 0 && /\s/.test(source[end - 1])) end--;
    let start = end;
    while (start > 0 && /[A-Za-z_$]/.test(source[start - 1])) start--;
    return source.slice(start, end);
}

function regexCanStart(last, source, i) {
    if (REGEX_BEFORE.has(last)) return true;
    return /[A-Za-z_$]/.test(last) && REGEX_AFTER_WORDS.has(wordBefore(source, i));
}

function skipString(source, i, quote) {
    for (let j = i + 1; j < source.length; j++) {
        if (source[j] === '\\') { j++; continue; }
        if (source[j] === quote) return j + 1;
    }
    return source.length;
}

function skipRegex(source, i) {
    let inClass = false;
    for (let j = i + 1; j < source.length; j++) {
        const c = source[j];
        if (c === '\\') { j++; continue; }
        if (c === '\n') return j;
        if (inClass) { if (c === ']') inClass = false; continue; }
        if (c === '[') { inClass = true; continue; }
        if (c === '/') {
            let k = j + 1;
            while (k < source.length && /[a-z]/.test(source[k])) k++;
            return k;
        }
    }
    return source.length;
}

function skipTemplate(source, i) {
    for (let j = i + 1; j < source.length; j++) {
        const c = source[j];
        if (c === '\\') { j++; continue; }
        if (c === '`') return j + 1;
        if (c === '$' && source[j + 1] === '{') {
            const end = scan(source, j + 2, { depth: 1 });
            if (end < 0) return source.length;
            j = end;
        }
    }
    return source.length;
}

// Walks code from `i`. With a depth, returns the index of the brace that brings it to zero. Without
// one (depth 0 and `open` unset), finds the first brace outside parentheses, then its partner.
function scan(source, i, { depth = 0, findOpen = false, openParens = 0 } = {}) {
    let parens = openParens;
    let opened = !findOpen;
    let last = '';
    while (i < source.length) {
        const c = source[i];
        const next = source[i + 1];
        if (c === '/' && next === '/') { const end = source.indexOf('\n', i); i = end < 0 ? source.length : end; continue; }
        if (c === '/' && next === '*') { const end = source.indexOf('*/', i + 2); i = end < 0 ? source.length : end + 2; continue; }
        if (c === '"' || c === "'") { i = skipString(source, i, c); last = c; continue; }
        if (c === '`') { i = skipTemplate(source, i); last = '`'; continue; }
        if (c === '/' && regexCanStart(last, source, i)) { i = skipRegex(source, i); last = '/'; continue; }
        if (/\s/.test(c)) { i++; continue; }
        if (!opened) {
            if (c === '(') parens++;
            else if (c === ')') parens--;
            else if (c === '{' && parens === 0) { opened = true; depth = 1; last = c; i++; continue; }
        } else if (c === '{') {
            depth++;
        } else if (c === '}') {
            depth--;
            if (depth === 0) return i;
        }
        last = c;
        i++;
    }
    return -1;
}

// The source from where `head` first matches to the brace that closes the block it opens: the
// block's own opening brace when `head` ends with one, else the first brace after the parameters.
export function blockAt(source, head) {
    const pattern = new RegExp(head.source, head.flags.replace('g', ''));
    const match = pattern.exec(source);
    if (!match) return '';
    const after = match.index + match[0].length;
    // A head such as "function name(" leaves its parameter list open.
    const openParens = (match[0].match(/\(/g) || []).length - (match[0].match(/\)/g) || []).length;
    const end = match[0].endsWith('{') ? scan(source, after, { depth: 1 })
                                       : scan(source, after, { findOpen: true, openParens: Math.max(0, openParens) });
    return end < 0 ? '' : source.slice(match.index, end + 1);
}
