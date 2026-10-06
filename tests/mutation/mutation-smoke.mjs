import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { emitTestResult } from '../helpers/test-result.mjs';
import { applyMutation, checkMutationTable, mutationWorkerCount, guardVerdict, outputTail,
         GUARD_TIMEOUT_MS } from '../helpers/mutation-core.mjs';
import { mutations } from './guards.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const contract = JSON.parse(fs.readFileSync(path.join(root, 'tests/baseline-contract.json'), 'utf8'));
const startedAt = Date.now();

const table = checkMutationTable(mutations, {
    readSource: file => fs.readFileSync(path.join(root, file), 'utf8'),
    contractGuards: contract.contracts.flatMap(item => item.mutationGuards || [])
});
if (table.problems.length) {
    console.error(`✗ the mutation table has ${table.problems.length} problem(s); no guard was run:`);
    for (const problem of table.problems) console.error(`  - ${problem}`);
    process.exit(1);
}

const cores = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
const workers = mutationWorkerCount(process.env.MYAI_MUTATION_WORKERS, cores, mutations.length);

function copyTree(from, to) {
    fs.mkdirSync(to, { recursive: true });
    const fast = process.platform === 'win32' ? null : spawnSync('cp', ['-a', `${from}/.`, to], { encoding: 'utf8' });
    if (!fast || fast.status !== 0) {
        fs.rmSync(to, { recursive: true, force: true });
        fs.cpSync(from, to, { recursive: true });
    }
}

function runGuard(mutation, tree) {
    const target = path.join(tree, mutation.file);
    const before = fs.readFileSync(target, 'utf8');
    fs.writeFileSync(target, applyMutation(mutation, before).after);
    const started = Date.now();
    return new Promise(resolve => {
        let output = '';
        let timedOut = false;
        let spawnError = null;
        const [command, ...args] = mutation.command;
        const child = spawn(command, args, {
            cwd: tree,
            env: { ...process.env, MYAI_STRICT_TESTS: '1' },
            stdio: ['ignore', 'pipe', 'pipe']
        });
        const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, GUARD_TIMEOUT_MS);
        child.stdout.on('data', chunk => { output += chunk; });
        child.stderr.on('data', chunk => { output += chunk; });
        child.on('error', err => { spawnError = err.message; });
        child.on('close', exitCode => {
            clearTimeout(timer);
            fs.writeFileSync(target, before);
            const verdict = guardVerdict({ exitCode, timedOut, spawnError, output }, mutation.expected);
            resolve({ id: mutation.id, ...verdict, output, ms: Date.now() - started });
        });
    });
}

const outcomes = new Array(mutations.length);
let printed = 0;
function printReady() {
    while (printed < outcomes.length && outcomes[printed]) {
        const outcome = outcomes[printed++];
        console.log(outcome.ok
            ? `✓ ${outcome.id} detected (${(outcome.ms / 1000).toFixed(1)} s)`
            : `✗ ${outcome.id}: ${outcome.reason}`);
    }
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myai-mutations-'));
try {
    const trees = [path.join(tempRoot, 'tree-0')];
    copyTree(root, trees[0]);
    for (const leftover of ['artifacts', '.git', '.release_journal.json']) {
        fs.rmSync(path.join(trees[0], leftover), { recursive: true, force: true });
    }
    for (let i = 1; i < workers; i++) {
        trees.push(path.join(tempRoot, `tree-${i}`));
        copyTree(trees[0], trees[i]);
    }
    console.log(`Running ${mutations.length} mutation guards with ${workers} worker(s)`);
    let next = 0;
    await Promise.all(trees.map(async tree => {
        while (next < mutations.length) {
            const index = next++;
            outcomes[index] = await runGuard(mutations[index], tree);
            printReady();
        }
    }));
} finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
}

const failures = outcomes.filter(outcome => !outcome.ok);
const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
if (failures.length) {
    console.error(`\n✗ ${failures.length} of ${mutations.length} mutation guards failed:`);
    for (const failure of failures) {
        console.error(`\n--- ${failure.id}: ${failure.reason}\n${outputTail(failure.output)}`);
    }
    process.exit(1);
}

const assertions = table.checks + mutations.length * 2;
console.log(`✓ all ${mutations.length} mutation guards detected in ${seconds} s with ${workers} worker(s)`);
emitTestResult('mutation-guards', 'pass', {
    assertions, mutations: mutations.length, workers, durationMs: Date.now() - startedAt
});
