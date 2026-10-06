export function classifySuiteOutcome({ exitCode, markerStatus, portable = false, timedOut = false }) {
    if (timedOut || exitCode !== 0) return 'fail';
    if (markerStatus === 'skip') return portable ? 'skip' : 'fail';
    if (markerStatus === 'pass') return 'pass';
    return 'fail';
}

export function baselineSucceeded({ results, expectedCount, portable = false }) {
    if (!Array.isArray(results) || results.length !== expectedCount) return false;
    if (results.some(item => item.status === 'fail')) return false;
    if (!portable && results.some(item => item.status === 'skip')) return false;
    return results.every(item => item.status === 'pass' || (portable && item.status === 'skip'));
}

export const QUICK_TIERS = Object.freeze(['unit', 'contract', 'static']);
export const OVERLAP_MIN_JOBS = 4;
export const OVERLAP_RESERVED_JOBS = 3;
export const MAX_PLANNED_MUTATION_WORKERS = 8;

export function baselineJobs(requested, cores) {
    const asked = Math.floor(Number(requested));
    if (Number.isFinite(asked) && asked >= 1) return asked;
    return Math.max(1, Math.floor(Number(cores) || 1));
}

export function planBaseline(suites, { jobs = 1 } = {}) {
    const width = Math.max(1, Math.floor(Number(jobs) || 1));
    const quick = suites.filter(suite => QUICK_TIERS.includes(suite.tier));
    const mutation = suites.filter(suite => suite.tier === 'mutation');
    const slow = suites.filter(suite => !quick.includes(suite) && !mutation.includes(suite));
    const stages = [];
    if (quick.length) {
        stages.push({ name: 'quick', concurrency: Math.min(width, quick.length), lanes: quick.map(suite => [suite]) });
    }
    if (width >= OVERLAP_MIN_JOBS) {
        const lanes = [...slow.map(suite => [suite]), ...(mutation.length ? [mutation] : [])];
        if (lanes.length) stages.push({ name: 'together', concurrency: lanes.length, lanes });
        const mutationWorkers = Math.max(1, Math.min(MAX_PLANNED_MUTATION_WORKERS, width - OVERLAP_RESERVED_JOBS));
        return { jobs: width, stages, mutationWorkers };
    }
    if (slow.length) stages.push({ name: 'integration', concurrency: 1, lanes: [slow] });
    if (mutation.length) stages.push({ name: 'mutation', concurrency: 1, lanes: [mutation] });
    return { jobs: width, stages, mutationWorkers: width };
}

export function plannedSuites(plan) {
    return plan.stages.flatMap(stage => stage.lanes.flat());
}

export function describeDuration(ms) {
    const seconds = Math.max(0, Math.round((Number(ms) || 0) / 1000));
    if (seconds < 60) return `${seconds} s`;
    return `${Math.floor(seconds / 60)} min ${String(seconds % 60).padStart(2, '0')} s`;
}

export function slowestSuites(results, count = 3) {
    return [...(results || [])]
        .filter(item => Number.isFinite(item.durationMs))
        .sort((a, b) => b.durationMs - a.durationMs)
        .slice(0, count);
}
