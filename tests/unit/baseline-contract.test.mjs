/* Validate the machine-readable compatibility contract and its executable suite mapping. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASELINE_SUITES } from '../helpers/baseline-suites.mjs';
import { emitTestResult } from '../helpers/test-result.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const contract = JSON.parse(fs.readFileSync(path.join(root, 'tests/baseline-contract.json'), 'utf8'));
let assertions = 0;
function ok(value, message) {
    assertions++;
    if (!value) throw new Error(`Assertion failed: ${message}`);
}

ok(contract.schemaVersion === 1, 'contract schema version is supported');
ok(contract.baseline === 'myAI-v30', 'contract names the current application baseline');
ok(contract.rules?.strictSkipsAllowed === false, 'strict baseline forbids skipped suites');
ok(Array.isArray(contract.contracts) && contract.contracts.length >= 10, 'contract defines a broad executable baseline');

const suiteIds = new Set(BASELINE_SUITES.map(suite => suite.id));
ok(suiteIds.size === BASELINE_SUITES.length, 'registered suite IDs are unique');
for (const suite of BASELINE_SUITES) {
    ok(Array.isArray(suite.command) && suite.command.length >= 2, `${suite.id} has an executable command`);
    ok(Number.isFinite(suite.timeoutMs) && suite.timeoutMs >= 10000, `${suite.id} has a finite hang timeout`);
    const script = suite.command[1];
    ok(fs.existsSync(path.join(root, script)), `${suite.id} command target exists`);
}

const contractIds = new Set();
const mutationIds = new Set();
for (const item of contract.contracts) {
    ok(/^[-A-Z0-9]+$/.test(item.id), `${item.id} uses a stable machine ID`);
    ok(!contractIds.has(item.id), `${item.id} is unique`);
    contractIds.add(item.id);
    ok(typeof item.acceptance === 'string' && item.acceptance.length >= 40, `${item.id} has explicit acceptance criteria`);
    ok(Array.isArray(item.suites) && item.suites.length > 0, `${item.id} maps to executable suites`);
    for (const suiteId of item.suites) ok(suiteIds.has(suiteId), `${item.id} references registered suite ${suiteId}`);
    if (item.severity === 'critical') {
        ok(Array.isArray(item.mutationGuards) && item.mutationGuards.length > 0, `${item.id} has mutation guards`);
        for (const guard of item.mutationGuards) {
            ok(typeof guard === 'string' && guard.startsWith('MUT-'), `${guard} is a valid mutation guard`);
            ok(!mutationIds.has(guard), `${guard} is unique`);
            mutationIds.add(guard);
        }
    }
}

for (const suite of BASELINE_SUITES.filter(item => item.required)) {
    ok(contract.contracts.some(item => item.suites.includes(suite.id)), `${suite.id} is claimed by at least one contract`);
}

ok(Array.isArray(contract.predefinedFutureGates) && contract.predefinedFutureGates.length >= 8,
   'additional regression gates are specified in advance');
const futureIds = new Set();
for (const item of contract.predefinedFutureGates) {
    ok(!contractIds.has(item.id) && !futureIds.has(item.id), `${item.id} is a unique future gate`);
    futureIds.add(item.id);
    ok(typeof item.acceptance === 'string' && item.acceptance.length >= 40, `${item.id} has testable acceptance criteria`);
}

console.log(`✓ all ${assertions} baseline-contract assertions passed`);
emitTestResult('baseline-contract', 'pass', {
    assertions,
    contracts: contract.contracts.length,
    futureGates: contract.predefinedFutureGates.length
});
