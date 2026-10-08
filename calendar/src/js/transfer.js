// Moving events in and out as .ics files: a calendar exported from Google, Apple or Outlook comes in
// one event (one UID) per calendar object, each with the VTIMEZONEs it uses; a calendar goes out as
// one file any calendar app can import.

import { parseComponents, serializeComponent, component, property, getProp, childComponents,
         cloneComponent, setProp } from './icalendar.js';
import { newUid, PRODID } from './event-model.js';

function tzidsUsed(node, out = new Set()) {
    for (const prop of node.props) {
        for (const param of prop.params) if (param.name === 'TZID' && param.values[0]) out.add(param.values[0]);
    }
    for (const child of node.components) tzidsUsed(child, out);
    return out;
}

// Splits a calendar file into one object per event. Events without a UID get one; to-dos, journal
// entries and anything else that is not an event are counted and left out.
export function splitCalendarFile(text) {
    const roots = parseComponents(text);
    const calendars = roots.filter(r => r.name === 'VCALENDAR');
    const groups = new Map();
    const timezones = new Map();
    let skipped = 0;
    for (const cal of calendars) {
        for (const vtz of childComponents(cal, 'VTIMEZONE')) {
            const id = (getProp(vtz, 'TZID') || {}).value;
            if (id && !timezones.has(id)) timezones.set(id, vtz);
        }
        for (const child of cal.components) {
            if (child.name === 'VTIMEZONE') continue;
            if (child.name !== 'VEVENT') { skipped++; continue; }
            let uid = (getProp(child, 'UID') || {}).value;
            const event = cloneComponent(child);
            if (!uid) {
                uid = newUid();
                setProp(event, 'UID', uid);
            }
            if (!groups.has(uid)) groups.set(uid, []);
            groups.get(uid).push(event);
        }
    }
    const objects = [];
    for (const [uid, events] of groups) {
        const used = new Set();
        events.forEach(e => tzidsUsed(e, used));
        const vcalendar = component('VCALENDAR', [
            property('VERSION', '2.0'),
            property('PRODID', PRODID),
            property('CALSCALE', 'GREGORIAN')
        ]);
        for (const id of used) if (timezones.has(id)) vcalendar.components.push(cloneComponent(timezones.get(id)));
        // The master first, then its overrides.
        events.sort((a, b) => (getProp(a, 'RECURRENCE-ID') ? 1 : 0) - (getProp(b, 'RECURRENCE-ID') ? 1 : 0));
        vcalendar.components.push(...events);
        const summaryProp = getProp(events[0], 'SUMMARY');
        objects.push({ uid, text: serializeComponent(vcalendar), summary: summaryProp ? summaryProp.value : '' });
    }
    return { objects, skipped, calendarsInFile: calendars.length };
}

// One file with every event of a calendar, each VTIMEZONE once.
export function exportCalendar(texts, { name = 'Calendar' } = {}) {
    const vcalendar = component('VCALENDAR', [
        property('VERSION', '2.0'),
        property('PRODID', PRODID),
        property('CALSCALE', 'GREGORIAN'),
        property('X-WR-CALNAME', String(name).replace(/[\r\n]/g, ' '))
    ]);
    const timezones = new Map();
    const events = [];
    for (const text of texts) {
        for (const root of parseComponents(text)) {
            if (root.name !== 'VCALENDAR') continue;
            for (const child of root.components) {
                if (child.name === 'VTIMEZONE') {
                    const id = (getProp(child, 'TZID') || {}).value;
                    if (id && !timezones.has(id)) timezones.set(id, child);
                } else {
                    events.push(child);
                }
            }
        }
    }
    vcalendar.components.push(...timezones.values(), ...events);
    return serializeComponent(vcalendar);
}
