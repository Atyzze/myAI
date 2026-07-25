/* Pure checks for strict/portable baseline outcome classification. */
import { classifySuiteOutcome, baselineSucceeded } from '../helpers/baseline-core.mjs';
import { emitTestResult } from '../helpers/test-result.mjs';

let assertions = 0;
function ok(value, message) {
    assertions++;
    if (!value) throw new Error(`Assertion failed: ${message}`);
}

ok(classifySuiteOutcome({ exitCode: 0, markerStatus: 'pass' }) === 'pass', 'passing marked suite passes');
ok(classifySuiteOutcome({ exitCode: 0, markerStatus: 'skip', portable: false }) === 'fail', 'strict mode rejects a skipped suite');
ok(classifySuiteOutcome({ exitCode: 0, markerStatus: 'skip', portable: true }) === 'skip', 'portable mode records an explicit skip');
ok(classifySuiteOutcome({ exitCode: 0, markerStatus: null }) === 'fail', 'missing machine-readable result fails');
ok(classifySuiteOutcome({ exitCode: 1, markerStatus: 'pass' }) === 'fail', 'nonzero process exit wins over a pass marker');
ok(classifySuiteOutcome({ exitCode: 0, markerStatus: 'pass', timedOut: true }) === 'fail', 'hung suite killed by timeout fails');
ok(baselineSucceeded({ results: [{ status: 'pass' }, { status: 'pass' }], expectedCount: 2 }), 'complete strict pass succeeds');
ok(!baselineSucceeded({ results: [{ status: 'pass' }], expectedCount: 2 }), 'incomplete suite list fails');
ok(!baselineSucceeded({ results: [{ status: 'pass' }, { status: 'skip' }], expectedCount: 2 }), 'strict baseline cannot succeed with a skip');
ok(baselineSucceeded({ results: [{ status: 'pass' }, { status: 'skip' }], expectedCount: 2, portable: true }), 'portable diagnostics may succeed with an explicit skip');

console.log(`✓ all ${assertions} baseline-runner assertions passed`);
emitTestResult('baseline-runner-unit', 'pass', { assertions });
