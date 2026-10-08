// Each guard breaks one thing the calendar must get right, and names the test that has to notice.
// The mutation smoke run applies each to a copy of the app, runs that test, and fails unless the
// test fails with the expected message: a test that cannot tell the broken code from the real one
// is not protecting anything.
export const guards = [
    {
        id: 'MUT-SKIP-PAST-THE-WINDOW',
        file: 'src/js/rrule.js',
        from: '    return Math.max(0, periods - 2);',
        to: '    return Math.max(0, periods + 1);',
        command: ['node', 'tests/unit/core.test.mjs'],
        expected: /starting late/
    },
    {
        id: 'MUT-EXDATE-IGNORED',
        file: 'src/js/occurrences.js',
        from: '            if (exdates.has(key) || overrideKeys.has(key)) return;',
        to: '            if (overrideKeys.has(key)) return;',
        command: ['node', 'tests/unit/core.test.mjs'],
        expected: /an EXDATE removes its occurrence/
    },
    {
        id: 'MUT-END-NOT-A-CLOCK-TIME',
        file: 'src/js/occurrences.js',
        from: '    if (timing.wallEnd) {',
        to: '    if (false) {',
        command: ['node', 'tests/unit/ui-core.test.mjs'],
        expected: /night shift until 06:00 ends at 06:00/
    },
    {
        id: 'MUT-CUT-OVERLAPS',
        file: 'src/js/event-model.js',
        from: '    else until = { ...utcToWall(split.utc - 1000, UTC_ZONE), date: false, utc: true };',
        to: '    else until = { ...utcToWall(split.utc, UTC_ZONE), date: false, utc: true };',
        command: ['node', 'tests/unit/series-edit.test.mjs'],
        expected: /ends one second before the 4th/
    },
    {
        id: 'MUT-COUNT-STARTS-OVER',
        file: 'src/js/event-model.js',
        from: '        const left = Math.max(1, oldRule.count - before);',
        to: '        const left = oldRule.count;',
        command: ['node', 'tests/unit/series-edit.test.mjs'],
        expected: /with what is left of COUNT/
    },
    {
        id: 'MUT-REST-LOSES-EXCEPTIONS',
        file: 'src/js/event-model.js',
        from: '        return key != null && keyAtOrAfter(key, split);\n    });',
        to: '        return false;\n    });',
        command: ['node', 'tests/unit/series-edit.test.mjs'],
        expected: /and the changed occurrence after it, under the new UID/
    },
    {
        id: 'MUT-OLD-REMINDERS-RING',
        file: 'src/js/reminders-core.js',
        from: '    const from = lastCheck == null || lastCheck > now ? graceStart : Math.max(lastCheck, graceStart);',
        to: '    const from = lastCheck == null ? now - 365 * 86400000 : lastCheck;',
        command: ['node', 'tests/unit/ui-core.test.mjs'],
        expected: /not when the app was opened twenty minutes later/
    },
    {
        id: 'MUT-DISMISSED-RINGS-AGAIN',
        file: 'src/js/reminders-core.js',
        from: '        .filter(a => !(a.alarm.acknowledged != null && a.alarm.acknowledged >= a.at))',
        to: '        .filter(a => true)',
        command: ['node', 'tests/unit/ui-core.test.mjs'],
        expected: /dismissed on another device/
    },
    {
        id: 'MUT-OVERLAPS-STACKED',
        file: 'src/js/views-core.js',
        from: '            let col = columnEnds.findIndex(end => end <= item.top);',
        to: '            let col = columnEnds.length ? 0 : -1;',
        command: ['node', 'tests/unit/ui-core.test.mjs'],
        expected: /two overlapping events side by side/
    },
    {
        id: 'MUT-ALL-DAY-DAY-AFTER',
        file: 'src/js/views-core.js',
        from: '            for (const b of bounds) if (b.key >= occ.startDate && b.key < occ.endDate) map.get(b.key).push(occ);',
        to: '            for (const b of bounds) if (b.key >= occ.startDate && b.key <= occ.endDate) map.get(b.key).push(occ);',
        command: ['node', 'tests/unit/ui-core.test.mjs'],
        expected: /not the day after/
    },
    {
        id: 'MUT-LINK-ANY-SCHEME',
        file: 'src/js/links-core.js',
        from: "        return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;",
        to: '        return url.href;',
        command: ['node', 'tests/unit/ui-core.test.mjs'],
        expected: /nothing but http and https becomes a link/
    },
    {
        id: 'MUT-BROWSER-LOGIN-BOX',
        file: 'src/js/caldav.js',
        from: "cache: 'no-store', credentials: 'omit', redirect: 'follow'",
        to: "cache: 'no-store', credentials: 'same-origin', redirect: 'follow'",
        command: ['node', 'tests/unit/static.test.mjs'],
        expected: /never pops up the browser's login box/
    },
    {
        id: 'MUT-WORKER-CACHES-EVENTS',
        file: 'sw.js',
        from: '    if (SHELL_URLS.has(url.origin + url.pathname)) event.respondWith(fromShell(request));',
        to: '    event.respondWith(fromShell(request));',
        command: ['node', 'tests/unit/static.test.mjs'],
        expected: /never the calendar server/
    },
    {
        id: 'MUT-EARLIER-EDIT-WINS',
        file: 'src/js/sync.js',
        from: '        if (theirs > (op.editedAt || 0)) {',
        to: '        if (theirs < (op.editedAt || 0)) {',
        command: ['node', 'tests/integration/sync-radicale.mjs'],
        expected: /the one made later wins on both devices/
    },
    {
        id: 'MUT-EDIT-LOST-TO-DELETE-404',
        file: 'src/js/sync.js',
        from: '                await this.setBase(op, null);\n                return this.pushOne({ ...op, baseEtag: null }, changes, attempt + 1);\n            }\n            if (err.kind === \'conflict\')',
        to: '                await this.store.dropOp(op.id);\n                return;\n            }\n            if (err.kind === \'conflict\')',
        command: ['node', 'tests/unit/sync-fake.test.mjs'],
        expected: /put back with the edit, also when the server answers 404/
    },
    {
        id: 'MUT-EDIT-LOST-TO-DELETE-412',
        file: 'src/js/sync.js',
        from: '            await this.setBase(op, null);\n            return this.pushOne({ ...op, baseEtag: null }, changes, attempt + 1);\n        }\n        if (op.type === \'put\' && !op.baseEtag',
        to: '            await this.store.dropOp(op.id);\n            return;\n        }\n        if (op.type === \'put\' && !op.baseEtag',
        command: ['node', 'tests/integration/sync-radicale.mjs'],
        expected: /put back with the edit, not lost/
    },
    {
        id: 'MUT-LOST-ANSWER-DUPLICATES',
        file: 'src/js/sync.js',
        from: "        if (op.type === 'put' && !op.baseEtag && server.data === op.data) {",
        to: "        if (false) {",
        command: ['node', 'tests/unit/sync-fake.test.mjs'],
        expected: /recognises the event already arrived/
    },
    {
        id: 'MUT-LOSS-MIRRORED-WITHOUT-COPY',
        file: 'src/js/sync.js',
        from: "            await this.keepCopy({ reason: 'events', calendar: cal, objects: going.map(href => localObjects.get(href)) });",
        to: '            void going;',
        command: ['node', 'tests/unit/sync-fake.test.mjs'],
        expected: /keeps a copy of the ten events that went/
    },
    {
        id: 'MUT-CALENDAR-GONE-WITHOUT-COPY',
        file: 'src/js/sync.js',
        from: "                if (objects.length) await this.keepCopy({ reason: 'calendar', calendar: cal, objects });",
        to: '                void objects;',
        command: ['node', 'tests/unit/sync-fake.test.mjs'],
        expected: /a whole calendar gone from the server is kept too/
    },
    {
        id: 'MUT-OFFLINE-CREATE-THEN-DELETE-SENT',
        file: 'src/js/store.js',
        from: '        if (!existing.baseEtag && !existing.sent && !existing.sending) return null;',
        to: '        if (false) return null;',
        command: ['node', 'tests/integration/sync-radicale.mjs'],
        expected: /an event made and deleted offline leaves nothing to send/
    }
];
