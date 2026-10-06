export const SAME_SPEAKER_SIMILARITY = 0.35;

export const MERGE_SIMILARITY = 0.40;

const MIN_SEGMENTS_PER_SPEAKER = 3;
const MIN_SECONDS_PER_SPEAKER = 6;

export const SECOND_SPEAKER_THRESHOLD = 0.6;

export const MAX_SPEAKERS = 4;

export const RECLUSTER_WINDOW = 450;

// A group of two lines becomes a voice only when each line sounds like the other clearly more than
// like any other group. Two noisy lines of one speaker land in a group of their own often enough
// that without this a monologue would keep a second speaker for the rest of the session.
export const NEW_VOICE_MARGIN = 0.10;
// How much more a line of a voice has to sound like another voice before it moves there.
export const SWITCH_MARGIN = 0.15;
// Two voices whose voiceprints score this much against each other, with this many lines each,
// are one speaker.
export const CONSOLIDATE_SIMILARITY = 0.70;
export const CONSOLIDATE_LINES = 5;

const clamp01 = value => Math.max(0, Math.min(1, Number(value) || 0));

export function normalizeEmbedding(embedding) {
    if (!embedding || typeof embedding.length !== 'number' || embedding.length === 0) return null;
    const out = new Array(embedding.length);
    let sum = 0;
    for (let i = 0; i < embedding.length; i++) {
        const value = Number(embedding[i]);
        if (!Number.isFinite(value)) return null;
        out[i] = value;
        sum += value * value;
    }
    const norm = Math.sqrt(sum);
    if (!(norm > 0)) return null;
    for (let i = 0; i < out.length; i++) out[i] /= norm;
    return out;
}

export function similarity(a, b) {
    if (!a || !b || a.length !== b.length) return 0;
    let dot = 0;
    for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
    return dot;
}

export function createDiarization(policy = DEFAULT_SPEAKER_POLICY) {
    return { points: [], speakers: [], registry: [], nextId: 1, aliases: {}, names: {},
             history: {}, locked: {}, inferred: {},
             frozen: {}, tally: {}, voiceOf: {}, voices: {}, labelled: false, shown: [],
             policy: SPEAKER_POLICIES.includes(policy) ? policy : DEFAULT_SPEAKER_POLICY };
}

export function resolveIdentity(state, id) {
    const aliases = (state && state.aliases) || {};
    let current = id;
    for (let hop = 0; hop < 16 && aliases[current] != null; hop++) current = aliases[current];
    return current;
}

export function collapseIdentity(state, fromId, toId) {
    const from = resolveIdentity(state, Number(fromId));
    const to = resolveIdentity(state, Number(toId));
    if (!Number.isFinite(from) || !Number.isFinite(to) || from === to) return state;
    const low = Math.min(from, to);
    const high = Math.max(from, to);
    return { ...state, aliases: { ...state.aliases, [high]: low } };
}

export function separateIdentity(state, id) {
    const target = Number(id);
    if (!Number.isFinite(target) || !state || !state.aliases || state.aliases[target] == null) return state;
    const aliases = { ...state.aliases };
    delete aliases[target];
    return { ...state, aliases };
}

export const NUMBERS_POLICY = 'numbers';
export const INFER_POLICY = 'infer';
export const SPEAKER_POLICIES = Object.freeze([NUMBERS_POLICY, INFER_POLICY]);

export const DEFAULT_SPEAKER_POLICY = NUMBERS_POLICY;

export function speakerPolicy(state) {
    const value = state && state.policy;
    return SPEAKER_POLICIES.includes(value) ? value : DEFAULT_SPEAKER_POLICY;
}

export function setSpeakerPolicy(state, policy) {
    if (!SPEAKER_POLICIES.includes(policy) || speakerPolicy(state) === policy) return state;
    return { ...state, policy };
}

const NOT_A_NAME = new Set([
    'dutch', 'english', 'german', 'french', 'spanish', 'italian', 'nederlands',
    'engels', 'duits', 'frans', 'spaans', 'italiaans', 'speaker', 'spreker',
    'person', 'persoon', 'the', 'a', 'an', 'de', 'het', 'een', 'same', 'dezelfde',
    'actually', 'eigenlijk', 'and', 'en', 'not', 'niet', 'i', 'ik', 'he', 'she',
    'hij', 'zij', 'this', 'that', 'dit', 'dat'
]);
const NAME_MAX_WORDS = 4;

export function extractName(rest, { requireCapital = true } = {}) {
    const words = String(rest || '').trim().split(/\s+/);
    const out = [];
    for (const raw of words) {
        const word = raw.replace(/^[^\p{L}\p{N}]+/u, '').replace(/[^\p{L}\p{N}'’-]+$/u, '');
        if (!word) break;
        if (out.length >= (requireCapital ? NAME_MAX_WORDS : 3)) break;
        if (/^\d+$/.test(word)) break;
        if (NOT_A_NAME.has(word.toLowerCase())) break;
        if (requireCapital && !/^\p{Lu}/u.test(word)) break;
        out.push(word);
    }
    return out.join(' ');
}

export function nameIdentity(state, id, name, { locked = true, inferred = false } = {}) {
    const target = resolveIdentity(state, Number(id));
    const clean = String(name || '').trim();
    if (!Number.isFinite(target) || !clean) return state;
    if (inferred && ((state && state.locked) || {})[target]) return state;
    const existing = state.names ? state.names[target] : null;
    const chosen = existing && inferred ? preferFullerName(existing, clean) : clean;
    const past = ((state.history || {})[target] || []);
    const history = past.includes(chosen) ? past : [...past, chosen];
    return {
        ...state,
        names: { ...(state.names || {}), [target]: chosen },
        history: { ...(state.history || {}), [target]: history },
        locked: { ...(state.locked || {}), [target]: locked && !inferred },
        inferred: { ...(state.inferred || {}), [target]: !!inferred }
    };
}

export function inferredNameCount(state) {
    const inferred = (state && state.inferred) || {};
    const names = (state && state.names) || {};
    return Object.keys(inferred).filter(id => inferred[id] && names[id]).length;
}

export function isInferredName(state, id) {
    return !!((state && state.inferred) || {})[resolveIdentity(state, Number(id))];
}

export function nameSimilarity(a, b) {
    const left = String(a || '').trim().toLowerCase();
    const right = String(b || '').trim().toLowerCase();
    if (!left || !right) return 0;
    if (left === right) return 1;
    const rows = left.length + 1;
    const cols = right.length + 1;
    let previous = Array.from({ length: cols }, (_, i) => i);
    for (let i = 1; i < rows; i++) {
        const current = [i];
        for (let j = 1; j < cols; j++) {
            current[j] = Math.min(
                previous[j] + 1,
                current[j - 1] + 1,
                previous[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1)
            );
        }
        previous = current;
    }
    const distance = previous[cols - 1];
    return 1 - (distance / Math.max(left.length, right.length));
}

export const NAME_MATCH_THRESHOLD = 0.7;

export function findByName(state, text) {
    const needle = String(text || '').trim().toLowerCase();
    if (!needle) return [];
    const names = (state && state.names) || {};
    const history = (state && state.history) || {};
    const ids = new Set([...Object.keys(names), ...Object.keys(history)]);
    const current = [...ids].filter(id => String(names[id] || '').toLowerCase().includes(needle));
    if (current.length) return current.map(Number);
    const past = [...ids]
        .filter(id => (history[id] || []).some(old => String(old).toLowerCase().includes(needle)));
    if (past.length) return past.map(Number);

    const near = [...ids]
        .map(id => ({ id: Number(id), score: nameSimilarity(names[id], needle) }))
        .filter(item => item.score >= NAME_MATCH_THRESHOLD)
        .sort((a, b) => b.score - a.score);
    if (!near.length) return [];
    const contested = near.filter(item => near[0].score - item.score <= 0.05);
    return contested.map(item => item.id);
}

function preferFullerName(existing, incoming) {
    const a = existing.split(/\s+/).map(w => w.toLowerCase());
    const b = incoming.split(/\s+/).map(w => w.toLowerCase());
    const isRun = (short, long) =>
        short.length < long.length
        && (short.every((w, i) => w === long[i])
            || short.every((w, i) => w === long[long.length - short.length + i]));
    if (isRun(a, b)) return incoming;
    if (isRun(b, a)) return existing;
    return incoming;
}

export function resetNames(state) {
    return { ...state, names: {}, locked: {}, inferred: {} };
}

export function speakerDisplayName(state, id) {
    const target = resolveIdentity(state, Number(id));
    const names = (state && state.names) || {};
    const name = names[target];
    const number = () => speakerLabel(shownNumber(state, target));
    if (!name) return number();
    const shared = Object.keys(names)
        .filter(key => String(names[key]).toLowerCase() === String(name).toLowerCase());
    if (shared.length > 1) return number();
    if (!isInferredName(state, target)) return name;
    if (speakerPolicy(state) === NUMBERS_POLICY) return number();
    return `${name}?`;
}

// Commands name speakers by identity; what they report back names them by the number on screen.
export function applySpeakerCommand(state, command) {
    if (!command) return { state, echo: null, ok: false };
    const shownAs = id => shownNumber(state, id);
    if (command.type === 'resetNames') {
        return { state: resetNames(state), ok: true,
                 echo: 'forgot every name; they are numbers again until a suggestion is confirmed' };
    }
    if (command.type === 'renameByName') {
        const hits = findByName(state, command.match);
        if (hits.length === 0) {
            return { state, ok: false, echo: `no speaker called "${command.match}"` };
        }
        if (hits.length > 1) {
            return { state, ok: false,
                     echo: `"${command.match}" matches ${hits.length} speakers — use their number instead` };
        }
        const id = Number(hits[0]);
        const was = (state.names || {})[id];
        const heard = was && String(was).toLowerCase() !== String(command.match).toLowerCase()
            ? ` (heard "${command.match}")` : '';
        return { state: nameIdentity(state, id, command.name), ok: true,
                 echo: was ? `Speaker ${shownAs(id)} "${was}"${heard} → "${command.name}"`
                           : `Speaker ${shownAs(id)} → "${command.name}"` };
    }
    if (command.type === 'name') {
        const guess = command.origin === 'inferred';
        const next = nameIdentity(state, command.id, command.name, { locked: !guess, inferred: guess });
        if (guess && next === state) return { state, ok: false, echo: null };
        const stored = (next.names || {})[resolveIdentity(next, command.id)] || command.name;
        const clash = Object.keys(next.names || {})
            .filter(id => Number(id) !== resolveIdentity(next, command.id)
                && String(next.names[id]).toLowerCase() === String(stored).toLowerCase());
        const echo = clash.length
            ? `Speaker ${shownAs(command.id)} → "${stored}" · also Speaker ${clash.map(shownAs).join(', ')}; they may be the same person`
            : `Speaker ${shownAs(command.id)} → "${stored}"`;
        return { state: next, echo, ok: true };
    }
    if (command.type === 'separate') {
        const next = separateIdentity(state, command.id);
        if (next === state) {
            return { state, ok: false,
                     echo: `Speaker ${shownAs(command.id)} was not merged into anything` };
        }
        return { state: next, ok: true,
                 echo: `Speaker ${shownNumber(next, command.id)} is its own speaker again` };
    }
    const merged = collapseIdentity(state, command.from, command.to);
    const kept = resolveIdentity(merged, command.to);
    const undo = '';
    const because = command.why ? ` · ${command.why}` : '';
    if (command.type === 'mergeAndName') {
        const named = nameIdentity(merged, kept, command.name,
                                   { locked: command.origin !== 'inferred', inferred: command.origin === 'inferred' });
        return { state: named, ok: true,
                 echo: `Speaker ${shownAs(command.from)} + Speaker ${shownAs(command.to)} → "${(named.names || {})[kept] || command.name}"${undo}` };
    }
    return { state: merged, ok: true,
             echo: `Speaker ${shownAs(command.from)} → Speaker ${shownNumber(merged, kept)}${because}${undo}` };
}

export function addEmbedding(state, key, embedding, seconds = 0, options = {}) {
    return addEmbeddings(state, [{ key, embedding, seconds }], options);
}

export function addEmbeddings(state, items, options = {}) {
    const incoming = [];
    for (const item of items || []) {
        const vec = normalizeEmbedding(item && item.embedding);
        if (vec) incoming.push({ key: item.key, vec, seconds: Math.max(0, Number(item.seconds) || 0) });
    }
    if (!incoming.length) return state;
    const keys = new Set(incoming.map(point => point.key));
    const points = [...state.points.filter(point => !keys.has(point.key)), ...incoming];
    return retireOldPoints(recluster({ ...state, points }, options), options);
}

export function retireOldPoints(state, { reclusterWindow = RECLUSTER_WINDOW } = {}) {
    const points = (state && state.points) || [];
    const window = Math.max(1, Math.floor(Number(reclusterWindow) || RECLUSTER_WINDOW));
    if (points.length <= window) return state;
    const byIndex = new Map(((state && state.speakers) || []).map(speaker => [speaker.index, speaker.id]));
    const frozen = { ...((state && state.frozen) || {}) };
    const tally = { ...((state && state.tally) || {}) };
    const excess = points.length - window;
    for (let i = 0; i < excess; i++) {
        const point = points[i];
        const id = byIndex.get(point.speaker);
        if (id == null) continue;
        frozen[point.key] = id;
        const past = tally[id] || { segments: 0, seconds: 0 };
        tally[id] = { segments: past.segments + 1, seconds: past.seconds + point.seconds };
    }
    const voiceOf = { ...((state && state.voiceOf) || {}) };
    for (let i = 0; i < excess; i++) delete voiceOf[points[i].key];
    return { ...state, points: points.slice(excess), frozen, tally, voiceOf };
}

// A group of lines while they are regrouped: the voice it is, if it is one, its lines, and the sum
// of their voiceprints, which normalised is its centroid.
function makeGroup(dims, id = null, voice = false) {
    return { id, voice, members: [], sum: new Array(dims).fill(0) };
}

function joinGroup(group, point) {
    group.members.push(point);
    for (let i = 0; i < group.sum.length; i++) group.sum[i] += point.vec[i];
    point.group = group;
}

function leaveGroup(group, point) {
    group.members = group.members.filter(member => member !== point);
    for (let i = 0; i < group.sum.length; i++) group.sum[i] -= point.vec[i];
    point.group = null;
}

function moveLines(from, to) {
    for (const point of [...from.members]) {
        leaveGroup(from, point);
        joinGroup(to, point);
    }
}

// How much a voiceprint sounds like a group: its similarity to the group's centroid, with one of
// the group's own lines left out when asked, so a line is not compared with itself.
function scoreAgainst(vec, sum, leaveOut = null) {
    let norm = 0;
    let dot = 0;
    for (let i = 0; i < sum.length; i++) {
        const value = leaveOut ? sum[i] - leaveOut[i] : sum[i];
        norm += value * value;
        dot += vec[i] * value;
    }
    return norm > 0 ? dot / Math.sqrt(norm) : -Infinity;
}

function groupsAlike(a, b) {
    const centroid = normalizeEmbedding(a.sum);
    return centroid ? scoreAgainst(centroid, b.sum) : -Infinity;
}

// Where one line belongs. A line of a voice moves only to another voice, and only when it sounds
// clearly more like that one than like the rest of its own; a line alone in its group joins another
// group as a new line would; any other line goes to the group it sounds most like.
function settleLine(point, groups, sameSpeaker) {
    const own = point.group.members.length > 1 ? scoreAgainst(point.vec, point.group.sum, point.vec) : null;
    let best = null;
    let bestScore = -Infinity;
    for (const group of groups) {
        if (group === point.group || !group.members.length) continue;
        if (point.pinned && !group.voice) continue;
        const score = scoreAgainst(point.vec, group.sum);
        if (score > bestScore) { bestScore = score; best = group; }
    }
    if (!best) return;
    const move = point.pinned
        ? own != null && bestScore >= own + SWITCH_MARGIN && bestScore >= sameSpeaker
        : (own == null ? bestScore >= sameSpeaker : bestScore > own);
    if (!move) return;
    leaveGroup(point.group, point);
    joinGroup(best, point);
}

// Groups that are not voices merge as they always did: with each other, or into a voice, once
// their centroids are this alike. Two voices never merge here.
function mergeLooseGroups(groups, mergeSimilarity) {
    let current = groups;
    for (;;) {
        let pair = null;
        for (let a = 0; a < current.length && !pair; a++) {
            for (let b = a + 1; b < current.length && !pair; b++) {
                const first = current[a];
                const second = current[b];
                if (!first.members.length || !second.members.length || (first.voice && second.voice)) continue;
                if (groupsAlike(first, second) >= mergeSimilarity) pair = [first, second];
            }
        }
        if (!pair) return current;
        const [keep, drop] = pair[1].voice ? [pair[1], pair[0]] : pair;
        moveLines(drop, keep);
        current = current.filter(group => group !== drop);
    }
}

// Which of two voices goes on when they turn out to be one speaker: the one with a name, or else
// the lower number. Two voices named differently are not one speaker, whatever their voiceprints.
function survivorOf(first, second, names) {
    const named = [first, second].filter(group => names[group.id]);
    if (named.length === 2 && String(names[first.id]).toLowerCase() !== String(names[second.id]).toLowerCase()) return null;
    if (named.length === 1) return named[0];
    return first.id <= second.id ? first : second;
}

function joinVoices(groups, keep, drop, aliases) {
    moveLines(drop, keep);
    return { groups: groups.filter(group => group !== drop), aliases: { ...aliases, [drop.id]: keep.id } };
}

// Two voices become one only on strong evidence: every line of the smaller sounds more like the
// other voice than like the rest of its own lines, or both have said CONSOLIDATE_LINES lines and
// their voiceprints score CONSOLIDATE_SIMILARITY against each other.
function consolidateVoices(groups, aliases, names, sameSpeaker) {
    let current = { groups, aliases };
    for (;;) {
        const voices = current.groups.filter(group => group.voice && group.members.length);
        let found = null;
        for (const small of voices) {
            for (const big of voices) {
                if (big === small || big.members.length < small.members.length) continue;
                const everyLineAgrees = small.members.every(point => scoreAgainst(point.vec, big.sum)
                    > (small.members.length > 1 ? scoreAgainst(point.vec, small.sum, point.vec) : sameSpeaker));
                const bothAlike = small.members.length >= CONSOLIDATE_LINES
                    && groupsAlike(small, big) >= CONSOLIDATE_SIMILARITY;
                if (!everyLineAgrees && !bothAlike) continue;
                const keep = survivorOf(small, big, names);
                if (keep) { found = { keep, drop: keep === small ? big : small }; break; }
            }
            if (found) break;
        }
        if (!found) return current;
        current = joinVoices(current.groups, found.keep, found.drop, current.aliases);
    }
}

// The speaker ceiling from Settings: past it a stray group joins the group it is most like, and
// when only voices are left the two most alike become one.
function capGroups(groups, aliases, names, maxSpeakers) {
    const cap = Math.max(1, Math.floor(Number(maxSpeakers) || 1));
    let current = { groups, aliases };
    for (;;) {
        const live = current.groups.filter(group => group.members.length);
        if (live.length <= cap) return current;
        const loose = live.filter(group => !group.voice);
        let best = null;
        for (const first of (loose.length ? loose : live)) {
            for (const second of live) {
                if (second === first) continue;
                const score = groupsAlike(first, second);
                if (!best || score > best.score) best = { first, second, score };
            }
        }
        if (!best) return current;
        if (!best.first.voice) {
            moveLines(best.first, best.second);
            current = { groups: current.groups.filter(group => group !== best.first), aliases: current.aliases };
        } else {
            const keep = survivorOf(best.first, best.second, {}) ;
            current = joinVoices(current.groups, keep, keep === best.first ? best.second : best.first, current.aliases);
        }
    }
}

// How clearly the lines of a group that is not a voice yet sound like each other rather than like
// any other group: the smallest margin over its lines.
function newVoiceMargin(group, live) {
    let margin = Infinity;
    for (const point of group.members) {
        const own = scoreAgainst(point.vec, group.sum, point.vec);
        let rival = -Infinity;
        for (const other of live) {
            if (other !== group) rival = Math.max(rival, scoreAgainst(point.vec, other.sum));
        }
        margin = Math.min(margin, own - rival);
    }
    return margin;
}

// Every new line regroups the lines of the window, but a voice stays a voice. A group becomes one
// once it has said two lines that clearly belong together; every regrouping then starts from the
// lines that are already its own, a line of it moves to another voice only when it sounds clearly
// more like that one, and two voices become one only on strong evidence. Build 131 regrouped every
// line from scratch, so a second voice that had been on screen for a minute could be merged back
// into the first, and every number went with it.
export function recluster(state, {
    sameSpeaker = SAME_SPEAKER_SIMILARITY,
    mergeSimilarity = MERGE_SIMILARITY,
    maxSpeakers = MAX_SPEAKERS
} = {}) {
    const points = state.points.map(point => ({ ...point }));
    const dims = points.length ? points[0].vec.length : 0;
    const voiceOf = (state && state.voiceOf) || {};
    const voices = { ...((state && state.voices) || {}) };
    const names = (state && state.names) || {};
    let aliases = { ...((state && state.aliases) || {}) };
    let groups = [];

    const byVoice = new Map();
    for (const point of points) {
        if (voiceOf[point.key] == null) continue;
        const id = resolveIdentity({ aliases }, Number(voiceOf[point.key]));
        if (!byVoice.has(id)) {
            const group = makeGroup(dims, id, true);
            byVoice.set(id, group);
            groups.push(group);
        }
        point.pinned = true;
        joinGroup(byVoice.get(id), point);
    }
    for (const point of points) {
        if (point.pinned) continue;
        let best = null;
        let bestScore = -Infinity;
        for (const group of groups) {
            const score = scoreAgainst(point.vec, group.sum);
            if (score > bestScore) { bestScore = score; best = group; }
        }
        if (best && bestScore >= sameSpeaker) joinGroup(best, point);
        else {
            const group = makeGroup(dims);
            groups.push(group);
            joinGroup(group, point);
        }
    }
    for (let round = 0; round < 2; round++) {
        for (const point of points) settleLine(point, groups, sameSpeaker);
        groups = mergeLooseGroups(groups.filter(group => group.members.length || group.voice), mergeSimilarity);
    }
    ({ groups, aliases } = consolidateVoices(groups, aliases, names, sameSpeaker));
    ({ groups, aliases } = capGroups(groups, aliases, names, maxSpeakers));

    const live = groups.filter(group => group.members.length);
    const speakers = live.map((group, index) => {
        for (const point of group.members) point.speaker = index;
        return {
            index,
            vec: normalizeEmbedding(group.sum),
            segments: group.members.length,
            seconds: group.members.reduce((sum, point) => sum + point.seconds, 0),
            id: group.id,
            voice: group.voice,
            margin: group.voice || group.members.length < MIN_LINES_PER_VOICE ? null : newVoiceMargin(group, live)
        };
    });
    const assigned = assignIdentities({ ...state, aliases }, speakers, sameSpeaker);
    for (const speaker of assigned.speakers) {
        if (!speaker.voice && voices[speaker.id]) speaker.voice = true;
        if (!speaker.voice && speaker.segments >= MIN_LINES_PER_VOICE
            && (speaker.segments > MIN_LINES_PER_VOICE || speaker.margin >= NEW_VOICE_MARGIN)) speaker.voice = true;
        if (speaker.voice) voices[speaker.id] = true;
    }
    const nextVoiceOf = {};
    for (const point of points) {
        const speaker = assigned.speakers[point.speaker];
        if (speaker && speaker.voice) nextVoiceOf[point.key] = speaker.id;
        delete point.group;
        delete point.pinned;
    }
    const tally = (state && state.tally) || {};
    assigned.speakers = assigned.speakers.map(({ voice, margin, ...speaker }) => {
        const past = tally[speaker.id];
        return past
            ? { ...speaker, segments: speaker.segments + past.segments, seconds: speaker.seconds + past.seconds }
            : speaker;
    });
    const next = { ...state, points, ...assigned, aliases, voiceOf: nextVoiceOf, voices };
    const labelled = !!(state && state.labelled) || voicesAndStrays(next).voices >= 2;
    const shown = Array.isArray(state && state.shown) ? state.shown : [];
    return { ...next, labelled, shown: labelled ? numberNewVoices(next, shown) : shown };
}

function assignIdentities(state, speakers, sameSpeaker) {
    const registry = ((state && state.registry) || []).map(entry => ({ ...entry }));
    let nextId = Math.max(1, Number(state && state.nextId) || 1);

    const takenSpeaker = new Set();
    const takenEntry = new Set();
    speakers.forEach((speaker, si) => {
        if (speaker.id == null) return;
        takenSpeaker.add(si);
        let ri = registry.findIndex(entry => entry.id === speaker.id);
        if (ri < 0) {
            registry.push({ id: speaker.id, vec: speaker.vec });
            ri = registry.length - 1;
        }
        registry[ri].vec = speaker.vec;
        takenEntry.add(ri);
    });

    const pairs = [];
    speakers.forEach((speaker, si) => {
        if (takenSpeaker.has(si)) return;
        registry.forEach((entry, ri) => {
            if (!takenEntry.has(ri)) pairs.push({ si, ri, score: similarity(speaker.vec, entry.vec) });
        });
    });
    pairs.sort((a, b) => b.score - a.score);

    for (const pair of pairs) {
        if (pair.score < sameSpeaker) break;
        if (takenSpeaker.has(pair.si) || takenEntry.has(pair.ri)) continue;
        speakers[pair.si].id = registry[pair.ri].id;
        registry[pair.ri].vec = speakers[pair.si].vec;
        takenSpeaker.add(pair.si);
        takenEntry.add(pair.ri);
    }
    speakers.forEach((speaker, si) => {
        if (takenSpeaker.has(si)) return;
        speaker.id = nextId++;
        registry.push({ id: speaker.id, vec: speaker.vec });
    });

    return { speakers, registry, nextId, aliases: (state && state.aliases) || {},
             names: (state && state.names) || {},
             history: (state && state.history) || {} };
}

// How clearly two voice groups are two people: nothing where the clustering would merge them, the
// 60% bar where a single line would no longer count as the other group's voice, and all of it just
// beyond. The bar used to sit at 0.20, well below that boundary. Two people sharing one room, one
// microphone and one language score about 0.3 against each other, so a second voice the clustering
// had already told apart stayed unlabelled for as long as it spoke, while a podcast in another
// language cleared the bar at once.
export function voiceSeparation(score, { sameSpeaker = SAME_SPEAKER_SIMILARITY,
                                         mergeSimilarity = MERGE_SIMILARITY } = {}) {
    const margin = mergeSimilarity - sameSpeaker;
    if (!(margin > 0)) return score < sameSpeaker ? 1 : 0;
    return clamp01(SECOND_SPEAKER_THRESHOLD * (mergeSimilarity - score) / margin);
}

export function secondSpeakerProbability(state, {
    sameSpeaker = SAME_SPEAKER_SIMILARITY,
    mergeSimilarity = MERGE_SIMILARITY,
    minSegments = MIN_SEGMENTS_PER_SPEAKER,
    minSeconds = MIN_SECONDS_PER_SPEAKER
} = {}) {
    const speakers = (state && state.speakers) || [];
    if (speakers.length < 2) return 0;

    const evidenceOf = speaker => Math.min(
        clamp01(speaker.segments / minSegments),
        clamp01(speaker.seconds / minSeconds)
    );

    let best = 0;
    for (let a = 0; a < speakers.length; a++) {
        for (let b = a + 1; b < speakers.length; b++) {
            const separation = voiceSeparation(similarity(speakers[a].vec, speakers[b].vec),
                                               { sameSpeaker, mergeSimilarity });
            const support = Math.min(evidenceOf(speakers[a]), evidenceOf(speakers[b]));
            best = Math.max(best, Math.min(separation, support));
        }
    }
    return clamp01(best);
}

export function speakerProbabilities(state, options = {}) {
    const probability = secondSpeakerProbability(state, options);
    const seen = new Set();
    return ((state && state.speakers) || []).map(speaker => ({
        index: speaker.index,
        id: resolveIdentity(state, speaker.id),
        label: speakerLabel(shownNumber(state, speaker.id)),
        probability,
        segments: speaker.segments,
        seconds: speaker.seconds
    })).filter(item => { if (seen.has(item.id)) return false; seen.add(item.id); return true; });
}

export const MIN_LINES_PER_VOICE = 2;

// How many lines each speaker has said, by the identity they are shown under: the lines of the
// current window (which already include the retired lines of a speaker still in it), and the
// retired lines of a speaker who has none left in the window.
export function linesByIdentity(state) {
    const out = new Map();
    const add = (id, count) => {
        if (id == null || !(count > 0)) return;
        const who = resolveIdentity(state, id);
        out.set(who, (out.get(who) || 0) + count);
    };
    const present = new Set();
    for (const speaker of ((state && state.speakers) || [])) {
        present.add(Number(speaker.id));
        add(speaker.id, Number(speaker.segments) || 0);
    }
    for (const [id, past] of Object.entries((state && state.tally) || {})) {
        if (!present.has(Number(id))) add(Number(id), Number(past && past.segments) || 0);
    }
    return out;
}

// Whether an identity is a voice: one that has said two lines that belong together at some point
// in the session (recluster keeps the record). A state without that record, built by hand, counts
// the lines it holds now.
function voiceTest(state, minLines = MIN_LINES_PER_VOICE) {
    const recorded = state && state.voices;
    if (!recorded) {
        const said = linesByIdentity(state);
        return id => (said.get(id) || 0) >= minLines;
    }
    const known = new Set(Object.keys(recorded).map(key => resolveIdentity(state, Number(key))));
    return id => known.has(id);
}

// The voices that have lines in the session, by the identity they are shown under, in the order of
// their numbers.
export function voicesOf(state, { minLines = MIN_LINES_PER_VOICE } = {}) {
    const isVoice = voiceTest(state, minLines);
    const voices = [...linesByIdentity(state).keys()].filter(id => isVoice(id));
    return voices.sort((a, b) => shownNumber(state, a) - shownNumber(state, b));
}

// Where each identity first speaks, as a position in the session: lines that have left the
// regrouping window came before every line still in it.
function firstHeard(state) {
    const first = new Map();
    for (const id of Object.keys((state && state.tally) || {})) {
        const who = resolveIdentity(state, Number(id));
        if (!first.has(who)) first.set(who, -1);
    }
    const byIndex = new Map(((state && state.speakers) || []).map(speaker => [speaker.index, speaker.id]));
    ((state && state.points) || []).forEach((point, at) => {
        const id = byIndex.get(point.speaker);
        if (id == null) return;
        const who = resolveIdentity(state, Number(id));
        if (!first.has(who)) first.set(who, at);
    });
    return first;
}

function byFirstHeard(state) {
    const first = firstHeard(state);
    const at = id => (first.has(id) ? first.get(id) : Infinity);
    return (a, b) => at(a) - at(b) || a - b;
}

// Once numbers are shown, a voice that has none yet takes the next one; voices that get theirs at
// the same moment, as the first two do, take them in the order they first spoke. A number already
// on screen never changes for a newcomer.
function numberNewVoices(state, shown) {
    const numbered = new Set(shown.map(id => resolveIdentity(state, Number(id))));
    const isVoice = voiceTest(state);
    const fresh = [...linesByIdentity(state).keys()].filter(id => isVoice(id) && !numbered.has(id));
    return fresh.length ? [...shown, ...fresh.sort(byFirstHeard(state))] : shown;
}

// Speaker numbers are what the transcript shows, and they count 1, 2, 3 in the order voices were
// first shown with one. They are not the identities the clustering keeps: a group of lines takes
// an identity before it is known to be a voice, most such groups never become one, and Build 132
// showed identities, so the first person on screen could be Speaker 2 and the third Speaker 5.
// When two voices become one, the joined voice keeps the lower number and every voice after it
// moves up one, so the numbers on screen never skip one. Before numbers are shown, voices follow
// in the order they first spoke, and groups that are not a voice come last. A state from before
// Build 133, or built by hand, shows identities as it always did.
export function shownNumbers(state) {
    const out = new Map();
    if (!state || !Array.isArray(state.shown)) return out;
    const present = linesByIdentity(state);
    for (const raw of state.shown) {
        const id = resolveIdentity(state, Number(raw));
        if (present.has(id) && !out.has(id)) out.set(id, out.size + 1);
    }
    const rest = [...present.keys()].filter(id => !out.has(id));
    if (!rest.length) return out;
    const isVoice = voiceTest(state);
    const order = byFirstHeard(state);
    for (const id of [...rest.filter(id => isVoice(id)).sort(order), ...rest.filter(id => !isVoice(id)).sort(order)]) {
        out.set(id, out.size + 1);
    }
    return out;
}

// The number one speaker is shown under. Every line on screen asks, so the voices already shown
// are counted without ordering the rest. An identity with no lines keeps its own number.
export function shownNumber(state, id) {
    const target = resolveIdentity(state, Number(id));
    if (!state || !Array.isArray(state.shown)) return target;
    const present = linesByIdentity(state);
    const counted = new Set();
    for (const raw of state.shown) {
        const who = resolveIdentity(state, Number(raw));
        if (!present.has(who) || counted.has(who)) continue;
        counted.add(who);
        if (who === target) return counted.size;
    }
    const number = shownNumbers(state).get(target);
    return number == null ? target : number;
}

function voicesAndStrays(state, minLines = MIN_LINES_PER_VOICE) {
    const isVoice = voiceTest(state, minLines);
    let voices = 0;
    let strays = 0;
    for (const id of linesByIdentity(state).keys()) {
        if (isVoice(id)) voices++;
        else strays++;
    }
    return { voices, strays };
}

// Speaker numbers are shown once two voices have spoken, and from then on for the rest of the
// session: Build 131 took them away again whenever a regrouping merged the voices back into one.
// The voices are the clustering's own groups; a line alone in its group is not a voice yet, so a
// stray line in a monologue numbers nothing.
export function labelsEarned(state, { minLines = MIN_LINES_PER_VOICE } = {}) {
    return !!(state && state.labelled) || voicesAndStrays(state, minLines).voices >= 2;
}

export function diarizationStats(state, options = {}) {
    const points = (state && state.points) || [];
    const speakers = (state && state.speakers) || [];
    let closest = null;
    for (let a = 0; a < speakers.length; a++) {
        for (let b = a + 1; b < speakers.length; b++) {
            const score = similarity(speakers[a].vec, speakers[b].vec);
            if (closest == null || score > closest) closest = score;
        }
    }
    const { voices, strays } = voicesAndStrays(state);
    return {
        samples: points.length,
        clusters: speakers.length,
        voices,
        strays,
        labelled: labelsEarned(state),
        closest,
        probability: secondSpeakerProbability(state, options),
        threshold: options.threshold == null ? SECOND_SPEAKER_THRESHOLD : options.threshold,
        sameSpeaker: options.sameSpeaker == null ? SAME_SPEAKER_SIMILARITY : options.sameSpeaker
    };
}

export function describeDiarization(stats) {
    if (!stats || stats.samples === 0) {
        return '🗣️ no voice data - the server is sending no embeddings';
    }
    const strays = Number(stats.strays) || 0;
    const strayNote = strays ? ` · ${strays} stray line${strays === 1 ? '' : 's'}` : '';
    if (stats.labelled) {
        return `🗣️ ${stats.voices} speakers · ${Math.round(stats.probability * 100)}% sure${strayNote}`;
    }
    if (stats.voices === 0 && stats.clusters > 1) {
        return `🗣️ no voice with two lines yet · ${stats.samples} samples`;
    }
    return `🗣️ one voice so far${strayNote} · ${stats.samples} samples`;
}

export function speakerLabel(id) {
    return `Speaker ${Math.max(1, Number(id) || 1)}`;
}

export function attributionByKey(state, keys = null) {
    const byIndex = new Map(((state && state.speakers) || [])
        .map(speaker => [speaker.index, resolveIdentity(state, speaker.id)]));
    const frozen = (state && state.frozen) || {};
    const live = new Map(((state && state.points) || [])
        .map(point => [point.key, byIndex.get(point.speaker)]));
    const wanted = keys || [...Object.keys(frozen), ...live.keys()];
    const out = new Map();
    for (const key of wanted) {
        if (live.has(key)) out.set(key, live.get(key));
        else if (frozen[key] != null) out.set(key, resolveIdentity(state, Number(frozen[key])));
    }
    return out;
}

export function decorateLines(lines, state, { everyLine = true, minLines = MIN_LINES_PER_VOICE } = {}) {
    const list = lines || [];
    if (!labelsEarned(state, { minLines })) {
        return list.map(line => ({ ...line, speaker: null, showSpeaker: false }));
    }
    const isVoice = voiceTest(state, minLines);
    const bySpeaker = attributionByKey(state, list.map(line => line.key));
    let previous = null;
    return list.map(line => {
        const own = bySpeaker.get(line.key);
        // A line whose group is not a voice yet is shown, like a line without a voiceprint, with
        // the speaker before it until its group becomes one.
        const speaker = own != null && isVoice(own) ? own : previous;
        const showSpeaker = speaker != null && (everyLine || speaker !== previous);
        if (speaker != null) previous = speaker;
        return { ...line, speaker, showSpeaker };
    });
}
