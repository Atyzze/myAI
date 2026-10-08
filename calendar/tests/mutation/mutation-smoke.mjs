// Runs every guard in tests/mutation/guards.mjs: the app is copied, one thing in it broken, and the
// test that should notice is run on the copy. The run passes only if every such test fails, and
// fails for the expected reason.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { guards } from './guards.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const repo = path.resolve(root, '..');
const TIMEOUT_MS = 240000;
const only = process.argv.slice(2);
const selected = only.length ? guards.filter(g => only.includes(g.id)) : guards;

// The table itself: unique ids, and each change applies to exactly one place.
const problems = [];
const ids = new Set();
for (const guard of guards) {
    if (ids.has(guard.id)) problems.push(`${guard.id} is listed twice`);
    ids.add(guard.id);
    const source = fs.readFileSync(path.join(root, guard.file), 'utf8');
    const count = source.split(guard.from).length - 1;
    if (count !== 1) problems.push(`${guard.id}: its change is found ${count} times in ${guard.file}, not once`);
    if (!(guard.expected instanceof RegExp)) problems.push(`${guard.id}: no expected failure message`);
}
if (problems.length) {
    console.error(`✗ the guard table has problems; nothing was run:\n  - ${problems.join('\n  - ')}`);
    console.log(`MYAI_TEST_RESULT ${JSON.stringify({ suite: 'mutation', status: 'fail', problems })}`);
    process.exit(1);
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'myai-calendar-mutation-'));

function copyApp(to) {
    fs.mkdirSync(to, { recursive: true });
    fs.cpSync(root, path.join(to, 'calendar'), {
        recursive: true,
        filter: src => !/[\\/](artifacts|node_modules)([\\/]|$)/.test(path.relative(root, src) ? `/${path.relative(root, src)}` : '')
    });
    // The Radicale harness uses the box's account tool and vobject patch, next to the app.
    fs.cpSync(path.join(repo, 'box'), path.join(to, 'box'), { recursive: true });
    fs.cpSync(path.join(repo, 'nix'), path.join(to, 'nix'), { recursive: true });
    return path.join(to, 'calendar');
}

function runGuard(guard) {
    const app = copyApp(path.join(scratch, guard.id));
    const target = path.join(app, guard.file);
    fs.writeFileSync(target, fs.readFileSync(target, 'utf8').replace(guard.from, guard.to));
    const started = Date.now();
    return new Promise(resolve => {
        let output = '';
        let timedOut = false;
        const [command, ...args] = guard.command;
        const child = spawn(command, args, { cwd: app, env: { ...process.env, MYAI_STRICT_TESTS: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
        const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, TIMEOUT_MS);
        child.stdout.on('data', d => { output += d; });
        child.stderr.on('data', d => { output += d; });
        child.on('close', code => {
            clearTimeout(timer);
            const killed = !timedOut && code !== 0 && guard.expected.test(output);
            const why = timedOut ? 'timed out'
                : code === 0 ? 'the test still passed with the change'
                : !guard.expected.test(output) ? `the test failed, but not with ${guard.expected}` : '';
            resolve({ id: guard.id, killed, why, ms: Date.now() - started, tail: output.slice(-600) });
        });
    });
}

const workers = Math.max(1, Math.min(4, Math.floor((os.availableParallelism ? os.availableParallelism() : os.cpus().length) / 2)));
const queue = [...selected];
const results = [];
await Promise.all(Array.from({ length: workers }, async () => {
    while (queue.length) {
        const guard = queue.shift();
        const result = await runGuard(guard);
        results.push(result);
        console.log(`${result.killed ? '✓' : '✗'} ${result.id} (${Math.round(result.ms / 100) / 10} s)${result.killed ? '' : `: ${result.why}`}`);
    }
}));
fs.rmSync(scratch, { recursive: true, force: true });

const survived = results.filter(r => !r.killed);
for (const r of survived) console.log(`\n--- ${r.id} output tail ---\n${r.tail}`);
console.log(survived.length ? `\n${survived.length} of ${results.length} guards were not caught.` : `\n✓ all ${results.length} guards were caught by the test that should catch them`);
console.log(`MYAI_TEST_RESULT ${JSON.stringify({ suite: 'mutation', status: survived.length ? 'fail' : 'pass', guards: results.length, caught: results.length - survived.length })}`);
process.exit(survived.length ? 1 : 0);
