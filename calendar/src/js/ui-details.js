// The panel that opens when an event is tapped: when it is, how it repeats, where (with map links),
// its reminders and notes, and what can be done with it.

import { h, clear, byId, openOverlay, closeOverlay, append } from './dom.js';
import { describeWhen, dayMedium, weekdayNameOf } from './format.js';
import { mapLinks, geoOf, linkify, safeHttpUrl, appleLocationTitle } from './links-core.js';
import { describeAlarmSeconds } from './event-model.js';
import { getProp, parseRecur } from './icalendar.js';
import { describeRule } from './rrule.js';
import { dateKey } from './wall.js';
import { utcToWall } from './tz.js';

function linkifiedText(text) {
    return linkify(text).map(part => (part.href
        ? h('a', { href: part.href, target: '_blank', rel: 'noopener noreferrer' }, part.text)
        : part.text));
}

function repeatText(ctx, occ) {
    if (!occ.recurring) return '';
    if (occ.override) return 'One occurrence of a repeating event, changed on its own.';
    const series = ctx.index.series(occ.href);
    const master = series && series.master;
    const ruleProp = master && getProp(master, 'RRULE');
    if (!ruleProp) return 'Repeats on set dates.';
    const rule = parseRecur(ruleProp.value);
    if (!rule) return 'Repeats.';
    let untilText = null;
    if (rule.until) {
        const until = rule.until.utc && occ.zone ? utcToWall(Date.UTC(rule.until.year, rule.until.month - 1, rule.until.day, rule.until.hour, rule.until.minute, rule.until.second), occ.zone) : rule.until;
        untilText = dayMedium(dateKey(until));
    }
    return describeRule(rule, { untilText, weekdayName: weekdayNameOf });
}

function alarmText(occ, alarm) {
    if (alarm.absoluteUtc != null) return 'At a set time';
    const seconds = alarm.offset.days * 86400 + alarm.offset.seconds;
    return `${describeAlarmSeconds(seconds, occ.allDay)}${alarm.related === 'END' ? ' (from the end)' : ''}`;
}

export function openDetails(ctx, occ) {
    const panel = byId('detailsPanel');
    clear(panel);
    const record = ctx.index.get(occ.href);
    const cal = ctx.calendarsByHref.get(occ.calendar);
    const readOnly = !record || (cal && cal.readOnly);
    const when = describeWhen(occ, ctx.zone, ctx.clock);
    const repeat = repeatText(ctx, occ);
    const geo = geoOf(occ.vevent);
    const placeTitle = appleLocationTitle(occ.vevent);
    const locationUrl = safeHttpUrl(occ.location);
    const maps = mapLinks(occ.location || placeTitle, geo);
    const alarms = (occ.alarms || []).filter(a => a.action !== 'NONE');

    append(panel, [
        h('div', { class: 'panel-head' },
            h('h2', { id: 'dt-title', style: { fontSize: '17px', color: '#fff' } }, occ.summary || '(No title)'),
            h('button', { class: 'close-btn', type: 'button', 'data-close': 'detailsOverlay' }, '✕')),
        occ.cancelled ? h('div', { class: 'err-box' }, 'Cancelled.') : null,
        h('div', { class: 'details-when' }, when.main,
            when.zoneNote ? h('div', { class: 'hint' }, `(${when.zoneNote})`) : null),
        h('div', { class: 'details-meta' },
            repeat ? h('div', null, h('span', { class: 'k' }, 'Repeats'), `🔁 ${repeat}`) : null,
            cal ? h('div', null, h('span', { class: 'k' }, 'Calendar'),
                h('span', { class: 'row', style: { gap: '6px' } }, h('span', { class: 'cal-dot', style: { '--c': cal.color || '#4caf50' } }), cal.name,
                    cal.readOnly ? h('span', { class: 'hint' }, '(read only)') : null)) : null,
            occ.location || placeTitle ? h('div', null, h('span', { class: 'k' }, 'Where'),
                locationUrl ? h('a', { href: locationUrl, target: '_blank', rel: 'noopener noreferrer' }, occ.location)
                    : h('span', null, `📍 ${occ.location || placeTitle}`)) : null,
            maps.length ? h('div', { class: 'map-links' }, maps.map(link =>
                h('a', { href: link.href, target: '_blank', rel: 'noopener noreferrer' }, link.label))) : null,
            occ.url && safeHttpUrl(occ.url) ? h('div', null, h('span', { class: 'k' }, 'Link'),
                h('a', { href: safeHttpUrl(occ.url), target: '_blank', rel: 'noopener noreferrer' }, occ.url)) : null,
            alarms.length ? h('div', null, h('span', { class: 'k' }, 'Reminders'),
                alarms.map(a => h('div', null, `🔔 ${alarmText(occ, a)}`))) : null),
        occ.description ? h('div', { class: 'notes' }, linkifiedText(occ.description)) : null,
        record && record.pending ? h('div', { class: 'warn-box' }, 'Saved on this device; it goes to the box at the next sync.') : null,
        readOnly ? h('div', { class: 'hint' }, 'This calendar is read only here.') : null,
        h('div', { class: 'btn-row' },
            readOnly ? null : h('button', { class: 'btn primary', type: 'button', 'data-action': 'edit',
                onclick: () => { closeOverlay('detailsOverlay', { force: true }); ctx.actions.edit(occ); } }, '✏️ Edit'),
            h('button', { class: 'btn', type: 'button', 'data-action': 'duplicate',
                onclick: () => { closeOverlay('detailsOverlay', { force: true }); ctx.actions.duplicate(occ); } }, '⧉ Duplicate'),
            readOnly ? null : h('button', { class: 'btn danger', type: 'button', 'data-action': 'delete',
                onclick: async () => {
                    const deleted = await ctx.actions.remove(occ);
                    if (deleted) closeOverlay('detailsOverlay', { force: true });
                } }, '🗑 Delete'))
    ]);
    openOverlay('detailsOverlay');
}
