// How this device shows the calendar. These are per device (a phone may start its week on another
// day than the laptop); what the calendar holds is on the server.

import { localeClock, localeWeekStart } from './format.js';
import { TIMED_ALARM_PRESETS, ALL_DAY_ALARM_PRESETS } from './event-model.js';

export const VIEWS = ['month', 'week', 'day', 'list'];
export const DURATIONS = [15, 30, 45, 60, 90, 120, 180];

export const PREF_DEFAULTS = Object.freeze({
    view: 'month',
    weekStart: null,           // null: as the device's language and region say
    clock: null,               // null: as the device says; '24' or '12'
    durationMinutes: 60,
    alarmSeconds: -15 * 60,    // a new timed event reminds 15 minutes before; null for none
    allDayAlarmSeconds: 9 * 3600, // a new all-day event reminds at 09:00 that day; null for none
    defaultCalendar: null,     // the calendar new events go to (its address)
    hidden: [],                // calendars not shown on this device
    notify: false,             // also show reminders as system notifications while the app is open
    listDays: 30
});

// A reminder setting: seconds from the start (negative is before), or null for none.
function alarmSetting(value, fallback) {
    if (value === null || value === '' || value === 'none') return null;
    const n = Number(value);
    return Number.isFinite(n) && Math.abs(n) <= 60 * 86400 ? n : fallback;
}

export const ALARM_CHOICES = { timed: TIMED_ALARM_PRESETS, allDay: ALL_DAY_ALARM_PRESETS };

export function normalizePrefs(raw) {
    const p = { ...PREF_DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) };
    const out = { ...PREF_DEFAULTS };
    if (VIEWS.includes(p.view)) out.view = p.view;
    if ([0, 1, 6].includes(p.weekStart)) out.weekStart = p.weekStart;
    if (p.clock === '24' || p.clock === '12') out.clock = p.clock;
    if (DURATIONS.includes(Number(p.durationMinutes))) out.durationMinutes = Number(p.durationMinutes);
    out.alarmSeconds = alarmSetting(p.alarmSeconds, PREF_DEFAULTS.alarmSeconds);
    out.allDayAlarmSeconds = alarmSetting(p.allDayAlarmSeconds, PREF_DEFAULTS.allDayAlarmSeconds);
    if (typeof p.defaultCalendar === 'string' && p.defaultCalendar) out.defaultCalendar = p.defaultCalendar;
    if (Array.isArray(p.hidden)) out.hidden = p.hidden.filter(h => typeof h === 'string');
    out.notify = p.notify === true;
    const days = parseInt(p.listDays, 10);
    if (days >= 7 && days <= 366) out.listDays = days;
    return out;
}

export function effectiveWeekStart(prefs, locale) {
    return prefs.weekStart == null ? localeWeekStart(locale) : prefs.weekStart;
}

export function effectiveClock(prefs, locale) {
    return prefs.clock || localeClock(locale);
}

// The calendar a new event goes to: the chosen one while it exists and can be written, otherwise
// the first that can.
export function pickDefaultCalendar(calendars, prefs) {
    const writable = calendars.filter(c => !c.readOnly && (!c.components || c.components.includes('VEVENT')));
    return writable.find(c => c.href === prefs.defaultCalendar) || writable[0] || null;
}
