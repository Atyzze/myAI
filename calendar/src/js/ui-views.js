// Drawing the four views from what views-core works out: month, week (three days on a phone), day,
// and the list with search. Nothing here changes data; taps are handed to the callbacks in `on`.

import { h, clear } from './dom.js';
import { layoutDay, nowMinutes, minuteAt, chipsFor, dayBounds, agendaDays } from './views-core.js';
import { WEEKDAYS_SHORT, dayShort, dayLong, dayMedium, relativeDay, timeAt, timeOnDay, hourLabel } from './format.js';
import { parseDateKey, weekdayOf } from './wall.js';

const MAX_CHIPS = 3;

function colorOf(ctx, occ) {
    const cal = ctx.calendarsByHref.get(occ.calendar);
    return (cal && cal.color) || '#4caf50';
}

function occTitle(occ) {
    return occ.summary || '(No title)';
}

function chip(ctx, occ, dayKey) {
    const pending = ctx.pendingHrefs.has(occ.href);
    const zone = ctx.zone;
    const timeText = occ.allDay ? null
        : (occ.startUtc >= dayBounds(dayKey, zone).start ? timeAt(occ.startUtc, zone, ctx.clock) : '↳');
    return h('button', {
        type: 'button',
        class: `chip${occ.allDay ? ' allday' : ''}${occ.cancelled ? ' cancelled' : ''}${pending ? ' pending' : ''}`,
        style: { '--c': colorOf(ctx, occ) },
        title: `${occTitle(occ)}${pending ? ' (not yet on the server)' : ''}`,
        onclick: event => { event.stopPropagation(); ctx.on.openOccurrence(occ); }
    }, timeText ? h('span', { class: 't' }, timeText) : null, occTitle(occ));
}

// ---- month ---------------------------------------------------------------------------------------------------

function renderMonth(container, ctx) {
    const { range, byDay, todayKey, focusKey } = ctx;
    const grid = h('div', { class: 'month', role: 'grid', 'aria-label': range.title });
    for (let i = 0; i < 7; i++) {
        const weekday = (ctx.weekStart + i) % 7;
        grid.append(h('div', { class: 'wd', role: 'columnheader' }, WEEKDAYS_SHORT[weekday]));
    }
    for (const key of range.days) {
        const date = parseDateKey(key);
        const list = byDay.get(key) || [];
        const classes = ['day'];
        if (date.month !== range.month) classes.push('other');
        if (key === todayKey) classes.push('today');
        if (key === focusKey) classes.push('selected');
        const { shown, more } = chipsFor(list, MAX_CHIPS);
        const cell = h('div', {
            class: classes.join(' '), role: 'gridcell', 'data-date': key,
            'aria-label': `${dayLong(key)}, ${list.length ? `${list.length} event${list.length === 1 ? '' : 's'}` : 'nothing planned'}`,
            onclick: () => ctx.on.selectDay(key),
            ondblclick: () => ctx.on.newEventAt(key, null)
        },
        h('button', {
            type: 'button', class: 'num', 'aria-label': `Open ${dayLong(key)}`,
            onclick: event => { event.stopPropagation(); ctx.on.openDay(key); }
        }, String(date.day)),
        shown.map(occ => chip(ctx, occ, key)),
        more ? h('div', { class: 'more' }, `+${more} more`) : null,
        list.length ? h('div', { class: 'dots', 'aria-hidden': 'true' },
            list.slice(0, 4).map(occ => h('i', { style: { '--c': colorOf(ctx, occ) } }))) : null);
        grid.append(cell);
    }
    container.append(grid);
    // The chosen day's events under the month: on a phone the only place to read them.
    const items = byDay.get(focusKey) || [];
    container.append(h('div', { class: 'agenda', 'data-agenda': focusKey },
        dayBlock(ctx, focusKey, items, { addButton: true, emptyText: 'Nothing planned.' })));
}

// ---- week and day --------------------------------------------------------------------------------------------

function renderTimeline(container, ctx) {
    const { range, byDay, todayKey } = ctx;
    const cols = range.days.length;
    const timeline = h('div', { class: 'timeline', style: { '--cols': String(cols) } });

    const head = h('div', { class: 'tl-head' }, h('div', null));
    for (const key of range.days) {
        const date = parseDateKey(key);
        head.append(h('div', {
            class: `h${key === todayKey ? ' today' : ''}`, role: 'button', tabindex: '0', 'data-date': key,
            'aria-label': `Open ${dayLong(key)}`,
            onclick: () => ctx.on.openDay(key),
            onkeydown: event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); ctx.on.openDay(key); } }
        }, h('b', null, String(date.day)), WEEKDAYS_SHORT[weekdayOf(date)]));
    }
    timeline.append(head);

    const allDayRow = h('div', { class: 'tl-allday' }, h('div', { class: 'lbl' }, 'all day'));
    for (const key of range.days) {
        const list = (byDay.get(key) || []).filter(o => o.allDay);
        allDayRow.append(h('div', { class: 'cell', 'data-date': key }, list.map(occ => chip(ctx, occ, key))));
    }
    timeline.append(allDayRow);

    const scroll = h('div', { class: 'tl-scroll' });
    const grid = h('div', { class: 'tl-grid' });
    const hours = h('div', { class: 'tl-hours', 'aria-hidden': 'true' });
    for (let hour = 1; hour < 24; hour++) {
        hours.append(h('span', { style: { top: `calc(${hour} * var(--hour))` } }, hourLabel(hour, ctx.clock)));
    }
    grid.append(hours);
    for (const key of range.days) {
        const col = h('div', {
            class: `tl-col${key === todayKey ? ' today' : ''}`, 'data-date': key,
            'aria-label': `${dayLong(key)}: tap a time to plan something`,
            onclick: event => {
                if (event.target !== col) return;
                const rect = col.getBoundingClientRect();
                ctx.on.newEventAt(key, minuteAt((event.clientY - rect.top) / rect.height));
            }
        });
        for (const item of layoutDay(byDay.get(key) || [], key, ctx.zone)) {
            const occ = item.occ;
            const span = (item.bottom - item.top) / 60;
            const pending = ctx.pendingHrefs.has(occ.href);
            // On a phone's narrow columns only the start fits beside the title.
            const withEnd = occ.endUtc > occ.startUtc && span >= 0.75 && !ctx.narrow;
            const label = item.startsBefore ? `↳ until ${timeAt(occ.endUtc, ctx.zone, ctx.clock)}`
                : `${timeAt(occ.startUtc, ctx.zone, ctx.clock)}${withEnd ? ` - ${timeAt(occ.endUtc, ctx.zone, ctx.clock)}` : ''}`;
            col.append(h('button', {
                type: 'button',
                // A short event has room for one line: its time and title side by side.
                class: `tl-ev${span < 0.75 ? ' short' : ''}${occ.cancelled ? ' cancelled' : ''}${pending ? ' pending' : ''}`,
                style: {
                    '--c': colorOf(ctx, occ),
                    top: `calc(${item.top / 60} * var(--hour))`,
                    height: `calc(${span} * var(--hour) - 2px)`,
                    left: `calc(${item.col} * 100% / ${item.cols} + 1px)`,
                    width: `calc(100% / ${item.cols} - 3px)`
                },
                title: `${occTitle(occ)} (${label})`,
                onclick: event => { event.stopPropagation(); ctx.on.openOccurrence(occ); }
            }, h('span', { class: 't' }, label), occTitle(occ), occ.location && span >= 1.2 ? h('span', { class: 'loc' }, occ.location) : null));
        }
        const now = nowMinutes(key, ctx.nowMs, ctx.zone);
        if (now != null) col.append(h('div', { class: 'tl-now', style: { top: `calc(${now / 60} * var(--hour))` } }));
        grid.append(col);
    }
    scroll.append(grid);
    timeline.append(scroll);
    container.append(timeline);
    // The hours scroll under the day headers: the headers leave room for the scroll bar, so the
    // columns line up.
    requestAnimationFrame(() => {
        const gutter = Math.max(0, scroll.offsetWidth - scroll.clientWidth);
        head.style.paddingRight = `${gutter}px`;
        allDayRow.style.paddingRight = `${gutter}px`;
    });
    return scroll;
}

// ---- list ------------------------------------------------------------------------------------------------------

function itemRow(ctx, occ, dayKey) {
    const zone = ctx.zone;
    const { start, end } = dayBounds(dayKey, zone);
    const cal = ctx.calendarsByHref.get(occ.calendar);
    const pending = ctx.pendingHrefs.has(occ.href);
    const sub = [occ.location, ctx.showCalendarNames && cal ? cal.name : null, pending ? 'not yet on the server' : null].filter(Boolean).join(' · ');
    return h('button', {
        type: 'button', class: `item${occ.cancelled ? ' cancelled' : ''}`, style: { '--c': colorOf(ctx, occ) },
        onclick: () => ctx.on.openOccurrence(occ)
    },
    h('span', { class: 'when' }, timeOnDay(occ, dayKey, start, end, zone, ctx.clock)),
    h('span', { class: 'bar' }),
    h('span', { class: 'what' }, h('b', null, occTitle(occ)), sub ? h('span', null, sub) : null));
}

function dayBlock(ctx, key, items, { addButton = false, emptyText = '' } = {}) {
    const rel = relativeDay(key, ctx.todayKey);
    const block = h('div', { class: `agenda-day${key < ctx.todayKey ? ' past' : ''}`, 'data-date': key },
        h('h3', null, dayMedium(key), rel ? h('span', { class: 'badge' }, rel) : null));
    if (items.length) for (const occ of items) block.append(itemRow(ctx, occ, key));
    else if (emptyText) block.append(h('div', { class: 'agenda-empty' }, emptyText));
    if (addButton) {
        block.append(h('button', { type: 'button', class: 'more-btn', onclick: () => ctx.on.newEventAt(key, null) }, `＋ Add on ${dayShort(key)}`));
    }
    return block;
}

export function renderListResults(results, ctx) {
    clear(results);
    const days = ctx.searchResults ? ctx.searchResults.days : agendaDays(ctx.occurrences, ctx.range.days, ctx.zone);
    if (ctx.searchResults) {
        const { total, capped } = ctx.searchResults;
        results.append(h('div', { class: 'hint', style: { margin: '4px 2px 8px' } },
            total ? `${total} found${capped ? ' (the first shown)' : ''}, from a year back to two years ahead.` : 'Nothing found from a year back to two years ahead.'));
    } else if (!days.length) {
        results.append(h('div', { class: 'agenda-empty' }, `Nothing planned from ${dayMedium(ctx.range.from)} to ${dayMedium(ctx.range.days[ctx.range.days.length - 1])}.`));
    }
    const agenda = h('div', { class: 'agenda' });
    for (const { key, items } of days) agenda.append(dayBlock(ctx, key, items));
    results.append(agenda);
    if (!ctx.searchResults) {
        results.append(h('button', { type: 'button', class: 'more-btn', onclick: () => ctx.on.showMore() }, `Show ${ctx.listStep} more days`));
    }
}

function renderList(container, ctx) {
    const input = h('input', {
        id: 'search', type: 'search', placeholder: 'Search titles, places and notes', value: ctx.search || '',
        autocomplete: 'off', 'aria-label': 'Search',
        oninput: () => ctx.on.search(input.value)
    });
    container.append(h('div', { class: 'list-tools' }, input));
    const results = h('div', { class: 'list-results' });
    container.append(results);
    renderListResults(results, ctx);
}

// ---- the view -----------------------------------------------------------------------------------------------------

// Draws the view into the container. The week and day views keep their scroll position when they
// are drawn again for the same days (a sync must not make the hours jump).
export function renderView(container, ctx, previous = {}) {
    if (ctx.view === 'list' && previous.view === 'list' && container.querySelector('.list-results')) {
        renderListResults(container.querySelector('.list-results'), ctx);
        return { view: 'list' };
    }
    const oldScroll = container.querySelector('.tl-scroll');
    const keepScroll = oldScroll && previous.rangeKey === `${ctx.view}|${ctx.range.from}|${ctx.range.to}` ? oldScroll.scrollTop : null;
    clear(container);
    if (ctx.view === 'month') renderMonth(container, ctx);
    else if (ctx.view === 'list') renderList(container, ctx);
    else {
        const scroll = renderTimeline(container, ctx);
        requestAnimationFrame(() => {
            if (keepScroll != null) { scroll.scrollTop = keepScroll; return; }
            const hourPx = scroll.querySelector('.tl-grid').getBoundingClientRect().height / 24 || 48;
            const now = ctx.range.days.includes(ctx.todayKey) ? nowMinutes(ctx.todayKey, ctx.nowMs, ctx.zone) : null;
            const firstEvent = Math.min(...ctx.range.days.flatMap(key => layoutDay(ctx.byDay.get(key) || [], key, ctx.zone).map(i => i.top)), 24 * 60);
            const minute = now != null ? Math.max(0, now - 90) : Math.min(7 * 60, firstEvent);
            scroll.scrollTop = Math.max(0, (minute / 60) * hourPx - 4);
        });
    }
    return { view: ctx.view, rangeKey: `${ctx.view}|${ctx.range.from}|${ctx.range.to}` };
}
