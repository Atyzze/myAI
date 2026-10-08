// The assertion helpers every suite uses: failures are collected rather than thrown, so one run
// lists every broken expectation, and the last line is the machine-readable result the gate reads.

export function suite(name) {
    let passed = 0;
    const failures = [];
    const ok = (condition, message) => {
        if (condition) passed++;
        else failures.push(`✗ ${message}`);
        return !!condition;
    };
    const eq = (actual, expected, message) => {
        const a = JSON.stringify(actual);
        const e = JSON.stringify(expected);
        if (a === e) { passed++; return true; }
        failures.push(`✗ ${message}\n    expected ${e}\n    got      ${a}`);
        return false;
    };
    const finish = (extra = {}) => {
        if (failures.length) {
            console.log(`${passed} passed, ${failures.length} FAILED:\n`);
            console.log(failures.join('\n'));
            console.log(`MYAI_TEST_RESULT ${JSON.stringify({ suite: name, status: 'fail', assertions: passed + failures.length, failed: failures.length, ...extra })}`);
            process.exit(1);
        }
        console.log(`✓ all ${passed} ${name} assertions passed`);
        console.log(`MYAI_TEST_RESULT ${JSON.stringify({ suite: name, status: 'pass', assertions: passed, ...extra })}`);
        process.exit(0);
    };
    return { ok, eq, finish, get passed() { return passed; } };
}
