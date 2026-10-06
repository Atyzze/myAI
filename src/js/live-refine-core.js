function normWord(word) {
    let value = String(word || '');
    try { value = value.normalize('NFKC'); } catch (_) {}
    return value.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

function wordsOf(text) {
    return String(text || '').trim().split(/\s+/).map(normWord).filter(Boolean);
}

function sequenceCount(words, sequence) {
    if (!sequence.length || sequence.length > words.length) return 0;
    let count = 0;
    for (let at = 0; at + sequence.length <= words.length; at++) {
        let same = true;
        for (let i = 0; i < sequence.length; i++) {
            if (words[at + i] !== sequence[i]) { same = false; break; }
        }
        if (same) count++;
    }
    return count;
}

export function findBoundaryRepetition(prevText, nextText, {
    minWords = 2, maxWords = 16, minSimilarity = 0.75, maxPrefixSkip = 2
} = {}) {
    const prev = wordsOf(prevText);
    const next = wordsOf(nextText);
    let best = null;

    const maxSkip = Math.min(Math.max(0, maxPrefixSkip), Math.max(0, next.length - minWords));
    for (let skip = 0; skip <= maxSkip; skip++) {
        const scan = Math.min(maxWords, prev.length, next.length - skip);
        for (let k = scan; k >= minWords; k--) {
            const a = prev.slice(prev.length - k);
            const b = next.slice(skip, skip + k);
            let same = 0;
            for (let i = 0; i < k; i++) if (a[i] === b[i]) same++;
            const similarity = same / k;
            const exact = same === k;
            if (k <= 3 ? !exact : similarity < minSimilarity) continue;
            const candidate = {
                words: k,
                similarity,
                exact,
                previous: a,
                repeated: b,
                nextSkipWords: skip,
                nextPrefixWords: skip + k
            };
            if (!best || candidate.words > best.words
                || (candidate.words === best.words && candidate.nextSkipWords < best.nextSkipWords)) {
                best = candidate;
            }
            break;
        }
    }
    return best;
}

export function adjacentRepeatWords(text, { minWords = 3, maxWords = 12 } = {}) {
    const words = wordsOf(text);
    let best = 0;
    for (let size = Math.min(maxWords, Math.floor(words.length / 2)); size >= minWords; size--) {
        for (let at = 0; at + size * 2 <= words.length; at++) {
            let same = true;
            for (let i = 0; i < size; i++) {
                if (words[at + i] !== words[at + size + i]) { same = false; break; }
            }
            if (same) return size;
        }
    }
    return best;
}

export function translationIntroducesRepetition(source, translated) {
    const after = adjacentRepeatWords(translated);
    if (after < 3) return false;
    const before = adjacentRepeatWords(source);
    return after > before;
}

function multisetSimilarity(aText, bText) {
    const a = wordsOf(aText), b = wordsOf(bText);
    if (!a.length || !b.length) return 0;
    const counts = new Map();
    for (const word of a) counts.set(word, (counts.get(word) || 0) + 1);
    let intersection = 0;
    for (const word of b) {
        const n = counts.get(word) || 0;
        if (n > 0) { intersection++; counts.set(word, n - 1); }
    }
    const precision = intersection / a.length;
    const recall = intersection / b.length;
    return precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
}

export function preferWiderRecheck(originalText, recheckedText, candidate, {
    minSimilarity = 0.82
} = {}) {
    if (!candidate || candidate.words < 2) return false;
    const original = wordsOf(originalText);
    const rechecked = wordsOf(recheckedText);
    if (!original.length || !rechecked.length) return false;

    const expectedRemoval = Math.max(candidate.words,
        Number(candidate.nextPrefixWords) || candidate.words);
    const removed = original.length - rechecked.length;
    if (removed < Math.max(1, expectedRemoval - 2)) return false;
    if (removed > expectedRemoval + 3) return false;
    if (multisetSimilarity(originalText, recheckedText) < minSimilarity) return false;

    if (candidate.words <= 3) {
        const phrase = (candidate.previous || []).map(normWord).filter(Boolean);
        const before = sequenceCount(original, phrase);
        const after = sequenceCount(rechecked, phrase);
        return before >= 2 && after < before;
    }
    return [candidate.previous, candidate.repeated]
        .map(words => (words || []).map(normWord).filter(Boolean))
        .some(phrase => sequenceCount(rechecked, phrase) < sequenceCount(original, phrase));
}

export function findTimedRepetitionCandidates(entries, {
    minOverlapSec = 0.15, maxLongPhraseGapSec = 0.35, maxCandidates = 8
} = {}) {
    const timed = (entries || []).map(entry => ({
        entry,
        startSec: Number(entry && (entry.startSec ?? entry.coreSec)),
        endSec: Number(entry && (entry.endSec ?? entry.coreEndSec)),
        text: String(entry && entry.text || '').trim()
    })).filter(item => Number.isFinite(item.startSec) && Number.isFinite(item.endSec)
        && item.endSec > item.startSec && item.text)
      .sort((a, b) => a.startSec - b.startSec || a.endSec - b.endSec);

    const out = [];
    for (let i = 1; i < timed.length && out.length < maxCandidates; i++) {
        const previous = timed[i - 1], current = timed[i];
        const candidate = findBoundaryRepetition(previous.text, current.text);
        if (!candidate) continue;
        const overlapSec = Math.min(previous.endSec, current.endSec)
            - Math.max(previous.startSec, current.startSec);
        const gapSec = current.startSec - previous.endSec;
        if (candidate.words <= 3) {
            if (overlapSec < minOverlapSec) continue;
        } else if (overlapSec < minOverlapSec && gapSec > maxLongPhraseGapSec) {
            continue;
        }
        out.push({
            previous: previous.entry,
            current: current.entry,
            candidate,
            overlapSec: Math.max(0, overlapSec),
            fromSec: Math.max(0, Math.min(previous.startSec, current.startSec)),
            toSec: Math.max(previous.endSec, current.endSec)
        });
    }
    return out;
}

export function mergeTimedPcm(windows, sampleRate = 16000) {
    const usable = (windows || []).filter(item => item && item.pcm instanceof Float32Array && item.pcm.length);
    if (!usable.length) return { pcm: new Float32Array(0), startSec: 0, endSec: 0 };
    const startSec = Math.min(...usable.map(item => Number(item.startSec) || 0));
    const endSec = Math.max(...usable.map(item => (Number(item.startSec) || 0) + item.pcm.length / sampleRate));
    const length = Math.max(0, Math.ceil((endSec - startSec) * sampleRate));
    const pcm = new Float32Array(length);
    for (const item of usable) {
        const offset = Math.max(0, Math.round(((Number(item.startSec) || 0) - startSec) * sampleRate));
        pcm.set(item.pcm.subarray(0, Math.max(0, Math.min(item.pcm.length, pcm.length - offset))), offset);
    }
    return { pcm, startSec, endSec };
}

export function replaceWindowLines(lines, previousKeys, currentKeys, recheckedText) {
    const text = String(recheckedText || '').trim();
    const reviewed = new Set([...(previousKeys || []), ...(currentKeys || [])]);
    const current = new Set(currentKeys || []);
    const spoken = (lines || []).filter(line => !line.system && reviewed.has(line.key));
    if (!text || !spoken.length) return { lines: lines || [], changed: [] };
    const keeper = spoken.find(line => current.has(line.key)) || spoken[spoken.length - 1];
    const startSec = Math.min(...spoken.map(line => line.startSec));
    const endSec = Math.max(...spoken.map(line => line.endSec));
    const replaced = [];
    for (const line of lines) {
        if (line.system || !reviewed.has(line.key)) replaced.push(line);
        else if (line === keeper) replaced.push({ ...line, text, startSec, endSec });
    }
    return { lines: replaced, changed: spoken.map(line => line.key) };
}
