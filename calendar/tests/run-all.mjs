// The calendar's full gate: every suite, one after the other, each in its own process. Writes
// artifacts/test-report.json, which the release packager reads.
//
//   node tests/run-all.mjs              strict: Radicale and Chromium must be there (MYAI_RADICALE_PYTHON)
//   node tests/run-all.mjs --portable   a suite whose outside tool is missing is skipped, and says so
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const portable = process.argv.includes('--portable');

export const SUITES = [
    { id: 'core', file: 'tests/unit/core.test.mjs', what: 'iCalendar, time zones, repeats (against python-dateutil), edits' },
    { id: 'series-edit', file: 'tests/unit/series-edit.test.mjs', what: '"this and following": cutting a repeating event in two' },
    { id: 'ui-core', file: 'tests/unit/ui-core.test.mjs', what: 'views, words for dates, the event index, reminders, links, settings' },
    { id: 'sync-fake', file: 'tests/unit/sync-fake.test.mjs', what: 'sync against a server double that answers as other CalDAV servers do' },
    { id: 'static', file: 'tests/unit/static.test.mjs', what: 'modules, the offline shell, build numbers, the page' },
    { id: 'sync-radicale', file: 'tests/integration/sync-radicale.mjs', what: 'two devices syncing through a real Radicale', external: true },
    { id: 'browser-calendar', file: 'tests/integration/browser-calendar.mjs', what: 'the app in Chromium: laptop and phone, offline, import, reminders', external: true },
    { id: 'shell-update', file: 'tests/integration/shell-update.mjs', what: 'a new build offered and taken on a tap, data kept', external: true },
    { id: 'mutation', file: 'tests/mutation/mutation-smoke.mjs', what: 'broken code is caught by the test meant to catch it', external: true }
];

function runSuite(suite) {
    const started = Date.now();
    return new Promise(resolve => {
        const env = { ...process.env };
        if (portable) delete env.MYAI_STRICT_TESTS; else env.MYAI_STRICT_TESTS = '1';
        const child = spawn(process.execPath, [suite.file], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
        let output = '';
        child.stdout.on('data', d => { output += d; process.stdout.write(d); });
        child.stderr.on('data', d => { output += d; process.stderr.write(d); });
        child.on('close', code => {
            const line = output.split('\n').reverse().find(l => l.startsWith('MYAI_TEST_RESULT '));
            let reported = null;
            try { reported = line ? JSON.parse(line.slice('MYAI_TEST_RESULT '.length)) : null; } catch (_) { reported = null; }
            let status = reported ? reported.status : 'fail';
            if (code !== 0 && status !== 'fail') status = 'fail';
            if (code === 0 && !reported) status = 'fail';
            resolve({
                id: suite.id, what: suite.what, status, durationMs: Date.now() - started,
                assertions: reported ? (reported.assertions ?? reported.guards ?? null) : null,
                reason: reported && reported.reason ? reported.reason : (status === 'fail' && !reported ? `exited with ${code} without a result line` : undefined)
            });
        });
    });
}

const startedAt = Date.now();
const results = [];
for (const suite of SUITES) {
    console.log(`\n=== ${suite.id}: ${suite.what}`);
    results.push(await runSuite(suite));
}
const build = Number(fs.readFileSync(path.join(root, 'BUILD_NUMBER'), 'utf8').trim());
const report = {
    build,
    mode: portable ? 'portable' : 'strict',
    startedAt: new Date(startedAt).toISOString(),
    wallMs: Date.now() - startedAt,
    expectedSuites: SUITES.map(s => s.id),
    results,
    passed: results.filter(r => r.status === 'pass').length,
    failed: results.filter(r => r.status === 'fail').length,
    skipped: results.filter(r => r.status === 'skip').length
};
fs.mkdirSync(path.join(root, 'artifacts'), { recursive: true });
fs.writeFileSync(path.join(root, 'artifacts', 'test-report.json'), JSON.stringify(report, null, 2) + '\n');

console.log('\n=== the calendar gate');
for (const r of results) {
    const mark = r.status === 'pass' ? '✓' : r.status === 'skip' ? '↷' : '✗';
    console.log(`${mark} ${r.id.padEnd(17)} ${String(r.assertions ?? '').padStart(4)}  ${(r.durationMs / 1000).toFixed(1).padStart(6)} s  ${r.reason || ''}`);
}
const strictSkip = !portable && report.skipped > 0;
console.log(`${report.passed} passed, ${report.failed} failed, ${report.skipped} skipped (${report.mode}) in ${(report.wallMs / 1000).toFixed(0)} s`);
process.exit(report.failed || strictSkip ? 1 : 0);
