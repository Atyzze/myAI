export const PROPOSE_SCORE = 1;
export const PROPOSE_MARGIN = 0.5;
export const PROPOSAL_TTL_SEC = 600;

const NUMBER_WORDS = {
    one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
    een: 1, één: 1, twee: 2, drie: 3, vier: 4, vijf: 5, zes: 6, zeven: 7, acht: 8
};

const WHO = '(?:speaker|spreker)';
const VERB = '(?:confirm|confirmed|bevestig|bevestigd)';
const NUMBER = '([0-9]+|[a-zéë]+)';

const VERB_FIRST = new RegExp(`^${VERB}\\s+${WHO}\\s+${NUMBER}$`, 'i');
const WHO_FIRST = new RegExp(`^${WHO}\\s+${NUMBER}\\s+${VERB}$`, 'i');
const BARE = new RegExp(`^${VERB}$`, 'i');

export function speakerNumber(token) {
    const said = String(token || '').trim().toLowerCase();
    if (!said) return null;
    if (/^[0-9]+$/.test(said)) {
        const value = Number(said);
        return Number.isInteger(value) && value > 0 ? value : null;
    }
    return NUMBER_WORDS[said] || null;
}

export function sentences(text) {
    return String(text || '')
        .split(/[.?!\n]+/)
        .map(part => part.replace(/[,;:"'‘’“”]+/g, ' ').replace(/\s+/g, ' ').trim())
        .filter(Boolean);
}

export function parseConfirm(text, pendingIds = []) {
    const pending = [...new Set((pendingIds || []).map(Number).filter(Number.isInteger))];
    for (const sentence of sentences(text)) {
        const match = sentence.match(VERB_FIRST) || sentence.match(WHO_FIRST);
        if (match) {
            const id = speakerNumber(match[1]);
            if (id != null) return { id, form: 'explicit' };
            continue;
        }
        if (!BARE.test(sentence)) continue;
        if (pending.length === 1) return { id: pending[0], form: 'bare' };
        if (pending.length > 1) return { id: null, form: 'ambiguous' };
    }
    return null;
}

export function promotable(candidate) {
    if (!candidate) return false;
    const score = Number(candidate.score);
    const self = Number(candidate.self);
    const runnerUp = Number(candidate.runnerUp || 0);
    if (!Number.isFinite(score) || score < PROPOSE_SCORE) return false;
    if (!Number.isFinite(self) || self <= 0) return false;
    if (Number.isFinite(runnerUp) && score - runnerUp < PROPOSE_MARGIN) return false;
    return true;
}

export function proposalSubject(command) {
    if (!command) return null;
    if (command.type === 'name') return Number(command.id);
    if (command.type === 'merge') return Number(command.from);
    return null;
}

export function proposalKey(command) {
    const subject = proposalSubject(command);
    if (subject == null) return null;
    if (command.type === 'name') return `name:${subject}:${String(command.name || '').toLowerCase()}`;
    return `merge:${subject}:${Number(command.to)}`;
}

export function nextProposals(previous, commands, nowSec = 0) {
    const kept = new Map();
    for (const proposal of (previous || [])) {
        if (nowSec - proposal.atSec > PROPOSAL_TTL_SEC) continue;
        kept.set(proposalSubject(proposal.command), proposal);
    }
    for (const command of (commands || [])) {
        const subject = proposalSubject(command);
        if (subject == null) continue;
        const key = proposalKey(command);
        const standing = kept.get(subject);
        if (standing && proposalKey(standing.command) === key) continue;
        kept.set(subject, { command, key, atSec: nowSec });
    }
    return [...kept.values()].sort((a, b) => proposalSubject(a.command) - proposalSubject(b.command));
}

export function takeProposal(proposals, id) {
    const list = proposals || [];
    const found = list.find(proposal => proposalSubject(proposal.command) === Number(id));
    return { proposal: found || null, rest: list.filter(proposal => proposal !== found) };
}

export function dropSubject(proposals, id) {
    return (proposals || []).filter(proposal => proposalSubject(proposal.command) !== Number(id));
}

// A suggestion names speakers by the numbers on screen: numberOf turns the identity a command is
// about into the number that speaker is shown under.
export function describeProposal(proposal, numberOf = id => id) {
    const command = proposal && proposal.command;
    if (!command) return '';
    const subject = numberOf(proposalSubject(command));
    if (command.type === 'name') {
        return `Speaker ${subject} → "${command.name}"? say "confirm speaker ${subject}"`;
    }
    return `Speaker ${subject} may be Speaker ${numberOf(command.to)}? say "confirm speaker ${subject}" to join them`;
}

// "confirm speaker N" means the suggestion that was announced for Speaker N. Numbers on screen
// move up when two voices become one, so a suggestion keeps the number it was announced with;
// when two were announced with the same number, the latest is meant.
export function proposalForNumber(proposals, number, numberOf = id => id) {
    const wanted = Number(number);
    let found = null;
    for (const proposal of (proposals || [])) {
        const announced = proposal.number != null ? proposal.number : numberOf(proposalSubject(proposal.command));
        if (announced !== wanted) continue;
        if (!found || (Number(proposal.atSec) || 0) >= (Number(found.atSec) || 0)) found = proposal;
    }
    return found;
}

export function describeConfirmResult({ id, applied, echo, pending }) {
    if (id == null) {
        return pending > 1
            ? 'more than one suggestion is waiting; say which, e.g. "confirm speaker 2"'
            : 'nothing is waiting to be confirmed';
    }
    if (!applied) return `nothing is waiting to be confirmed for Speaker ${id}`;
    return echo ? `${echo} · confirmed` : `Speaker ${id} confirmed`;
}
