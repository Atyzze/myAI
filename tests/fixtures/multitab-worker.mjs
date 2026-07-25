/* Worker-side harness that loads the real recording-lock.js in an isolated JS
 * realm. Workers share a synchronous file-backed localStorage, while the parent
 * supplies a Web Locks broker when mode === 'web-locks'.
 */
import fs from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';

const { storageFile, mode, tabName } = workerData;
const lockFile = `${storageFile}.lock`;
const sleepCell = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms) { Atomics.wait(sleepCell, 0, 0, ms); }

function withStorageLock(work) {
    let fd;
    for (;;) {
        try { fd = fs.openSync(lockFile, 'wx'); break; }
        catch (err) {
            if (err.code !== 'EEXIST') throw err;
            sleepSync(2);
        }
    }
    try { return work(); }
    finally {
        try { fs.closeSync(fd); } catch (_) {}
        try { fs.unlinkSync(lockFile); } catch (_) {}
    }
}
function readStorage() {
    try { return JSON.parse(fs.readFileSync(storageFile, 'utf8') || '{}'); }
    catch (_) { return {}; }
}
function mutateStorage(mutator) {
    return withStorageLock(() => {
        const values = readStorage();
        const result = mutator(values);
        fs.writeFileSync(storageFile, JSON.stringify(values));
        return result;
    });
}

const sessionValues = new Map();
Object.defineProperty(globalThis, 'sessionStorage', { value: {
    getItem(key) { return sessionValues.has(key) ? sessionValues.get(key) : null; },
    setItem(key, value) { sessionValues.set(key, String(value)); },
    removeItem(key) { sessionValues.delete(key); }
}, configurable: true });
Object.defineProperty(globalThis, 'localStorage', { value: {
    getItem(key) { return withStorageLock(() => readStorage()[key] ?? null); },
    setItem(key, value) { mutateStorage(values => { values[key] = String(value); }); },
    removeItem(key) { mutateStorage(values => { delete values[key]; }); }
}, configurable: true });

let brokerSeq = 0;
const brokerReplies = new Map();
if (mode === 'web-locks') {
    Object.defineProperty(globalThis, 'navigator', { value: { locks: {
        request(name, options, callback) {
            const brokerId = `${tabName}:${++brokerSeq}`;
            const grant = new Promise((resolve, reject) => brokerReplies.set(brokerId, { resolve, reject }));
            parentPort.postMessage({ type: 'broker-request', brokerId, name, options });
            return grant.then(async granted => {
                if (!granted) return callback(null);
                try { return await callback({ name, mode: options?.mode || 'exclusive' }); }
                finally { parentPort.postMessage({ type: 'broker-release', brokerId, name }); }
            });
        }
    } }, configurable: true });
} else {
    Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
}

const lock = await import('../../src/js/recording-lock.js');

async function handleCommand(command, payload) {
    switch (command) {
        case 'acquire': {
            const acquired = await lock.acquireRecordingLock();
            if (acquired) lock.publishRecordingLease(payload.recId, Date.now(), payload.sessionId);
            return { acquired, ownerId: lock.getRecordingOwnerId(), lease: lock.getActiveRecordingLease() };
        }
        case 'release':
            await lock.releaseRecordingLock();
            return { released: true, lease: lock.getActiveRecordingLease() };
        case 'read':
            return { ownerId: lock.getRecordingOwnerId(), lease: lock.getActiveRecordingLease() };
        case 'publish': {
            const lease = lock.publishRecordingLease(
                payload.recId, payload.heartbeatAt || Date.now(), payload.sessionId, payload.durationMs || 0
            );
            return { lease, active: lock.getActiveRecordingLease(payload.now || Date.now()) };
        }
        case 'owns-row':
            return lock.isRecordOwnedByLiveTab(payload.row, payload.now || Date.now());
        case 'nested-acquire':
            return lock.acquireRecordingLock();
        default:
            throw new Error(`Unknown command: ${command}`);
    }
}

parentPort.on('message', async message => {
    if (message.type === 'broker-response') {
        const pending = brokerReplies.get(message.brokerId);
        if (pending) {
            brokerReplies.delete(message.brokerId);
            pending.resolve(message.granted);
        }
        return;
    }
    if (message.type !== 'command') return;
    try {
        const value = await handleCommand(message.command, message.payload || {});
        parentPort.postMessage({ type: 'command-result', id: message.id, value });
    } catch (err) {
        parentPort.postMessage({ type: 'command-result', id: message.id, error: err?.stack || String(err) });
    }
});
parentPort.postMessage({ type: 'ready', tabName, ownerId: lock.getRecordingOwnerId() });
