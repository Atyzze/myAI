/* Deterministic, dependency-free multi-tab integration tests.
 * Two worker realms load the actual recording-lock.js module with separate
 * sessionStorage identities and shared localStorage. Both the Web Locks path
 * and the verified-storage fallback are exercised.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { emitTestResult } from '../helpers/test-result.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const workerUrl = new URL('../fixtures/multitab-worker.mjs', import.meta.url);
let assertions = 0;
function ok(value, message) {
    assertions++;
    if (!value) throw new Error(`Assertion failed: ${message}`);
}

class TabWorker {
    constructor(name, mode, storageFile, broker) {
        this.name = name;
        this.seq = 0;
        this.pending = new Map();
        this.ready = new Promise((resolve, reject) => {
            this.worker = new Worker(workerUrl, { workerData: { tabName: name, mode, storageFile } });
            this.worker.on('message', message => {
                if (message.type === 'ready') { this.ownerId = message.ownerId; resolve(message); return; }
                if (message.type === 'command-result') {
                    const pending = this.pending.get(message.id);
                    if (!pending) return;
                    this.pending.delete(message.id);
                    if (message.error) pending.reject(new Error(message.error));
                    else pending.resolve(message.value);
                    return;
                }
                broker?.handle(this, message);
            });
            this.worker.on('error', reject);
        });
    }
    async command(command, payload = {}) {
        await this.ready;
        const id = `${this.name}:${++this.seq}`;
        const promise = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
        this.worker.postMessage({ type: 'command', id, command, payload });
        return promise;
    }
    terminate() { return this.worker.terminate(); }
}

class WebLockBroker {
    constructor() { this.owners = new Map(); }
    handle(tab, message) {
        if (message.type === 'broker-request') {
            const owner = this.owners.get(message.name);
            const granted = !owner;
            if (granted) this.owners.set(message.name, { tab, brokerId: message.brokerId });
            tab.worker.postMessage({ type: 'broker-response', brokerId: message.brokerId, granted });
        } else if (message.type === 'broker-release') {
            const owner = this.owners.get(message.name);
            if (owner?.tab === tab && owner.brokerId === message.brokerId) this.owners.delete(message.name);
        }
    }
    dropTab(tab) {
        for (const [name, owner] of this.owners) if (owner.tab === tab) this.owners.delete(name);
    }
}

async function runWebLocks(storageFile) {
    const broker = new WebLockBroker();
    const a = new TabWorker('A', 'web-locks', storageFile, broker);
    const b = new TabWorker('B', 'web-locks', storageFile, broker);
    await Promise.all([a.ready, b.ready]);
    ok(a.ownerId !== b.ownerId, 'separate tab realms have unique session owners');

    const first = await a.command('acquire', { recId: 11, sessionId: 'session-a' });
    ok(first.acquired, 'tab A acquires the real module global lock');
    const seen = await b.command('read');
    ok(seen.lease?.recId === 11 && seen.lease?.sessionId === 'session-a', 'tab B reads tab A shared recording lease');
    await b.command('release');
    const stillOwned = await b.command('read');
    ok(stillOwned.lease?.ownerId === first.ownerId, 'non-owner release cannot clear another tab lease');

    await a.command('publish', { recId: 11, sessionId: 'session-a', durationMs: 9876 });
    const durationSeen = await b.command('read');
    ok(durationSeen.lease?.durationMs === 9876, 'heartbeat updates propagate elapsed duration across tabs');

    const blocked = await b.command('acquire', { recId: 12, sessionId: 'session-b' });
    ok(!blocked.acquired, 'tab B is denied while tab A holds Web Lock');
    ok(await a.command('owns-row', { row: {
        id: 11, ownerId: first.ownerId, sessionId: 'session-a', heartbeatAt: first.lease.heartbeatAt
    } }), 'matching row/session is recognized as live');
    ok(!(await a.command('owns-row', { row: {
        id: 11, ownerId: first.ownerId, sessionId: 'different', heartbeatAt: first.lease.heartbeatAt
    } })), 'session mismatch cannot claim the active stream');

    ok(await a.command('nested-acquire'), 'same tab lock acquisition is re-entrant');
    await a.command('release');
    ok((await b.command('acquire', { recId: 12, sessionId: 'session-b' })).acquired === false,
        'one nested hold remains after partial release');
    await a.command('release');
    const second = await b.command('acquire', { recId: 12, sessionId: 'session-b' });
    ok(second.acquired, 'tab B acquires after the final release');
    await b.command('release');
    ok(!(await a.command('read')).lease, 'final release removes the global lease');

    await Promise.all([a.terminate(), b.terminate()]);
}

async function runFallback(storageFile) {
    fs.writeFileSync(storageFile, '{}');
    const a = new TabWorker('fallback-A', 'fallback', storageFile);
    const b = new TabWorker('fallback-B', 'fallback', storageFile);
    await Promise.all([a.ready, b.ready]);
    const [ra, rb] = await Promise.all([
        a.command('acquire', { recId: 21, sessionId: 'fallback-a' }),
        b.command('acquire', { recId: 22, sessionId: 'fallback-b' })
    ]);
    ok(Number(ra.acquired) + Number(rb.acquired) === 1, 'simultaneous fallback contenders produce exactly one winner');
    const winner = ra.acquired ? a : b;
    const loser = ra.acquired ? b : a;
    const winningSession = ra.acquired ? 'fallback-a' : 'fallback-b';
    await loser.command('release');
    const observed = await loser.command('read');
    ok(observed.lease?.sessionId === winningSession, 'fallback loser sees winner session lease and cannot clear it');
    await winner.command('release');
    const retry = await loser.command('acquire', { recId: 23, sessionId: 'fallback-retry' });
    ok(retry.acquired, 'fallback loser can acquire after winner releases');
    await loser.command('release');

    await a.command('publish', {
        recId: 24, sessionId: 'crashed-session', heartbeatAt: Date.now() - 60000
    });
    const staleView = await b.command('read');
    ok(!staleView.lease, 'expired fallback lease is not treated as an active recording');
    const staleTakeover = await b.command('acquire', { recId: 25, sessionId: 'stale-takeover' });
    ok(staleTakeover.acquired, 'a new tab can take over after a crashed lease expires');
    await b.command('release');
    await Promise.all([a.terminate(), b.terminate()]);
}

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myai-multitab-'));
const storageFile = path.join(tempDir, 'shared-local-storage.json');
fs.writeFileSync(storageFile, '{}');
try {
    await runWebLocks(storageFile);
    await runFallback(storageFile);
    console.log(`✓ all ${assertions} multi-tab integration assertions passed`);
    emitTestResult('multitab-realms', 'pass', { assertions, realms: 2, paths: ['web-locks', 'storage-fallback'] });
} finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
}
