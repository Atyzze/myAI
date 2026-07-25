/** Pure outcome rules for the compatibility-baseline runner. */
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
