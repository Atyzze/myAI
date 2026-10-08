// Showing reminders while the app is open: a toast in every open tab, and a system notification
// when that is switched on. Which reminders are due is reminders-core's; this is the timing and the
// showing. A phone's own calendar app (connected to the box) rings for the same alarms, also with
// this app closed.

import { h, toast } from './dom.js';
import { alarmsIn, dueReminders, nextAlarmAt, reminderText, LOOK_BACK_MS, LOOK_AHEAD_MS } from './reminders-core.js';

const HOUR = 3600000;
const CHECK_AT_LEAST_EVERY_MS = 60000;

async function withLock(name, work) {
    if (navigator.locks && typeof navigator.locks.request === 'function') {
        return navigator.locks.request(name, { ifAvailable: true }, lock => (lock ? work() : null));
    }
    return work();
}

export function startReminders(ctx) {
    let timer = null;
    let stopped = false;

    function present(item) {
        toast(h('div', null, h('b', null, `🔔 ${item.title}`), h('div', null, item.body)), {
            kind: 'reminder', timeoutMs: 0, key: item.id,
            actions: [{ label: 'Open', run: () => ctx.openByKey(item.key, item.startUtc) }]
        });
        try { if (navigator.vibrate) navigator.vibrate([180, 90, 180]); } catch (_) {}
    }

    async function notify(item) {
        if (!ctx.notificationsOn()) return;
        const options = {
            body: item.body, tag: item.id, renotify: false, requireInteraction: true,
            icon: 'assets/icon-192.png', badge: 'assets/icon-192.png',
            data: { key: item.key, startUtc: item.startUtc, url: location.href }
        };
        try {
            const reg = navigator.serviceWorker && await navigator.serviceWorker.getRegistration();
            if (reg && reg.showNotification) { await reg.showNotification(item.title, options); return; }
            new Notification(item.title, options);
        } catch (_) {}
    }

    async function check() {
        if (stopped) return;
        clearTimeout(timer);
        const now = Date.now();
        let next = null;
        try {
            // Hour-aligned windows, so the occurrences are worked out once an hour, not every check.
            const from = Math.floor((now - LOOK_BACK_MS) / HOUR) * HOUR;
            const to = Math.ceil((now + LOOK_AHEAD_MS) / HOUR) * HOUR;
            const alarms = alarmsIn(ctx.occurrences(from, to), from, to);
            next = nextAlarmAt(alarms, now);
            const due = await withLock('myai-calendar-reminders', async () => {
                const saved = (await ctx.store.getMeta('reminders')) || {};
                const result = dueReminders(alarms, { now, lastCheck: saved.lastCheck ?? null, shown: saved.shown || {} });
                await ctx.store.setMeta('reminders', { shown: result.shown, lastCheck: result.lastCheck });
                return result.due;
            });
            if (due && due.length) {
                const items = due.map(r => ({
                    id: r.id, key: r.occurrence.key, startUtc: r.occurrence.startUtc,
                    ...reminderText(r, now, ctx.zone(), ctx.clock())
                }));
                for (const item of items) { present(item); notify(item); }
                ctx.broadcast({ type: 'reminders', items });
            }
        } catch (_) {
            // A failed look is tried again at the next one.
        }
        const wait = next ? Math.min(Math.max(next - Date.now() + 250, 1000), CHECK_AT_LEAST_EVERY_MS) : CHECK_AT_LEAST_EVERY_MS;
        timer = setTimeout(check, wait);
    }

    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(); });
    check();
    return {
        check,
        // Shown by another tab: the toast shows here too, the notification only once.
        showFromOtherTab(items) { for (const item of items || []) present(item); },
        stop() { stopped = true; clearTimeout(timer); }
    };
}
