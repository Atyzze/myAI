import { resolveIdentity, similarity, nameSimilarity, extractName,
         attributionByKey, speakerPolicy, shownNumber, NAME_MATCH_THRESHOLD,
         INFER_POLICY } from './diarize-core.js';
import { promotable, PROPOSE_SCORE } from './speaker-confirm-core.js';

export const EXPLICIT_SELF_WEIGHT = 1;
export const LOOSE_SELF_WEIGHT = 0.6;

export const ADDRESSED_WEIGHT = 0.25;

export const COMMIT_SCORE = 0.6;

export const NAME_MERGE_SIMILARITY = 0.2;

export const MAX_CLAIMS = 300;
export const MAX_ORDER = 2000;

const ADDRESS_REACH = 3;

const NOT_A_PERSON = new Set([
    'sorry', 'fine', 'good', 'great', 'okay', 'ok', 'ready', 'sure', 'afraid',
    'glad', 'happy', 'here', 'there', 'back', 'done', 'late', 'early', 'right',
    'wrong', 'going', 'trying', 'thinking', 'talking', 'saying', 'still', 'just',
    'not', 'all', 'everyone', 'everybody', 'guys', 'folks', 'both', 'well',
    'goed', 'prima', 'klaar', 'bang', 'blij', 'hier', 'daar', 'terug', 'laat',
    'weer', 'nog', 'niet', 'iedereen', 'allemaal', 'mensen', 'even', 'bezig',
    'benieuwd', 'akkoord', 'oké', 'jammer', 'welkom', 'welcome', 'thanks',
    'yes', 'no', 'ja', 'nee', 'maybe', 'misschien',
    'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
    'maandag', 'dinsdag', 'woensdag', 'donderdag', 'vrijdag', 'zaterdag', 'zondag',
    'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
    'september', 'october', 'november', 'december', 'today', 'tomorrow',
    'vandaag', 'morgen', 'gisteren'
]);

const ADDRESSED_TO_SYSTEM = /\b(?:speaker|spreker|person|persoon|system\s*z)\b/i;

const LEADING_FRAMES = [
    { kind: 'self', weight: EXPLICIT_SELF_WEIGHT,
      re: /\b(?:my name is|my name's|i am called|i'm called|call me|they call me|mijn naam is|ik heet|noem me|je mag me)\b\s*(.+)$/i },
    { kind: 'self', weight: LOOSE_SELF_WEIGHT,
      re: /\b(?:i'm|i am|this is|it's|it is|ik ben|dit is|dat is|je spreekt met)\b\s*(.+)$/i },
    { kind: 'self', weight: LOOSE_SELF_WEIGHT, re: /^\s*met\s+(.+)$/i },
    { kind: 'addressed', weight: ADDRESSED_WEIGHT,
      re: /\b(?:hi|hey|hello|hallo|hoi|dag|goedemorgen|goedemiddag|goedenavond|thanks|thank you|dank je|dank u|bedankt|sorry|welcome|welkom|good morning|good evening)\b\s*,?\s*(.+)$/i }
];

const TRAILING_SELF = /^\s*(.+?)\s+(?:here|speaking|hier|spreekt)\b/i;

const TRAILING_ADDRESS = /,\s*([^,]{1,40})\s*$/;

const SAME_SPEAKER_CUE = /\b(?:still\s+me|same\s+person|same\s+speaker|it'?s\s+me\s+again|me\s+again|nog\s+steeds\s+ik|dat\s+ben\s+ik\s+nog|ik\s+ben\s+het\s+weer|zelfde\s+persoon|dezelfde\s+persoon)\b/i;

function usableName(raw) {
    const name = extractName(raw, { requireCapital: true });
    if (!name) return '';
    const words = name.split(/\s+/).slice(0, 2);
    if (NOT_A_PERSON.has(words[0].toLowerCase())) return '';
    if (words[0].length < 2) return '';
    return words.join(' ');
}

export function readEvidence(text) {
    const out = [];
    for (const sentence of String(text || '').split(/[.?!\n]+/)) {
        const trimmed = sentence.trim();
        if (!trimmed) continue;
        if (SAME_SPEAKER_CUE.test(trimmed)) out.push({ kind: 'sameSpeaker', name: '', weight: 0 });
        if (ADDRESSED_TO_SYSTEM.test(trimmed)) continue;

        let claimed = false;
        for (const frame of LEADING_FRAMES) {
            const match = trimmed.match(frame.re);
            if (!match) continue;
            const name = usableName(match[1]);
            if (!name) continue;
            out.push({ kind: frame.kind, name, weight: frame.weight });
            claimed = true;
            break;
        }
        if (claimed) continue;

        const lead = trimmed.match(TRAILING_SELF);
        if (lead) {
            const name = usableName(lead[1]);
            if (name && name.split(/\s+/).length <= 2) {
                out.push({ kind: 'self', name, weight: LOOSE_SELF_WEIGHT });
                continue;
            }
        }
        const tail = trimmed.match(TRAILING_ADDRESS);
        if (tail) {
            const name = usableName(tail[1]);
            if (name && name.length === tail[1].trim().replace(/[^\p{L}\p{N}'’\s-]+$/u, '').length) {
                out.push({ kind: 'addressed', name, weight: ADDRESSED_WEIGHT });
            }
        }
    }
    return out;
}

export function createSpeakerHints() {
    return { claims: [], order: [] };
}

export function noteSpeech(hints, key, text, atSec = 0) {
    const base = hints || createSpeakerHints();
    if (key == null) return base;
    const order = base.order.includes(key) ? base.order : [...base.order, key];
    const evidence = readEvidence(text);
    if (!evidence.length) {
        return { claims: base.claims, order: order.slice(-MAX_ORDER) };
    }
    const claims = [...base.claims,
                    ...evidence.map(item => ({ ...item, key, atSec: Math.max(0, Number(atSec) || 0) }))];
    return { claims: claims.slice(-MAX_CLAIMS), order: order.slice(-MAX_ORDER) };
}

function addresseeOf(order, attribution, key, speakerId, index) {
    const at = index ? (index.has(key) ? index.get(key) : -1) : order.indexOf(key);
    if (at < 0) return null;
    for (let step = 1; step <= ADDRESS_REACH; step++) {
        for (const index of [at + step, at - step]) {
            if (index < 0 || index >= order.length) continue;
            const who = attribution.get(order[index]);
            if (who != null && who !== speakerId) return who;
        }
    }
    return null;
}

export function scoreClaims(hints, state, attribution = null) {
    const ledger = hints || createSpeakerHints();
    const map = attribution || attributionByKey(state);
    const at = new Map(ledger.order.map((key, i) => [key, i]));
    const totals = new Map();

    const credit = (id, name, weight, kind) => {
        if (id == null || !name) return;
        const forId = totals.get(id) || new Map();
        let bucket = null;
        for (const existing of forId.keys()) {
            if (nameSimilarity(existing, name) >= NAME_MATCH_THRESHOLD) { bucket = existing; break; }
        }
        const entry = forId.get(bucket) || { score: 0, self: 0, evidence: '' };
        entry.score += weight;
        if (kind === 'self') entry.self += weight;
        const label = bucket && bucket.length >= name.length ? bucket : name;
        if (bucket && bucket !== label) forId.delete(bucket);
        if (!entry.evidence && kind === 'self') entry.evidence = name;
        forId.set(label, entry);
        totals.set(id, forId);
    };

    for (const claim of ledger.claims) {
        if (claim.kind === 'sameSpeaker' || !claim.name) continue;
        const raw = map.get(claim.key);
        if (raw == null) continue;
        const speaker = resolveIdentity(state, raw);
        if (claim.kind === 'self') credit(speaker, claim.name, claim.weight, 'self');
        else credit(addresseeOf(ledger.order, map, claim.key, speaker, at),
                    claim.name, claim.weight, 'addressed');
    }
    return totals;
}

function bestTwo(forId) {
    const ranked = [...forId.entries()]
        .map(([name, entry]) => ({ name, ...entry }))
        .sort((a, b) => b.score - a.score);
    return { top: ranked[0] || null, next: ranked[1] || null };
}

function vectorsById(state) {
    const out = new Map();
    for (const speaker of ((state && state.speakers) || [])) {
        const id = resolveIdentity(state, speaker.id);
        if (!out.has(id)) out.set(id, speaker.vec);
    }
    return out;
}

export function inferNames(hints, state, totals = null) {
    totals = totals || scoreClaims(hints, state);
    const names = (state && state.names) || {};
    const locked = (state && state.locked) || {};

    const candidates = [];
    for (const [id, forId] of totals) {
        const { top, next } = bestTwo(forId);
        if (!top) continue;
        const runnerUp = next ? next.score : 0;
        if (!promotable({ score: top.score, self: top.self, runnerUp })) continue;
        candidates.push({ id, name: top.name, score: top.score, self: top.self, runnerUp });
    }
    candidates.sort((a, b) => b.score - a.score);

    const takenName = new Set();
    const takenId = new Set();
    const commands = [];
    for (const item of candidates) {
        const lower = item.name.toLowerCase();
        if (takenId.has(item.id) || takenName.has(lower)) continue;
        takenId.add(item.id);
        takenName.add(lower);
        if (locked[item.id]) continue;
        if (nameSimilarity(names[item.id] || '', item.name) >= NAME_MATCH_THRESHOLD) continue;
        commands.push({ type: 'name', id: item.id, name: item.name, origin: 'inferred',
                        score: item.score, self: item.self, runnerUp: item.runnerUp,
                        why: `heard them introduce themselves` });
    }
    return commands;
}

export function inferMerges(hints, state, { nameMergeSimilarity = NAME_MERGE_SIMILARITY, totals = null } = {}) {
    totals = totals || scoreClaims(hints, state);
    const names = (state && state.names) || {};
    const locked = (state && state.locked) || {};
    const vectors = vectorsById(state);

    const claimed = [];
    for (const [id, forId] of totals) {
        const { top } = bestTwo(forId);
        if (!top || top.self <= 0) continue;
        claimed.push({ id, name: top.name, self: top.self, score: top.score });
    }
    for (const id of Object.keys(names)) {
        const numeric = Number(id);
        if (claimed.some(item => item.id === numeric)) continue;
        claimed.push({ id: numeric, name: names[id], self: locked[id] ? COMMIT_SCORE : 0, score: COMMIT_SCORE });
    }

    const commands = [];
    const merged = new Set();
    for (let a = 0; a < claimed.length; a++) {
        for (let b = a + 1; b < claimed.length; b++) {
            const left = claimed[a];
            const right = claimed[b];
            if (left.id === right.id || merged.has(left.id) || merged.has(right.id)) continue;
            if (nameSimilarity(left.name, right.name) < NAME_MATCH_THRESHOLD) continue;
            if (Math.max(left.score, right.score) < PROPOSE_SCORE) continue;
            if (Math.min(left.score, right.score) < COMMIT_SCORE) continue;
            if (left.self <= 0 || right.self <= 0) continue;
            const vecA = vectors.get(left.id);
            const vecB = vectors.get(right.id);
            if (!vecA || !vecB) continue;
            if (similarity(vecA, vecB) < nameMergeSimilarity) continue;
            // The later number joins the earlier one, as the numbers on screen read.
            const [to, from] = shownNumber(state, left.id) <= shownNumber(state, right.id)
                ? [left.id, right.id] : [right.id, left.id];
            merged.add(from);
            commands.push({ type: 'merge', from, to, origin: 'inferred',
                            why: `both introduced themselves as "${left.name}"` });
        }
    }
    return commands;
}

export function sameSpeakerNotes(hints, state, attribution = null) {
    const ledger = hints || createSpeakerHints();
    const map = attribution || attributionByKey(state);
    const notes = [];
    for (const claim of ledger.claims) {
        if (claim.kind !== 'sameSpeaker') continue;
        const raw = map.get(claim.key);
        if (raw == null) continue;
        const id = resolveIdentity(state, raw);
        notes.push({
            id,
            atSec: claim.atSec,
            text: `heard that this may not be a new voice - Speaker ${shownNumber(state, id)} may be somebody already on screen`
        });
    }
    return notes;
}

export function reviewSpeakers(hints, state, options = {}) {
    if (speakerPolicy(state) !== INFER_POLICY) return { commands: [], notes: [] };
    const ledger = hints || createSpeakerHints();
    const attribution = attributionByKey(state, [...ledger.order, ...ledger.claims.map(claim => claim.key)]);
    const merges = inferMerges(hints, state, { ...options, totals: scoreClaims(hints, state, attribution) });
    let after = state;
    for (const merge of merges) {
        const aliases = { ...((after && after.aliases) || {}), [merge.from]: merge.to };
        after = { ...after, aliases };
    }
    const afterTotals = scoreClaims(hints, after, attribution);
    return { commands: [...merges, ...inferNames(hints, after, afterTotals)],
             notes: sameSpeakerNotes(hints, after, attribution) };
}

export function describeInference(hints, state) {
    const totals = scoreClaims(hints, state);
    if (!totals.size) return '';
    const parts = [];
    for (const [id, forId] of totals) {
        const { top, next } = bestTwo(forId);
        if (!top) continue;
        const ready = promotable({ score: top.score, self: top.self, runnerUp: next ? next.score : 0 });
        const share = Math.round(Math.min(1, top.score / PROPOSE_SCORE) * 100);
        parts.push(`${top.name} ${ready ? '✓' : `${share}%`} → Speaker ${shownNumber(state, id)}`);
    }
    return parts.length ? `👂 ${parts.join(' · ')}` : '';
}
