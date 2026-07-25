import { emitTestResult } from '../helpers/test-result.mjs';
/* Zero-dependency checks for the cross-tab recording lease fallback.
 * Run from repository root: node tests/unit/recording-lock.test.mjs
 */
class MemoryStorage {
    #values = new Map();
    getItem(key) { return this.#values.has(key) ? this.#values.get(key) : null; }
    setItem(key, value) { this.#values.set(key, String(value)); }
    removeItem(key) { this.#values.delete(key); }
    clear() { this.#values.clear(); }
}

Object.defineProperty(globalThis, 'localStorage', { value: new MemoryStorage(), configurable: true });
Object.defineProperty(globalThis, 'sessionStorage', { value: new MemoryStorage(), configurable: true });
Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });

const lock = await import('../../src/js/recording-lock.js');
let assertions = 0;
function ok(value, message) {
    assertions++;
    if (!value) throw new Error(`Assertion failed: ${message}`);
}

const now = Date.now();
ok(lock.isFreshHeartbeat(now - 1000, now, 5000), 'recent heartbeat is fresh');
ok(!lock.isFreshHeartbeat(now - 6000, now, 5000), 'old heartbeat is stale');
ok(!lock.isFreshHeartbeat(undefined, now, 5000), 'missing heartbeat is stale');
ok(!lock.isFreshHeartbeat(now - 5000, now, 5000), 'heartbeat at the stale boundary is expired');

const ownerId = lock.getRecordingOwnerId();
let observed = null;
const unsubscribe = lock.subscribeRecordingLease(lease => { observed = lease; });
lock.publishRecordingLease(7, now, 'session-a', 4321);
ok(observed?.sessionId === 'session-a', 'lease subscribers receive session-aware updates');
ok(observed?.durationMs === 4321, 'lease carries shared elapsed duration for the remote live row');
ok(lock.getActiveRecordingLease(now)?.recId === 7, 'fresh published lease is active');
ok(lock.isLeaseOwnedByThisTab(), 'published lease belongs to this tab');
ok(lock.isRecordOwnedByLiveTab({ id: 7, ownerId, sessionId: 'session-a', heartbeatAt: now }, now), 'matching fresh row, session and lease are live');
ok(!lock.isRecordOwnedByLiveTab({ id: 7, ownerId, sessionId: 'session-b', heartbeatAt: now }, now), 'different session is isolated');
ok(!lock.isRecordOwnedByLiveTab({ id: 8, ownerId, sessionId: 'session-a', heartbeatAt: now }, now), 'different recording id is not live');
ok(!lock.isRecordOwnedByLiveTab({ id: 7, ownerId: 'other', sessionId: 'session-a', heartbeatAt: now }, now), 'different owner is not live');
ok(!lock.isRecordOwnedByLiveTab({ id: 7, ownerId, sessionId: 'session-a', heartbeatAt: now - 20000 }, now), 'stale row heartbeat is not live');
unsubscribe();

localStorage.setItem(lock.RECORDING_LEASE_KEY, '{not-json');
ok(lock.readRecordingLease() === null, 'malformed shared lease is ignored instead of crashing startup');
localStorage.removeItem(lock.RECORDING_LEASE_KEY);

await lock.releaseRecordingLock();
localStorage.setItem(lock.RECORDING_LEASE_KEY, JSON.stringify({
    ownerId: 'another-tab', recId: 2, sessionId: 'other-session', heartbeatAt: Date.now(), token: 'other'
}));
ok(!(await lock.acquireRecordingLock()), 'fresh competing fallback lease blocks acquisition');
localStorage.setItem(lock.RECORDING_LEASE_KEY, JSON.stringify({
    ownerId: 'crashed-tab', recId: 3, sessionId: 'stale-session',
    heartbeatAt: Date.now() - 60000, token: 'stale'
}));
ok(await lock.acquireRecordingLock(), 'stale competing fallback lease can be replaced after a crash');
await lock.releaseRecordingLock();

localStorage.removeItem(lock.RECORDING_LEASE_KEY);
const contestedAcquire = lock.acquireRecordingLock();
setTimeout(() => localStorage.setItem(lock.RECORDING_LEASE_KEY, JSON.stringify({
    ownerId: 'racing-tab', recId: 4, sessionId: 'racing-session',
    heartbeatAt: Date.now(), token: 'racing-token'
})), 20);
ok(!(await contestedAcquire), 'fallback verification rejects a lease overwritten during acquisition');
localStorage.removeItem(lock.RECORDING_LEASE_KEY);

const simultaneous = await Promise.all([lock.acquireRecordingLock(), lock.acquireRecordingLock()]);
ok(simultaneous.every(Boolean), 'simultaneous same-tab acquisition shares one underlying lock');
await lock.releaseRecordingLock();
ok(lock.readRecordingLease() !== null, 'one simultaneous hold remains after the first release');
await lock.releaseRecordingLock();
ok(lock.readRecordingLease() === null, 'simultaneous shared lock is released at depth zero');

ok(await lock.acquireRecordingLock(), 'fallback lock can be acquired without a competitor');
ok(await lock.acquireRecordingLock(), 'same-tab acquisition is re-entrant');
await lock.releaseRecordingLock();
ok(lock.readRecordingLease() !== null, 'partial release keeps a nested lock lease');
await lock.releaseRecordingLock();
ok(lock.readRecordingLease() === null, 'final release removes this tab lease');

console.log(`✓ all ${assertions} recording-lock assertions passed`);
emitTestResult('recording-lock-unit', 'pass', { assertions });
