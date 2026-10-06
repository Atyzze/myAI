import { classifySuiteOutcome, baselineSucceeded, baselineJobs, planBaseline, plannedSuites,
         describeDuration, slowestSuites } from '../helpers/baseline-core.mjs';
import { BASELINE_SUITES } from '../helpers/baseline-suites.mjs';
import { chromiumCandidates, findChromium } from '../helpers/chromium.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyMutation, checkMutationTable, mutationWorkerCount, guardVerdict,
         GUARD_TIMEOUT_MS } from '../helpers/mutation-core.mjs';
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

{
    const ids = suites => suites.map(suite => suite.id).sort().join(',');
    const lost = [];
    for (const jobs of [1, 2, 3, 4, 8, 16, 64]) {
        const planned = plannedSuites(planBaseline(BASELINE_SUITES, { jobs }));
        if (planned.length !== BASELINE_SUITES.length || ids(planned) !== ids(BASELINE_SUITES)) lost.push(jobs);
    }
    ok(lost.length === 0, `gate plan: every suite runs exactly once whatever the number of jobs (${lost.join(', ')})`);

    const two = planBaseline(BASELINE_SUITES, { jobs: 2 });
    ok(two.stages.map(stage => stage.name).join(',') === 'quick,integration,mutation'
       && two.stages[0].concurrency === 2 && two.stages[1].concurrency === 1 && two.stages[2].concurrency === 1,
       'gate plan: with two cores the quick suites run two at a time, then the browser suites one after another, then the guards');
    ok(two.stages[1].lanes.length === 1
       && two.stages[1].lanes[0].map(suite => suite.id).join(',') === BASELINE_SUITES.filter(suite => suite.tier === 'integration').map(suite => suite.id).join(','),
       'gate plan: and the browser suites keep their order');
    ok(two.mutationWorkers === 2, 'gate plan: the guards then have both cores');

    const eight = planBaseline(BASELINE_SUITES, { jobs: 8 });
    const together = eight.stages.find(stage => stage.name === 'together');
    ok(eight.stages.length === 2 && together && together.concurrency === together.lanes.length
       && together.lanes.some(lane => lane.some(suite => suite.tier === 'mutation'))
       && together.lanes.filter(lane => lane.some(suite => suite.tier === 'integration')).length
          === BASELINE_SUITES.filter(suite => suite.tier === 'integration').length,
       'gate plan: with eight cores the browser suites and the guards run side by side');
    ok(eight.mutationWorkers === 5, 'gate plan: leaving three cores to the browser suites');
    ok(planBaseline(BASELINE_SUITES, { jobs: 1 }).stages.every(stage => stage.concurrency === 1),
       'gate plan: one job runs everything one at a time');
    ok(planBaseline(BASELINE_SUITES.filter(suite => suite.tier !== 'mutation'), { jobs: 8 }).stages
        .every(stage => stage.lanes.every(lane => lane.every(suite => suite.tier !== 'mutation'))),
       'gate plan: without the guards there is no guard lane');

    ok(baselineJobs('3', 8) === 3 && baselineJobs(undefined, 6) === 6 && baselineJobs('0', 6) === 6 && baselineJobs('x', 0) === 1,
       'gate jobs: MYAI_TEST_JOBS chooses, otherwise one per core');
    ok(describeDuration(59400) === '59 s' && describeDuration(61000) === '1 min 01 s',
       'gate: durations are written for people');
    ok(slowestSuites([{ id: 'a', durationMs: 5 }, { id: 'b', durationMs: 50 }, { id: 'c' }], 5).map(item => item.id).join(',') === 'b,a',
       'gate: the slowest suites come first');
}

{
    const sources = {
        'a.js': 'const answer = 42;\nconst twice = 1;\nconst twice = 1;\n',
        'b.js': 'export const b = true;\n'
    };
    const guard = (id, extra) => ({ id, file: 'a.js', command: ['node', 'x.mjs'], expected: /boom/, ...extra });
    const table = [
        guard('MUT-GOOD', { from: 'const answer = 42;', to: 'const answer = 41;' }),
        guard('MUT-GONE', { from: 'const missing = 0;', to: '' }),
        guard('MUT-TWICE', { from: 'const twice = 1;', to: '' }),
        guard('MUT-NOOP', { transform: source => source }),
        guard('MUT-THROWS', { transform: source => source.match(/nothing here/)[0] }),
        guard('MUT-GOOD', { from: 'const answer = 42;', to: '' }),
        guard('MUT-UNLISTED', { file: 'b.js', from: 'true', to: 'false' }),
        guard('MUT-NO-EXPECTATION', { from: 'const answer = 42;', to: '', expected: 'boom' }),
        guard('MUT-NO-FILE', { file: 'gone.js', from: 'x', to: 'y' })
    ];
    const listed = ['MUT-GOOD', 'MUT-GONE', 'MUT-TWICE', 'MUT-NOOP', 'MUT-THROWS', 'MUT-NO-EXPECTATION',
                    'MUT-NO-FILE', 'MUT-NEVER-WRITTEN'];
    const { problems } = checkMutationTable(table, {
        readSource: file => { if (!(file in sources)) throw new Error('missing'); return sources[file]; },
        contractGuards: listed
    });
    const says = pattern => problems.some(problem => pattern.test(problem));
    ok(problems.length === 9, `mutation table: every problem is reported at once, not only the first (${problems.length}: ${problems.join(' | ')})`);
    ok(says(/MUT-GONE: its anchor occurs 0 times/) && says(/MUT-TWICE: its anchor occurs 2 times/),
       'mutation table: an anchor that is missing or not unique is named');
    ok(says(/MUT-NOOP: its transform changes nothing/) && says(/MUT-THROWS: its transform throws/),
       'mutation table: a transform that changes nothing or throws is named');
    ok(says(/MUT-GOOD is listed twice/), 'mutation table: a guard listed twice is named');
    ok(says(/MUT-UNLISTED is implemented but no contract lists it/) && says(/MUT-NEVER-WRITTEN is listed in a contract but not implemented/),
       'mutation table: guards and contracts that disagree are named both ways');
    ok(says(/MUT-NO-EXPECTATION does not say which failure it expects/) && says(/MUT-NO-FILE mutates gone\.js, which cannot be read/),
       'mutation table: a guard without an expected failure or with a missing file is named');
    ok(checkMutationTable(table.slice(0, 1), { readSource: file => sources[file], contractGuards: ['MUT-GOOD'] }).problems.length === 0,
       'mutation table: a sound table has no problems');
    ok(applyMutation({ from: 'const answer = 42;', to: 'const answer = `$&`;' }, sources['a.js']).after.startsWith('const answer = `$&`;'),
       'mutation: the replacement text is inserted exactly as written');
}

ok(mutationWorkerCount('3', 8, 200) === 3, 'mutation workers: MYAI_MUTATION_WORKERS chooses the number');
ok(mutationWorkerCount(undefined, 2, 200) === 2 && mutationWorkerCount(undefined, 64, 200) === 8,
   'mutation workers: by default one per core, at most eight');
ok(mutationWorkerCount('0', 4, 200) === 4 && mutationWorkerCount('lots', 4, 200) === 4,
   'mutation workers: a request that is not a positive number is ignored');
ok(mutationWorkerCount(undefined, 8, 3) === 3 && mutationWorkerCount('5', 8, 2) === 2,
   'mutation workers: never more workers than guards');

ok(guardVerdict({ exitCode: 1, output: 'Assertion failed: boom' }, /boom/).ok, 'guard: a failure for the named invariant is a detection');
ok(/survived/.test(guardVerdict({ exitCode: 0, output: '' }, /boom/).reason), 'guard: a suite that still passes means the mutation survived');
ok(/not for the invariant/.test(guardVerdict({ exitCode: 1, output: 'SyntaxError' }, /boom/).reason),
   'guard: a failure for another reason is not a detection');
ok(new RegExp(`within ${GUARD_TIMEOUT_MS / 1000} s`).test(guardVerdict({ exitCode: null, timedOut: true, output: 'boom' }, /boom/).reason),
   'guard: a suite that hangs is reported as a timeout, even if its output named the invariant');
ok(/could not run/.test(guardVerdict({ spawnError: 'ENOENT' }, /boom/).reason), 'guard: a suite that cannot start is reported as such');

{
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myai-chromium-'));
    try {
        const make = rel => {
            const file = path.join(tmp, rel);
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, '');
            return file;
        };
        const older = make('pw/chromium-1100/chrome-linux/chrome');
        const newer = make('pw/chromium-1194/chrome-linux64/chrome');
        make('pw/chromium_headless_shell-1194/chrome-linux/headless_shell');
        const onPath = make('bin/chromium');
        const env = { PLAYWRIGHT_BROWSERS_PATH: path.join(tmp, 'pw'), PATH: path.join(tmp, 'bin') };
        const candidates = chromiumCandidates(env, path.join(tmp, 'home'));
        ok(candidates[0] === newer && candidates[1] === older,
           'chromium: without CHROME_BIN the newest Chromium Playwright installed is tried first');
        ok(candidates.indexOf(onPath) > 1, 'chromium: then one on the PATH');
        ok(!candidates.some(candidate => /headless_shell/.test(candidate)),
           'chromium: the headless shell is not mistaken for Chromium');
        ok(findChromium({ ...env, CHROME_BIN: onPath }, { home: tmp }) === onPath, 'chromium: CHROME_BIN wins when it exists');
        ok(findChromium({ PLAYWRIGHT_BROWSERS_PATH: '0', PATH: path.join(tmp, 'bin') },
                        { home: path.join(tmp, 'home'), exists: file => file.startsWith(tmp) }) === onPath,
           'chromium: without a Playwright browser, one on the PATH is found');
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
}

console.log(`✓ all ${assertions} baseline-runner assertions passed`);
emitTestResult('baseline-runner-unit', 'pass', { assertions });
