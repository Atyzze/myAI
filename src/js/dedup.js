/* ==========================================================================
   dedup.js - Seam-overlap trimming, shared by the reassembler (module) and
   the live-log popup (injected as source text). Replaces the old Set-based
   ratio dedup, which ignored word order/counts and over-suppressed text.

   seamTrim(prevText, nextText): returns nextText with ONLY its leading run of
   words that duplicates the trailing run of prevText removed. Positional and
   contiguous, so it removes the ±overlap bleed at chunk seams without dropping
   legitimately repeated content elsewhere.

   Script note: normalization is Unicode-aware (\p{L}\p{N} under the /u flag) and
   normalized-empty tokens (pure punctuation, or - previously - ANY CJK/Cyrillic/
   Arabic/Hindi token) are treated as NON-matching. The old [^a-z0-9] stripper
   reduced every non-Latin token to '', so all of them compared equal and seamTrim
   deleted whole chunks of Chinese/Japanese/Korean/Russian/Arabic/Hindi text.

   Single source of truth: seamTrim is a normal exported function. Both consumers
   import it - transcribe-core.js for the stored transcript, and live-view.js for
   the live popup - so there is no second copy to drift.

   Historical note: the popup documents used to receive this function as INJECTED
   SOURCE TEXT (via Function.prototype.toString), because a popup carrying an
   inline script could not import modules. That popup script was refused outright
   by the inherited CSP; the popups now load a real same-origin module, so the
   injection - and its dependency on the app never being minified - is gone.
   ========================================================================== */

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
            // Empty (punctuation-only / non-alphanumeric script) tokens never count
            // as a duplicate - otherwise non-Latin content gets deleted wholesale.
            if (a === '' || b === '' || a !== b) { ok = false; break; }
        }
        if (ok) return ntok.slice(k).join(' ');
    }
    return ntok.join(' ');
}

/** Keep a bounded rolling tail of words for cheap O(1) seam comparison. */
export function appendTail(tail, addedText, windowWords = 40) {
    const words = (tail + ' ' + addedText).trim().split(/\s+/).filter(Boolean);
    return words.slice(-windowWords).join(' ');
}
