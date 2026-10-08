// The version under ❓: the build this page runs, and a newer one once the box has it. A new build
// downloads in the background and waits; it takes over when the version is tapped, or by itself the
// next time the app is started (every tab of it closed), as service workers do.

const ASK_MS = 3000;
const CHECK_EVERY_MS = 30 * 60 * 1000;

export function documentBuild() {
    const meta = document.querySelector('meta[name="myai-calendar-build"]');
    const digits = meta ? String(meta.getAttribute('content') || '').trim() : '';
    return /^\d+$/.test(digits) ? `v${digits}` : null;
}

function askVersion(worker) {
    return new Promise(resolve => {
        if (!worker) { resolve(null); return; }
        const channel = new MessageChannel();
        const timer = setTimeout(() => resolve(null), ASK_MS);
        channel.port1.onmessage = event => {
            clearTimeout(timer);
            const data = event.data || {};
            resolve(typeof data.version === 'string' ? data.version : null);
        };
        try { worker.postMessage({ type: 'version' }, [channel.port2]); } catch (_) { clearTimeout(timer); resolve(null); }
    });
}

export function startUpdates({ badge, canSwitch = () => true, onBlocked = () => {} }) {
    const loaded = documentBuild() || 'dev';
    let offered = null;
    let switching = false;
    let registration = null;

    const paint = (text, title, offeredNow = false) => {
        badge.textContent = text;
        badge.title = title;
        badge.setAttribute('aria-label', title);
        badge.classList.toggle('offered', offeredNow);
    };
    paint(loaded, `Running build ${loaded}. Tap to look for a newer one.`);

    if (!('serviceWorker' in navigator)) {
        paint(loaded, `Running build ${loaded}. This browser cannot keep the app for offline use.`);
        return { check() {} };
    }

    async function offer(worker) {
        const version = await askVersion(worker);
        if (!version || version === loaded) return;
        offered = worker;
        paint(`${loaded} › ${version}`, `Build ${version} is ready. Tap to switch to it now; otherwise it takes over the next time the app is started.`, true);
    }

    function watch(reg) {
        reg.addEventListener('updatefound', () => {
            const worker = reg.installing;
            if (!worker) return;
            if (navigator.serviceWorker.controller) paint(`${loaded} ⟳`, 'A newer build is downloading.');
            worker.addEventListener('statechange', () => {
                if (worker.state === 'installed' && navigator.serviceWorker.controller) offer(worker);
                else if (worker.state === 'redundant' && !offered) paint(loaded, `Running build ${loaded}. A newer build could not be installed; it is tried again later.`);
                else if (worker.state === 'activated' && !offered) paint(loaded, `Running build ${loaded}, ready for offline use.`);
            });
        });
    }

    navigator.serviceWorker.register('sw.js').then(reg => {
        registration = reg;
        watch(reg);
        if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
        setInterval(() => { reg.update().catch(() => {}); }, CHECK_EVERY_MS);
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') reg.update().catch(() => {});
        });
    }).catch(err => paint(loaded, `Running build ${loaded}. Offline use is not available: ${err && err.message ? err.message : err}`));

    navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (switching) location.reload();
    });

    async function check() {
        if (offered) return;
        if (!registration) return;
        paint(`${loaded} ⟳`, 'Asking the box for a newer build…');
        try { await registration.update(); } catch (_) {
            paint(`${loaded} ⚠`, `Running build ${loaded}. The box could not be reached to look for a newer one.`);
            setTimeout(() => { if (!offered) paint(loaded, `Running build ${loaded}. Tap to look for a newer one.`); }, 4000);
            return;
        }
        if (registration.installing) return;
        if (registration.waiting) { await offer(registration.waiting); return; }
        paint(`${loaded} ✓`, `Build ${loaded} is the newest the box has.`);
        setTimeout(() => { if (!offered) paint(loaded, `Running build ${loaded}. Tap to look for a newer one.`); }, 4000);
    }

    badge.addEventListener('click', () => {
        if (!offered) { check(); return; }
        if (!canSwitch()) { onBlocked(); return; }
        switching = true;
        offered.postMessage({ type: 'activate-now' });
        // Should the new build not take over, the page is reloaded anyway; it then still runs this one.
        setTimeout(() => location.reload(), 5000);
    });

    return { check };
}
