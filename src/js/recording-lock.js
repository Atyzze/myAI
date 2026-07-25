/* ========================================================================== 
   recording-lock.js - Cross-tab recording/finalization ownership.

   Web Locks provides atomic exclusion where available. A verified localStorage
   lease is the fallback and also lets every tab render the current global LIVE
   state. The lease carries both a tab owner and a per-recording session id, so
   stale chunks can never be mistaken for the active write stream.
   ========================================================================== */
import { CONFIG } from './config.js';

const LOCK_NAME    = 'myai-active-recording';
export const RECORDING_LEASE_KEY = 'myai-active-recording-lease-v2';
const LEGACY_LEASE_KEY = 'myai-active-recording-lease-v1';
const TAB_KEY      = 'myai-tab-owner-v1';
const CHANNEL_NAME = 'myai-recording-lock-v2';

function randomId() {
    try { return crypto.randomUUID(); } catch (_) {}
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

let tabId;
try {
    tabId = sessionStorage.getItem(TAB_KEY) || randomId();
    sessionStorage.setItem(TAB_KEY, tabId);
} catch (_) {
    tabId = randomId();
}

let releaseHold = null;
let lockTask = null;
let fallbackToken = null;
let acquirePromise = null;
let held = false;
let holdDepth = 0;
const leaseListeners = new Set();
let channel = null;

function notifyLeaseListeners() {
    const lease = getActiveRecordingLease();
    for (const listener of [...leaseListeners]) {
        try { listener(lease); } catch (err) { console.warn('Recording lease listener failed:', err); }
    }
}

function broadcastLeaseChange() {
    try { channel?.postMessage({ type: 'lease-changed' }); } catch (_) {}
    notifyLeaseListeners();
}

if (typeof window !== 'undefined') {
    try {
        if (typeof BroadcastChannel === 'function') {
            channel = new BroadcastChannel(CHANNEL_NAME);
            channel.addEventListener('message', event => {
                if (event.data?.type === 'lease-changed') notifyLeaseListeners();
            });
        }
    } catch (_) {}
    window.addEventListener('storage', event => {
        if (event.key === RECORDING_LEASE_KEY || event.key === LEGACY_LEASE_KEY) notifyLeaseListeners();
    });
}

export function getRecordingOwnerId() { return tabId; }

export function readRecordingLease() {
    try {
        const raw = localStorage.getItem(RECORDING_LEASE_KEY)
            || localStorage.getItem(LEGACY_LEASE_KEY);
        return raw ? JSON.parse(raw) : null;
    } catch (_) { return null; }
}

export function isFreshHeartbeat(timestamp, now = Date.now(), staleMs = CONFIG.RECORDING_STALE_MS) {
    return Number.isFinite(Number(timestamp)) && now - Number(timestamp) < staleMs;
}

export function getActiveRecordingLease(now = Date.now()) {
    const lease = readRecordingLease();
    return lease && isFreshHeartbeat(lease.heartbeatAt, now) ? lease : null;
}

export function isLeaseOwnedByThisTab(lease = getActiveRecordingLease()) {
    return !!lease && lease.ownerId === tabId;
}

export function isRecordOwnedByLiveTab(rec, now = Date.now()) {
    if (!rec || !rec.ownerId || !isFreshHeartbeat(rec.heartbeatAt, now)) return false;
    const lease = getActiveRecordingLease(now);
    if (!lease
        || lease.ownerId !== rec.ownerId
        || Number(lease.recId) !== Number(rec.id)) return false;
    // Legacy rows/leases have no sessionId; retain compatibility. New rows must
    // match exactly, which prevents fragments from a different capture session
    // under the same legacy recording id from being treated as one stream.
    return !rec.sessionId || !lease.sessionId || lease.sessionId === rec.sessionId;
}

export function subscribeRecordingLease(listener) {
    if (typeof listener !== 'function') return () => {};
    leaseListeners.add(listener);
    try { listener(getActiveRecordingLease()); } catch (_) {}
    return () => leaseListeners.delete(listener);
}

export function publishRecordingLease(recId, heartbeatAt = Date.now(), sessionId = null, durationMs = 0) {
    const lease = {
        ownerId: tabId,
        recId: recId == null ? null : Number(recId),
        sessionId: sessionId || null,
        durationMs: Math.max(0, Number(durationMs) || 0),
        heartbeatAt,
        token: fallbackToken
    };
    try {
        localStorage.setItem(RECORDING_LEASE_KEY, JSON.stringify(lease));
        localStorage.removeItem(LEGACY_LEASE_KEY);
    } catch (_) {}
    broadcastLeaseChange();
    return lease;
}

function clearOwnLease() {
    const lease = readRecordingLease();
    if (lease && lease.ownerId === tabId) {
        try {
            localStorage.removeItem(RECORDING_LEASE_KEY);
            localStorage.removeItem(LEGACY_LEASE_KEY);
        } catch (_) {}
        broadcastLeaseChange();
    }
}

async function acquireUnderlyingLock() {
    if (navigator.locks && typeof navigator.locks.request === 'function') {
        let resolveAcquired;
        const acquired = new Promise(resolve => { resolveAcquired = resolve; });
        const hold = new Promise(resolve => { releaseHold = resolve; });
        lockTask = navigator.locks.request(
            LOCK_NAME,
            { mode: 'exclusive', ifAvailable: true },
            async lock => {
                if (!lock) {
                    releaseHold = null;
                    resolveAcquired(false);
                    return;
                }
                resolveAcquired(true);
                await hold;
            }
        ).catch(() => {
            releaseHold = null;
            resolveAcquired(false);
        });
        return acquired;
    }

    // Best-effort fallback. Write a unique token, briefly yield, then verify that
    // this tab still owns the lease. A competing write causes one contender to
    // fail verification; a fresh existing lease prevents a late contender.
    const existing = getActiveRecordingLease();
    if (existing && existing.ownerId !== tabId) return false;

    fallbackToken = randomId();
    publishRecordingLease(null);
    await new Promise(resolve => setTimeout(resolve, 80 + Math.floor(Math.random() * 80)));
    const verify = readRecordingLease();
    if (!verify || verify.ownerId !== tabId || verify.token !== fallbackToken) {
        fallbackToken = null;
        return false;
    }
    releaseHold = () => {};
    return true;
}

export async function acquireRecordingLock() {
    if (held) {
        holdDepth++;
        return true;
    }
    if (acquirePromise) {
        const ok = await acquirePromise;
        if (ok) holdDepth++;
        return ok;
    }

    acquirePromise = acquireUnderlyingLock();
    const ok = await acquirePromise;
    acquirePromise = null;
    if (ok) {
        held = true;
        holdDepth = 1;
    }
    return ok;
}

export async function releaseRecordingLock() {
    if (!held) return;
    if (holdDepth > 1) {
        holdDepth--;
        return;
    }

    held = false;
    holdDepth = 0;
    clearOwnLease();
    fallbackToken = null;

    const release = releaseHold;
    releaseHold = null;
    if (release) {
        try { release(); } catch (_) {}
    }
    const task = lockTask;
    lockTask = null;
    if (task) {
        try { await task; } catch (_) {}
    }
}
