import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { BASELINE_SUITES } from './helpers/baseline-suites.mjs';
import { TEST_RESULT_PREFIX } from './helpers/test-result.mjs';
import { classifySuiteOutcome, baselineSucceeded, baselineJobs, planBaseline, plannedSuites,
         describeDuration, slowestSuites } from './helpers/baseline-core.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const contractPath = path.join(root, 'tests', 'baseline-contract.json');
const baselineEpoch = JSON.parse(fs.readFileSync(contractPath, 'utf8')).baseline;
const args = new Set(process.argv.slice(2));
const portable = args.has('--portable');
const noMutation = args.has('--no-mutation');
const selected = BASELINE_SUITES.filter(suite => !(noMutation && suite.id === 'mutation-guards'));
const startedAt = new Date().toISOString();
const startedMs = Date.now();
const cores = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
const plan = planBaseline(selected, { jobs: baselineJobs(process.env.MYAI_TEST_JOBS, cores) });
if (plannedSuites(plan).length !== selected.length) throw new Error('the gate plan does not hold every selected suite exactly once');

function sourceTreeDigest() {
    const files = [];
    function walk(dir) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.name === '.git' || entry.name === 'artifacts') continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.isFile()) files.push(full);
        }
    }
    walk(root);
    files.sort((a, b) => path.relative(root, a).localeCompare(path.relative(root, b)));
    const aggregate = createHash('sha256');
    for (const file of files) {
        const rel = path.relative(root, file).split(path.sep).join('/');
        const digest = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
        aggregate.update(`${rel}\0${digest}\n`);
    }
    return { sha256: aggregate.digest('hex'), fileCount: files.length };
}

const sourceTreeBefore = sourceTreeDigest();

function suiteEnv(suite) {
    const env = { ...process.env, MYAI_STRICT_TESTS: portable ? '0' : '1' };
    if (suite.tier === 'mutation' && !process.env.MYAI_MUTATION_WORKERS) {
        env.MYAI_MUTATION_WORKERS = String(plan.mutationWorkers);
    }
    return env;
}

function runSuite(suite, { live }) {
    return new Promise(resolve => {
        const [command, ...commandArgs] = suite.command;
        const started = Date.now();
        if (live) console.log(`\n=== ${suite.id} (${suite.tier}) ===`);
        else console.log(`▶ ${suite.id} started`);
        const child = spawn(command, commandArgs, { cwd: root, env: suiteEnv(suite), stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        let transcript = '';
        let timedOut = false;
        const timeout = setTimeout(() => {
            timedOut = true;
            child.kill('SIGKILL');
        }, suite.timeoutMs || 60000);
        child.stdout.on('data', chunk => {
            const text = String(chunk);
            stdout += text;
            if (live) process.stdout.write(text); else transcript += text;
        });
        child.stderr.on('data', chunk => {
            const text = String(chunk);
            stderr += text;
            if (live) process.stderr.write(text); else transcript += text;
        });
        child.on('close', code => {
            clearTimeout(timeout);
            const durationMs = Date.now() - started;
            const markers = stdout.split(/\r?\n/)
                .filter(line => line.startsWith(TEST_RESULT_PREFIX))
                .map(line => {
                    try { return JSON.parse(line.slice(TEST_RESULT_PREFIX.length)); }
                    catch (_) { return null; }
                }).filter(Boolean);
            const marker = markers.find(item => item.suite === suite.id) || markers.at(-1) || null;
            const status = classifySuiteOutcome({
                exitCode: code, markerStatus: marker?.status || null, portable, timedOut
            });
            if (!live) {
                console.log(`\n=== ${suite.id} (${suite.tier}): ${status} in ${describeDuration(durationMs)} ===`);
                process.stdout.write(transcript);
            } else {
                console.log(`--- ${suite.id}: ${status} in ${describeDuration(durationMs)}`);
            }
            if (timedOut) console.log(`✗ ${suite.id} was stopped after ${describeDuration(suite.timeoutMs || 60000)}`);
            resolve({
                id: suite.id,
                tier: suite.tier,
                command: suite.command.join(' '),
                status,
                exitCode: code,
                timedOut,
                timeoutMs: suite.timeoutMs || 60000,
                durationMs,
                result: marker,
                stdoutSha256: createHash('sha256').update(stdout).digest('hex'),
                stderr: stderr.trim().slice(-4000)
            });
        });
    });
}

const results = [];
let stopped = false;

async function runStage(stage) {
    const live = stage.concurrency === 1;
    let nextLane = 0;
    const laneRunner = async () => {
        while (!stopped && nextLane < stage.lanes.length) {
            const lane = stage.lanes[nextLane++];
            for (const suite of lane) {
                if (stopped) return;
                const result = await runSuite(suite, { live });
                results.push(result);
                if (result.status !== 'pass' && !(portable && result.status === 'skip')) {
                    stopped = true;
                    return;
                }
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(stage.concurrency, stage.lanes.length) }, laneRunner));
}

console.log(`Gate: ${selected.length} suites, ${plan.jobs} job(s): `
    + plan.stages.map(stage => `${stage.name} (${stage.lanes.flat().length} suite${stage.lanes.flat().length === 1 ? '' : 's'}, ${stage.concurrency} at a time)`).join(', then ')
    + (selected.some(suite => suite.tier === 'mutation') ? `; mutation guards on ${process.env.MYAI_MUTATION_WORKERS || plan.mutationWorkers} worker(s)` : ''));
for (const stage of plan.stages) {
    if (stopped) break;
    await runStage(stage);
}

const order = new Map(selected.map((suite, index) => [suite.id, index]));
results.sort((a, b) => order.get(a.id) - order.get(b.id));
const wallMs = Date.now() - startedMs;

const report = {
    schemaVersion: 1,
    baseline: baselineEpoch,
    mode: portable ? 'portable' : 'strict',
    startedAt,
    finishedAt: new Date().toISOString(),
    wallMs,
    jobs: plan.jobs,
    plan: plan.stages.map(stage => ({
        name: stage.name, concurrency: stage.concurrency, lanes: stage.lanes.map(lane => lane.map(suite => suite.id))
    })),
    passed: results.filter(item => item.status === 'pass').length,
    skipped: results.filter(item => item.status === 'skip').length,
    failed: results.filter(item => item.status === 'fail').length,
    expectedSuites: selected.map(item => item.id),
    sourceTree: {
        before: sourceTreeBefore,
        after: sourceTreeDigest()
    },
    results
};
const outDir = path.join(root, 'artifacts');
fs.mkdirSync(outDir, { recursive: true });
const reportPath = path.join(outDir, 'baseline-report.json');
report.sourceTree.unchanged = report.sourceTree.before.sha256 === report.sourceTree.after.sha256;
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');

const success = report.sourceTree.unchanged
    && baselineSucceeded({ results, expectedCount: selected.length, portable });
console.log('\nSuite times, slowest first:');
for (const item of slowestSuites(results, results.length)) {
    console.log(`  ${item.id.padEnd(22)} ${describeDuration(item.durationMs).padStart(10)}  ${item.status}`);
}
if (!report.sourceTree.unchanged) console.log('✗ a suite changed the source tree');
console.log(`\nBaseline report: ${path.relative(root, reportPath)}`);
console.log(success
    ? `✓ ${report.passed} suites passed${report.skipped ? `; ${report.skipped} skipped in portable mode` : ''} in ${describeDuration(wallMs)}`
    : `✗ baseline failed after ${results.length}/${selected.length} suites`);
process.exit(success ? 0 : 1);
