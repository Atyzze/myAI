export const GUARD_TIMEOUT_MS = 30000;
export const MAX_MUTATION_WORKERS = 8;

export function applyMutation(mutation, source) {
    if (typeof mutation.transform === 'function') {
        let after;
        try {
            after = mutation.transform(source);
        } catch (err) {
            return { after: null, problem: `its transform throws: ${err && err.message ? err.message : err}` };
        }
        if (typeof after !== 'string') return { after: null, problem: 'its transform does not return text' };
        if (after === source) return { after: null, problem: 'its transform changes nothing' };
        return { after, problem: null };
    }
    if (typeof mutation.from !== 'string' || mutation.from === '') {
        return { after: null, problem: 'it has neither an anchor nor a transform' };
    }
    const occurrences = source.split(mutation.from).length - 1;
    if (occurrences !== 1) {
        return { after: null, problem: `its anchor occurs ${occurrences} times in ${mutation.file}, not exactly once` };
    }
    if (typeof mutation.to !== 'string') return { after: null, problem: 'it has no replacement text' };
    return { after: source.replace(mutation.from, () => mutation.to), problem: null };
}

export function checkMutationTable(mutations, { readSource, contractGuards = [] } = {}) {
    const problems = [];
    let checks = 0;
    const check = (value, problem) => {
        checks++;
        if (!value) problems.push(problem);
    };
    const seen = new Set();
    for (const [index, mutation] of (mutations || []).entries()) {
        const id = mutation && mutation.id;
        const name = typeof id === 'string' && id ? id : `guard #${index + 1}`;
        check(typeof id === 'string' && /^MUT-[-A-Z0-9]+$/.test(id), `${name} has no stable MUT- identifier`);
        check(!seen.has(id), `${name} is listed twice`);
        seen.add(id);
        check(Array.isArray(mutation.command) && mutation.command.length >= 2
              && mutation.command.every(part => typeof part === 'string'),
              `${name} has no command to run`);
        check(mutation.expected instanceof RegExp, `${name} does not say which failure it expects`);
        let source = null;
        try {
            source = readSource(mutation.file);
        } catch (_) {
            source = null;
        }
        check(typeof source === 'string', `${name} mutates ${mutation.file}, which cannot be read`);
        if (typeof source !== 'string') continue;
        const { problem } = applyMutation(mutation, source);
        check(!problem, `${name}: ${problem}`);
    }
    const listed = new Set(contractGuards);
    for (const id of listed) check(seen.has(id), `${id} is listed in a contract but not implemented`);
    for (const id of seen) {
        if (typeof id === 'string') check(listed.has(id), `${id} is implemented but no contract lists it`);
    }
    return { problems, checks };
}

export function mutationWorkerCount(requested, cores, guards) {
    const cap = Math.max(1, Math.floor(Number(guards) || 1));
    const asked = Math.floor(Number(requested));
    if (Number.isFinite(asked) && asked >= 1) return Math.min(asked, cap);
    const available = Math.max(1, Math.floor(Number(cores) || 1));
    return Math.min(available, MAX_MUTATION_WORKERS, cap);
}

export function guardVerdict({ exitCode = null, timedOut = false, spawnError = null, output = '' }, expected) {
    if (spawnError) return { ok: false, reason: `could not run its suite: ${spawnError}` };
    if (timedOut) return { ok: false, reason: `its suite did not finish within ${GUARD_TIMEOUT_MS / 1000} s` };
    if (exitCode === 0) return { ok: false, reason: 'survived: its suite still passes with the mutation in place' };
    if (!(expected instanceof RegExp) || !expected.test(output)) {
        return { ok: false, reason: 'its suite failed, but not for the invariant the guard names' };
    }
    return { ok: true, reason: 'detected' };
}

export function outputTail(output, lines = 12) {
    return String(output || '').trimEnd().split(/\r?\n/).slice(-lines).join('\n');
}
