export const mutations = [
    {
        id: 'MUT-LIVE-COVERAGE-BEFORE-TEXT',
        file: 'src/js/live-scribe-core.js',
        from: 'covered: released.ready.filter(entry => entry.coverage)',
        to: 'covered: [...released.ready, ...pending.values()].filter(entry => entry.coverage)',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /a window waiting for an earlier one is not yet counted as transcribed/
    },
    {
        id: 'MUT-RENAME-KEEPS-FULLER',
        file: 'src/js/diarize-core.js',
        from: '    const chosen = existing && inferred ? preferFullerName(existing, clean) : clean;',
        to: '    const chosen = existing ? preferFullerName(existing, clean) : clean;',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /a spoken rename to a shorter name is carried out/
    },
    {
        id: 'MUT-STALE-TRANSLATION',
        file: 'src/js/translate-core.js',
        from: 'line.key === row.key && line.text === row.text',
        to: 'line.key === row.key',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /a late translation of text that was since corrected is dropped/
    },
    {
        id: 'MUT-STOP-TWICE',
        file: 'src/js/jobs.js',
        from: '        if (!running) running = Promise.resolve().then(task)',
        to: '        running = Promise.resolve().then(task)',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /a second stop while one is saving joins the same save/
    },
    {
        id: 'MUT-AFTER-RECORDING-PARALLEL',
        file: 'src/js/jobs.js',
        from: '            if (await task() === CANCELLED) return CANCELLED;',
        to: '            Promise.resolve().then(task).catch(err => reportFailedStep(err, index));',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /the automatic pipeline and the cleanup pass never overlap/
    },
    {
        id: 'MUT-DELETE-TEXT-TAKES-AUDIO',
        file: 'src/js/retention-core.js',
        from: '        if (!(Number(row.audioBytes) > 0) && !row.processing) deleteIds.push(row.id);',
        to: '        if (!(Number(row.audioBytes) > 0)) deleteIds.push(row.id);',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /only rows with nothing else left are removed/
    },
    {
        id: 'MUT-RETENTION-LOSES-LIVE-DECISION',
        file: 'src/js/settings.js',
        from: "                    if (dropLive) await deleteLiveTranscript(id).catch(() => {});",
        to: "                    if (false) await deleteLiveTranscript(id).catch(() => {});",
        command: ['node', 'tests/unit/storage-paths.test.mjs'],
        expected: /text past its window takes the live transcript with it/
    },
    {
        id: 'MUT-CONVERT-RESURRECTS',
        file: 'src/js/audio-format.js',
        from: 'export function conversionStillApplies(current, original) {\n    return ',
        to: 'export function conversionStillApplies(current, original) {\n    return true || ',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /audio deleted during conversion stays deleted/
    },
    {
        id: 'MUT-POPUP-INLINE-SCRIPT',
        file: 'src/js/live-tabs.js',
        from: '  <div id="footer">${footer}</div>\n  </body></html>`;',
        to: '  <div id="footer">${footer}</div>\n  <script type="module" src="live-view.js"><\\/script>\n  </body></html>`;',
        command: ['node', 'tests/unit/live-view.test.mjs'],
        expected: /popup document has no script element/
    },
    {
        id: 'MUT-SHELL-OMIT-MODULE',
        file: 'sw.js',
        from: "    './src/js/live-render.js',\n",
        to: '',
        command: ['node', 'tests/unit/static.test.mjs'],
        expected: /the offline shell includes live-render\.js/
    },
    {
        id: 'MUT-JOB-IDENTITY',
        file: 'src/js/jobs.js',
        from: 'if (controller && controllers.get(k) !== controller) return false;',
        to: 'if (false) return false;',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /stale completion cannot unregister newer controller|newer controller survives stale cleanup/
    },
    {
        id: 'MUT-LOCK-SPLIT-BRAIN',
        file: 'src/js/recording-lock.js',
        from: 'resolveAcquired(false);\n                    return;',
        to: 'resolveAcquired(true);\n                    return;',
        command: ['node', 'tests/integration/multitab-integration.mjs'],
        expected: /tab B is denied while tab A holds Web Lock|one nested hold remains/
    },
    {
        id: 'MUT-LOCK-FALLBACK-VERIFY',
        file: 'src/js/recording-lock.js',
        from: 'if (!verify || verify.ownerId !== tabId || verify.token !== fallbackToken) {',
        to: 'if (!verify) {',
        command: ['node', 'tests/unit/recording-lock.test.mjs'],
        expected: /fallback verification rejects a lease overwritten during acquisition/
    },
    {
        id: 'MUT-WAV-ASSEMBLY',
        file: 'src/js/audio.js',
        from: 'v.setUint32(0,  0x46464952, true);',
        to: 'v.setUint32(0,  0x00000000, true);',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /RIFF magic|recognises a RIFF\/WAVE header/
    },
    {
        id: 'MUT-WEBM-PASSTHROUGH',
        file: 'src/js/webm-duration.js',
        from: '    if (!Number.isFinite(ms) || ms <= 0) return blob;',
        to: '    if (!Number.isFinite(ms) || ms <= 0 || ms > 0) return blob;',
        command: ['node', 'tests/unit/webm-duration.test.mjs'],
        expected: /missing Duration is inserted|finite size|CuePoint/
    },
    {
        id: 'MUT-OPUS-WINDOWING',
        file: 'src/js/webm-duration.js',
        from: "    if (!(blob instanceof Blob)) throw new TypeError('Expected a Blob.');\n    const type = String(blob.type || '').toLowerCase();\n    if (!type.includes('webm')) return null;",
        to: "    return null;\n    if (!(blob instanceof Blob)) throw new TypeError('Expected a Blob.');\n    const type = String(blob.type || '').toLowerCase();\n    if (!type.includes('webm')) return null;",
        command: ['node', 'tests/unit/webm-duration.test.mjs'],
        expected: /multi-hour WebM source/
    },
    {
        id: 'MUT-SW-API-CACHE',
        file: 'sw.js',
        from: "    if (isApiRoute(url.pathname)) return;",
        to: "    if (isApiRoute(url.pathname)) { event.respondWith(cacheFirstShell(request)); return; }",
        command: ['node', 'tests/unit/sw-routing.test.mjs'],
        expected: /Ollama GET route is not intercepted or cached|transcription GET route is not intercepted or cached/
    },
    {
        id: 'MUT-RUNNER-SKIP',
        file: 'tests/helpers/baseline-core.mjs',
        from: "if (markerStatus === 'skip') return portable ? 'skip' : 'fail';",
        to: "if (markerStatus === 'skip') return 'pass';",
        command: ['node', 'tests/unit/baseline-runner.test.mjs'],
        expected: /strict mode rejects a skipped suite|portable mode records an explicit skip/
    },
    {
        id: 'MUT-POPUP-UNBOUNDED-WAIT',
        file: 'src/js/live-tabs.js',
        from: '      if (Date.now() >= deadline) { _driving.delete(win); reportPopupFailure(win); return; }',
        to: '      if (false) { _driving.delete(win); reportPopupFailure(win); return; }',
        command: ['node', 'tests/unit/live-view.test.mjs'],
        expected: /a popup whose page never loads is told so/
    },
    {
        id: 'MUT-STREAM-REINIT-REPLACE',
        file: 'src/js/live-tabs.js',
        from: '  return resetEntry(_replyStreams, _replyStreamOrder, recId,\n                    { tokens: \'\', count: 0, firstAt: 0, lastAt: 0, model: \'\', done: false })\n         .generation;',
        to: '  _replyStreams[recId] = { tokens: \'\', listeners: [], count: 0, firstAt: 0, lastAt: 0, model: \'\', done: false, generation: 1 };\n  _touchEvict(_replyStreams, _replyStreamOrder, recId);\n  return _replyStreams[recId].generation;',
        command: ['node', 'tests/unit/live-view.test.mjs'],
        expected: /tokens still reach a popup opened before the stream was re-initialised/
    },
    {
        id: 'MUT-LIVE-VIEW-DESKTOP-ONLY',
        file: 'src/js/live-tabs.js',
        from: '  if (prefersInlineView()) return openInlineReplyStream(recId, recLabel);',
        to: '  if (false) return openInlineReplyStream(recId, recLabel);',
        command: ['node', 'tests/unit/live-view.test.mjs'],
        expected: /a touch device opens no second window/
    },
    {
        id: 'MUT-POPUP-UNREADABLE-LEFT-EMPTY',
        file: 'src/js/live-tabs.js',
        from: '      if (openInstead) {\n        try { win.close(); } catch (_) {}\n        openInstead();\n      }',
        to: '',
        command: ['node', 'tests/unit/live-view.test.mjs'],
        expected: /the view opens in the page instead/
    },
    {
        id: 'MUT-POPUP-POSTED-TO',
        file: 'src/js/live-tabs.js',
        from: "    try { renderer.handle(msg); } catch (err) { console.warn('Live view popup could not be updated:', err); }",
        to: "    try { renderer.handle(msg); win.postMessage({ msg }, '*'); } catch (err) { console.warn('Live view popup could not be updated:', err); }",
        command: ['node', 'tests/unit/live-view.test.mjs'],
        expected: /nothing is posted to the popup/
    },
    {
        id: 'MUT-POPUP-FOLLOWS-NAVIGATION',
        file: 'src/js/live-tabs.js',
        from: '    try { showing = !win.closed && win.document === doc; } catch (_) {}',
        to: "    try { showing = !win.closed; } catch (_) {}\n    if (showing) { try { win.document; } catch (_) { win.postMessage({ msg }, '*'); } }",
        command: ['node', 'tests/unit/live-view.test.mjs'],
        expected: /navigated to another site is let go/
    },
    {
        id: 'MUT-SAVED-VIEW-DESKTOP-ONLY',
        file: 'src/js/live-tabs.js',
        from: '  if (prefersInlineView()) return openInline();',
        to: '  if (false) return openInline();',
        command: ['node', 'tests/unit/live-view.test.mjs'],
        expected: /a saved reply opens no second window on a touch device/
    },
    {
        id: 'MUT-REPLY-MODEL-IGNORE-INSTALLED',
        file: 'src/js/reply-core.js',
        from: '    if (preferredName && list.includes(preferredName)) return preferredName;',
        to: '    if (false) return preferredName;',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /falls back to the preferred default when the stored model is gone/
    },
    {
        id: 'MUT-REPLY-STREAM-FRAMING',
        file: 'src/js/reply-core.js',
        from: "            while ((newline = buffer.indexOf('\\n')) >= 0) {",
        to: "            while (false && (newline = buffer.indexOf('\\n')) >= 0) {",
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /reply stream: the first token announces itself exactly once|reply stream: the object completes on the next read/
    },
    {
        id: 'MUT-LIVE-STATUS-KEYBOARD',
        file: 'src/js/live-tabs.js',
        from: "    main.setAttribute('tabindex', '0');",
        to: "",
        command: ['node', 'tests/unit/live-view.test.mjs'],
        expected: /the tap-to-watch target is focusable and exposed as a button/
    },
    {
        id: 'MUT-IDB-COMMIT-BEFORE-RESOLVE',
        file: 'src/js/idb-min.js',
        from: '            const res = await pReq(tx.objectStore(storeName).put(value));\n            await pTx(tx);',
        to: '            const res = await pReq(tx.objectStore(storeName).put(value));',
        command: ['node', 'tests/unit/platform.test.mjs'],
        expected: /a resolved put has already committed its transaction/
    },
    {
        id: 'MUT-WAKELOCK-NO-REACQUIRE',
        file: 'src/js/wake-lock.js',
        from: '        if (document.visibilityState === \'visible\' && _wantLock && !_sentinel) {',
        to: '        if (false && document.visibilityState === \'visible\' && _wantLock && !_sentinel) {',
        command: ['node', 'tests/unit/platform.test.mjs'],
        expected: /returning to the foreground re-acquires the dropped lock/
    },
    {
        id: 'MUT-SW-NAV-NETWORK-FIRST',
        file: 'sw.js',
        from: '    const shell = await cache.match(new URL(\'./index.html\', self.registration.scope).href);\n    if (shell) return shell;\n\n    try {',
        to: '    const shell = await cache.match(new URL(\'./index.html\', self.registration.scope).href);\n\n    try {',
        command: ['node', 'tests/unit/sw-routing.test.mjs'],
        expected: /served from the installed shell|touches the network not at all/
    },
    {
        id: 'MUT-SW-SHELL-HTTP-CACHE',
        file: 'sw.js',
        from: "        const response = await fetch(new Request(path, { cache: 'reload' }));",
        to: '        const response = await fetch(new Request(path));',
        command: ['node', 'tests/unit/sw-routing.test.mjs'],
        expected: /every shell resource is installed with cache: reload/
    },
    {
        id: 'MUT-REPLY-STREAM-GENERATION',
        file: 'src/js/live-tabs.js',
        from: '  if (!ownsEntry(s, generation)) return;\n  s.done = true;',
        to: '  s.done = true;',
        command: ['node', 'tests/unit/live-view.test.mjs'],
        expected: /superseded|generation/i
    },
    {
        id: 'MUT-RENDER-DEFER-LATCH',
        file: 'src/js/render-defer.js',
        from: '    return { paint: false, defer: true, armRecheck: !deferralPending };',
        to: '    return { paint: false, defer: true, armRecheck: false };',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /bounded re-check|live re-check/
    },
    {
        id: 'MUT-WHOLE-FILE-DECODE-UNBOUNDED',
        file: 'src/js/transcribe-core.js',
        from: '    const estimatedBytes = Math.round((ms / 1000) * DECODED_BYTES_PER_SECOND);\n    if (estimatedBytes > budget) {',
        to: '    const estimatedBytes = Math.round((ms / 1000) * DECODED_BYTES_PER_SECOND);\n    if (false) {',
        command: ['node', 'tests/unit/core.test.mjs'],
        expected: /past the budget is refused|five-hour recording is refused/
    },
    {
        id: 'MUT-LIVE-PREVIEW-POLL',
        file: 'src/js/player-core.js',
        from: '        : ended ? hasNewChunk\n        : false;',
        to: '        : ended ? hasNewChunk\n        : hasNewChunk;',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /paused, unrequested tick never rebuilds/
    },
    {
        id: 'MUT-RETENTION-NEVER',
        file: 'src/js/retention-core.js',
        from: '    const option = BY_VALUE.get(String(value ?? \'\'));\n    return (option || BY_VALUE.get(DEFAULT_RETENTION)).ms;',
        to: '    const option = BY_VALUE.get(String(value ?? \'\'));\n    return option ? option.ms : Infinity;',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /unrecognised stored value falls back to the default/
    },
    {
        id: 'MUT-RETENTION-TEXT-CLOCK',
        file: 'src/js/retention-core.js',
        from: '    const itemTime = item => Number(item && item.time) || recordedAt;',
        to: '    const itemTime = () => recordedAt;',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /generated yesterday is a day old, not forty/
    },
    {
        id: 'MUT-LIVE-SCRIBE-UNBOUNDED',
        file: 'src/js/live-scribe-core.js',
        from: '    if (inFlight >= maxInFlight) return { ...idle, dropSec };',
        to: '    if (inFlight >= maxInFlight) return idle;',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /still drops the audio it cannot hold|never left above its cap/
    },
    {
        id: 'MUT-LIVE-SCRIBE-GAP-TRIM',
        file: 'src/js/live-scribe-core.js',
        from: '        const mayRepeat = tail && !(gap && appended === 0) && itemStart < seamLimit;',
        to: '        const mayRepeat = tail && itemStart < seamLimit;',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /never seam-trimmed against what came before/
    },
    {
        id: 'MUT-BACKUP-CRC',
        file: 'src/js/backup-core.js',
        from: '    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);',
        to: '    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 7);',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /CRC-32 matches the standard check value/
    },
    {
        id: 'MUT-LIVE-SCRIBE-DROP-ON-FAIL',
        file: 'src/js/live-scribe-core.js',
        from: '    if (!online) return { send: false, waitMs: RETRY_BASE_MS, reason: \'offline\' };',
        to: '    if (!online) return { send: true, waitMs: 0, reason: \'offline\' };',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /known-offline device waits instead of spending the attempt/
    },
    {
        id: 'MUT-LIVE-REUSE-ORIGIN',
        file: 'src/js/transcribe-core.js',
        from: '        if (span.fromSec - cursor >= floor) gaps.push({ fromSec: cursor, toSec: Math.min(span.fromSec, total) });',
        to: '        if (false) gaps.push({ fromSec: cursor, toSec: Math.min(span.fromSec, total) });',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /the seconds before live transcription started are the only gap|leaves a hole in the coverage/
    },
    {
        id: 'MUT-DIARIZE-THRESHOLD',
        file: 'src/js/diarize-core.js',
        from: '            const support = Math.min(evidenceOf(speakers[a]), evidenceOf(speakers[b]));',
        to: '            const support = 1;',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /one segment of a new voice is not enough to claim a second speaker/
    },
    {
        id: 'MUT-HEAD-GAP-DISCARDED',
        file: 'src/js/transcribe-core.js',
        from: '        const floor = cursor === 0 ? Math.min(minGapSec, HEAD_MIN_GAP_SEC) : minGapSec;',
        to: '        const floor = minGapSec;',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /sub-second gap at the START of the recording is still transcribed, whole/
    },
    {
        id: 'MUT-SELECTION-STALE',
        file: 'src/js/selection-core.js',
        from: '    if (Number.isFinite(producedAt) && Number.isFinite(chosenAt) && producedAt > chosenAt) {',
        to: '    if (false) {',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /produced since the choice was made is shown instead/
    },
    {
        id: 'MUT-DIARIZE-BOUNDARY',
        file: 'src/js/diarize-core.js',
        from: 'export const SAME_SPEAKER_SIMILARITY = 0.35;',
        to: 'export const SAME_SPEAKER_SIMILARITY = 0.70;',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /boundary sits between what one voice scores and what two different voices score|two voices are two clusters/
    },
    {
        id: 'MUT-DIARIZE-CLOSEST-PAIR',
        file: 'src/js/diarize-core.js',
        from: '            best = Math.max(best, Math.min(separation, support));\n        }\n    }\n    return clamp01(best);',
        to: '            best = a === 0 && b === 1 ? Math.min(separation, support) : Math.min(best, separation, support);\n        }\n    }\n    return clamp01(best);',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /diarize: a well-separated pair still reports/
    },
    {
        id: 'MUT-NAME-FROM-PROSE',
        file: 'src/js/diarize-core.js',
        from: '        if (requireCapital && !/^\\p{Lu}/u.test(word)) break;',
        to: '        if (false) break;',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /after a bare "is", prose is not a name|prose after "is" is not a name/
    },
    {
        id: 'MUT-PANEL-EMPTY-WHILE-PENDING',
        file: 'src/js/translate-core.js',
        from: '        : { text: original, translated: false, from: plan.from, pending: !abandoned, abandoned };',
        to: '        : { text: \'\', translated: false, from: plan.from, pending: !abandoned, abandoned };',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /panels: before the translation lands, the words as spoken are shown/
    },
    {
        id: 'MUT-ECHO-DISPLAY-FALLBACK',
        file: 'src/js/diarize-core.js',
        from: '        const stored = (next.names || {})[resolveIdentity(next, command.id)] || command.name;',
        to: '        const stored = speakerDisplayName(next, command.id);',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /command: the receipt reports the name that was stored/
    },
    {
        id: 'MUT-COLOUR-FOLLOWS-VOLUME',
        file: 'src/js/translate-core.js',
        from: 'export function firstSeenOrder(tally) {\n    return Object.keys(tally || {});',
        to: 'export function firstSeenOrder(tally) {\n    return Object.keys(tally || {}).sort((a, b) => tally[b] - tally[a]);',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /a language keeps its colour when it becomes the most spoken|languages are remembered in the order first heard/
    },
    {
        id: 'MUT-TRANSLATE-OLDEST-FIRST',
        file: 'src/js/translate-core.js',
        from: '    for (let i = list.length - 1; i >= 0 && out.length < limit; i--) {',
        to: '    for (let i = 0; i < list.length && out.length < limit; i++) {',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /the newest untranslated line is translated first/
    },
    {
        id: 'MUT-PANELS-FOLLOW-VOLUME',
        file: 'src/js/translate-core.js',
        from: '        .sort((a, b) => firstSeen.indexOf(a) - firstSeen.indexOf(b))',
        to: '        .sort((a, b) => (counts[b] - counts[a]) || a.localeCompare(b))',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /boxes are ordered by which language was heard first|does not move when someone else talks for longer/
    },
    {
        id: 'MUT-BATCH-PARTIAL-APPLY',
        file: 'src/js/translate-core.js',
        from: '    if (found.size !== count) return null;',
        to: '    if (found.size === 0) return null;',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /batch: a reply that merged two lines into one is refused whole/
    },
    {
        id: 'MUT-PANELS-STRAY-DISPLACES',
        file: 'src/js/translate-core.js',
        from: '        .slice(0, cap)',
        to: '        .slice(-cap)',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /with boxes contested, a language heard once loses to ones heard more/
    },
    {
        id: 'MUT-TRANSLATE-NO-BACKOFF',
        file: 'src/js/translate-core.js',
        from: '    if (failures === 0) return 0;\n    return Math.min(cap, base * Math.pow(2, failures - 1));',
        to: '    return 0;',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /the first failure buys a pause/
    },
    {
        id: 'MUT-TRANSLATE-GAVEUP-INVISIBLE',
        file: 'src/js/translate-core.js',
        from: '    const abandoned = !!(gaveUp && typeof gaveUp.has === \'function\' && gaveUp.has(key));',
        to: '    const abandoned = false;',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /panels: and says it is abandoned rather than pending/
    },
    {
        id: 'MUT-TRANSLATE-SPLITS-MODEL',
        file: 'src/js/reply.js',
        from: "export async function translateLines(prompt, expectedLines, signal, { onTiming = null } = {}) {\n    const base = CONFIG.OLLAMA_URL.replace(/\\/+$/, '');\n    const model = await resolveReplyModel(base);",
        to: "export async function translateLines(prompt, expectedLines, signal, { onTiming = null } = {}) {\n    const base = CONFIG.OLLAMA_URL.replace(/\\/+$/, '');\n    const model = 'translation-only-model';",
        command: ['node', 'tests/unit/translate-request.test.mjs'],
        expected: /uses the same selected AI model as replies/
    },
    {
        id: 'MUT-RETENTION-ACK-ONCE',
        file: 'src/js/retention-core.js',
        from: '    if (!agreed || !policy) return false;',
        to: '    if (!policy) return false;\n    if (!agreed) return String(token || \'\') === \'1\';\n    return true;',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /agreeing to a month is not agreeing to five minutes/
    },
    {
        id: 'MUT-PANELS-WORDLESS-THRESHOLD',
        file: 'src/js/translate-core.js',
        from: '    return words >= minWords && (runs == null || runs >= minRuns);',
        to: '    return words >= 1;',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /one stray word does not earn a box/
    },
    {
        id: 'MUT-PANELS-SUM-NOT-SHAPE',
        file: 'src/js/translate-core.js',
        from: '            runs: (runsOf(current) || 0) + (words >= minWordsPerRun ? 1 : 0)',
        to: '            runs: (runsOf(current) || 0) + 1',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /panels: and still earn nothing, because the threshold is a shape/
    },
    {
        id: 'MUT-PANEL-SILENT-ABOUT-WHY',
        file: 'src/js/translate-core.js',
        from: "        if (state === 'failing') notes.push(activity.slow ? 'AI model too slow' : 'server not answering');",
        to: "        if (false) notes.push(activity.slow ? 'AI model too slow' : 'server not answering');",
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /says which of the three faults it is/
    },
    {
        id: 'MUT-BATCH-NUMBERS-OR-NOTHING',
        file: 'src/js/translate-core.js',
        from: '    if (found.size === 0 && count > 1) {',
        to: '    if (false) {',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /exactly the right number of lines is read by position/
    },
    {
        id: 'MUT-NAME-COIN-TOSS',
        file: 'src/js/diarize-core.js',
        from: '    const contested = near.filter(item => near[0].score - item.score <= 0.05);',
        to: '    const contested = [near[0]];',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /coin toss with somebody's name on it/
    },
    {
        id: 'MUT-INFER-HEARSAY',
        file: 'src/js/speaker-infer-core.js',
        from: 'export const ADDRESSED_WEIGHT = 0.25;',
        to: 'export const ADDRESSED_WEIGHT = 1;',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /one person naming another names nobody|never suggests one by itself/
    },
    {
        id: 'MUT-INFER-OVERWRITES-STATED',
        file: 'src/js/diarize-core.js',
        from: '    if (inferred && ((state && state.locked) || {})[target]) return state;',
        to: '    if (false) return state;',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /pushed through anyway it changes nothing and reports nothing/
    },
    {
        id: 'MUT-INFER-SILENT-GUESS',
        file: 'src/js/diarize-core.js',
        from: '    return `${name}?`;',
        to: '    return name;',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /a name nobody confirmed is displayed as the guess it is/
    },
    {
        id: 'MUT-INFER-NAME-OVERRULES-EARS',
        file: 'src/js/speaker-infer-core.js',
        from: 'export const NAME_MERGE_SIMILARITY = 0.2;',
        to: 'export const NAME_MERGE_SIMILARITY = -1;',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /two voices with nothing acoustically in common are two people who share a name/
    },
    {
        id: 'MUT-POLICY-SWITCH-FORGETS',
        file: 'src/js/diarize-core.js',
        from: '    return { ...state, policy };',
        to: '    return { ...state, policy, names: {}, inferred: {} };',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /hiding is not forgetting|switching back restores the whole session/
    },
    {
        id: 'MUT-SCALE-UNBOUNDED-REGROUP',
        file: 'src/js/diarize-core.js',
        from: '    return retireOldPoints(recluster({ ...state, points }, options), options);',
        to: '    return recluster({ ...state, points }, options);',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /scale: the regrouping works over a window/
    },
    {
        id: 'MUT-RUNWAY-IGNORES-FINALIZE',
        file: 'src/js/runway-core.js',
        from: '        secondsLeft: saveableSec,',
        to: '        secondsLeft: captureSec,',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /runway: so that is the one the session reports/
    },
    {
        id: 'MUT-RUNWAY-CAPTURE-AS-SPACE',
        file: 'src/js/runway-core.js',
        from: '    const seconds = Number.isFinite(storage.saveableSec) ? storage.saveableSec : storage.secondsLeft;',
        to: '    const seconds = Number.isFinite(storage.captureSec) ? storage.captureSec : storage.secondsLeft;',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /runway: the space estimate is the saveable figure/
    },
    {
        id: 'MUT-RUNWAY-LINGERS-AFTER-STOP',
        file: 'src/js/recorder.js',
        from: "    paintRunway('', 'ok');\n",
        to: '',
        command: ['node', 'tests/unit/static.test.mjs'],
        expected: /tearing down a recording blanks the session runway line/
    },
    {
        id: 'MUT-PAGE-TOP-ON-FIRST-PAGE',
        file: 'src/js/pagination-core.js',
        from: '    if (!bar.onlyAfterFirstPage) return true;\n    return Number(curPage) > 0;',
        to: '    return true;',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /pages: the first page carries the controls at the bottom/
    },
    {
        id: 'MUT-HELP-RESTATES-SPOKEN-SYNTAX',
        file: 'index.html',
        from: '    <h3>\u{1F4BE} Space</h3>',
        to: '    <h3>\u{1F5E3}\u{FE0F} Spoken commands</h3>\n    <p>Say &ldquo;system z 2&rdquo; for the list.</p>\n\n    <h3>\u{1F4BE} Space</h3>',
        command: ['node', 'tests/unit/static.test.mjs'],
        expected: /the help overlay documents no spoken-instruction syntax/
    },
    {
        id: 'MUT-MODEL-RESIDENT-IGNORED',
        file: 'src/js/model-ready-core.js',
        from: "    if (isModelResident(loaded, wanted)) return { action: 'ready', release: [] };",
        to: "    if (isModelResident(loaded, wanted) && waitedMs > 0) return { action: 'ready', release: [] };",
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /ready: a model already loaded is asked for straight away/
    },
    {
        id: 'MUT-MODEL-SWAP-NEVER-HELPED',
        file: 'src/js/model-ready-core.js',
        from: "    if (!released && waitedMs >= graceMs && others.length) {\n        return { action: 'release', release: others };\n    }\n",
        to: '',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /ready: a swap that has not happened within the grace period is helped along/
    },
    {
        id: 'MUT-MODEL-BLIP-READ-AS-DEATH',
        file: 'src/js/model-ready-core.js',
        from: 'export const MODEL_PROBE_FAILURES_BEFORE_UNREACHABLE = 4;',
        to: 'export const MODEL_PROBE_FAILURES_BEFORE_UNREACHABLE = 1;',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /ready: one missed probe is a blip, not a dead server/
    },
    {
        id: 'MUT-MODEL-RETRY-WITHOUT-PREFLIGHT',
        file: 'src/js/model-ready-core.js',
        from: '    if (!preflightSucceeded) return false;\n',
        to: '',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /ready: where readiness was never established, retrying just doubles the wait/
    },
    {
        id: 'MUT-MODEL-PREFLIGHT-UNWIRED',
        file: 'src/js/reply.js',
        from: '        let preflighted = await ensureModelReady(base, model, progressCallback, ctrl.signal, { numCtx });\n',
        to: '        let preflighted = false;\n',
        command: ['node', 'tests/unit/app-behaviour.test.mjs'],
        expected: /a reply makes sure the model is loaded before it asks for one/
    },
    {
        id: 'MUT-UPDATE-ADOPTS-NEW-WORKER',
        file: 'src/js/update-core.js',
        from: "    return { ...state, ...settledAs(state, value), pending: value, installFailed: null };",
        to: "    return { ...state, ...settledAs(state, value), loaded: value, pending: null };",
        command: ['node', 'tests/unit/platform.test.mjs'],
        expected: /an update waiting, not the build this page is running|is an update, on the very first paint/
    },
    {
        id: 'MUT-INSTALL-FAILURE-IGNORED',
        file: 'src/js/version.js',
        from: "            if (settled === 'redundant') {",
        to: '            if (false) {',
        command: ['node', 'tests/unit/platform.test.mjs'],
        expected: /an install that fails is reported as failed/
    },
    {
        id: 'MUT-FAILED-INSTALL-OFFERS-FORCE',
        file: 'src/js/update-core.js',
        from: '    if (readyBuild(state) || state.incoming || state.installFailed) return false;',
        to: '    if (readyBuild(state) || state.incoming) return false;',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /a failed install is not taken for a browser that keeps its cached shell/
    },
    {
        id: 'MUT-SHELL-PARTIAL-INSTALL',
        file: 'sw.js',
        from: '        return storable(response);\n    }));\n    const cache = await caches.open(SHELL_CACHE);\n    await Promise.all(SHELL.map((path, i) => cache.put(new Request(path), responses[i])));',
        to: '        const cache = await caches.open(SHELL_CACHE);\n        await cache.put(new Request(path), await storable(response));\n        return null;\n    }));',
        command: ['node', 'tests/unit/sw-routing.test.mjs'],
        expected: /stores none of the files it did fetch/
    },
    {
        id: 'MUT-WORKER-TAKES-OVER-BY-ITSELF',
        file: 'sw.js',
        from: '        if (await replacesWorkerThatDoesNotAsk()) await self.skipWaiting();',
        to: '        await self.skipWaiting();',
        command: ['node', 'tests/unit/sw-routing.test.mjs'],
        expected: /waits to be asked, so open tabs keep the files of their own build/
    },
    {
        id: 'MUT-OLD-PAGES-LEFT-WAITING',
        file: 'sw.js',
        from: '    return keys.some(key => key !== SHELL_CACHE && shellBuild(key) !== null && shellBuild(key) < FIRST_BUILD_THAT_WAITS);',
        to: '    return keys.some(() => false);',
        command: ['node', 'tests/unit/sw-routing.test.mjs'],
        expected: /Build 128 or earlier takes over by itself/
    },
    {
        id: 'MUT-ACTIVATE-MESSAGE-IGNORED',
        file: 'sw.js',
        from: '        event.waitUntil(acceptBuild(VERSION).catch(() => {}).then(() => self.skipWaiting()));',
        to: '        event.waitUntil(acceptBuild(VERSION).catch(() => {}));',
        command: ['node', 'tests/unit/sw-routing.test.mjs'],
        expected: /asked by a page, it takes over/
    },
    {
        id: 'MUT-SHELL-REDIRECT-KEPT',
        file: 'sw.js',
        from: 'async function storable(response) {\n    return new Response(',
        to: 'async function storable(response) {\n    if (response) return response;\n    return new Response(',
        command: ['node', 'tests/unit/sw-routing.test.mjs'],
        expected: /stored with its body read at once|a shell file the server redirected is stored as a response of its own/
    },
    {
        id: 'MUT-WAITING-NOT-ASKED',
        file: 'src/js/version.js',
        from: '        if (waitingIsNewest) await activateWaitingWorker();',
        to: '        if (waitingIsNewest) { /* left waiting */ }',
        command: ['node', 'tests/unit/platform.test.mjs'],
        expected: /after asking the waiting build to take over/
    },
    {
        id: 'MUT-RELOAD-BEFORE-TAKEOVER',
        file: 'src/js/version.js',
        from: '        return await withinTime(tookOver, timeoutMs, false);',
        to: '        return false;',
        command: ['node', 'tests/unit/platform.test.mjs'],
        expected: /and only once it has/
    },
    {
        id: 'MUT-WAITING-BUILD-FORGOTTEN',
        file: 'src/js/update-core.js',
        from: '        waiting: state.waiting === value ? null : state.waiting',
        to: '        waiting: null',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /the old build still serving does not make the waiting one disappear/
    },
    {
        id: 'MUT-UPDATEFOUND-IGNORED',
        file: 'src/js/version.js',
        from: "        registration.addEventListener('updatefound', () => {",
        to: "        registration.addEventListener('updatefound-unheard', () => {",
        command: ['node', 'tests/unit/platform.test.mjs'],
        expected: /an install the browser starts by itself is followed too/
    },
    {
        id: 'MUT-PCM-RESAMPLED-WITHOUT-FILTER',
        file: 'src/js/audio.js',
        from: '    return resampleAll(monoFloat.subarray(0, frames), sourceRate);',
        to: '    return Float32Array.from({ length: Math.max(1, Math.round(frames * TARGET_RATE / sourceRate)) },\n        (_, i) => monoFloat[Math.min(frames - 1, Math.floor(i * sourceRate / TARGET_RATE))]);',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /without a 4 kHz ghost of a 12 kHz sound/
    },
    {
        id: 'MUT-RESAMPLE-CUTOFF-AT-SOURCE',
        file: 'src/js/resample-core.js',
        from: '    const cutoff = CUTOFF_SHARE * 0.5 * Math.min(1, to / from);',
        to: '    const cutoff = CUTOFF_SHARE * 0.5;',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /filtered out instead of folding back into the speech band/
    },
    {
        id: 'MUT-RESAMPLE-SEAMS',
        file: 'src/js/audio.js',
        from: '        const margin = srcRate === TARGET_RATE ? 0 : resamplerFor(srcRate, TARGET_RATE).margin;',
        to: '        const margin = 0;',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /meet without a click|same audio as that stretch of the whole recording/
    },
    {
        id: 'MUT-ACTIVATE-DELETES-NEWER-SHELL',
        file: 'sw.js',
        from: '            && !(shellBuild(key) !== null && own !== null && shellBuild(key) > own));',
        to: '            );',
        command: ['node', 'tests/unit/sw-routing.test.mjs'],
        expected: /the shell of a newer build that is installing meanwhile is left alone/
    },
    {
        id: 'MUT-UPDATE-OFFERS-DOWNGRADE',
        file: 'src/js/update-core.js',
        from: '    if (olderBuild(value, state.loaded)) return { ...state, ...settledAs(state, value), pending: null };',
        to: '',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /an older build still serving is never offered/
    },
    {
        id: 'MUT-HARD-RELOAD-LEAVES-OWN-BUILD-WAITING',
        file: 'src/js/version.js',
        from: '        if (version === _state.loaded && sw && !sw.controller) {',
        to: '        if (false) {',
        command: ['node', 'tests/unit/platform.test.mjs'],
        expected: /asks its own build, waiting, to take over/
    },
    {
        id: 'MUT-FAILED-ROW-BUTTONS-DROPPED',
        file: 'src/js/gui.js',
        from: "            <div class=\"rec-error\" role=\"alert\">Finalization failed: ${escapeHtml(rec.finalizationError || 'Unknown error')}</div>\n            ${buttons}`;",
        to: "            <div class=\"rec-error\" role=\"alert\">Finalization failed: ${escapeHtml(rec.finalizationError || 'Unknown error')}</div>`;",
        command: ['node', 'tests/unit/app-behaviour.test.mjs'],
        expected: /offers to retry, to download the audio saved so far, and to delete/
    },
    {
        id: 'MUT-INTERRUPTED-ROW-BUTTONS-DROPPED',
        file: 'src/js/gui.js',
        from: "            <div class=\"live-rec-meta\"><span style=\"opacity:.7\">The tab that recorded this stopped before saving it. It is recovered from the pieces it stored.</span></div>\n            ${buttons}`;",
        to: "            <div class=\"live-rec-meta\"><span style=\"opacity:.7\">The tab that recorded this stopped before saving it. It is recovered from the pieces it stored.</span></div>`;",
        command: ['node', 'tests/unit/app-behaviour.test.mjs'],
        expected: /offers Recover now and Delete/
    },
    {
        id: 'MUT-UPDATE-INSTALLING-CALLED-READY',
        file: 'src/js/update-core.js',
        from: "    if (state && state.incoming) return 'installing';",
        to: "    if (state && state.incoming) return 'reload';",
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /update: so tapping it does not reload/
    },
    {
        id: 'MUT-UPDATE-RELOADS-MID-RECORDING',
        file: 'src/js/update-core.js',
        from: "    return (action === 'reload' || action === 'force') && recording === true;",
        to: '    return false;',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /update: a reload is refused while a recording is running/
    },
    {
        id: 'MUT-UPDATE-BADGE-NOT-TAPPABLE',
        file: 'index.html',
        from: '<button id="app-version" data-action="appUpdate" aria-label="App version"></button>',
        to: '<div id="app-version" aria-label="App version"></div>',
        command: ['node', 'tests/unit/static.test.mjs'],
        expected: /the version under the help button is a button/
    },
    {
        id: 'MUT-BUILD-STAMP-DRIFTS',
        file: 'index.html',
        transform(source) {
            return source.replace(/<meta name="myai-build" content="\d+">/,
                                  '<meta name="myai-build" content="1">');
        },
        command: ['node', 'tests/unit/static.test.mjs'],
        expected: /the document carries the build it was released as/
    },
    {
        id: 'MUT-VERSION-IGNORES-DOCUMENT-STAMP',
        file: 'src/js/version.js',
        from: '    _state = noteLoadedVersion(_state, documentBuild());\n',
        to: '',
        command: ['node', 'tests/unit/platform.test.mjs'],
        expected: /still knows which build it is, from its own stamp|is an update, on the very first paint/
    },
    {
        id: 'MUT-STUCK-WORKER-UNNOTICED',
        file: 'src/js/update-core.js',
        from: "    if (updateStuck(state)) return 'force';",
        to: '',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /update: which needs the installed shell cleared/
    },
    {
        id: 'MUT-WORKER-SCRIPT-FROM-CACHE',
        file: 'src/js/version.js',
        from: "        const res = await fetch(workerScriptUrl(), { cache: 'reload', ...(ctrl ? { signal: ctrl.signal } : {}) });",
        to: "        const res = await fetch(workerScriptUrl(), { ...(ctrl ? { signal: ctrl.signal } : {}) });",
        command: ['node', 'tests/unit/platform.test.mjs'],
        expected: /fetched past the HTTP cache/
    },
    {
        id: 'MUT-RELEASE-MTIME-PINNED',
        file: 'tools/package_release.py',
        from: '    return RELEASE_EPOCH + (build * 86400)',
        to: '    return 0',
        command: ['node', 'tests/unit/static.test.mjs'],
        expected: /every build carries its own modification time/
    },
    {
        id: 'MUT-LIVE-TEXT-ON-AUDIO-CLOCK',
        file: 'src/js/retention-core.js',
        from: '                    || (hasLive && !dropLive);',
        to: ';',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /retention: so the row survives, instead of being swept as though it held nothing/
    },
    {
        id: 'MUT-LIVE-TEXT-OUTLIVES-DELETE',
        file: 'src/js/settings.js',
        from: '            for (const id of plan.clearIds) {\n                await deleteLiveTranscript(id).catch(() => {});\n',
        to: '            for (const id of plan.clearIds) {\n',
        command: ['node', 'tests/unit/app-behaviour.test.mjs'],
        expected: /no stored transcript outlives the dialog that deleted it/
    },
    {
        id: 'MUT-DROPPED-AUDIO-CLAIMED-COVERED',
        file: 'src/js/live-scribe.js',
        from: '    state.consumedSec += seconds;\n',
        to: '',
        command: ['node', 'tests/unit/static.test.mjs'],
        expected: /discarded audio still advances the position in the recording/
    },
    {
        id: 'MUT-WINDOW-INDEX-STRANDED',
        file: 'src/js/live-scribe.js',
        from: '            abandonWindowIndex(index, recId, epoch);\n            throw err;',
        to: '            throw err;',
        command: ['node', 'tests/unit/static.test.mjs'],
        expected: /still claims its sequence number/
    },
    {
        id: 'MUT-DELETE-AFTER-FAILED-BACKUP',
        file: 'src/js/settings.js',
        transform(source) {
            return source.replace('if (!await offerBackupFirst()) return;', 'await offerBackupFirst();');
        },
        command: ['node', 'tests/unit/app-behaviour.test.mjs'],
        expected: /no destructive action runs the backup offer without reading its answer/
    },
    {
        id: 'MUT-FULLSCREEN-TRAP',
        file: 'src/js/main.js',
        from: '        if (showingFs || browserFs()) {',
        to: '        if (browserFs()) {',
        command: ['node', 'tests/unit/static.test.mjs'],
        expected: /the fullscreen toggle asks what the page is actually showing/
    },
    {
        id: 'MUT-SAVED-TRANSCRIPT-RETRIMMED',
        file: 'src/js/live-render.js',
        from: '                const kept = (chunk.final || !tail) ? textPart : seamTrim(tail, textPart);',
        to: '                const kept = tail ? seamTrim(tail, textPart) : textPart;',
        command: ['node', 'tests/unit/live-view.test.mjs'],
        expected: /a stored transcript is shown word for word/
    },
    {
        id: 'MUT-BUSY-ROW-LOOKS-IDLE',
        file: 'src/js/gui.js',
        from: '    for (const rec of page) restoreRunningJobStatus(rec);\n',
        to: '',
        command: ['node', 'tests/unit/static.test.mjs'],
        expected: /the progress bar with its cancel control is restored with the row/
    },
    {
        id: 'MUT-EMPTY-BOX-CANNOT-RESET',
        file: 'src/js/settings.js',
        from: "    if (value === '' && el.tagName === 'SELECT' && (readStored(key) || '') !== '') return;",
        to: "    if (value === '' && (readStored(key) || '') !== '') return;",
        command: ['node', 'tests/unit/static.test.mjs'],
        expected: /a text box the guide says can be emptied really can be/
    },
    {
        id: 'MUT-CAPTURE-STALL-UNNOTICED',
        file: 'src/js/capture-health-core.js',
        from: '    const stalled = !!muted || silent;',
        to: '    const stalled = false;',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /capture: but four seconds with no audio at all is a fault worth showing/
    },
    {
        id: 'MUT-CAPTURE-MUTE-IGNORED',
        file: 'src/js/capture-health-core.js',
        from: '    const stalled = !!muted || silent;',
        to: '    const stalled = silent;',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /capture: a track that reports itself muted is a fault at once/
    },
    {
        id: 'MUT-CAPTURE-STALL-STOPS-RECORDING',
        file: 'src/js/recorder.js',
        from: '        markAudioIncomplete(AppState.recId);',
        to: '        handleCaptureFailure(new Error("stalled"), "microphone");',
        command: ['node', 'tests/unit/static.test.mjs'],
        expected: /never stops the recording, because a false alarm must not be able to end one|marks the file incomplete rather than letting it pass as whole/
    },
    {
        id: 'MUT-DURATION-OVERCLAIMS',
        file: 'src/js/capture-health-core.js',
        from: '    return Math.min(wall, captured);',
        to: '    return wall;',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /capture: a file never claims more audio than actually arrived/
    },
    {
        id: 'MUT-FILL-HAMMERS-DEAD-SERVER',
        file: 'src/js/transcribe-core.js',
        from: '    return reached === true && aligned === false;',
        to: '    return aligned === false;',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /that multiplies one failure by the batch size/
    },
    {
        id: 'MUT-BACKFILL-UNBOUNDED',
        file: 'src/js/live-scribe.js',
        from: '                capBackfillLines();\n',
        to: '',
        command: ['node', 'tests/unit/static.test.mjs'],
        expected: /the backfilled prefix is bounded/
    },
    {
        id: 'MUT-HEARTBEAT-CARRIES-TRANSCRIPT',
        file: 'src/js/recorder.js',
        from: '            if (snapshotted) {\n                rec.liveTranscriptLines',
        to: '            if (snapshotted) {\n                rec.liveTranscript = liveTranscript;\n                rec.liveTranscriptLines',
        command: ['node', 'tests/unit/static.test.mjs'],
        expected: /never carries the live transcript through the recording row/
    },
    {
        id: 'MUT-SNAPSHOT-NEVER-STORED',
        file: 'src/js/recorder.js',
        from: '            snapshotted = await writeLiveTranscript(recId, liveTranscript);',
        to: '            snapshotted = true;',
        command: ['node', 'tests/unit/static.test.mjs'],
        expected: /the transcript is stored before its lightweight row metadata is updated/
    },
    {
        id: 'MUT-UPGRADE-CLOSES-RECORDING-TAB',
        file: 'src/js/idb-min.js',
        from: '                try { mayClose = canClose() !== false; } catch (_) { mayClose = true; }',
        to: '                mayClose = true;',
        command: ['node', 'tests/unit/static.test.mjs'],
        expected: /a connection asks before closing itself for an upgrade/
    },
    {
        id: 'MUT-RECORDING-NOT-BUSY',
        file: 'src/js/db.js',
        from: "        canClose: () => shouldCloseForUpgrade({ recording: _busy() === true }),",
        to: '        canClose: () => true,',
        command: ['node', 'tests/unit/app-behaviour.test.mjs'],
        expected: /what counts as busy is whether this tab is holding a recording/
    },
    {
        id: 'MUT-CLOSED-CONNECTION-BRICKS-TAB',
        file: 'src/js/db.js',
        from: "        onClosed: () => { _dbPromise = null; setGuard('closed'); },",
        to: "        onClosed: () => { setGuard('closed'); },",
        command: ['node', 'tests/unit/app-behaviour.test.mjs'],
        expected: /a connection that was closed is forgotten/
    },
    {
        id: 'MUT-STALE-TAB-UNRECOGNISED',
        file: 'src/js/db-lifecycle-core.js',
        from: "    return name === 'VersionError' || /less than the existing version/i.test(message);",
        to: "    return name === 'VersionError';",
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /upgrade: by name or by what it said/
    },
    {
        id: 'MUT-CONTRACT-MAPPING',
        file: 'tests/baseline-contract.json',
        transform(source) {
            const parsed = JSON.parse(source);
            parsed.contracts[0].suites.push('nonexistent-suite');
            return JSON.stringify(parsed, null, 2) + '\n';
        },
        command: ['node', 'tests/unit/baseline-contract.test.mjs'],
        expected: /references registered suite nonexistent-suite/
    },
    {
        id: 'MUT-FAILED-UPGRADE-COMMITS',
        file: 'src/js/idb-min.js',
        from: '                try { req.transaction.abort(); } catch (_) {}\n',
        to: '',
        command: ['node', 'tests/unit/platform.test.mjs'],
        expected: /aborts the versionchange transaction/
    },
    {
        id: 'MUT-PAUSE-FORGETS-RECORDING',
        file: 'src/js/live-scribe.js',
        from: '    if (!keepText) state.recId = null;',
        to: '    state.recId = null;',
        command: ['node', 'tests/unit/live-scribe.test.mjs'],
        expected: /keeps the transcript instead of blanking the panel/
    },
    {
        id: 'MUT-CLOSE-KEEPS-RECORDING',
        file: 'src/js/live-scribe.js',
        from: '    if (!keepText) state.recId = null;',
        to: '    if (keepText) state.recId = null;',
        command: ['node', 'tests/unit/live-scribe.test.mjs'],
        expected: /keeps the transcript instead of blanking the panel|never inherits/
    },
    {
        id: 'MUT-WAKELOCK-LATE-SENTINEL-KEPT',
        file: 'src/js/wake-lock.js',
        from: '        if (!_wantLock) {\n            try { await sentinel.release(); } catch (_) {}\n            return false;\n        }\n',
        to: '',
        command: ['node', 'tests/unit/platform.test.mjs'],
        expected: /is not reported as held|released at once/
    },
    {
        id: 'MUT-POPUP-CLOSED-STILL-TRACKED',
        file: 'src/js/live-tabs.js',
        from: '      if (win.closed) { _driving.delete(win); return; }',
        to: '      if (false) { _driving.delete(win); return; }',
        command: ['node', 'tests/unit/live-view.test.mjs'],
        expected: /closed before its page loaded is let go/
    },
    {
        id: 'MUT-ATTRIBUTE-TEXT-ESCAPER',
        file: 'src/js/live-scribe.js',
        from: 'data-lang="${escapeAttr(target)}"',
        to: 'data-lang="${escapeHtml(target)}"',
        command: ['node', 'tests/unit/static.test.mjs'],
        expected: /escaped for attribute position/
    },
    {
        id: 'MUT-CONFIRM-MATCHES-SUBSTRING',
        file: 'src/js/speaker-confirm-core.js',
        transform(source) {
            const line = source.match(/const VERB_FIRST = .*\n/)[0];
            return source.replace(line, line.replace('`^', '`').replace('$`', '`'));
        },
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /talking about confirming a speaker is not confirming one/
    },
    {
        id: 'MUT-CONFIRM-BARE-GUESSES',
        file: 'src/js/speaker-confirm-core.js',
        from: '        if (pending.length === 1) return { id: pending[0], form: \'bare\' };\n        if (pending.length > 1) return { id: null, form: \'ambiguous\' };',
        to: '        if (pending.length >= 1) return { id: pending[0], form: \'bare\' };',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /refuses to guess which|rather than picking one/
    },
    {
        id: 'MUT-PROPOSE-BAR-TOO-LOW',
        file: 'src/js/speaker-confirm-core.js',
        from: 'export const PROPOSE_SCORE = 1;',
        to: 'export const PROPOSE_SCORE = 0.6;',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /a full point of evidence|waits to be corroborated/
    },
    {
        id: 'MUT-PROPOSE-WITHOUT-SELF-EVIDENCE',
        file: 'src/js/speaker-confirm-core.js',
        from: '    if (!Number.isFinite(self) || self <= 0) return false;',
        to: '',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /guess about a third party, never proposed/
    },
    {
        id: 'MUT-PROPOSE-IGNORES-RUNNER-UP',
        file: 'src/js/speaker-confirm-core.js',
        from: '    if (Number.isFinite(runnerUp) && score - runnerUp < PROPOSE_MARGIN) return false;',
        to: '',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /two plausible names stays a number/
    },
    {
        id: 'MUT-PROPOSAL-NEVER-EXPIRES',
        file: 'src/js/speaker-confirm-core.js',
        from: '        if (nowSec - proposal.atSec > PROPOSAL_TTL_SEC) continue;',
        to: '',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /expires instead of waiting/
    },
    {
        id: 'MUT-LIST-LOADS-AUDIO',
        file: 'src/js/recorder.js',
        from: '        rec.audioBytes = masterBlob.size;\n        if (webmSeekable)',
        to: '        rec.blob = masterBlob;\n        rec.audioBytes = masterBlob.size;\n        if (webmSeekable)',
        command: ['node', 'tests/unit/storage-paths.test.mjs'],
        expected: /leaves only its size on the row/
    },
    {
        id: 'MUT-PLAYER-EAGER',
        file: 'src/js/gui.js',
        from: 'preload="none"',
        to: 'preload="metadata"',
        command: ['node', 'tests/unit/static.test.mjs'],
        expected: /rendered empty and names the recording/
    },
    {
        id: 'MUT-PLAYER-KEEPS-EVERY-BLOB',
        file: 'src/js/gui.js',
        from: '    detachAudioSource();\n    revokeAllObjectUrls();',
        to: '    revokeAllObjectUrls();',
        command: ['node', 'tests/unit/static.test.mjs'],
        expected: /at most one recording is ever held in memory/
    },
    {
        id: 'MUT-STORAGE-TOTAL-LOADS-AUDIO',
        file: 'src/js/db.js',
        from: '        total += Number(cursor.value && cursor.value.bytes) || 0;',
        to: '        total += cursor.value.blob?.size || 0;',
        command: ['node', 'tests/unit/static.test.mjs'],
        expected: /counted from recorded sizes|audioBytes/
    },
    {
        id: 'MUT-THIRD-REVIEW-PASS-BACK',
        file: 'src/js/transcribe.js',
        from: 'const MAX_LIVE_REPLAY_RANGES = 6;',
        to: 'const MAX_LIVE_REPLAY_RANGES = 6;\nasync function reviewTranscriptEchoes() { return 0; }',
        command: ['node', 'tests/unit/static.test.mjs'],
        expected: /no third pass re-listening/
    },
    {
        id: 'MUT-DEFAULT-BACK-TO-WAV',
        file: 'src/js/config.js',
        from: "    'set-recording-format': 'opus',",
        to: "    'set-recording-format': 'wav',",
        command: ['node', 'tests/unit/static.test.mjs'],
        expected: /compressed audio is what a new install records/
    },
    {
        id: 'MUT-INFERRED-NAME-APPLIED',
        file: 'src/js/live-scribe.js',
        from: '    state.proposals = nextProposals(state.proposals, review.commands, atSec);',
        to: '    for (const command of review.commands) {\n'
          + '        const applied = applySpeakerCommand(state.diarization, command);\n'
          + '        if (applied.ok) state.diarization = applied.state;\n'
          + '    }\n'
          + '    state.proposals = nextProposals(state.proposals, review.commands, atSec);',
        command: ['node', 'tests/unit/static.test.mjs'],
        expected: /never applied there; inference only proposes/
    },
    {
        id: 'MUT-CONFIRMED-NAME-LEFT-OPEN',
        file: 'src/js/live-scribe.js',
        from: "{ ...proposal.command, origin: 'confirmed' }",
        to: 'proposal.command',
        command: ['node', 'tests/unit/static.test.mjs'],
        expected: /locked rather than left open to being re-guessed/
    },
    {
        id: 'MUT-CONFIRM-APPLIES-ANYTHING',
        file: 'src/js/live-scribe.js',
        from: '        : { proposal: null, rest: state.proposals };',
        to: '        : { proposal: { command: { type: \'name\', id, name: \'Unknown\' } }, rest: state.proposals };',
        command: ['node', 'tests/unit/live-scribe.test.mjs'],
        expected: /applies nothing, and says so|does not invent a name/
    },
    {
        id: 'MUT-OPUS-CAPTURE-UNWATCHED',
        file: 'src/js/recorder.js',
        from: '                AppState.captureProgress = (AppState.captureProgress || 0) + ev.data.size;\n',
        to: '',
        command: ['node', 'tests/unit/static.test.mjs'],
        expected: /the only evidence the recorder ever gets/
    },
    {
        id: 'MUT-STALL-WINDOW-IGNORES-CADENCE',
        file: 'src/js/recorder.js',
        from: '        stallMs: AppState.workletNode\n'
            + '            ? CAPTURE_STALL_MS\n'
            + '            : captureStallMs(CONFIG.IO_FLUSH_SEC * 1000)',
        to: '        stallMs: CAPTURE_STALL_MS',
        command: ['node', 'tests/unit/static.test.mjs'],
        expected: /judged on how often blocks actually arrive/
    },
    {
        id: 'MUT-STALL-WINDOW-TOO-TIGHT',
        file: 'src/js/capture-health-core.js',
        from: '    return Math.max(CAPTURE_STALL_MS, every * 2 + CAPTURE_STALL_MS);',
        to: '    return CAPTURE_STALL_MS;',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /every normal gap between deliveries would read as a fault|three missed deliveries/
    },
    {
        id: 'MUT-FIRST-PAINT-SILENT-FAILURE',
        file: 'src/js/main.js',
        from: '    const firstPaint = renderList().catch(err => {',
        to: '    const firstPaint = Promise.resolve(renderList()).then(err => {',
        command: ['node', 'tests/unit/static.test.mjs'],
        expected: /reports its own failure instead of leaving an empty page/
    },
    {
        id: 'MUT-WEBM-TRUNCATED-TAIL-LOST',
        file: 'src/js/webm-duration.js',
        from: '        ? estimateTruncatedDurationSec(clusters.map(cluster => cluster.startSec))',
        to: '        ? finalStartSec',
        command: ['node', 'tests/unit/webm-duration.test.mjs'],
        expected: /spans a decodable window|reaches the end of the last Cluster|stays reachable for review/
    },
    {
        id: 'MUT-LIVE-STALE-WINDOW-LANDS',
        file: 'src/js/live-scribe.js',
        from: '        if (epoch !== state.epoch || !state.active || state.recId !== recId) return;\n\n        state.answered++;',
        to: '        if (!state.active || state.recId !== recId) return;\n\n        state.answered++;',
        command: ['node', 'tests/unit/live-scribe.test.mjs'],
        expected: /never lands in the resumed session/
    },
    {
        id: 'MUT-LIVE-INFLIGHT-UNDERFLOWS',
        file: 'src/js/live-scribe.js',
        from: '        if (epoch === state.epoch) {\n            state.inFlight--;',
        to: '        if (true) {\n            state.inFlight--;',
        command: ['node', 'tests/unit/static.test.mjs'],
        expected: /in-flight count is only ever adjusted by the session that owns it/
    },
    {
        id: 'MUT-SEAM-EXACT-MATCH-ONLY',
        file: 'src/js/dedup.js',
        from: "    for (var f = scan; f >= SEAM_FUZZY_MIN_WORDS; f--) {\n        if (seamRunMatches(pTail, nHead, f)) return ntok.slice(f - closingWordToKeep(pTail, nHead, f)).join(' ');\n    }\n",
        to: '',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /survives one misheard word/
    },
    {
        id: 'MUT-SEAM-TOLERANCE-UNANCHORED',
        file: 'src/js/dedup.js',
        from: '    if (!cutWord(tailA, tailB, false)) return false;',
        to: '',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /closing word|differently anchored/
    },
    {
        id: 'MUT-WAKELOCK-DOUBLE-ACQUIRE',
        file: 'src/js/wake-lock.js',
        from: '    if (_pending) return _pending;\n',
        to: '',
        command: ['node', 'tests/unit/platform.test.mjs'],
        expected: /shares that request instead of orphaning/
    },
    {
        id: 'MUT-WAKELOCK-STALE-CLEARS-CURRENT',
        file: 'src/js/wake-lock.js',
        from: '            if (_sentinel === sentinel) _sentinel = null;',
        to: '            _sentinel = null;',
        command: ['node', 'tests/unit/platform.test.mjs'],
        expected: /never clears the lock that replaced it/
    },
    {
        id: 'MUT-GAPS-REPEAT-EVERY-CHUNK',
        file: 'src/js/transcribe-core.js',
        from: '    const merged = mergePlaceholderRuns(allSegs);',
        to: '    const merged = allSegs;',
        command: ['node', 'tests/unit/core.test.mjs'],
        expected: /reported once, not once per chunk|one neutral note, not one per minute/
    },
    {
        id: 'MUT-SILENCE-READ-AS-FAILURE',
        file: 'src/js/transcribe-core.js',
        from: '    return level.peak < SILENCE_PEAK_THRESHOLD && level.rms < SILENCE_RMS_THRESHOLD;',
        to: '    return false;',
        command: ['node', 'tests/unit/core.test.mjs'],
        expected: /reads as silent|inaudible room hum/
    },
    {
        id: 'MUT-CHUNK-RETRY-REMOVED',
        file: 'src/js/transcribe-core.js',
        from: 'export const CHUNK_RETRY_DELAYS_MS = [1500, 5000];',
        to: 'export const CHUNK_RETRY_DELAYS_MS = [];',
        command: ['node', 'tests/unit/saved-transcripts.test.mjs'],
        expected: /bounded list rather than an open-ended loop/
    },
    {
        id: 'MUT-CLIPBOARD-UNCAPPED',
        file: 'src/js/clipboard-core.js',
        from: '    const kept = clipped ? text.slice(0, limit) : text;',
        to: '    const kept = text;',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /capped instead of being fed whole/
    },
    {
        id: 'MUT-ROTATION-LEFT-ON',
        file: 'src/js/main.js',
        from: '        followDeviceOrientation(false);\n        setVisualizerFullscreen(false);',
        to: '        setVisualizerFullscreen(false);',
        command: ['node', 'tests/unit/static.test.mjs'],
        expected: /puts the ordinary interface back to portrait/
    },
    {
        id: 'MUT-STORAGE-COUNTS-TWICE',
        file: 'src/js/db.js',
        from: '    let total = await audioBytesTotal();',
        to: '    let total = await audioBytesTotal();\n    let c1 = await db.transaction(CONFIG.STORE_REC).store.openCursor();\n    while (c1) { total += Number(c1.value && c1.value.audioBytes) || 0; c1 = await c1.continue(); }',
        command: ['node', 'tests/unit/app-behaviour.test.mjs'],
        expected: /each stored recording is counted once/
    },
    {
        id: 'MUT-CONVERT-WRITES-BEFORE-CHECK',
        file: 'src/js/gui.js',
        from: '        await commitAudio(key, storedBlob, (r) => {',
        to: '        await writeAudio(key, storedBlob);\n        await dbUpdate(CONFIG.STORE_REC, key, (r) => {',
        command: ['node', 'tests/unit/static.test.mjs'],
        expected: /writes its audio apart from the row that owns it|writes nothing, instead of leaving audio/
    },
    {
        id: 'MUT-COMMIT-AUDIO-BEFORE-CHECK',
        file: 'src/js/db.js',
        from: '    const current = await tx.stores[CONFIG.STORE_REC].get(recId);\n    const next = mutate(current);',
        to: '    await tx.stores[CONFIG.STORE_AUDIO].put({ recId, blob, bytes: blob.size, at: Date.now() });\n    const current = await tx.stores[CONFIG.STORE_REC].get(recId);\n    const next = mutate(current);',
        command: ['node', 'tests/unit/app-behaviour.test.mjs'],
        expected: /only after the row has agreed to take it/
    },
    {
        id: 'MUT-ORPHAN-AUDIO-KEPT',
        file: 'src/js/main.js',
        from: '        try { await cleanupOrphanAudio(); }',
        to: '        try { await Promise.resolve(); }',
        command: ['node', 'tests/unit/static.test.mjs'],
        expected: /audio left behind by an older build is swept on start/
    },
    {
        id: 'MUT-CONTINUE-WHILE-RECORDING',
        file: 'src/js/gui.js',
        from: "    if (AppState.recId != null || AppState.busy) {\n        alert('💬 Continue",
        to: "    if (false) {\n        alert('💬 Continue",
        command: ['node', 'tests/unit/static.test.mjs'],
        expected: /Continue during a recording does nothing silently/
    },
    {
        id: 'MUT-SWEEP-ALERTS',
        file: 'src/js/settings.js',
        from: '        }, { quiet: true });',
        to: '        });',
        command: ['node', 'tests/unit/app-behaviour.test.mjs'],
        expected: /background sweep never interrupts an idle tab/
    },
    {
        id: 'MUT-GUARD-NOTICE-UNOWNED',
        file: 'src/js/main.js',
        from: "        node.dataset.owner = 'guard';\n",
        to: '',
        command: ['node', 'tests/unit/static.test.mjs'],
        expected: /claims the alert line/
    },
    {
        id: 'MUT-UPGRADE-DELETES-NOTES',
        file: 'src/js/db-lifecycle-core.js',
        from: '        if (db.objectStoreNames.contains(spec.name)) {\n            store = upgradeTx.objectStore(spec.name);\n        } else {',
        to: '        if (db.objectStoreNames.contains(spec.name)) db.deleteObjectStore(spec.name);\n        {',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /an upgrade never deletes a store/
    },
    {
        id: 'MUT-VETO-NEVER-RELEASED',
        file: 'src/js/idb-min.js',
        from: 'onBlocked({ holding: true, release });',
        to: 'onBlocked({ holding: true });',
        command: ['node', 'tests/unit/platform.test.mjs'],
        expected: /handed a way to give the connection up later/
    },
    {
        id: 'MUT-IDLE-NEVER-RELEASES',
        file: 'src/js/main.js',
        from: 'setInterval(noteDatabaseIdle, 1000);',
        to: '',
        command: ['node', 'tests/unit/static.test.mjs'],
        expected: /checked continuously/
    },
    {
        id: 'MUT-HANDOVER-DURING-FOLLOWUP',
        file: 'src/js/main.js',
        from: '    || followUpsRunning() || hasAnyJob() || isConverting();',
        to: '    || hasAnyJob() || isConverting();',
        command: ['node', 'tests/unit/static.test.mjs'],
        expected: /automatic work a stopped recording starts/
    },
    {
        id: 'MUT-FOLLOWUP-UNCOUNTED',
        file: 'src/js/recorder.js',
        from: '            trackFollowUp(completeTranscriptColumns(currentId)',
        to: '            (completeTranscriptColumns(currentId)',
        command: ['node', 'tests/unit/static.test.mjs'],
        expected: /every piece of work a stopped recording starts is counted/
    },
    {
        id: 'MUT-JOB-HANDOVER',
        file: 'src/js/main.js',
        from: '    || followUpsRunning() || hasAnyJob() || isConverting();',
        to: '    || followUpsRunning();',
        command: ['node', 'tests/unit/static.test.mjs'],
        expected: /transcription, reply or conversion that is still running/
    },
    {
        id: 'MUT-BUSY-NOTICE-BLAMES-RECORDING',
        file: 'src/js/db-lifecycle-core.js',
        from: '    if (busy) {\n',
        to: '    if (false) {\n',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /the wait is for that work, not asked to stop a recording/
    },
    {
        id: 'MUT-FAILED-START-KEEPS-CONTEXT',
        file: 'src/js/recorder.js',
        from: "        AppState.pendingContext = null;\n        await releaseRecordingLock();\n        recordBtn.classList.remove('recording');",
        to: "        if (contextForRecording && !AppState.pendingContext) AppState.pendingContext = contextForRecording;\n        await releaseRecordingLock();\n        recordBtn.classList.remove('recording');",
        command: ['node', 'tests/unit/static.test.mjs'],
        expected: /fails to start drops the context it was given/
    },
    {
        id: 'MUT-SILENCE-TO-MODEL',
        file: 'src/js/transcribe-core.js',
        from: '        if (keptTrim !== SILENT_MARKER) plainParts.push(keptTrim);',
        to: '        plainParts.push(keptTrim);',
        command: ['node', 'tests/unit/core.test.mjs'],
        expected: /carries only what was said, never a no-speech note/
    },
    {
        id: 'MUT-FREE-SPACE-ZERO-GB',
        file: 'src/js/config.js',
        from: '    if (gib >= 1) return `${gib.toFixed(1)} GB`;',
        to: '    return `${gib.toFixed(0)} GB`;',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /under a gigabyte is shown in megabytes/
    },
    {
        id: 'MUT-RECOVERY-READS-ALL',
        file: 'src/js/recorder.js',
        from: '    const pending = (await getUnfinishedRecordings())\n',
        to: "    const pending = (await dbExec(CONFIG.STORE_REC, 'getAllFromIndex', { index: 'by-date' })).filter(rec => rec.processing)\n",
        command: ['node', 'tests/unit/storage-paths.test.mjs'],
        expected: /startup looks up unfinished recordings through the capture-state index/
    },
    {
        id: 'MUT-STATE-INDEX-MISSING',
        file: 'src/js/db-lifecycle-core.js',
        from: ",\n                    { name: 'by-state', keyPath: 'captureState' }] },",
        to: '] },',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /adds exactly what is missing/
    },
    {
        id: 'MUT-JUMP-READS-ALL',
        file: 'src/js/gui.js',
        from: '    const index = await recordingPosition(Number(recId));',
        to: "    const all = await dbExec(CONFIG.STORE_REC, 'getAllFromIndex', { index: 'by-date' });\n    const index = all.findIndex(rec => rec.id == recId);",
        command: ['node', 'tests/unit/static.test.mjs'],
        expected: /jumping to a recording counts the newer ones/
    },
    {
        id: 'MUT-BUTTONS-POLLED',
        file: 'src/js/main.js',
        from: 'onRecordingStateChange(() => { paintLiveScribeButton(); paintPasteRecordButton(); });',
        to: 'setInterval(paintLiveScribeButton, 500);\nsetInterval(paintPasteRecordButton, 500);',
        command: ['node', 'tests/unit/static.test.mjs'],
        expected: /repainted when recording state changes, not polled/
    },
    {
        id: 'MUT-STATE-NOT-ANNOUNCED',
        file: 'src/js/recorder.js',
        from: "    if (!stopStillSaving) document.getElementById('recordBtn').textContent = 'Start Recording';\n    announceRecordingState();\n}",
        to: "    if (!stopStillSaving) document.getElementById('recordBtn').textContent = 'Start Recording';\n}",
        command: ['node', 'tests/unit/static.test.mjs'],
        expected: /a recording ending announces itself/
    },
    {
        id: 'MUT-HINT-ON-EVERY-ERROR',
        file: 'src/js/live-scribe.js',
        from: "        hint: hint != null ? hint : '',",
        to: "        hint: hint != null ? hint : (kind === 'error' ? 'say \"confirm speaker N\" to accept a suggested name' : ''),",
        command: ['node', 'tests/unit/static.test.mjs'],
        expected: /carries a hint only when one is given/
    },
    {
        id: 'MUT-CONTEXT-TEXT-NOT-TAPPABLE',
        file: 'src/js/gui.js',
        from: '    <div class="context-preview" role="button" tabindex="0" data-action="viewContextPart" data-rec-id="${rec.id}" data-item-idx="${idx}" data-part="input"',
        to: '    <div class="context-preview" data-rec-id="${rec.id}" data-item-idx="${idx}" data-part="input"',
        command: ['node', 'tests/unit/static.test.mjs'],
        expected: /tapping the text of a context item opens it in full/
    },
    {
        id: 'MUT-CONTEXT-COPY-MISSING',
        file: 'src/js/gui.js',
        from: "            case 'copyContextPart': return window.copyContextPart(recId, Number(el.dataset.itemIdx), el.dataset.part, el);\n",
        to: '',
        command: ['node', 'tests/unit/static.test.mjs'],
        expected: /the copy button is wired/
    },
    {
        id: 'MUT-LIVE-BUTTON-HIDDEN-IDLE',
        file: 'src/js/main.js',
        from: '    liveScribeBtn.hidden = false;',
        to: '    liveScribeBtn.hidden = !recording;',
        command: ['node', 'tests/unit/static.test.mjs'],
        expected: /stays beside Start Recording when nothing is recording/
    },
    {
        id: 'MUT-LIVE-BUTTON-NO-START',
        file: 'src/js/main.js',
        from: '        if (!AppState.busy) beginRecordingSession({ live: true });',
        to: '        if (!AppState.busy) beginRecordingSession();',
        command: ['node', 'tests/unit/static.test.mjs'],
        expected: /starts a recording with live transcription on/
    },
    {
        id: 'MUT-LIVE-STICKY',
        file: 'src/js/recorder.js',
        from: '    AppState.liveScribe = live === true || liveTranscriptionByDefault();',
        to: '    if (live === true || liveTranscriptionByDefault()) AppState.liveScribe = true;',
        command: ['node', 'tests/unit/static.test.mjs'],
        expected: /never inherits the previous recording/
    },
    {
        id: 'MUT-PASTE-HIDDEN-WHILE-RECORDING',
        file: 'src/js/main.js',
        from: '    pasteRecordBtn.hidden = false;',
        to: '    pasteRecordBtn.hidden = AppState.recId != null;',
        command: ['node', 'tests/unit/static.test.mjs'],
        expected: /stays beside Start Recording during a recording/
    },
    {
        id: 'MUT-PASTE-DURING-RECORDING-LOST',
        file: 'src/js/main.js',
        from: '        if (recordingId != null) {\n            const count = await addContextToRecording(recordingId, item);',
        to: '        if (recordingId != null) {\n            const count = 0;',
        command: ['node', 'tests/unit/static.test.mjs'],
        expected: /adds the clipboard to the recording that is running/
    },
    {
        id: 'MUT-TIMER-IN-BUTTON',
        file: 'src/js/recorder.js',
        from: "    if (recordBtn.textContent !== 'Stop Recording') recordBtn.textContent = 'Stop Recording';",
        to: '    recordBtn.textContent = `Stop Recording (${fmtDur(elapsed)})`;',
        command: ['node', 'tests/unit/static.test.mjs'],
        expected: /says Stop Recording without a timer/
    },
    {
        id: 'MUT-LIVE-TITLE-SUFFIX',
        file: 'src/js/recorder.js',
        from: '            filename: getLocalIso(now),',
        to: '            filename: `${getLocalIso(now)} - Recording...`,',
        command: ['node', 'tests/unit/static.test.mjs'],
        expected: /titled by its date and time alone/
    },
    {
        id: 'MUT-ROW-WRAPS',
        file: 'index.html',
        from: '#record-controls{display:flex;flex-wrap:nowrap;',
        to: '#record-controls{display:flex;flex-wrap:wrap;',
        command: ['node', 'tests/unit/static.test.mjs'],
        expected: /never wrap onto a second line/
    },
    {
        id: 'MUT-PASTE-BOX-IS-PROMPT',
        file: 'src/js/main.js',
        from: "    return askForPastedText(refused ? 'The clipboard could not be read here.' : 'The clipboard is empty.');",
        to: "    return window.prompt('Paste the text this recording should remember:') || '';",
        command: ['node', 'tests/unit/static.test.mjs'],
        expected: /never the browser prompt that truncates/
    },
    {
        id: 'MUT-CLIPBOARD-CAP-20K',
        file: 'src/js/clipboard-core.js',
        from: 'export const CLIPBOARD_CONTEXT_MAX_CHARS = 100000;',
        to: 'export const CLIPBOARD_CONTEXT_MAX_CHARS = 20000;',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /up to 100,000 characters is kept whole/
    },
    {
        id: 'MUT-BIG-PASTE-DROPPED',
        file: 'src/js/reply-core.js',
        from: '    while (tokensOf(prompt) > maxTokens && keptChain.length > 1) {',
        to: '    while (tokensOf(prompt) > maxTokens && keptChain.length) {',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /shortened to fit, never dropped whole/
    },
    {
        id: 'MUT-TRANSLATE-OWN-CONTEXT',
        file: 'src/js/reply.js',
        from: '            num_ctx: AI_NUM_CTX,\n            num_predict',
        to: '            num_ctx: 4096,\n            num_predict',
        command: ['node', 'tests/unit/translate-request.test.mjs'],
        expected: /never makes the server reload the model/
    },
    {
        id: 'MUT-WARMUP-DEFAULT-CONTEXT',
        file: 'src/js/reply.js',
        from: "keep_alive: MODEL_KEEP_ALIVE, options: { num_ctx: numCtx } }",
        to: "keep_alive: MODEL_KEEP_ALIVE }",
        command: ['node', 'tests/unit/translate-request.test.mjs'],
        expected: /loads the model with the same context translation will ask for/
    },
    {
        id: 'MUT-REPLY-OWN-CONTEXT',
        file: 'src/js/reply.js',
        from: 'minCtx: AI_NUM_CTX, maxCtx: AI_MAX_NUM_CTX',
        to: 'minCtx: 8192, maxCtx: AI_MAX_NUM_CTX',
        command: ['node', 'tests/unit/app-behaviour.test.mjs'],
        expected: /moving between them never reloads the model/
    },
    {
        id: 'MUT-LOAD-TIME-CHARGED',
        file: 'src/js/translate-core.js',
        from: '        ? Math.round((prompt || 0) + (evaluate || 0))',
        to: '        ? Math.round((load || 0) + (prompt || 0) + (evaluate || 0))',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /never the seconds the server spent loading the model/
    },
    {
        id: 'MUT-RATE-FROM-TWO',
        file: 'src/js/translate-core.js',
        from: '    return list.length >= minSamples ? translationRate(list) : null;',
        to: '    return list.length ? translationRate(list) : null;',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /two requests are not yet a rate/
    },
    {
        id: 'MUT-CAUSE-LINGERS',
        file: 'src/js/translate-core.js',
        from: '        if (cause) notes.push(String(cause));\n    }\n',
        to: '    }\n    if (cause) notes.push(String(cause));\n',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /disappears once nothing is waiting/
    },
    {
        id: 'MUT-SPEED-IN-TRANSCRIPT',
        file: 'src/js/live-scribe.js',
        from: '            setTranslateCause(TRANSLATE_CAUSES.cpu);',
        to: "            echoCommand(`translation is slow - ${spilled.name} is partly on the CPU`, 0, 'warn');",
        command: ['node', 'tests/unit/static.test.mjs'],
        expected: /never writes a line of its own into the transcript/
    },
    {
        id: 'MUT-NO-WARMUP',
        file: 'src/js/live-scribe.js',
        from: '        warmAiModel(state.controller.signal)',
        to: '        Promise.resolve(state.controller.signal)',
        command: ['node', 'tests/unit/static.test.mjs'],
        expected: /loads the AI model as it starts/
    },
    {
        id: 'MUT-TAP-COUNTS-NOTHING',
        file: 'src/js/capture-health-core.js',
        from: '    return Math.round((now - start) * rate);',
        to: '    return 0;',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /turning on 📝 counts the audio the recording already has/
    },
    {
        id: 'MUT-TAP-FORGETS-EARLIER-AUDIO',
        file: 'src/js/recorder.js',
        from: "    if (AppState.recFormat === 'opus' && AppState.graphStartSec != null) {\n        AppState.samplesSeen",
        to: "    if (false) {\n        AppState.samplesSeen",
        command: ['node', 'tests/unit/static.test.mjs'],
        expected: /counts the audio recorded before the tap/
    },
    {
        id: 'MUT-RESUME-FORGETS-SPEAKERS',
        file: 'src/js/live-scribe-core.js',
        from: "    'diarization', 'speakerHints', 'proposals', 'proposalEchoed', 'inferEchoed',",
        to: "    'speakerHints', 'proposals', 'proposalEchoed', 'inferEchoed',",
        command: ['node', 'tests/unit/live-scribe.test.mjs'],
        expected: /every line from before the pause keeps its speaker/
    },
    {
        id: 'MUT-RESUME-DROPS-TRANSLATIONS',
        file: 'src/js/live-scribe-core.js',
        from: "    'translations', 'translateGaveUp', 'languages', 'closedLanguages',",
        to: "    'translateGaveUp', 'languages', 'closedLanguages',",
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /keeps the translations of the lines it kept/
    },
    {
        id: 'MUT-RESUME-REUSES-KEYS',
        file: 'src/js/live-scribe.js',
        from: '                key: `w${epoch}.${item.index}:${n}`,',
        to: '                key: `w${item.index}:${n}`,',
        command: ['node', 'tests/unit/static.test.mjs'],
        expected: /every line key names the session it came from/
    },
    {
        id: 'MUT-FILL-NEVER-GIVES-UP',
        file: 'src/js/transcribe-core.js',
        from: "                if (breaker.broken) {\n                    return outcome({ missing: missing + batch.length,",
        to: "                if (false) {\n                    return outcome({ missing: missing + batch.length,",
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /asked exactly three times, never once per line/
    },
    {
        id: 'MUT-FILL-NOT-A-JOB',
        file: 'src/js/jobs.js',
        from: "    cancelJob('f', recId);\n",
        to: '',
        command: ['node', 'tests/unit/app-behaviour.test.mjs'],
        expected: /so deleting the recording stops it/
    },
    {
        id: 'MUT-HEAD-SQUEEZES-STATUS',
        file: 'index.html',
        from: '.live-scribe-status{flex:1 0 100%;',
        to: '.live-scribe-status{flex:1;',
        command: ['node', 'tests/unit/static.test.mjs'],
        expected: /the connection status gets a line of its own/
    },
    {
        id: 'MUT-HEAD-DETAILS-PUSH',
        file: 'index.html',
        from: '.live-scribe-info{flex:1 1 0;min-width:0;overflow:hidden;',
        to: '.live-scribe-info{flex:0 0 auto;min-width:0;overflow:hidden;',
        command: ['node', 'tests/unit/static.test.mjs'],
        expected: /instead of pushing the buttons off screen/
    },
    {
        id: 'MUT-COPY-SKIPS-ARCHIVE',
        file: 'src/js/live-scribe-core.js',
        from: '    return [...(archivedLines || []), ...(backfillLines || []), ...(lines || [])]',
        to: '    return [...(backfillLines || []), ...(lines || [])]',
        command: ['node', 'tests/unit/live-scribe.test.mjs'],
        expected: /keeps the lines that scrolled out of view/
    },
    {
        id: 'MUT-COPY-KEEPS-NOTICES',
        file: 'src/js/live-scribe-core.js',
        from: '        .filter(line => line && !line.system)',
        to: '        .filter(line => line)',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /start at the beginning, in time order, without notices/
    },
    {
        id: 'MUT-SPACES-COUNTED',
        file: 'src/js/reply-core.js',
        from: '        if (cls.space) { closeRun(); continue; }',
        to: '        if (cls.space) { closeRun(); total += 1 / 3; continue; }',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /English speech is not overcounted/
    },
    {
        id: 'MUT-CODE-RUNS-AS-WORDS',
        file: 'src/js/reply-core.js',
        from: '        total += run >= CODE_RUN_MIN && runLetters && runDigits ? Math.max(runTokens, run) : runTokens;',
        to: '        total += runTokens;',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /like hashes and base64, count a token per character/
    },
    {
        id: 'MUT-DIGITS-CHEAP',
        file: 'src/js/reply-core.js',
        from: 'const DIGIT_CLASS = Object.freeze({ digit: true, weight: 1 });',
        to: 'const DIGIT_CLASS = Object.freeze({ digit: true, weight: 0.3 });',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /numbers count a token per digit/
    },
    {
        id: 'MUT-TIMEOUT-READ-AS-CANCEL',
        file: 'src/js/reply.js',
        from: '        if (timedOut && !(signal && signal.aborted)) throw translationTimeoutError(timeoutMs);\n',
        to: '',
        command: ['node', 'tests/unit/translate-request.test.mjs'],
        expected: /runs out of time says so/
    },
    {
        id: 'MUT-TIMEOUT-NOT-SLOWER',
        file: 'src/js/translate-core.js',
        from: '    const timedOut = !!error && error.name === TRANSLATION_TIMEOUT;',
        to: '    const timedOut = false;',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /retried at half the size/
    },
    {
        id: 'MUT-TIMEOUT-FLAT',
        file: 'src/js/translate-core.js',
        from: '    return TRANSLATE_TIMEOUT_BASE_MS + TRANSLATE_TIMEOUT_PER_LINE_MS * count;',
        to: '    return 45000;',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /a bigger batch is given more time/
    },
    {
        id: 'MUT-STALE-TRANSLATION-FINALLY',
        file: 'src/js/live-scribe.js',
        from: "        .finally(() => {\n            if (epoch !== state.epoch) return;\n",
        to: "        .finally(() => {\n",
        command: ['node', 'tests/unit/static.test.mjs'],
        expected: /cannot change the state of the session that replaced it/
    },
    {
        id: 'MUT-FPS-ALWAYS-ON',
        file: 'src/js/recorder.js',
        from: '    AppState._fpsEl = on && fpsCounterWanted() ? fpsDisplay : null;',
        to: '    AppState._fpsEl = on ? fpsDisplay : null;',
        command: ['node', 'tests/unit/static.test.mjs'],
        expected: /frame counter is shown only when debugging is switched on/
    },
    {
        id: 'MUT-WAVE-EVERY-FRAME',
        file: 'src/js/recorder.js',
        from: '    if (frame.draw) paintWave(now);',
        to: '    paintWave(now);',
        command: ['node', 'tests/unit/static.test.mjs'],
        expected: /painted only on the frames its frame rate allows/
    },
    {
        id: 'MUT-WAVE-COVERS-ROW',
        file: 'index.html',
        from: 'body.live-scribe-on #visualizer{height:44px;',
        to: 'body.live-scribe-on #visualizer{height:160px;',
        command: ['node', 'tests/unit/static.test.mjs'],
        expected: /waveform is a thin strip/
    },
    {
        id: 'MUT-ARCHIVE-FIRST-LANGUAGE-ONLY',
        file: 'src/js/live-scribe-core.js',
        from: '        for (const target of targets || []) {',
        to: '        for (const target of (targets || []).slice(0, 1)) {',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /a dropped line keeps its translation into every language heard/
    },
    {
        id: 'MUT-ARCHIVE-ONE-LANGUAGE',
        file: 'src/js/live-scribe.js',
        from: '    return Object.keys(state.languages || {});',
        to: '    return Object.keys(state.languages || {}).slice(0, 1);',
        command: ['node', 'tests/unit/static.test.mjs'],
        expected: /keeps its translation into every language heard/
    },
    {
        id: 'MUT-UPDATE-TIMER-LEFT',
        file: 'src/js/version.js',
        from: '    return Promise.race([promise, expired]).finally(() => clearTimeout(timer));',
        to: '    return Promise.race([promise, expired]);',
        command: ['node', 'tests/unit/platform.test.mjs'],
        expected: /leaves no time limit running/
    },
    {
        id: 'MUT-WAVE-RATE-IGNORED',
        file: 'src/js/recorder.js',
        from: "    AppState._vizFps = waveformFps(getSetting('set-waveform-fps'));",
        to: '    AppState._vizFps = 30;',
        command: ['node', 'tests/unit/static.test.mjs'],
        expected: /frame rate is a setting: off, 10, 15, 30/
    },
    {
        id: 'MUT-WAVE-SETTING-NOT-LIVE',
        file: 'src/js/settings.js',
        from: "            if (k === 'set-waveform-fps') applyWaveformRate();\n",
        to: '',
        command: ['node', 'tests/unit/static.test.mjs'],
        expected: /applies at once, also to a recording in progress/
    },
    {
        id: 'MUT-WAVE-WAKES-EVERY-FRAME',
        file: 'src/js/waveform-core.js',
        from: '    return wait >= WAVE_TIMER_MIN_MS ? Math.floor(wait) : 0;',
        to: '    return 0;',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /between frames it sleeps/
    },
    {
        id: 'MUT-WAVE-CATCH-UP-BURST',
        file: 'src/js/waveform-core.js',
        from: '    return { draw: true, due: due && now - due < interval ? due + interval : now + interval };',
        to: '    return { draw: true, due: due ? due + interval : now + interval };',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /after a pause it draws once and carries on at its rate/
    },
    {
        id: 'MUT-WAVE-OFF-DRAWS',
        file: 'src/js/waveform-core.js',
        from: '    if (!(fps > 0)) return { draw: false, due: 0 };\n',
        to: '',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /off draws nothing/
    },
    {
        id: 'MUT-PREVIEW-FOR-BOXES',
        file: 'src/js/live-scribe-core.js',
        from: '    if (!shown || hidden || !heardSpeech) return idle;',
        to: '    if (hidden || !heardSpeech) return idle;',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /nothing is previewed while the translation boxes are shown/
    },
    {
        id: 'MUT-PREVIEW-IN-SILENCE',
        file: 'src/js/live-scribe-core.js',
        from: '    if (!shown || hidden || !heardSpeech) return idle;',
        to: '    if (!shown || hidden) return idle;',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /nor when nobody has spoken since the last one/
    },
    {
        id: 'MUT-PREVIEW-BEFORE-WINDOW',
        file: 'src/js/live-scribe-core.js',
        from: '    if (windowSlotFree && pending >= windowSec - leadSec) return idle;\n',
        to: '',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /about to be sent anyway/
    },
    {
        id: 'MUT-ROWS-REBUILT',
        file: 'src/js/live-scribe.js',
        from: '        if (!wanted.has(child.dataset.key)) container.removeChild(child);',
        to: '        if (false) container.removeChild(child);',
        command: ['node', 'tests/unit/live-scribe.test.mjs'],
        expected: /one row is created instead of every row again/
    },
    {
        id: 'MUT-SINGLE-INNERHTML',
        file: 'src/js/live-scribe.js',
        from: '        syncRows(nodes.text, singleRows(labelled));\n',
        to: "        nodes.text.innerHTML = singleRows(labelled).map(row => row.html).join('');\n",
        command: ['node', 'tests/unit/live-scribe.test.mjs'],
        expected: /each line is a row of its own/
    },
    {
        id: 'MUT-HEARTBEAT-ROW-EVERY-BEAT',
        file: 'src/js/recorder.js',
        from: '    if (beatStored && !heartbeatRowDue({ last: AppState.rowBeat, recId, state, now, force, snapshotted })) return;\n',
        to: '',
        command: ['node', 'tests/unit/static.test.mjs'],
        expected: /rewrites the recording only when it is due/
    },
    {
        id: 'MUT-BEAT-IGNORED-BY-RECOVERY',
        file: 'src/js/recorder.js',
        from: '            const beat = beats.get(Number(rec.id)) || null;\n            if (AppState.recId === rec.id || isRecordOwnedByLiveTab(rec, now, beat)) {',
        to: '            const beat = beats.get(Number(rec.id)) || null;\n            if (AppState.recId === rec.id || isRecordOwnedByLiveTab(rec, now)) {',
        command: ['node', 'tests/unit/storage-paths.test.mjs'],
        expected: /recovery reads each recording.s beat/
    },
    {
        id: 'MUT-BEAT-FROM-ANY-TAB',
        file: 'src/js/recording-lock.js',
        from: '    if (!rec.ownerId || beat.ownerId !== rec.ownerId) return 0;\n',
        to: '',
        command: ['node', 'tests/unit/recording-lock.test.mjs'],
        expected: /a beat from another tab does not keep a row alive/
    },
    {
        id: 'MUT-ROW-DUE-NEVER-REFRESHES',
        file: 'src/js/capture-health-core.js',
        from: '    return Number(now) - (Number(last.at) || 0) >= refreshMs;',
        to: '    return false;',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /a minute without one/
    },
    {
        id: 'MUT-DELETE-IGNORES-BEAT',
        file: 'src/js/settings.js',
        from: '        isFreshHeartbeat(recordHeartbeatAt(rec, beat)) ||',
        to: '        isFreshHeartbeat(rec.heartbeatAt) ||',
        command: ['node', 'tests/unit/storage-paths.test.mjs'],
        expected: /leave alone a recording another tab is still capturing/
    },
    {
        id: 'MUT-TABLE-FIRST-PROBLEM-ONLY',
        file: 'tests/helpers/mutation-core.mjs',
        from: '        if (!value) problems.push(problem);',
        to: '        if (!value && !problems.length) problems.push(problem);',
        command: ['node', 'tests/unit/baseline-runner.test.mjs'],
        expected: /every problem is reported at once/
    },
    {
        id: 'MUT-GUARD-TIMEOUT-AS-DETECTION',
        file: 'tests/helpers/mutation-core.mjs',
        from: "    if (timedOut) return { ok: false, reason: `its suite did not finish within ${GUARD_TIMEOUT_MS / 1000} s` };\n",
        to: '',
        command: ['node', 'tests/unit/baseline-runner.test.mjs'],
        expected: /a suite that hangs is reported as a timeout/
    },
    {
        id: 'MUT-WORKERS-UNBOUNDED',
        file: 'tests/helpers/mutation-core.mjs',
        from: '    return Math.min(available, MAX_MUTATION_WORKERS, cap);',
        to: '    return available;',
        command: ['node', 'tests/unit/baseline-runner.test.mjs'],
        expected: /by default one per core, at most eight/
    },
    {
        id: 'MUT-PLAN-DROPS-SUITE',
        file: 'tests/helpers/baseline-core.mjs',
        from: '        const lanes = [...slow.map(suite => [suite]), ...(mutation.length ? [mutation] : [])];',
        to: '        const lanes = slow.map(suite => [suite]);',
        command: ['node', 'tests/unit/baseline-runner.test.mjs'],
        expected: /every suite runs exactly once whatever the number of jobs/
    },
    {
        id: 'MUT-PLAN-BROWSERS-TOGETHER-ON-TWO',
        file: 'tests/helpers/baseline-core.mjs',
        from: '    if (width >= OVERLAP_MIN_JOBS) {',
        to: '    if (width >= 2) {',
        command: ['node', 'tests/unit/baseline-runner.test.mjs'],
        expected: /with two cores the quick suites run two at a time, then the browser suites one after another/
    },
    {
        id: 'MUT-UNREGISTERED-TEST-FILE',
        file: 'tests/helpers/baseline-suites.mjs',
        from: "command: ['node', 'tests/unit/sw-routing.test.mjs']",
        to: "command: ['node', 'tests/unit/core.test.mjs']",
        command: ['node', 'tests/unit/baseline-contract.test.mjs'],
        expected: /tests\/unit\/sw-routing\.test\.mjs runs in the gate/
    },
    {
        id: 'MUT-GUARD-SUITE-UNCLAIMED',
        file: 'tests/baseline-contract.json',
        transform(source) {
            const parsed = JSON.parse(source);
            const harness = parsed.contracts.find(item => item.id === 'TEST-HARNESS-001');
            harness.suites = harness.suites.filter(suite => suite !== 'static-integrity');
            return JSON.stringify(parsed, null, 2) + '\n';
        },
        command: ['node', 'tests/unit/baseline-contract.test.mjs'],
        expected: /MUT-SHELL-OMIT-MODULE is caught by static-integrity, and its contract TEST-HARNESS-001 names that suite/
    },
    {
        id: 'MUT-STATIC-CEILING-RAISED',
        file: 'tests/baseline-contract.json',
        transform(source) {
            const parsed = JSON.parse(source);
            parsed.rules.staticOnlyGuardCeiling += 1;
            return JSON.stringify(parsed, null, 2) + '\n';
        },
        command: ['node', 'tests/unit/baseline-contract.test.mjs'],
        expected: /the ceiling is lowered as guards move to suites that run the code/
    },
    {
        id: 'MUT-STRICT-COMMAND-DRIFT',
        file: 'tests/baseline-contract.json',
        from: '"strictCommand": "npm test",',
        to: '"strictCommand": "npm run test:unit",',
        command: ['node', 'tests/unit/baseline-contract.test.mjs'],
        expected: /the strict command the contract names is the gate package\.json runs/
    },
    {
        id: 'MUT-CHROMIUM-IGNORES-PLAYWRIGHT',
        file: 'tests/helpers/chromium.mjs',
        from: '        candidates.push(...playwrightChromiums(dir));\n',
        to: '',
        command: ['node', 'tests/unit/baseline-runner.test.mjs'],
        expected: /the newest Chromium Playwright installed is tried first/
    },
    {
        id: 'MUT-RELEASE-STAGED-ON-OTHER-DISK',
        file: 'tools/package_release.py',
        from: 'tempfile.TemporaryDirectory(prefix=f".myai-build-{target}-", dir=output_dir)',
        to: 'tempfile.TemporaryDirectory(prefix=f".myai-build-{target}-")',
        command: ['node', 'tests/unit/static.test.mjs'],
        expected: /staged inside the output folder/
    },
    {
        id: 'MUT-RELEASE-CHECKSUM-AFTER-PUBLISH',
        file: 'tools/package_release.py',
        from: '            publish([(zst_path, final), (checksum_staged, checksum)])',
        to: '            os.replace(zst_path, final)',
        command: ['node', 'tests/unit/static.test.mjs'],
        expected: /the archive and its checksum are published together/
    },
    {
        id: 'MUT-RELEASE-HALF-PUBLISHED',
        file: 'tools/package_release.py',
        from: '        for target in done:\n            target.unlink(missing_ok=True)\n',
        to: '',
        command: ['node', 'tests/unit/static.test.mjs'],
        expected: /a failed move takes back what it moved/
    },
    {
        id: 'MUT-RELEASE-CTRL-C-TRACEBACK',
        file: 'tools/package_release.py',
        from: '    except KeyboardInterrupt:\n        print("\\nrelease interrupted; nothing was published", file=sys.stderr)\n        report_tree_build()\n        return 130\n',
        to: '',
        command: ['node', 'tests/unit/static.test.mjs'],
        expected: /Ctrl-C says the tree was restored/
    },
    {
        id: 'MUT-WAVE-AUTO-CAPPED',
        file: 'src/js/waveform-core.js',
        from: '    return choice === WAVEFORM_AUTO ? Infinity : Number(choice);',
        to: '    return choice === WAVEFORM_AUTO ? 60 : Number(choice);',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /Auto draws a frame on every refresh/
    },
    {
        id: 'MUT-REFRESH-COUNTS-DROPPED-FRAMES',
        file: 'src/js/waveform-core.js',
        from: '    const steady = deltas.filter(delta => Math.abs(delta - median) <= median * 0.25);',
        to: '    const steady = deltas;',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /a dropped frame does not lower the measured rate/
    },
    {
        id: 'MUT-AUTO-LABEL-NOT-MEASURED',
        file: 'src/js/settings.js',
        from: '        if (el) el.value = getSetting(k);\n    });\n    labelAutoWaveform();\n',
        to: '        if (el) el.value = getSetting(k);\n    });\n',
        command: ['node', 'tests/unit/static.test.mjs'],
        expected: /Auto is labelled with the refresh rate measured from this screen/
    },
    {
        id: 'MUT-FULLSCREEN-OUTLIVES-WAVEFORM',
        file: 'src/js/recorder.js',
        from: '    if (!on) document.dispatchEvent(new CustomEvent(WAVEFORM_HIDDEN_EVENT));\n',
        to: '',
        command: ['node', 'tests/unit/static.test.mjs'],
        expected: /its fullscreen view is left too/
    },
    {
        id: 'MUT-FULLSCREEN-HIDDEN-IGNORED',
        file: 'src/js/main.js',
        from: '        if (showingFs || browserFs()) leaveFullscreen();',
        to: '        if (showingFs && browserFs()) leaveFullscreen();',
        command: ['node', 'tests/unit/static.test.mjs'],
        expected: /its fullscreen view is left too/
    },
    {
        id: 'MUT-STOP-FORGETS-PREPARING-WINDOW',
        file: 'src/js/live-scribe.js',
        from: '        if (state.inFlight === 0 && state.preparing === 0 && state.bufferLength === 0 && state.queue.length === 0) break;',
        to: '        if (state.inFlight === 0 && state.bufferLength === 0 && state.queue.length === 0) break;',
        command: ['node', 'tests/unit/live-scribe.test.mjs'],
        expected: /the words said in the last seconds before Stop are in the saved live transcript/
    },
    {
        id: 'MUT-SEAM-TRIMS-WHOLE-WINDOW',
        file: 'src/js/live-scribe-core.js',
        from: '        const mayRepeat = tail && !(gap && appended === 0) && itemStart < seamLimit;',
        to: '        const mayRepeat = tail && !(gap && appended === 0);',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /only a line that starts in the overlap with the previous window is checked for repeated words/
    },
    {
        id: 'MUT-SEAM-LIMIT-NOT-PASSED',
        file: 'src/js/live-scribe.js',
        from: '            seamUntilSec: afterGap ? null : entry.seamUntilSec\n',
        to: '\n',
        command: ['node', 'tests/unit/live-scribe.test.mjs'],
        expected: /sentences that only resemble the one before them are kept/
    },
    {
        id: 'MUT-SPLIT-SENTENCE-REORDERED',
        file: 'src/js/live-scribe-core.js',
        from: '        const startSec = Math.max(itemStart, lastStart);',
        to: '        const startSec = itemStart;',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /never starts before its beginning, so it is saved in spoken order/
    },
    {
        id: 'MUT-STALE-WINDOW-JOINS-NEW-SESSION',
        file: 'src/js/live-scribe.js',
        from: '        if (!state.active || state.recId !== recId || state.epoch !== epoch) {\n            abandonWindowIndex(index, recId, epoch);',
        to: '        if (!state.active || state.recId !== recId) {\n            abandonWindowIndex(index, recId, epoch);',
        command: ['node', 'tests/unit/live-scribe.test.mjs'],
        expected: /every window after the pause is shown, none knocked out by a window cut before it/
    },
    {
        id: 'MUT-OPUS-TAP-LEFT-CONNECTED',
        file: 'src/js/recorder.js',
        from: '        if (AppState.workletNode) await flushWorkletTail();\n',
        to: '        if (AppState.workletNode && !AppState.mediaRecorder) await flushWorkletTail();\n',
        command: ['node', 'tests/unit/static.test.mjs'],
        expected: /the audio tap hands over its last samples and is detached before the live transcript is finished/
    },
    {
        id: 'MUT-REPLAY-FAILURE-DROPS-LIVE',
        file: 'src/js/transcribe-core.js',
        from: '        if (heard) continue;\n        keptLive++;',
        to: '        continue;\n        keptLive++;',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /when replaying an overlapping live passage fails, the live lines are saved instead of a hole/
    },
    {
        id: 'MUT-REPLAY-SILENCE-COUNTS-AS-HEARD',
        file: 'src/js/transcribe-core.js',
        from: '            && touching.every(result => !result.failed)\n            && touching.some(result => replayHeardText(result, review));',
        to: '            && touching.every(result => !result.failed);',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /and so they are when the replay comes back with no words at all/
    },
    {
        id: 'MUT-REPLAY-DOUBLES-PARTIAL',
        file: 'src/js/transcribe-core.js',
        from: '                        ? { ...segment, _reviewSuppressed: true }',
        to: '                        ? segment',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /does not repeat the live text it gives way to/
    },
    {
        id: 'MUT-REPLAY-HIDES-REAL-GAP',
        file: 'src/js/transcribe-core.js',
        from: '                if (!holdsRealGap) result._reviewSuppressed = true;',
        to: '                result._reviewSuppressed = true;',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /a failed chunk that also covered audio nobody transcribed still says so/
    },
    {
        id: 'MUT-REPLAY-SETTLEMENT-UNUSED',
        file: 'src/js/transcribe.js',
        from: '        const merged = [...replay.results, ...liveResults];',
        to: '        const merged = [...results, ...liveResults];',
        command: ['node', 'tests/unit/static.test.mjs'],
        expected: /live lines set aside for a replay come back when the replay fails or hears nothing/
    },
    {
        id: 'MUT-RECOVERY-TAIL-THROWS',
        file: 'src/js/webm-duration.js',
        from: '                if (offset > cluster.dataStart) return { end: offset, cutShort: true };\n',
        to: '',
        command: ['node', 'tests/unit/webm-duration.test.mjs'],
        expected: /still become a seekable file with every Cluster indexed/
    },
    {
        id: 'MUT-RECOVERY-BEGUN-CLUSTER-REFUSED',
        file: 'src/js/webm-duration.js',
        from: '            if (err && err.truncated && err.carriesNoAudio && children.length > 0) {',
        to: '            if (err && err.truncated && err.carriesNoAudio && children.length > 0 && tolerateTruncation) {',
        command: ['node', 'tests/unit/webm-duration.test.mjs'],
        expected: /a Cluster that was only just begun when the tab closed is left out/
    },
    {
        id: 'MUT-RECOVERY-LAST-BLOCK-IGNORED',
        file: 'src/js/webm-duration.js',
        from: '    return Math.max(...ticks) * tickMs + frameMs;',
        to: '    return last.timestampTicks * tickMs;',
        command: ['node', 'tests/unit/webm-duration.test.mjs'],
        expected: /the length is read from the last block in the file/
    },
    {
        id: 'MUT-OPUS-LENGTH-FROM-COUNTED-SAMPLES',
        file: 'src/js/capture-health-core.js',
        from: '    if (fileMs != null && Number.isFinite(file) && file > 0 && file <= Number(elapsedMs) + FILE_LENGTH_SLACK_MS) {',
        to: '    if (false) {',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /is as long as its file, not as the samples counted/
    },
    {
        id: 'MUT-OPUS-LENGTH-NOT-FROM-FILE',
        file: 'src/js/recorder.js',
        from: '    try { fileMs = await webmAudioEndMs(rawMaster); } catch (_) { fileMs = null; }',
        to: '    fileMs = null;',
        command: ['node', 'tests/unit/static.test.mjs'],
        expected: /a finished Opus file is as long as the audio it holds/
    },
    {
        id: 'MUT-STOP-NOTE-FATAL',
        file: 'src/js/recorder.js',
        from: "            console.warn('Could not note the stop on the recording; finalizing it anyway:', err);",
        to: '            throw err;',
        command: ['node', 'tests/unit/storage-paths.test.mjs'],
        expected: /also when noting the stop failed once|and afterwards it is saved with its audio/
    },
    {
        id: 'MUT-BEAT-DROPPED-UNSETTLED',
        file: 'src/js/recorder.js',
        from: '        if (rowSettled) deleteCaptureBeat(currentId).catch(() => {});',
        to: '        deleteCaptureBeat(currentId).catch(() => {});',
        command: ['node', 'tests/unit/storage-paths.test.mjs'],
        expected: /the beat still says capture failed and audio is missing/
    },
    {
        id: 'MUT-BEAT-FORGETS-FAILURE',
        file: 'src/js/capture-health-core.js',
        from: '        beat.captureError = { ...captureFlags.captureError };\n',
        to: '',
        command: ['node', 'tests/unit/storage-paths.test.mjs'],
        expected: /the beat still says capture failed and audio is missing/
    },
    {
        id: 'MUT-HOLE-AFTER-FAILED-PIECE',
        file: 'src/js/recorder.js',
        from: '    if (AppState.fragmentWriteFailed) return false;\n',
        to: '',
        command: ['node', 'tests/unit/static.test.mjs'],
        expected: /later pieces wait in memory, so the stored audio never has a hole in the middle/
    },
    {
        id: 'MUT-FAILED-SAVE-UNREACHABLE',
        file: 'src/js/row-state-core.js',
        from: "                 actions: ['retryFinalizeRec', 'downloadRecoverableRec', 'deleteRec'] };",
        to: "                 actions: ['retryFinalizeRec', 'deleteRec'] };",
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /a recording whose save failed can still be downloaded as the audio saved so far/
    },
    {
        id: 'MUT-BACKUP-NOT-AWAITED',
        file: 'src/js/settings.js',
        from: "    return confirm('The backup download has started.\\n\\n'",
        to: "    return true || confirm('The backup download has started.\\n\\n'",
        command: ['node', 'tests/unit/app-behaviour.test.mjs'],
        expected: /deletes nothing until the person says the backup file was saved/
    },
    {
        id: 'MUT-BACKUP-HIDES-MISSING-AUDIO',
        file: 'src/js/settings.js',
        from: '            else missing.push(rec.id);\n',
        to: '',
        command: ['node', 'tests/unit/app-behaviour.test.mjs'],
        expected: /a backup names only the audio it really holds/
    },
    {
        id: 'MUT-SETTINGS-WRITE-ALL',
        file: 'src/js/settings.js',
        from: "    const modelBefore = getSetting('set-ollama-model');\n    persistEditedHere();",
        to: "    const modelBefore = getSetting('set-ollama-model');\n    ELEMENT_KEYS.forEach(persistControl);",
        command: ['node', 'tests/unit/static.test.mjs'],
        expected: /closing Settings writes only what was edited in this tab/
    },
    {
        id: 'MUT-RETENTION-WRITTEN-ON-CLOSE',
        file: 'src/js/settings.js',
        from: '        if (!RETENTION_KEYS.includes(key)) persistControl(key);',
        to: '        persistControl(key);',
        command: ['node', 'tests/unit/static.test.mjs'],
        expected: /a retention setting is only ever saved as the value that was confirmed/
    },
    {
        id: 'MUT-RETENTION-SAVES-LIVE-ELEMENT',
        file: 'src/js/settings.js',
        from: '    writeStored(key, next);\n    writeStored(RETENTION_ACK_KEY',
        to: '    persistControl(key);\n    writeStored(RETENTION_ACK_KEY',
        command: ['node', 'tests/unit/static.test.mjs'],
        expected: /a retention setting is only ever saved as the value that was confirmed/
    },
    {
        id: 'MUT-RETENTION-UNLOCKED',
        file: 'src/js/settings.js',
        from: '    el.disabled = true;\n    try {\n        await checkRetentionChange(key, el);',
        to: '    try {\n        await checkRetentionChange(key, el);',
        command: ['node', 'tests/unit/static.test.mjs'],
        expected: /cannot change while it is being checked/
    },
    {
        id: 'MUT-TRANSCRIPT-OUTLIVED-BY-REPLY',
        file: 'src/js/retention-core.js',
        from: '        .filter(item => ageOf(itemTime(item)) >= textMs && !answeredLater.has(String(item.id)))',
        to: '        .filter(item => ageOf(itemTime(item)) >= textMs)',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /a transcript is kept while a reply written from it is kept/
    },
    {
        id: 'MUT-DELETE-REPLY-CANCELS-ALL',
        file: 'src/js/settings.js',
        from: "        'The transcript it was written from is kept.')) return;\n    await dbUpdate(",
        to: "        'The transcript it was written from is kept.')) return;\n    cancelAllForRec(recId);\n    await dbUpdate(",
        command: ['node', 'tests/unit/app-behaviour.test.mjs'],
        expected: /deleting one transcript or reply leaves the other work on that recording running/
    },
    {
        id: 'MUT-CLEANUP-DROPS-ANSWERED',
        file: 'src/js/transcribe-core.js',
        from: "        && (!(item.source === 'L' || item.fromLive) || answered.has(String(item.id))));",
        to: "        && !(item.source === 'L' || item.fromLive));",
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /but never one a reply was written from/
    },
    {
        id: 'MUT-CLEANUP-KEEPS-AUTO-COPY',
        file: 'src/js/transcribe.js',
        from: "                    'S', { fromLive: true });",
        to: "                    'S');",
        command: ['node', 'tests/unit/static.test.mjs'],
        expected: /removes the live reading and its automatic copy/
    },
    {
        id: 'MUT-UPDATE-DURING-WORK',
        file: 'src/js/main.js',
        from: 'setUpdateBusyCheck(() => workingHere() || backupRunning());',
        to: 'setUpdateBusyCheck(() => AppState.recId != null);',
        command: ['node', 'tests/unit/static.test.mjs'],
        expected: /an update never reloads the page while this tab is recording, saving/
    },
    {
        id: 'MUT-POISON-WINDOW-RETRIED-FOREVER',
        file: 'src/js/live-scribe.js',
        from: '        if (verdict.giveUp) {',
        to: '        if (false) {',
        command: ['node', 'tests/unit/live-scribe.test.mjs'],
        expected: /does not hold back every line after it/
    },
    {
        id: 'MUT-OUTAGE-STRIKES-WINDOWS',
        file: 'src/js/live-scribe-core.js',
        from: '    const strikesNow = Math.max(0, Number(strikes) || 0) + (othersAnsweredSinceLastFailure ? 1 : 0);',
        to: '    const strikesNow = Math.max(0, Number(strikes) || 0) + 1;',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /keeps its place, however long the outage/
    },
    {
        id: 'MUT-SKIPPED-GAP-ON-LATER-LINE',
        file: 'src/js/live-scribe.js',
        from: '            if (!entry.coverage || entry.gap) state.gapBeforeNext = true;\n            else',
        to: '            if (!entry.coverage || entry.gap) state.pendingGap = true;\n            else',
        command: ['node', 'tests/unit/live-scribe.test.mjs'],
        expected: /the gap is marked on the line right after the skipped window/
    },
    {
        id: 'MUT-TRANSLATE-RECENT-WINDOW-ONLY',
        file: 'src/js/translate-core.js',
        from: '    for (let i = list.length - 1; i >= 0 && out.length < limit; i--) {',
        to: '    for (let i = list.length - 1; i >= Math.max(0, list.length - limit); i--) {',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /older ones come next, so none waits forever after an outage/
    },
    {
        id: 'MUT-OUTAGE-BLAMES-LINES',
        file: 'src/js/live-scribe.js',
        from: '            if (failure.countsAgainstLines) for (const item of batch) countAttempt(item.key);',
        to: '            for (const item of batch) countAttempt(item.key);',
        command: ['node', 'tests/unit/live-scribe.test.mjs'],
        expected: /marks no line "not translated"/
    },
    {
        id: 'MUT-TIMEOUT-BATCH-BLAMED',
        file: 'src/js/translate-core.js',
        from: "        countsAgainstLines: !!error && (error.name === 'EmptyTranslation' || (timedOut && lines === 1))",
        to: "        countsAgainstLines: !!error && (error.name === 'EmptyTranslation' || timedOut)",
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /nor does a batch that ran out of time/
    },
    {
        id: 'MUT-TRANSLATE-BACKOFF-MINUTE',
        file: 'src/js/translate-core.js',
        from: 'export const TRANSLATE_BACKOFF_MAX_MS = 15000;',
        to: 'export const TRANSLATE_BACKOFF_MAX_MS = 60000;',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /the next try is at most 15 seconds away/
    },
    {
        id: 'MUT-ONLINE-KEEPS-TRANSLATE-BACKOFF',
        file: 'src/js/live-scribe.js',
        from: '    state.translateFailures = 0;\n    state.translateNextAt = 0;\n    if (state.active) { paintConnection(); drain(); paintText(); }',
        to: '    if (state.active) { paintConnection(); drain(); }',
        command: ['node', 'tests/unit/static.test.mjs'],
        expected: /translation boxes try again at once/
    },
    {
        id: 'MUT-SILENCE-IS-LANGUAGE',
        file: 'src/js/translate-core.js',
        from: '    if (nothingSaid) return tally || {};\n',
        to: '\n',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /a window with nothing said in it is no evidence of its language/
    },
    {
        id: 'MUT-FIRST-LANGUAGE-FREE',
        file: 'src/js/translate-core.js',
        from: "        if (typeof entry === 'number') { established.push(code); continue; }\n        if (!languageEarnsPanel(",
        to: "        if (typeof entry === 'number' || established.length === 0) { established.push(code); continue; }\n        if (!languageEarnsPanel(",
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /does not become the first language/
    },
    {
        id: 'MUT-BACKFILL-NO-LANGUAGE',
        file: 'src/js/live-scribe.js',
        from: '                                                   text, language: item.language });',
        to: '                                                   text });',
        command: ['node', 'tests/unit/live-scribe.test.mjs'],
        expected: /carry the language they were spoken in/
    },
    {
        id: 'MUT-CANCEL-DOES-NOT-STOP-CHAIN',
        file: 'src/js/jobs.js',
        from: '            if (await task() === CANCELLED) return CANCELLED;',
        to: '            await task();',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /ends the chain, so the cleanup pass does not start/
    },
    {
        id: 'MUT-AUTO-SWALLOWS-CANCEL',
        file: 'src/js/auto-pipeline.js',
        from: '        if (isAbort(error)) outcome = CANCELLED;',
        to: "        if (isAbort(error)) outcome = 'done';",
        command: ['node', 'tests/unit/static.test.mjs'],
        expected: /say when they were cancelled, instead of swallowing it/
    },
    {
        id: 'MUT-EARLY-CANCEL-IGNORED',
        file: 'src/js/transcribe.js',
        from: "        if (!rec || !audioBlob) throw new Error('Audio blob missing.');\n        if (signal.aborted) throw abortError();",
        to: "        if (!rec || !audioBlob) throw new Error('Audio blob missing.');",
        command: ['node', 'tests/unit/saved-transcripts.test.mjs'],
        expected: /a transcription is cancellable from its first moment/
    },
    {
        id: 'MUT-REPLY-EARLY-CANCEL-IGNORED',
        file: 'src/js/reply.js',
        from: '        model = await resolveReplyModel(base);\n        if (ctrl.signal.aborted) throw abortError();',
        to: '        model = await resolveReplyModel(base);',
        command: ['node', 'tests/unit/static.test.mjs'],
        expected: /a reply is cancellable from its first moment/
    },
    {
        id: 'MUT-CLEANUP-ON-DELETED',
        file: 'src/js/recorder.js',
        from: '    if (!rec || rec.deleting) return CANCELLED;',
        to: '    if (!rec) return CANCELLED;',
        command: ['node', 'tests/unit/storage-paths.test.mjs'],
        expected: /the cleanup pass does not start on a recording being deleted/
    },
    {
        id: 'MUT-FILL-COMPETES-WITH-REPLY',
        file: 'src/js/transcribe.js',
        from: '              waitBeforeEachRequest: () => waitWhileAnyReplyRuns(ctrl.signal, noteWaiting) });',
        to: '              waitBeforeEachRequest: null });',
        command: ['node', 'tests/unit/app-behaviour.test.mjs'],
        expected: /the translation fill waits while a reply is running/
    },
    {
        id: 'MUT-FILL-UNANSWERED-LOST',
        file: 'src/js/transcribe-core.js',
        from: '                    unansweredBatchesToRetryAtEnd.push({ batch, target });',
        to: '                    missing += batch.length;',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /tried once more at the end instead of being lost/
    },
    {
        id: 'MUT-FILL-NOTE-AS-PIPELINE-ERROR',
        file: 'src/js/recorder.js',
        from: '            rec.fillError = result.stopped;',
        to: '            rec.pipelineError = result.stopped;',
        command: ['node', 'tests/unit/static.test.mjs'],
        expected: /says so in a notice of its own/
    },
    {
        id: 'MUT-OWN-SAVE-SHOWN-AS-OTHER-TAB',
        file: 'src/js/row-state-core.js',
        from: "    if (savingHere) return { kind: 'saving', live: false, here: true, actions: [] };\n",
        to: '',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /a recording this tab is saving says "Saving…"/
    },
    {
        id: 'MUT-START-LABEL-WHILE-SAVING',
        file: 'src/js/recorder.js',
        from: "    if (!stopStillSaving) document.getElementById('recordBtn').textContent = 'Start Recording';",
        to: "    document.getElementById('recordBtn').textContent = 'Start Recording';",
        command: ['node', 'tests/unit/static.test.mjs'],
        expected: /the record button keeps saying so instead of offering to start/
    },
    {
        id: 'MUT-NO-OPEN-TAB-RECOVERY',
        file: 'src/js/main.js',
        from: "        renderList().catch(err => console.warn('Cross-tab final render failed:', err));\n        scheduleRecoveryOfClosedTabRecordings();",
        to: "        renderList().catch(err => console.warn('Cross-tab final render failed:', err));",
        command: ['node', 'tests/unit/static.test.mjs'],
        expected: /an open tab recovers a recording whose tab closed without saving it/
    },
    {
        id: 'MUT-INTERRUPTED-WITHOUT-ACTIONS',
        file: 'src/js/row-state-core.js',
        from: "    return { kind: 'interrupted', live: false, here: false, actions: ['recoverNowRec', 'deleteRec'] };",
        to: "    return { kind: 'interrupted', live: false, here: false, actions: ['deleteRec'] };",
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /offers Recover now and Delete/
    },
    {
        id: 'MUT-REPAINT-STOPS-PLAYBACK',
        file: 'src/js/gui.js',
        from: '    const keptAudio = audioToKeepAcrossRepaint();',
        to: '    const keptAudio = null;',
        command: ['node', 'tests/unit/static.test.mjs'],
        expected: /so it neither stops nor rewinds/
    },
    {
        id: 'MUT-REPAINT-DROPS-TITLE-EDIT',
        file: 'src/js/gui.js',
        from: '    const keptTitle = titleEditToKeepAcrossRepaint();',
        to: '    const keptTitle = null;',
        command: ['node', 'tests/unit/static.test.mjs'],
        expected: /moves a title being typed along with it/
    },
    {
        id: 'MUT-BUTTON-STUCK-AFTER-REBUILD',
        file: 'src/js/gui.js',
        from: "            if (scribeRow) scribeRow.classList.remove('is-hidden');\n            if (!repainted) repaintIfRowRebuiltDuringJob(li);",
        to: "            if (scribeRow) scribeRow.classList.remove('is-hidden');",
        command: ['node', 'tests/unit/static.test.mjs'],
        expected: /the row on screen is repainted so its button works again/
    },
    {
        id: 'MUT-ENTER-OPENS-TWICE',
        file: 'src/js/gui.js',
        from: "        if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;\n        if (e.defaultPrevented) return;\n        const t = e.target;",
        to: "        if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;\n        const t = e.target;",
        command: ['node', 'tests/unit/static.test.mjs'],
        expected: /so it opens one view/
    },
    {
        id: 'MUT-DIALOG-TAB-ESCAPES',
        file: 'src/js/main.js',
        from: '    if (focusOutsideControls) { event.preventDefault(); (event.shiftKey ? last : first).focus(); }\n    else if',
        to: '    if',
        command: ['node', 'tests/unit/static.test.mjs'],
        expected: /Tab and Shift\+Tab stay inside an open dialog/
    },
    {
        id: 'MUT-SNAPSHOT-EVERY-MINUTE',
        file: 'src/js/recorder.js',
        from: '    if (!liveSnapshotDue({ now, last: AppState.liveSnapshot, ...sizeAndSignature })) return null;\n',
        to: '',
        command: ['node', 'tests/unit/static.test.mjs'],
        expected: /not rewritten whole every minute/
    },
    {
        id: 'MUT-SNAPSHOT-IGNORES-GROWTH',
        file: 'src/js/capture-health-core.js',
        from: '    return grownChars >= Math.max(LIVE_SNAPSHOT_MIN_GROWTH_CHARS, charsAtLastSnapshot * LIVE_SNAPSHOT_MIN_GROWTH_SHARE);',
        to: '    return true;',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /write at most a quarter of what saving it all every minute did/
    },
    {
        id: 'MUT-SNAPSHOT-UNCHANGED-REWRITTEN',
        file: 'src/js/capture-health-core.js',
        from: '    if (transcriptUnchanged) return false;\n',
        to: '',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /an unchanged transcript is not written again/
    },
    {
        id: 'MUT-LIVE-SWEEP-READS-ALL',
        file: 'src/js/db.js',
        from: '    const liveTranscriptRecIds = await db.getAllKeys(CONFIG.STORE_LIVE);',
        to: '    const liveTranscriptRecIds = (await db.getAll(CONFIG.STORE_LIVE)).map(row => row.recId);',
        command: ['node', 'tests/unit/app-behaviour.test.mjs'],
        expected: /reads their keys, never every transcript/
    },
    {
        id: 'MUT-QUEUE-UNDERCOUNTS-AUDIO',
        file: 'src/js/live-scribe.js',
        from: 'bytes: queuedWindowBytes(blob, resampled)',
        to: 'bytes: blob.size',
        command: ['node', 'tests/unit/static.test.mjs'],
        expected: /counts all the audio it holds/
    },
    {
        id: 'MUT-QUEUE-KEEPS-REVIEW-AUDIO',
        file: 'src/js/live-scribe-core.js',
        from: '        item.pcm16k = null;\n',
        to: '',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /let their review samples go/
    },
    {
        id: 'MUT-CENTROID-RESUMMED',
        file: 'src/js/diarize-core.js',
        from: '    for (let i = 0; i < group.sum.length; i++) group.sum[i] += point.vec[i];\n    point.group = group;',
        to: '    group.sum = group.members.reduce((sum, member) => sum.map((value, i) => value + member.vec[i]),\n'
            + '                                    new Array(group.sum.length).fill(0));\n    point.group = group;',
        command: ['node', 'tests/unit/static.test.mjs'],
        expected: /keeps a running sum per speaker/
    },
    {
        id: 'MUT-SPEAKERS-PER-LINE',
        file: 'src/js/live-scribe.js',
        from: '    if (learned) state.diarization = addEmbeddings(state.diarization, heard, { maxSpeakers: maxSpeakers() });',
        to: '    for (const one of heard) state.diarization = addEmbeddings(state.diarization, [one], { maxSpeakers: maxSpeakers() });',
        command: ['node', 'tests/unit/static.test.mjs'],
        expected: /the lines of one live window are clustered together, once/
    },
    {
        id: 'MUT-POOL-FIXED-TEN',
        file: 'src/js/transcribe.js',
        from: 'pool: { limit: Math.min(POOL_START, concurrency), max: concurrency }',
        to: 'pool: { limit: concurrency, max: concurrency }',
        command: ['node', 'tests/unit/saved-transcripts.test.mjs'],
        expected: /it sends a few chunks at a time to start/
    },
    {
        id: 'MUT-POOL-KEEPS-SIZE-ON-TIMEOUT',
        file: 'src/js/transcribe-core.js',
        from: '    if (timedOut) return Math.max(1, Math.floor(current / 2));',
        to: '    if (timedOut) return current;',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /a timeout halves it/
    },
    {
        id: 'MUT-POOL-NEVER-SHRINKS',
        file: 'src/js/transcribe-core.js',
        from: '    if (requestsAreQueuing) return Math.max(1, current - 1);',
        to: '    if (requestsAreQueuing) return current;',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /a slow answer, a sign of queuing, takes one away/
    },
    {
        id: 'MUT-POOL-IGNORES-LIMIT',
        file: 'src/js/transcribe-core.js',
        from: '            while (!stopped() && next < list.length && running < limitNow()) {',
        to: '            while (!stopped() && next < list.length && running < 10) {',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /never runs more than its limit at once/
    },
    {
        id: 'MUT-TIMEOUT-RESENT-AT-ONCE',
        file: 'src/js/transcribe-core.js',
        from: '    const delays = err && err.timedOut ? CHUNK_RETRY_DELAYS_AFTER_TIMEOUT_MS : CHUNK_RETRY_DELAYS_MS;',
        to: '    const delays = CHUNK_RETRY_DELAYS_MS;',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /a chunk that timed out is not sent again at once/
    },
    {
        id: 'MUT-LOG-CASCADES-TO-END',
        file: 'src/js/live-render.js',
        from: '            if (laterChunksUnaffected) break;',
        to: '',
        command: ['node', 'tests/unit/live-view.test.mjs'],
        expected: /renders again only the chunk after it/
    },
    {
        id: 'MUT-LOG-REBUILDS-EVERYTHING',
        file: 'src/js/live-render.js',
        from: '                    rerenderFrom(order.indexOf(key));',
        to: '                    views.clear(); transcriptEl.textContent = \'\'; rerenderFrom(0);',
        command: ['node', 'tests/unit/live-view.test.mjs'],
        expected: /are each rendered once, not the whole transcript again/
    },
    {
        id: 'MUT-LOG-LOSES-MOVED-CHUNK',
        file: 'src/js/live-render.js',
        from: '                    place(key);\n                    rerenderAll();',
        to: '                    const old = views.get(key);\n                    if (old) for (const node of old.nodes) detach(node);\n                    views.delete(key);\n                    place(key);\n                    rerenderFrom(0);',
        command: ['node', 'tests/unit/live-view.test.mjs'],
        expected: /a chunk sent again with a later start is shown once, at its new place/
    },
    {
        id: 'MUT-REPLY-WRITES-PER-TOKEN',
        file: 'src/js/live-render.js',
        from: "                if (Number.isFinite(msg.elapsedMs)) elapsedMs  = msg.elapsedMs;\n                writeGatheredTokensOnNextFrame();",
        to: "                if (Number.isFinite(msg.elapsedMs)) elapsedMs  = msg.elapsedMs;\n                writeGatheredTokens();",
        command: ['node', 'tests/unit/live-view.test.mjs'],
        expected: /wait for that frame, which is asked for once|a token is drawn on the next frame, not straight away/
    },
    {
        id: 'MUT-FIRST-BYTE-FIXED',
        file: 'src/js/reply.js',
        from: '    const firstByteMs = firstByteTimeoutMs(numCtx, CONFIG.REMOTE_FIRST_BYTE_TIMEOUT_MS);',
        to: '    const firstByteMs = CONFIG.REMOTE_FIRST_BYTE_TIMEOUT_MS;',
        command: ['node', 'tests/unit/app-behaviour.test.mjs'],
        expected: /waits for its first word according to the context it needs/
    },
    {
        id: 'MUT-FIRST-BYTE-SHORT-FOR-LONG-CONTEXT',
        file: 'src/js/model-ready-core.js',
        from: '    return modelReloadsForLargerContext ? Math.max(base, reloadWaitMs) : base;',
        to: '    return base;',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /waits longer before giving up/
    },
    {
        id: 'MUT-RESUME-REBUILDS-ROWS',
        file: 'src/js/live-scribe.js',
        from: '    stopLiveScribe({ keepText: false, keepRowsOnScreen: true });',
        to: '    stopLiveScribe({ keepText: false });',
        command: ['node', 'tests/unit/live-scribe.test.mjs'],
        expected: /keeps the rows already on screen/
    },
    {
        id: 'MUT-VIEWER-WAITS-FOR-FRAMES',
        file: 'src/js/live-render.js',
        from: '        requestAnimationFrame(runOnce);\n        setTimeout(runOnce, FRAME_FALLBACK_TIMER_MS);',
        to: '        requestAnimationFrame(runOnce);',
        command: ['node', 'tests/unit/static.test.mjs'],
        expected: /still shows the stream on a timer/
    },
    {
        id: 'MUT-SEAM-TRIMS-OWN-WINDOW',
        file: 'src/js/transcribe-core.js',
        from: '    seam.heardUntil.set(heardIn, Math.max(coveredUntil, endSec));\n',
        to: '',
        command: ['node', 'tests/unit/saved-transcripts.test.mjs'],
        expected: /a sentence that starts with the words the one before it ended on is saved whole/
    },
    {
        id: 'MUT-SEAM-IGNORES-TIME',
        file: 'src/js/transcribe-core.js',
        from: '        if (overlapsForSeam(earlier, { startSec, endSec }, toleranceSec)) heardElsewhere.unshift(earlier.text);',
        to: '        heardElsewhere.unshift(earlier.text);',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /is a new sentence, not a repeat/
    },
    {
        id: 'MUT-SEAM-NO-COVERAGE',
        file: 'src/js/transcribe-core.js',
        from: '        if (coveredUntil >= earlier.endSec - toleranceSec) continue;\n',
        to: '',
        command: ['node', 'tests/unit/saved-transcripts.test.mjs'],
        expected: /saved whole|a real repeat right after a boundary is kept/
    },
    {
        id: 'MUT-LIVE-TRANSCRIPT-RETRIMMED',
        file: 'src/js/transcribe-core.js',
        from: "        const heardIn = r.fromLive ? 'live' : `chunk:${index}`;",
        to: '        const heardIn = `chunk:${index}`;',
        command: ['node', 'tests/unit/saved-transcripts.test.mjs'],
        expected: /says what the live transcript showed, line for line/
    },
    {
        id: 'MUT-OVERLAP-SPEECH-AT-CORE',
        file: 'src/js/transcribe-core.js',
        from: '    if (!coreLevel || isNearSilent(coreLevel)) return { segments: [], useText: false };',
        to: '    if (!coreLevel || isNearSilent(coreLevel)) return { segments: [], useText: true };',
        command: ['node', 'tests/unit/saved-transcripts.test.mjs'],
        expected: /every word is saved once|are saved at the time they were said/
    },
    {
        id: 'MUT-SILENCE-OVER-WHOLE-CHUNK',
        file: 'src/js/transcribe.js',
        from: '        level = summarizeChunkLevel(chunkCoreSamples(audio, chunk));',
        to: '        level = summarizeChunkLevel(audio);',
        command: ['node', 'tests/unit/saved-transcripts.test.mjs'],
        expected: /saved as no speech, not as their place/
    },
    {
        id: 'MUT-CANCEL-REJECTION-UNHANDLED',
        file: 'src/js/transcribe.js',
        from: '    abortP.catch(() => {});\n',
        to: '',
        command: ['node', 'tests/unit/saved-transcripts.test.mjs'],
        expected: /leaves no rejected promise behind that nothing handles/
    },
    {
        id: 'MUT-LIVE-OVERLAP-SPEECH-AT-CORE',
        file: 'src/js/live-scribe.js',
        from: '            : picked.useText\n                ? [{ key: `w${epoch}',
        to: '            : true\n                ? [{ key: `w${epoch}',
        command: ['node', 'tests/unit/live-scribe.test.mjs'],
        expected: /adds no line of its own/
    },
    {
        id: 'MUT-DROP-KEEPS-CARRY',
        file: 'src/js/live-scribe.js',
        from: '    state.carry = null;\n    state.pendingGap = true;',
        to: '    state.pendingGap = true;',
        command: ['node', 'tests/unit/live-scribe.test.mjs'],
        expected: /carries nothing from before the gap/
    },
    {
        id: 'MUT-BACKFILL-SEAMLESS',
        file: 'src/js/live-scribe.js',
        from: '                    const text = passSeam(seam, { heardIn: `chunk:${chunk.idx}`, startSec: item.startSec,\n                                                  endSec: item.endSec, text: item.text });',
        to: '                    const text = item.text;',
        command: ['node', 'tests/unit/live-scribe.test.mjs'],
        expected: /a sentence both backfill windows heard where they overlap is shown once/
    },
    {
        id: 'MUT-SINGLE-LINE-NUMBERED',
        file: 'src/js/translate-core.js',
        from: '        if (numbered && lines.some(line => FIRST_ITEM.test(line))) return parseNumberedLines(body, 1);',
        to: '        if (lines.some(line => FIRST_ITEM.test(line))) return parseNumberedLines(body, 1);',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /a single line that starts with a date keeps it/
    },
    {
        id: 'MUT-SINGLE-LINE-NO-FALLBACK',
        file: 'src/js/translate-core.js',
        from: '        if (numbered && lines.some(line => FIRST_ITEM.test(line))) return parseNumberedLines(body, 1);',
        to: '        if (numbered) return parseNumberedLines(body, 1);',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /keeps a one-line translation that starts with a time/
    },
    {
        id: 'MUT-SINGLE-LINE-PREAMBLE-TAKEN',
        file: 'src/js/translate-core.js',
        from: '        if (numbered && lines.some(line => FIRST_ITEM.test(line))) return parseNumberedLines(body, 1);',
        to: '        if (numbered && FIRST_ITEM.test(lines[0])) return parseNumberedLines(body, 1);',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /read past the preamble/
    },
    {
        id: 'MUT-SINGLE-LINE-OWN-NUMBER-CUT',
        file: 'src/js/translate-core.js',
        from: "const FIRST_ITEM = /^\\s*(?:[-*>]\\s+)*\\**\\s*(?:line\\s*)?1\\s*\\**\\s*[.)\\]:-](?!\\d)/i;",
        to: "const FIRST_ITEM = /^\\s*(?:[-*>]\\s+)*\\**\\s*(?:line\\s*)?1\\s*\\**\\s*[.)\\]:-]/i;",
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /starts with a number of its own keeps it/
    },
    {
        id: 'MUT-RETENTION-FROM-START',
        file: 'src/js/retention-core.js',
        from: '    const recordedAt = recordingEndedAt(rec);',
        to: '    const recordedAt = Number(rec.timestamp) || 0;',
        command: ['node', 'tests/unit/storage-paths.test.mjs'],
        expected: /a 74-minute meeting stopped a minute ago keeps its audio/
    },
    {
        id: 'MUT-DELETE-TRANSCRIPT-KEEPS-LIVE',
        file: 'src/js/settings.js',
        from: '    if (dropLive) await deleteLiveTranscript(recId).catch(() => {});\n',
        to: '',
        command: ['node', 'tests/unit/storage-paths.test.mjs'],
        expected: /deletes the live transcript too, so no hidden copy is left/
    },
    {
        id: 'MUT-CLEANUP-KEEPS-LIVE',
        file: 'src/js/recorder.js',
        from: "        dropLive = liveTranscriptAfterCleanup(rec, kept) === 'drop';",
        to: '        dropLive = false;',
        command: ['node', 'tests/unit/storage-paths.test.mjs'],
        expected: /the live transcript that reading replaced goes too/
    },
    {
        id: 'MUT-BACKUP-CARRIES-ORPHAN-LIVE',
        file: 'src/js/settings.js',
        from: '            if (!backupIncludesLiveTranscript(rec)) continue;\n',
        to: '',
        command: ['node', 'tests/unit/storage-paths.test.mjs'],
        expected: /a live transcript whose transcript was deleted is not carried into the backup/
    },
    {
        id: 'MUT-DELETE-PROMPT-IGNORES-SAVED-SO-FAR',
        file: 'src/js/deletion-core.js',
        from: '    } else if (savedSoFarBytes > 0) {',
        to: '    } else if (false) {',
        command: ['node', 'tests/unit/storage-paths.test.mjs'],
        expected: /says how much audio it still holds/
    },
    {
        id: 'MUT-INTERRUPTED-DELETE-LEFT',
        file: 'src/js/settings.js',
        from: '                await removeRecordingData(id, rec.sessionId || null);\n',
        to: '',
        command: ['node', 'tests/unit/storage-paths.test.mjs'],
        expected: /deletions a closed tab left half done are finished|with everything the recording held/
    },
    {
        id: 'MUT-INTERRUPTED-DELETE-NOT-NOTED',
        file: 'src/js/settings.js',
        from: '    writeStored(INTERRUPTED_DELETIONS_KEY, withDeletionId(readStored(INTERRUPTED_DELETIONS_KEY), id, true));',
        to: '',
        command: ['node', 'tests/unit/storage-paths.test.mjs'],
        expected: /while a deletion runs it is noted/
    },
    {
        id: 'MUT-INTERRUPTED-DELETE-IGNORES-OWNER',
        file: 'src/js/settings.js',
        from: '            if (rec && rec.deleting && rowHasLiveAudioOwner(rec, beats)) continue;\n',
        to: '',
        command: ['node', 'tests/unit/storage-paths.test.mjs'],
        expected: /finishing interrupted deletions also leaves alone a recording another tab is still capturing/
    },
    {
        id: 'MUT-BEAT-FLAGS-DROPPED-AFTER-CLEANUP',
        file: 'src/js/recorder.js',
        from: "        () => persistOwnedHeartbeat(currentId, finalDuration, 'finalizing', currentSessionId, null,\n                                    { captureFlags: stopFlags }),",
        to: "        () => persistOwnedHeartbeat(currentId, finalDuration, 'finalizing', currentSessionId),",
        command: ['node', 'tests/unit/storage-paths.test.mjs'],
        expected: /the beat still says capture failed and audio is missing/
    },
    {
        id: 'MUT-DEFAULT-MODEL-UNDOCUMENTED',
        file: 'src/js/config.js',
        from: "    'set-ollama-model':     'qwen3.8:27b',",
        to: "    'set-ollama-model':     'gemma4:31b',",
        command: ['node', 'tests/unit/static.test.mjs'],
        expected: /the README names the default AI model the code uses/
    },
    {
        id: 'MUT-ENDED-AT-NOT-NOTED',
        file: 'src/js/finalize-core.js',
        from: '    noteRecordingEnded(rec);\n    rec.durationMs  = Math.max(0, durationMs || 0);',
        to: '    rec.durationMs  = Math.max(0, durationMs || 0);',
        command: ['node', 'tests/unit/storage-paths.test.mjs'],
        expected: /it remembers when it stopped/
    },
    {
        id: 'MUT-ENDED-AT-IGNORED',
        file: 'src/js/retention-core.js',
        from: '    return Math.max(Number(rec.endedAt) || 0, startedAt + Math.max(0, Number(rec.durationMs) || 0));',
        to: '    return startedAt + Math.max(0, Number(rec.durationMs) || 0);',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /ages from when it stopped, not from its start plus 20 minutes/
    },
    {
        id: 'MUT-INTERRUPTED-DELETE-IGNORES-MARK',
        file: 'src/js/settings.js',
        from: '            if (rec && rec.deleting) {\n                await removeRecordingData(id, rec.sessionId || null);',
        to: '            if (rec) {\n                await removeRecordingData(id, rec.sessionId || null);',
        command: ['node', 'tests/unit/storage-paths.test.mjs'],
        expected: /a noted recording that is not marked as being deleted is left whole/
    },
    {
        id: 'MUT-FAILED-MARK-KEEPS-NOTE',
        file: 'src/js/settings.js',
        from: '            } catch (err) {\n                noteDeletionFinished(id);\n                throw err;\n            }',
        to: '            } catch (err) {\n                throw err;\n            }',
        command: ['node', 'tests/unit/storage-paths.test.mjs'],
        expected: /could not even mark its recording leaves no note behind/
    },
    {
        id: 'MUT-FINAL-BEAT-NOT-FORCED',
        file: 'src/js/recorder.js',
        from: '{ force: true, captureFlags: stopFlags }',
        to: '{ captureFlags: stopFlags }',
        command: ['node', 'tests/unit/storage-paths.test.mjs'],
        expected: /also when noting the stop failed once/
    },
    {
        id: 'MUT-RECOVERY-DROPS-UNSETTLED-BEAT',
        file: 'src/js/recorder.js',
        from: '                if (settled) deleteCaptureBeat(rec.id).catch(() => {});',
        to: '                deleteCaptureBeat(rec.id).catch(() => {});',
        command: ['node', 'tests/unit/storage-paths.test.mjs'],
        expected: /cannot mark the recording keeps its beat, error and all/
    },
    {
        id: 'MUT-DELETE-AUDIO-IGNORES-OWNER',
        file: 'src/js/settings.js',
        from: '    if (AppState.recId === key || rowHasLiveAudioOwner(rec, await readCaptureBeats())) {',
        to: '    if (AppState.recId === key) {',
        command: ['node', 'tests/unit/storage-paths.test.mjs'],
        expected: /the audio of a recording another tab is still finalizing is not deleted/
    },
    {
        id: 'MUT-DELETE-AUDIO-RACE',
        file: 'src/js/settings.js',
        from: '                if (!current || !(current.audioBytes > 0) || rowHasLiveAudioOwner(current, beats)) return null;',
        to: '                if (!current || !(current.audioBytes > 0)) return null;',
        command: ['node', 'tests/unit/storage-paths.test.mjs'],
        expected: /nor one whose other tab took it up while the question was open/
    },
    {
        id: 'MUT-LIVE-RUN-ON-DROPPED',
        file: 'src/js/transcribe-core.js',
        from: '        if (reachIntoCoreSec == null || !(seg.start < coreRelEnd) || !(seg.end > coreRelStart)) return false;',
        to: '        if (true) return false;',
        command: ['node', 'tests/unit/live-scribe.test.mjs'],
        expected: /runs on into the next window\'s own audio is kept/
    },
    {
        id: 'MUT-LIVE-SHORT-RUN-ON-DROPPED',
        file: 'src/js/transcribe-core.js',
        from: '        return seg.end > coreRelStart + reachIntoCoreSec || soundPastCoreStart(envelope, seg, coreRelStart, coreRelEnd);',
        to: '        return seg.end > coreRelStart + reachIntoCoreSec;',
        command: ['node', 'tests/unit/live-scribe.test.mjs'],
        expected: /runs on a quarter of a second into the next window, followed by quiet, is kept/
    },
    {
        id: 'MUT-LIVE-QUIET-CORE-TOUCH-KEPT',
        file: 'src/js/transcribe-core.js',
        from: '    return past >= SILENCE_RMS_THRESHOLD && past >= rmsUnderSegments(envelope, [seg]) * CORE_SOUND_SHARE;',
        to: '    return true;',
        command: ['node', 'tests/unit/live-scribe.test.mjs'],
        expected: /heard again and adds nothing/
    },
    {
        id: 'MUT-EMPTY-WINDOW-IS-GAP',
        file: 'src/js/live-scribe.js',
        from: '            if (!entry.coverage || entry.gap) state.gapBeforeNext = true;\n            else state.recentReviewWindows = [];',
        to: '            state.gapBeforeNext = true;',
        command: ['node', 'tests/unit/live-scribe.test.mjs'],
        expected: /does not mark the next line as coming after a gap/
    },
    {
        id: 'MUT-CORE-SOUND-IGNORED',
        file: 'src/js/transcribe-core.js',
        from: '    return { segments: [], useText: !(coreLevel.rms < named * CORE_SOUND_SHARE) };',
        to: '    return { segments: [], useText: false };',
        command: ['node', 'tests/unit/saved-transcripts.test.mjs'],
        expected: /a minute full of speech is not lost when the server puts its words at the start of every chunk/
    },
    {
        id: 'MUT-NOISY-CORE-TAKES-OVERLAP',
        file: 'src/js/transcribe-core.js',
        from: '    return { segments: [], useText: !(coreLevel.rms < named * CORE_SOUND_SHARE) };',
        to: '    return { segments: [], useText: true };',
        command: ['node', 'tests/unit/saved-transcripts.test.mjs'],
        expected: /noisy minute/
    },
    {
        id: 'MUT-SAME-ROOM-VOICE-HIDDEN',
        file: 'src/js/diarize-core.js',
        from: '    return clamp01(SECOND_SPEAKER_THRESHOLD * (mergeSimilarity - score) / margin);',
        to: '    return clamp01((sameSpeaker - score) / 0.25);',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /the bar sits at the boundary where one line stops counting as the same voice/
    },
    {
        id: 'MUT-SPLIT-LABELLED-AS-TWO',
        file: 'src/js/diarize-core.js',
        from: '    return clamp01(SECOND_SPEAKER_THRESHOLD * (mergeSimilarity - score) / margin);',
        to: '    return clamp01((mergeSimilarity - score) / margin);',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /two groups the clustering would still let a line join are not two people/
    },
    {
        id: 'MUT-AGC-BYTE-METER',
        file: 'src/js/capture-health-core.js',
        from: '    analyser.getFloatTimeDomainData(samples);',
        to: '    const bytes = new Uint8Array(samples.length);\n    analyser.getByteTimeDomainData(bytes);\n'
            + '    for (let i = 0; i < samples.length; i++) samples[i] = (bytes[i] - 128) / 128;',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /the meter hears a quiet room as quiet/
    },
    {
        id: 'MUT-AGC-NO-HOLD',
        file: 'src/js/capture-health-core.js',
        from: '    if (!(rms >= AUTO_GAIN_HOLD_RMS)) return null;',
        to: '    if (!(rms > 0)) return null;',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /quiet room noise leaves the gain alone however long the pause lasts/
    },
    {
        id: 'MUT-NUMBERS-WAIT-FOR-CONFIDENCE',
        file: 'src/js/diarize-core.js',
        from: '    if (!labelsEarned(state, { minLines })) {',
        to: '    if (!labelsEarned(state, { minLines }) || secondSpeakerProbability(state) < SECOND_SPEAKER_THRESHOLD) {',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /numbered however alike they sound/
    },
    {
        id: 'MUT-STRAY-LINE-NUMBERED',
        file: 'src/js/diarize-core.js',
        from: '        const speaker = own != null && isVoice(own) ? own : previous;',
        to: '        const speaker = own != null ? own : previous;',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /a stray line carries the number before it/
    },
    {
        id: 'MUT-ONE-LINE-IS-A-VOICE',
        file: 'src/js/diarize-core.js',
        from: 'export const MIN_LINES_PER_VOICE = 2;',
        to: 'export const MIN_LINES_PER_VOICE = 1;',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /a monologue with stray lines is never numbered/
    },
    {
        id: 'MUT-RETIRED-VOICE-FORGOTTEN',
        file: 'src/js/diarize-core.js',
        from: '        if (!present.has(Number(id))) add(Number(id), Number(past && past.segments) || 0);',
        to: '        if (false) add(Number(id), Number(past && past.segments) || 0);',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /a voice whose lines have all left the window still counts/
    },
    {
        id: 'MUT-CONFIRMED-PAIR-COUNTS-TWICE',
        file: 'src/js/diarize-core.js',
        from: '        const who = resolveIdentity(state, id);',
        to: '        const who = id;',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /two groups confirmed as one person count as one voice/
    },
    {
        id: 'MUT-VOICES-REGROUPED-FROM-SCRATCH',
        file: 'src/js/diarize-core.js',
        from: '        if (voiceOf[point.key] == null) continue;',
        to: '        continue;',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /once numbers are shown they stay|each of them still has a number of their own|becomes that voice|moves to the voice it clearly sounds like/
    },
    {
        id: 'MUT-NUMBERS-NOT-LATCHED',
        file: 'src/js/diarize-core.js',
        from: '    return !!(state && state.labelled) || voicesAndStrays(state, minLines).voices >= 2;',
        to: '    return voicesAndStrays(state, minLines).voices >= 2;',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /the numbers stay on screen, all of them now the voice it joined/
    },
    {
        id: 'MUT-VOICES-JOINED-EASILY',
        file: 'src/js/diarize-core.js',
        from: 'export const CONSOLIDATE_SIMILARITY = 0.70;',
        to: 'export const CONSOLIDATE_SIMILARITY = 0.30;',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /never goes down|still has a number of their own/
    },
    {
        id: 'MUT-VOICES-NEVER-JOINED',
        file: 'src/js/diarize-core.js',
        from: '                if (!everyLineAgrees && !bothAlike) continue;',
        to: '                continue;',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /sounds more like another voice than like its own becomes that voice/
    },
    {
        id: 'MUT-NAMED-VOICE-LOST',
        file: 'src/js/diarize-core.js',
        from: '    if (named.length === 1) return named[0];',
        to: '',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /the named one goes on/
    },
    {
        id: 'MUT-DIFFERENT-NAMES-JOINED',
        file: 'src/js/diarize-core.js',
        from: '    if (named.length === 2 && String(names[first.id]).toLowerCase() !== String(names[second.id]).toLowerCase()) return null;',
        to: '',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /two voices named differently are never made one/
    },
    {
        id: 'MUT-VOICE-LINE-STUCK',
        file: 'src/js/diarize-core.js',
        from: '        ? own != null && bestScore >= own + SWITCH_MARGIN && bestScore >= sameSpeaker',
        to: '        ? false',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /moves to the voice it clearly sounds like/
    },
    {
        id: 'MUT-NEW-VOICE-WITHOUT-MARGIN',
        file: 'src/js/diarize-core.js',
        from: '            && (speaker.segments > MIN_LINES_PER_VOICE || speaker.margin >= NEW_VOICE_MARGIN)) speaker.voice = true;',
        to: '            ) speaker.voice = true;',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /not taken for a second voice/
    },
    {
        id: 'MUT-NUMBERS-ARE-IDENTITIES',
        file: 'src/js/diarize-core.js',
        from: '    const number = () => speakerLabel(shownNumber(state, target));',
        to: '    const number = () => speakerLabel(target);',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /the first person on screen is Speaker 1/
    },
    {
        id: 'MUT-NUMBERS-SKIP-AFTER-JOIN',
        file: 'src/js/diarize-core.js',
        from: '        if (who === target) return counted.size;',
        to: '        if (who === target) return state.shown.indexOf(raw) + 1;',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /the voice after them moves up one/
    },
    {
        id: 'MUT-NUMBERS-RESORTED',
        file: 'src/js/diarize-core.js',
        from: '    return fresh.length ? [...shown, ...fresh.sort(byFirstHeard(state))] : shown;',
        to: '    return [...shown, ...fresh].sort(byFirstHeard(state));',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /the voices already numbered keep theirs/
    },
    {
        id: 'MUT-FIRST-TWO-BY-IDENTITY',
        file: 'src/js/diarize-core.js',
        from: '    return (a, b) => at(a) - at(b) || a - b;',
        to: '    return (a, b) => a - b;',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /even when its identity is the higher one/
    },
    {
        id: 'MUT-NUMBERED-BEFORE-SHOWN',
        file: 'src/js/diarize-core.js',
        from: '    return { ...next, labelled, shown: labelled ? numberNewVoices(next, shown) : shown };',
        to: '    return { ...next, labelled, shown: numberNewVoices(next, shown) };',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /the voice whose line comes first is Speaker 1/
    },
    {
        id: 'MUT-HEADER-OUT-OF-ORDER',
        file: 'src/js/diarize-core.js',
        from: '    return voices.sort((a, b) => shownNumber(state, a) - shownNumber(state, b));',
        to: '    return voices;',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /lists speakers in the order of their numbers/
    },
    {
        id: 'MUT-RECEIPT-SAYS-IDENTITY',
        file: 'src/js/diarize-core.js',
        from: '    const shownAs = id => shownNumber(state, id);',
        to: '    const shownAs = id => resolveIdentity(state, Number(id));',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /and so does the receipt of a name/
    },
    {
        id: 'MUT-PANEL-SAYS-IDENTITY',
        file: 'src/js/speaker-infer-core.js',
        from: "        parts.push(`${top.name} ${ready ? '✓' : `${share}%`} → Speaker ${shownNumber(state, id)}`);",
        to: "        parts.push(`${top.name} ${ready ? '✓' : `${share}%`} → Speaker ${id}`);",
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /the panel names the speaker by the number on screen/
    },
    {
        id: 'MUT-MERGE-INTO-LOWER-IDENTITY',
        file: 'src/js/speaker-infer-core.js',
        from: '            const [to, from] = shownNumber(state, left.id) <= shownNumber(state, right.id)',
        to: '            const [to, from] = left.id <= right.id',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /joined into the one with the lower number on screen/
    },
    {
        id: 'MUT-PROPOSAL-SHOWS-IDENTITY',
        file: 'src/js/speaker-confirm-core.js',
        from: '    const subject = numberOf(proposalSubject(command));',
        to: '    const subject = proposalSubject(command);',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /names the speaker by the number on screen, not by identity/
    },
    {
        id: 'MUT-ANNOUNCED-NUMBER-FORGOTTEN',
        file: 'src/js/speaker-confirm-core.js',
        from: '        const announced = proposal.number != null ? proposal.number : numberOf(proposalSubject(proposal.command));',
        to: '        const announced = numberOf(proposalSubject(proposal.command));',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /even once that speaker shows as 2/
    },
    {
        id: 'MUT-CONFIRM-BY-IDENTITY',
        file: 'src/js/live-scribe.js',
        from: '    const meant = proposalForNumber(state.proposals, id, numberOnScreen);',
        to: '    const meant = state.proposals.find(proposal => proposalSubject(proposal.command) === id) || null;',
        command: ['node', 'tests/unit/live-scribe.test.mjs'],
        expected: /confirming Speaker 2 names that voice/
    },
    {
        id: 'MUT-SEAM-CUT-OPENING-WORD',
        file: 'src/js/dedup.js',
        from: '    var shared = heardEnd ? sharedEnd(a, b) : sharedStart(a, b);',
        to: '    var shared = heardEnd ? 0 : sharedStart(a, b);',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /heard only the end of/
    },
    {
        id: 'MUT-SEAM-CUT-CLOSING-WORD',
        file: 'src/js/dedup.js',
        from: '    var shared = heardEnd ? sharedEnd(a, b) : sharedStart(a, b);',
        to: '    var shared = heardEnd ? sharedEnd(a, b) : 0;',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /misheard as it was cut off|heard only the start of/
    },
    {
        id: 'MUT-SEAM-CUT-DIGITS',
        file: 'src/js/dedup.js',
        from: '    return shared >= SEAM_CUT_SHARED_MIN_CHARS && /\\p{L}/u.test(part);',
        to: '    return shared >= SEAM_CUT_SHARED_MIN_CHARS;',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /2023 and 2024/
    },
    {
        id: 'MUT-SEAM-SHORT-RUN-DROPPED',
        file: 'src/js/dedup.js',
        from: "    for (var c = Math.min(scan, SEAM_FUZZY_MIN_WORDS - 1); c >= 2; c--) {\n        if (shortRunWithCutEdge(pTail, nHead, c)) return ntok.slice(c - closingWordToKeep(pTail, nHead, c)).join(' ');\n    }\n",
        to: '',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /a short seam whose/
    },
    {
        id: 'MUT-SEAM-SHORT-RUN-TWO-CUTS',
        file: 'src/js/dedup.js',
        from: '    return cut === 1;',
        to: '    return cut >= 1;',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /both edge words being cut/
    },
    {
        id: 'MUT-SEAM-CLIPPED-WORD-KEPT',
        file: 'src/js/dedup.js',
        from: '    return pTail[pTail.length - 1] !== nHead[k - 1] ? 1 : 0;',
        to: '    return 0;',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /never lost to the clipped reading|which is kept whole/
    },
    {
        id: 'MUT-TAIL-GAP-DISCARDED',
        file: 'src/js/transcribe-core.js',
        from: '    if (total - cursor >= Math.min(minGapSec, TAIL_MIN_GAP_SEC)) gaps.push({ fromSec: cursor, toSec: total });',
        to: '    if (total - cursor >= minGapSec) gaps.push({ fromSec: cursor, toSec: total });',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /sub-second gap at the END of the recording/
    },
    {
        id: 'MUT-HOLES-NOT-MARKED',
        file: 'src/js/transcribe-core.js',
        from: '        } else if (r.untranscribed) {',
        to: '        } else if (false) {',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /marks where the live view heard nothing/
    },
    {
        id: 'MUT-HOLES-WITHOUT-COVERAGE',
        file: 'src/js/transcribe-core.js',
        from: '    if (!Array.isArray(coverage) || coverage.length === 0) return [];',
        to: '    if (!Array.isArray(coverage)) return [];',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /records no coverage says nothing/
    },
    {
        id: 'MUT-SPEAKER-LABEL-BLOCKS-SEAM',
        file: 'src/js/transcribe-core.js',
        from: '            const { label, text } = splitSpeakerLabel(line);',
        to: "            const { label, text } = { label: '', text: String(line.text).trim() };",
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /words both heard are trimmed and the speaker stays in front/
    },
    {
        id: 'MUT-SPEAKER-LABEL-DROPPED',
        file: 'src/js/transcribe-core.js',
        from: '        if (seg.label) keptTrim = `${seg.label}: ${keptTrim}`;',
        to: '',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /speaker stays in front|in the reading handed to the reply/
    },
    {
        id: 'MUT-BUSY-KEEPS-POOL',
        file: 'src/js/transcribe-core.js',
        from: '    if (busy) return Math.max(1, Math.floor(current / 2));',
        to: '    if (busy) return current;',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /answers busy \(503 or 429\) halves it/
    },
    {
        id: 'MUT-BUSY-NOT-RECOGNISED',
        file: 'src/js/transcribe.js',
        from: '            failed.busy = res.status === 503 || res.status === 429;',
        to: '            failed.busy = false;',
        command: ['node', 'tests/unit/saved-transcripts.test.mjs'],
        expected: /every chunk reaches a server that takes one at a time/
    },
    {
        id: 'MUT-BUSY-NOT-PASSED',
        file: 'src/js/transcribe.js',
        from: '        adjustPool(recId, state, { ok: false, timedOut: !!err.timedOut, busy: !!err.busy });',
        to: '        adjustPool(recId, state, { ok: false, timedOut: !!err.timedOut, busy: false });',
        command: ['node', 'tests/unit/saved-transcripts.test.mjs'],
        expected: /fewer chunks are sent at once after a busy answer/
    },
    {
        id: 'MUT-BUSY-CHUNK-GIVEN-UP',
        file: 'src/js/transcribe.js',
        from: '        if (shouldWaitForOwnChunk(err, queue.inFlight, busyWaits)) {',
        to: '        if (false) {',
        command: ['node', 'tests/unit/saved-transcripts.test.mjs'],
        expected: /every chunk reaches a server that takes one at a time/
    },
    {
        id: 'MUT-BUSY-WAKES-ON-REFUSAL',
        file: 'src/js/transcribe-core.js',
        from: '    if (!freedRoom && queue.inFlight > 0) return;\n    for (const wake of queue.waiting.splice(0)) wake();',
        to: '    for (const wake of queue.waiting.splice(0)) wake();',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /not woken by another chunk turned away as busy/
    },
    {
        id: 'MUT-BUSY-WAITS-FOR-NOTHING',
        file: 'src/js/transcribe-core.js',
        from: '    if (!freedRoom && queue.inFlight > 0) return;',
        to: '    if (!freedRoom) return;',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /instead of waiting for nothing/
    },
    {
        id: 'MUT-BUSY-WAITS-WITHOUT-OWN-CHUNK',
        file: 'src/js/transcribe-core.js',
        from: '    return !!(err && err.busy) && Number(ownInFlight) > 0 && Number(busyWaits) < maxWaits;',
        to: '    return !!(err && err.busy) && Number(busyWaits) < maxWaits;',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /busy with something else/
    },
    {
        id: 'MUT-BUSY-WAITS-FOREVER',
        file: 'src/js/transcribe-core.js',
        from: '    return !!(err && err.busy) && Number(ownInFlight) > 0 && Number(busyWaits) < maxWaits;',
        to: '    return !!(err && err.busy) && Number(ownInFlight) > 0;',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /keeps losing the race/
    },
    {
        id: 'MUT-NULL-SEGMENT-TEXT',
        file: 'src/js/transcribe.js',
        from: '        const segments = segmentsWithText(data.segments);',
        to: '        const segments = Array.isArray(data.segments) ? data.segments : [];',
        command: ['node', 'tests/unit/saved-transcripts.test.mjs'],
        expected: /without text does not take the rest of its chunk down/
    },
    {
        id: 'MUT-HOLES-NOT-STORED',
        file: 'src/js/transcribe.js',
        from: '    const results = [...liveLinesAsResults(live.lines || []), ...holeResults(holes)];',
        to: '    const results = liveLinesAsResults(live.lines || []);',
        command: ['node', 'tests/unit/app-behaviour.test.mjs'],
        expected: /still marks what the live transcript never heard|marks the window it skipped/
    },
    {
        id: 'MUT-HOLES-NOT-COUNTED',
        file: 'src/js/transcribe.js',
        from: "    const stored = await storeTranscript(recId, rec.resultGeneration || 0, reading, 'L', { holes: reading.holes });",
        to: "    const stored = await storeTranscript(recId, rec.resultGeneration || 0, reading, 'L');",
        command: ['node', 'tests/unit/app-behaviour.test.mjs'],
        expected: /counts them/
    },
    {
        id: 'MUT-FILL-GAPS-HIDDEN',
        file: 'src/js/gui.js',
        from: '    const showScribeButtons  = !compact || !hasTranscripts || fillsGaps;',
        to: '    const showScribeButtons  = !compact || !hasTranscripts;',
        command: ['node', 'tests/unit/app-behaviour.test.mjs'],
        expected: /offers 📝 Fill gaps for it/
    },
    {
        id: 'MUT-FILL-GAPS-SENDS-ALL',
        file: 'src/js/gui.js',
        from: '            }, { reuseLive: fillsGaps });',
        to: '            }, { reuseLive: false });',
        command: ['node', 'tests/unit/app-behaviour.test.mjs'],
        expected: /sends only the parts the live transcript never heard/
    },
    {
        id: 'MUT-FILL-GAPS-AFTER-FILLING',
        file: 'src/js/row-state-core.js',
        from: "        && !list.some(t => t && t.source !== 'L');",
        to: '        && true;',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /once a reading made after the recording exists/
    },
    {
        id: 'MUT-LIVE-NOTES-PROMISE-AUTO',
        file: 'src/js/live-scribe-core.js',
        from: 'export function afterRecordingFate(autoTranscribe) {\n    return autoTranscribe\n',
        to: 'export function afterRecordingFate(autoTranscribe) {\n    return true\n',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /promise nothing the app does not do|not promised to the pass after the recording/
    },
    {
        id: 'MUT-SKIP-NOTE-PROMISES-AUTO',
        file: 'src/js/live-scribe.js',
        from: '            + afterRecordingFate(autoTranscribeAfterRecording()).part',
        to: '            + afterRecordingFate(true).part',
        command: ['node', 'tests/unit/live-scribe.test.mjs'],
        expected: /promises that part to 📝 Fill gaps/
    },
    {
        id: 'MUT-KEY-ON-INNER-CONTROL-TAKEN',
        file: 'src/js/row-state-core.js',
        from: '    return event.target === element;',
        to: '    return true;',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /left to the 📋/
    },
    {
        id: 'MUT-SW-ANSWERS-EVERY-PAGE',
        file: 'sw.js',
        from: 'const isAppPage = url => APP_PAGES.has(url.pathname);',
        to: 'const isAppPage = url => true;',
        command: ['node', 'tests/unit/sw-routing.test.mjs'],
        expected: /another page of the origin/
    },
    {
        id: 'MUT-UPDATE-CHECK-HANGS',
        file: 'src/js/version.js',
        from: '    const version = await withinTime(read, timeoutMs, null);',
        to: '    const version = await read;',
        command: ['node', 'tests/unit/platform.test.mjs'],
        expected: /never answers is given up on/
    },
    {
        id: 'MUT-LIMITER-CLAMPED',
        file: 'src/js/capture-health-core.js',
        from: 'export const LIMITER_SETTINGS = Object.freeze({ threshold: -8, knee: 2, ratio: 20, attack: 0.003, release: 0.080 });',
        to: 'export const LIMITER_SETTINGS = Object.freeze({ threshold: -8, knee: 2, ratio: 30, attack: 0.003, release: 0.080 });',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /every setting lies inside the range Web Audio accepts/
    },
    {
        id: 'MUT-AUTOSCROLL-FIGHTS-READER',
        file: 'src/js/autoscroll-core.js',
        from: '    if (Math.abs(actual - exact) > USER_MOVED_PX) exact = actual;',
        to: '    if (Math.abs(actual - exact) > USER_MOVED_PX * 1000) exact = actual;',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /carries on from where the reader is/
    },
    {
        id: 'MUT-AUTOSCROLL-PAST-END',
        file: 'src/js/autoscroll-core.js',
        from: '    exact = Math.min(max, Math.max(0, exact));',
        to: '    exact = Math.max(0, exact);',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /it stops at the end of the text/
    },
    {
        id: 'MUT-TAKEOVER-ACCEPTS-ITSELF',
        file: 'sw.js',
        from: '        if (!current.build || number === null || number < FIRST_BUILD_THAT_ACCEPTS || shellGone) {',
        to: '        if (true) {',
        command: ['node', 'tests/unit/sw-routing.test.mjs'],
        expected: /still serves the build last accepted/
    },
    {
        id: 'MUT-ACCEPTED-SHELL-DELETED',
        file: 'sw.js',
        from: "        const staleKeys = keys.filter(key => key.startsWith('myai-shell-') && key !== SHELL_CACHE && key !== cacheName",
        to: "        const staleKeys = keys.filter(key => key.startsWith('myai-shell-') && key !== SHELL_CACHE",
        command: ['node', 'tests/unit/sw-routing.test.mjs'],
        expected: /still serves the build last accepted \(expected "index of v201", got "network"\)/
    },
    {
        id: 'MUT-TAP-DOES-NOT-ACCEPT',
        file: 'src/js/version.js',
        from: '        else if (_state.pending) await acceptServingBuild({ timeoutMs: _askTimeoutMs });',
        to: '        else if (false) await acceptServingBuild({ timeoutMs: _askTimeoutMs });',
        command: ['node', 'tests/unit/platform.test.mjs'],
        expected: /having told the serving build it is accepted/
    },
    {
        id: 'MUT-PINNED-SWEPT',
        file: 'src/js/retention-core.js',
        from: '    if (isPinned(rec)) return { ...empty, pinned: true, audioExpiresInMs, textExpiresInMs };',
        to: '    if (false) return { ...empty, pinned: true, audioExpiresInMs, textExpiresInMs };',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /shortening both windows to five minutes still deletes nothing in it/
    },
    {
        id: 'MUT-PIN-CLOCK-RUNS',
        file: 'src/js/retention-core.js',
        from: '    if (isPinned(rec)) spans.push([Number(rec.pinnedAt), now]);\n',
        to: '',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /its countdowns stand where they were when it was pinned/
    },
    {
        id: 'MUT-PIN-RESUMES-FROM-WALL-CLOCK',
        file: 'src/js/retention-core.js',
        from: '    spans.push([Number(rec.pinnedAt), now]);\n    delete rec.pinnedAt;',
        to: '    delete rec.pinnedAt;',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /the countdown runs on from where it stood, not from where the wall clock has got to/
    },
    {
        id: 'MUT-PIN-TOGGLES-BLIND',
        file: 'src/js/retention-core.js',
        from: '    if (!rec || !!pinned === isPinned(rec)) return false;',
        to: '    if (!rec) return false;\n    pinned = !isPinned(rec);',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /pinning a pinned recording again changes nothing/
    },
    {
        id: 'MUT-PIN-RIGHT-OF-FORMAT',
        file: 'src/js/gui.js',
        from: '<span class="rec-top-tools">${pinBtn}${fmtBadge}</span>',
        to: '<span class="rec-top-tools">${fmtBadge}${pinBtn}</span>',
        command: ['node', 'tests/unit/app-behaviour.test.mjs'],
        expected: /the row offers 📌 left of the format/
    },
    {
        id: 'MUT-FILL-KEPT-ONLY-AT-END',
        file: 'src/js/transcribe-core.js',
        from: '        if (typeof onBatch === \'function\' && Object.keys(answers).length) await onBatch(target, answers);',
        to: '        if (false) await onBatch(target, answers);',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /every answer is handed over as it comes/
    },
    {
        id: 'MUT-FILL-SILENT',
        file: 'src/js/recorder.js',
        from: "                if (liveStatusText(recId, 'translate')) updateLiveStatus(recId, 'translate', text);\n                else showLiveStatus(recId, 'translate', text, null, () => cancelJob('f', recId));\n",
        to: '',
        command: ['node', 'tests/unit/app-behaviour.test.mjs'],
        expected: /while a reply runs the recording says its translations wait for it/
    },
    {
        id: 'MUT-FILL-CROSS-CANCELS',
        file: 'src/js/recorder.js',
        from: "                else showLiveStatus(recId, 'translate', text, null, () => cancelJob('f', recId));",
        to: "                else showLiveStatus(recId, 'translate', text, null, () => window.cancelRecJob(recId));",
        command: ['node', 'tests/unit/app-behaviour.test.mjs'],
        expected: /stopping the translations stops only them, not a reply on the same recording/
    },
    {
        id: 'MUT-FILL-WRITES-DELETED-LIVE',
        file: 'src/js/transcribe.js',
        from: '        if (!kept) { ctrl.abort(); return; }',
        to: '        if (!kept) return;',
        command: ['node', 'tests/unit/app-behaviour.test.mjs'],
        expected: /a live transcript deleted while an answer was on its way stays deleted, and the fill ends there/
    },
    {
        id: 'MUT-LIVE-UPDATE-NOT-ATOMIC',
        file: 'src/js/db.js',
        from: "export async function updateLiveTranscript(recId, mutate) {\n    if (recId == null) return false;\n    const db = await database();\n    const tx = db.transaction(CONFIG.STORE_LIVE, 'readwrite');\n    const row = await tx.store.get(recId);\n    const next = mutate((row && row.live) || null);\n    if (next && typeof next.then === 'function') {\n        throw new TypeError('updateLiveTranscript(mutate) must be synchronous, like dbUpdate.');\n    }\n    if (next) await tx.store.put({ recId, live: next, at: Date.now() });\n    await tx.done;\n    return !!next;\n}\n",
        to: "export async function updateLiveTranscript(recId, mutate) {\n    const current = await readLiveTranscript(recId);\n    const next = mutate(current);\n    if (!next) return false;\n    return writeLiveTranscript(recId, next);\n}\n",
        command: ['node', 'tests/unit/app-behaviour.test.mjs'],
        expected: /a change to the live transcript that overlaps its deletion does not bring it back/
    },
    {
        id: 'MUT-READING-WITHOUT-TRANSLATIONS',
        file: 'src/js/transcribe.js',
        from: '            ? await withLiveTranslations(recId, { timestamped, plain }) : { timestamped, plain };',
        to: '            ? { timestamped, plain } : { timestamped, plain };',
        command: ['node', 'tests/unit/app-behaviour.test.mjs'],
        expected: /it carries the translations the boxes made, as the live reading does/
    },
    {
        id: 'MUT-REUSED-READING-WITHOUT-TRANSLATIONS',
        file: 'src/js/transcribe.js',
        from: '                    await withLiveTranslations(recId, reassembleTimeline(liveResults, liveResults.length)),',
        to: '                    reassembleTimeline(liveResults, liveResults.length),',
        command: ['node', 'tests/unit/app-behaviour.test.mjs'],
        expected: /the reading made after the recording from the live lines carries their translations/
    },
    {
        id: 'MUT-REFRESH-SKIPS-SHOWN-READING',
        file: 'src/js/transcribe.js',
        from: "            else if (item.fromLive) text = withTranslations({ timestamped: spokenPart(item.text), plain: item.plain }, live).timestamped;",
        to: "            else if (false) text = withTranslations({ timestamped: spokenPart(item.text), plain: item.plain }, live).timestamped;",
        command: ['node', 'tests/unit/app-behaviour.test.mjs'],
        expected: /each answer is kept as it comes, and reaches the transcript the row shows/
    },
];
