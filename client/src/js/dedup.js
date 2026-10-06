export const SEAM_FUZZY_MIN_WORDS = 4;
export const SEAM_FUZZY_MAX_MISMATCH_RATIO = 0.25;
export const SEAM_CUT_FRAGMENT_MIN_CHARS = 2;
export const SEAM_CUT_SHARED_MIN_CHARS = 3;

function sharedStart(a, b) {
    var n = 0;
    while (n < a.length && n < b.length && a[n] === b[n]) n++;
    return n;
}

function sharedEnd(a, b) {
    var n = 0;
    while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
    return n;
}

// A window edge can cut a word in two. The window after a seam may hear only the end of the word
// the overlap opens with ("day" for "today"), the window before it only the start of the word the
// overlap closes with ("after" for "afternoon"), and the clipped side may come out as something
// else ("yeah" for "year"). So the two readings of an edge word must agree on the part both windows
// heard: its end where the overlap opens, its start where it closes. A shared part of a few letters
// is enough; digits are not, since 2023 and 2024 are different numbers, not one cut short.
function cutWord(a, b, heardEnd) {
    if (a === '' || b === '') return false;
    if (a === b) return true;
    var shared = heardEnd ? sharedEnd(a, b) : sharedStart(a, b);
    if (shared === Math.min(a.length, b.length)) return shared >= SEAM_CUT_FRAGMENT_MIN_CHARS;
    var part = heardEnd ? a.slice(a.length - shared) : a.slice(0, shared);
    return shared >= SEAM_CUT_SHARED_MIN_CHARS && /\p{L}/u.test(part);
}

function seamRunMatches(pTail, nHead, k) {
    var first = pTail.length - k;
    if (first < 0) return false;
    var headA = pTail[first], headB = nHead[0];
    var tailA = pTail[pTail.length - 1], tailB = nHead[k - 1];
    if (!cutWord(headA, headB, true)) return false;
    if (!cutWord(tailA, tailB, false)) return false;
    var budget = Math.floor(k * SEAM_FUZZY_MAX_MISMATCH_RATIO);
    var mismatches = 0;
    for (var i = 0; i < k; i++) {
        var a = pTail[first + i], b = nHead[i];
        if (a === '' || b === '' || a !== b) {
            mismatches++;
            if (mismatches > budget) return false;
        }
    }
    return true;
}

// A seam of two or three words is too short to forgive a misheard word inside it, but its edge
// words are cut as often as a longer one's: one of them may be a cut word if every other word
// matches exactly.
function shortRunWithCutEdge(pTail, nHead, k) {
    var first = pTail.length - k;
    if (first < 0) return false;
    var cut = 0;
    for (var i = 0; i < k; i++) {
        var a = pTail[first + i], b = nHead[i];
        if (a === '' || b === '') return false;
        if (a === b) continue;
        var edge = i === 0 || i === k - 1;
        if (!edge || !cutWord(a, b, i === 0)) return false;
        cut++;
    }
    return cut === 1;
}

export function seamTrim(prevText, nextText, maxScan) {
    maxScan = maxScan || 25;
    if (!prevText) return nextText || '';
    if (!nextText) return '';
    var norm = function (w) {
        try { w = w.normalize('NFKC'); } catch (e) {}
        return w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
    };
    var ptok = String(prevText).trim().split(/\s+/).filter(Boolean);
    var ntok = String(nextText).trim().split(/\s+/).filter(Boolean);
    if (ntok.length === 0) return '';
    var scan  = Math.min(maxScan, ptok.length, ntok.length);
    var pTail = ptok.slice(-scan).map(norm);
    var nHead = ntok.slice(0, scan).map(norm);
    for (var k = scan; k >= 1; k--) {
        var ok = true;
        for (var i = 0; i < k; i++) {
            var a = pTail[pTail.length - k + i], b = nHead[i];
            if (a === '' || b === '' || a !== b) { ok = false; break; }
        }
        if (ok) return ntok.slice(k).join(' ');
    }
    for (var f = scan; f >= SEAM_FUZZY_MIN_WORDS; f--) {
        if (seamRunMatches(pTail, nHead, f)) return ntok.slice(f - closingWordToKeep(pTail, nHead, f)).join(' ');
    }
    for (var c = Math.min(scan, SEAM_FUZZY_MIN_WORDS - 1); c >= 2; c--) {
        if (shortRunWithCutEdge(pTail, nHead, c)) return ntok.slice(c - closingWordToKeep(pTail, nHead, c)).join(' ');
    }
    return ntok.join(' ');
}

// Where the seam closes on a word the window before cut short, the next window is the one that
// heard it whole: its reading is kept, so the word is never lost to the clipped one.
function closingWordToKeep(pTail, nHead, k) {
    return pTail[pTail.length - 1] !== nHead[k - 1] ? 1 : 0;
}

export function appendTail(tail, addedText, windowWords = 40) {
    const words = (tail + ' ' + addedText).trim().split(/\s+/).filter(Boolean);
    return words.slice(-windowWords).join(' ');
}
