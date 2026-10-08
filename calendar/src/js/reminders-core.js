// Which reminders are due while the app is open. The alarms themselves are the events' own (VALARM),
// the same ones a phone's calendar app rings for; this only decides when this app shows them, and
// makes sure each is shown once even with the app open in two tabs or reopened a minute later.

import { alarmsBetween } from './occurrences.js';
import { describeWhen, relativeText, timeAt } from './format.js';

// A reminder that came up while the app was closed is still shown when it is opened within this time.
export const MISSED_GRACE_MS = 15 * 60 * 1000;
// How long a shown reminder is remembered, so it is not shown again.
export const SHOWN_KEPT_MS = 3 * 86400000;
// The occurrences alarms are looked for in: an alarm can come up to two weeks before its event, or
// a while after it started.
export const LOOK_BACK_MS = 2 * 86400000;
export const LOOK_AHEAD_MS = 16 * 86400000;

// The alarms of these occurrences that go off in [fromUtc, toUtc), with an id that changes when the
// event is moved, so a moved event reminds again at its new time.
export function alarmsIn(occurrences, fromUtc, toUtc) {
    return alarmsBetween(occurrences, fromUtc, toUtc)
        .filter(a => a.alarm.action !== 'NONE')
        // Dismissed on another device (RFC 9074 ACKNOWLEDGED) after it went off: not shown here.
        .filter(a => !(a.alarm.acknowledged != null && a.alarm.acknowledged >= a.at))
        .map(a => ({ ...a, id: `${a.id}@${a.at}` }));
}

// The reminders to show now: those that went off since the last look (or in the last 15 minutes,
// whichever is later) and were not shown yet. Returns them with the updated record of what was shown.
export function dueReminders(alarms, { now, lastCheck = null, shown = {} }) {
    const graceStart = now - MISSED_GRACE_MS;
    const from = lastCheck == null || lastCheck > now ? graceStart : Math.max(lastCheck, graceStart);
    const due = alarms.filter(a => a.at <= now && (a.at > from || (lastCheck == null && a.at === from)) && !Object.prototype.hasOwnProperty.call(shown, a.id));
    const kept = {};
    for (const [id, at] of Object.entries(shown || {})) if (at > now - SHOWN_KEPT_MS) kept[id] = at;
    for (const a of due) kept[a.id] = a.at;
    return { due, shown: kept, lastCheck: now };
}

// When the next alarm after `now` goes off, or null.
export function nextAlarmAt(alarms, now) {
    let next = null;
    for (const a of alarms) if (a.at > now && (next === null || a.at < next)) next = a.at;
    return next;
}

// The words of a reminder: the title, and when the event is relative to now.
export function reminderText(reminder, now, viewerZone, clock = '24') {
    const occ = reminder.occurrence;
    const title = occ.summary || '(No title)';
    let when;
    if (occ.allDay) {
        when = describeWhen(occ, viewerZone, clock).main;
    } else {
        const delta = occ.startUtc - now;
        const at = timeAt(occ.startUtc, viewerZone, clock);
        if (Math.abs(delta) < 60000) when = `Starts now (${at})`;
        else if (delta > 0) when = `Starts ${relativeText(delta)} (${at})`;
        else if (occ.endUtc > now) when = `Started ${relativeText(delta)} (${at})`;
        else when = `Was at ${at}`;
    }
    const late = now - reminder.at > 60000 ? ' (missed while the app was closed)' : '';
    return { title, body: `${when}${occ.location ? `, ${occ.location}` : ''}${late}` };
}
