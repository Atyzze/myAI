export function shouldCloseForUpgrade({ recording = false, finalizing = false } = {}) {
    return !recording && !finalizing;
}

export function describeUpgradeBlocked({ recording = false, busy = false } = {}) {
    if (recording) {
        return '⏸️ A newer version of this app is waiting in another tab. '
             + 'This recording comes first: that version starts by itself once you stop recording, '
             + 'and every note is kept.';
    }
    if (busy) {
        return '⏸️ A newer version of this app is waiting in another tab. '
             + 'It starts by itself once the work running here finishes, such as saving or transcribing '
             + 'a recording, and every note is kept.';
    }
    return '⏸️ A newer version of this app is waiting for another tab of this app. '
         + 'It carries on by itself as soon as that tab closes or finishes what it is doing.';
}

export function describeConnectionClosed() {
    return '⚠️ A newer version of this app opened in another tab. '
         + 'Reload this page to carry on. Nothing has been lost.';
}

export function describeStaleTab() {
    return '⚠️ This tab is running an older version than the stored data. '
         + 'Reload it to continue. Nothing has been lost.';
}

export function isStaleVersionError(err) {
    const name = String((err && err.name) || '');
    const message = String((err && err.message) || '');
    return name === 'VersionError' || /less than the existing version/i.test(message);
}

export function connectionGuardState({ closed = false, stale = false, blocked = false } = {}) {
    if (stale) return 'stale';
    if (closed) return 'closed';
    if (blocked) return 'blocked';
    return 'open';
}

export function describeConnectionGuard(state, { recording = false, busy = false } = {}) {
    if (state === 'stale') return describeStaleTab();
    if (state === 'closed') return describeConnectionClosed();
    if (state === 'blocked') return describeUpgradeBlocked({ recording, busy });
    return '';
}

export function schemaLayout(config) {
    return [
        { name: config.STORE_LIVE, options: { keyPath: 'recId' }, indexes: [] },
        { name: config.STORE_BEATS, options: { keyPath: 'recId' }, indexes: [] },
        { name: config.STORE_AUDIO, options: { keyPath: 'recId' }, indexes: [] },
        { name: config.STORE_REC, options: { keyPath: 'id', autoIncrement: true },
          indexes: [{ name: 'by-date', keyPath: 'timestamp' },
                    { name: 'by-state', keyPath: 'captureState' }] },
        { name: config.STORE_FRAGMENTS, options: { keyPath: 'fragmentId', autoIncrement: true },
          indexes: [
              { name: 'by-rec', keyPath: 'recId', options: { unique: false } },
              { name: 'by-session', keyPath: 'sessionId', options: { unique: false } },
              { name: 'by-stream', keyPath: ['recId', 'sessionId'], options: { unique: false } },
              { name: 'by-stream-seq', keyPath: ['recId', 'sessionId', 'seq'], options: { unique: true } }
          ] }
    ];
}

export function applySchema(db, upgradeTx, layout) {
    const created = [];
    for (const spec of (layout || []).filter(item => item && item.name)) {
        let store;
        if (db.objectStoreNames.contains(spec.name)) {
            store = upgradeTx.objectStore(spec.name);
        } else {
            store = db.createObjectStore(spec.name, spec.options);
            created.push(spec.name);
        }
        for (const index of spec.indexes || []) {
            if (store.indexNames && store.indexNames.contains(index.name)) continue;
            store.createIndex(index.name, index.keyPath, index.options);
            created.push(`${spec.name}.${index.name}`);
        }
    }
    return created;
}
