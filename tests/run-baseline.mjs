/* Run the complete compatibility baseline and produce a machine-readable report.
 * Strict mode is the default: a missing browser/tool or an explicit skip fails.
 * Use --portable only for local diagnostics on machines lacking Chromium/ffmpeg.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { BASELINE_SUITES } from './helpers/baseline-suites.mjs';
import { TEST_RESULT_PREFIX } from './helpers/test-result.mjs';
import { classifySuiteOutcome, baselineSucceeded } from './helpers/baseline-core.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const portable = args.has('--portable');
const noMutation = args.has('--no-mutation');
const selected = BASELINE_SUITES.filter(suite => !(noMutation && suite.id === 'mutation-guards'));
const startedAt = new Date().toISOString();

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

function runSuite(suite) {
    return new Promise(resolve => {
        const [command, ...commandArgs] = suite.command;
        const child = spawn(command, commandArgs, {
            cwd: root,
            env: { ...process.env, MYAI_STRICT_TESTS: portable ? '0' : '1' },
            stdio: ['ignore', 'pipe', 'pipe']
        });
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        const timeout = setTimeout(() => {
            timedOut = true;
            child.kill('SIGKILL');
        }, suite.timeoutMs || 60000);
        child.stdout.on('data', chunk => { const text = String(chunk); stdout += text; process.stdout.write(text); });
        child.stderr.on('data', chunk => { const text = String(chunk); stderr += text; process.stderr.write(text); });
        child.on('close', code => {
            clearTimeout(timeout);
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
            resolve({
                id: suite.id,
                tier: suite.tier,
                command: suite.command.join(' '),
                status,
                exitCode: code,
                timedOut,
                timeoutMs: suite.timeoutMs || 60000,
                result: marker,
                stdoutSha256: createHash('sha256').update(stdout).digest('hex'),
                stderr: stderr.trim().slice(-4000)
            });
        });
    });
}

const results = [];
for (const suite of selected) {
    console.log(`\n=== ${suite.id} (${suite.tier}) ===`);
    const result = await runSuite(suite);
    results.push(result);
    if (result.status !== 'pass' && !(portable && result.status === 'skip')) break;
}

const report = {
    schemaVersion: 1,
    baseline: 'myAI-v30',
    mode: portable ? 'portable' : 'strict',
    startedAt,
    finishedAt: new Date().toISOString(),
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
console.log(`\nBaseline report: ${path.relative(root, reportPath)}`);
console.log(success
    ? `✓ ${report.passed} suites passed${report.skipped ? `; ${report.skipped} skipped in portable mode` : ''}`
    : `✗ baseline failed after ${results.length}/${selected.length} suites`);
process.exit(success ? 0 : 1);
