// In the strict gate (npm test) a missing external tool fails a suite; the portable gate may skip it.
export function strictTests(env = process.env) {
    return env.MYAI_STRICT_TESTS === '1';
}
