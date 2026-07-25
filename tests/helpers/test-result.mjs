/** Machine-readable test result marker consumed by tests/run-baseline.mjs. */
export const TEST_RESULT_PREFIX = 'MYAI_TEST_RESULT ';

export function emitTestResult(suite, status, details = {}) {
    const payload = {
        suite,
        status,
        ...details
    };
    console.log(`${TEST_RESULT_PREFIX}${JSON.stringify(payload)}`);
    return payload;
}

export function strictTestsRequired() {
    return process.env.MYAI_STRICT_TESTS === '1';
}
