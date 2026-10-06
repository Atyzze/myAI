import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASELINE_SUITES } from '../helpers/baseline-suites.mjs';
import { emitTestResult } from '../helpers/test-result.mjs';
import { mutations } from '../mutation/guards.mjs';

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
    ok(typeof item.title === 'string' && item.title.length >= 20, `${item.id} states what it guarantees`);
    ok(Array.isArray(item.suites) && item.suites.length > 0, `${item.id} maps to executable suites`);
    for (const suiteId of item.suites) ok(suiteIds.has(suiteId), `${item.id} references registered suite ${suiteId}`);
    for (const guard of item.mutationGuards || []) {
        ok(typeof guard === 'string' && guard.startsWith('MUT-'), `${guard} is a valid mutation guard`);
        ok(!mutationIds.has(guard), `${guard} is unique`);
        mutationIds.add(guard);
    }
}

for (const suite of BASELINE_SUITES.filter(item => item.required)) {
    ok(contract.contracts.some(item => item.suites.includes(suite.id)), `${suite.id} is claimed by at least one contract`);
}

// A guard that only static-integrity catches is caught by reading the source text, which can pass
// while the behaviour it stands for is broken. Their number may only go down: the ceiling is lowered
// whenever a guard moves to a suite that runs the code, so the room it leaves cannot be spent again.
const staticOnly = mutations.filter(item => item.command.join(' ') === 'node tests/unit/static.test.mjs').length;
const ceiling = contract.rules?.staticOnlyGuardCeiling;
ok(Number.isInteger(ceiling) && ceiling >= 0, 'the contract records how many guards may be checked only by reading source text');
ok(staticOnly <= ceiling,
   `no more guards are checked only by reading source text than the ceiling allows (${staticOnly}, ceiling ${ceiling})`);
ok(staticOnly === ceiling,
   `the ceiling is lowered as guards move to suites that run the code, so it cannot be spent again (${staticOnly}, ceiling ${ceiling})`);

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
ok(contract.strictCommand === 'npm test' && pkg.scripts?.test === 'node tests/run-baseline.mjs',
   'the strict command the contract names is the gate package.json runs');
ok(contract.portableCommand === 'npm run test:portable' && pkg.scripts?.['test:portable'] === 'node tests/run-baseline.mjs --portable',
   'and so is the portable one');

const gateScripts = new Set(BASELINE_SUITES.map(suite => suite.command.slice(1).join(' ')));
const listed = (dir, suffix) => fs.readdirSync(path.join(root, dir))
    .filter(name => name.endsWith(suffix)).map(name => `${dir}/${name}`);
for (const file of [...listed('tests/unit', '.test.mjs'), ...listed('tests/integration', '-integration.mjs'),
                    'tests/check-syntax.mjs', 'tests/mutation/mutation-smoke.mjs']) {
    ok(gateScripts.has(file), `${file} runs in the gate, so a test written there cannot be silently left out`);
}

const suiteOfCommand = new Map(BASELINE_SUITES.map(suite => [suite.command.join(' '), suite.id]));
const contractOfGuard = new Map(contract.contracts.flatMap(item => (item.mutationGuards || []).map(id => [id, item])));
for (const guard of mutations) {
    const suiteId = suiteOfCommand.get((guard.command || []).join(' '));
    ok(suiteId, `${guard.id} runs a suite of the gate`);
    const owner = contractOfGuard.get(guard.id);
    ok(owner && owner.suites.includes(suiteId),
       `${guard.id} is caught by ${suiteId}, and its contract ${owner ? owner.id : '(none)'} names that suite`);
}

console.log(`✓ all ${assertions} baseline-contract assertions passed`);
emitTestResult('baseline-contract', 'pass', {
    assertions,
    contracts: contract.contracts.length
});
