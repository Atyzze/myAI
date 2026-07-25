/* Targeted mutation guards.
 * Each mutation deliberately breaks one critical invariant in a temporary copy.
 * The baseline is trustworthy only if the mapped regression test fails for the
 * expected reason. No source file in the working tree is modified.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { emitTestResult } from '../helpers/test-result.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const contract = JSON.parse(fs.readFileSync(path.join(root, 'tests/baseline-contract.json'), 'utf8'));
let assertions = 0;
function ok(value, message) {
    assertions++;
    if (!value) throw new Error(`Assertion failed: ${message}`);
}

const mutations = [
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
        id: 'MUT-SESSION-INDEX',
        file: 'src/js/db.js',
        from: "createIndex('by-stream-seq', ['recId', 'sessionId', 'seq'], { unique: true });",
        to: "createIndex('by-stream-seq', ['recId', 'seq'], { unique: true });",
        command: ['node', 'tests/unit/static.test.mjs'],
        expected: /fragment store enforces per-session sequence identity/
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
        from: "    if (!Number.isFinite(ms) || ms <= 0) throw new Error('A positive recording duration is required.');\n\n    const parsed = parseTopLevel(bytes);",
        to: "    if (!Number.isFinite(ms) || ms <= 0) throw new Error('A positive recording duration is required.');\n\n    return { bytes, cueCount: 0, durationMs: ms, timecodeScale: 1000000 };\n    const parsed = parseTopLevel(bytes);",
        command: ['node', 'tests/unit/webm-duration.test.mjs'],
        expected: /missing Duration is inserted|finite size|CuePoint/
    },
    {
        id: 'MUT-OPUS-WINDOWING',
        file: 'src/js/webm-duration.js',
        from: "    if (!(blob instanceof Blob)) throw new TypeError('Expected a Blob.');\n    const type = String(blob.type || '').toLowerCase();\n    if (!type.includes('webm')) return null;",
        to: "    return null;\n    if (!(blob instanceof Blob)) throw new TypeError('Expected a Blob.');\n    const type = String(blob.type || '').toLowerCase();\n    if (!type.includes('webm')) return null;",
        command: ['node', 'tests/unit/webm-duration.test.mjs'],
        expected: /multi-hour WebM source|Cannot read properties of null/
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
        id: 'MUT-SERVER-POOL-WIDTH',
        file: 'src/js/config.js',
        from: 'TRANSCRIBE_CONCURRENCY: 10,',
        to: 'TRANSCRIBE_CONCURRENCY: 4,',
        command: ['node', 'tests/unit/static.test.mjs'],
        expected: /server transcription target concurrency is pinned to ten/
    },
    {
        id: 'MUT-CAPTURE-ERROR-CONTINUE',
        file: 'src/js/recorder.js',
        from: '    haltCaptureInputImmediately();\n    Promise.resolve(_renderList()).catch(renderErr => console.warn(\'Capture-error repaint failed:\', renderErr));\n    scheduleCaptureFailureStop();',
        to: '    Promise.resolve(_renderList()).catch(renderErr => console.warn(\'Capture-error repaint failed:\', renderErr));',
        command: ['node', 'tests/unit/static.test.mjs'],
        expected: /fatal capture errors halt the input immediately and force the stop lifecycle/
    },
    {
        // Put the popup script back inline. The CSP forbids inline execution in a
        // blob: document, so this reproduces the exact reported failure: the tab
        // opens and never renders anything.
        id: 'MUT-POPUP-INLINE-SCRIPT',
        file: 'src/js/live-tabs.js',
        from: '<script type="module" src="${escapeAttr(LIVE_VIEW_URL)}"><\\/script>',
        to: '<script>window._ready = true;<\\/script>',
        command: ['node', 'tests/unit/static.test.mjs'],
        expected: /every generated popup script is external, not inline/
    },
    {
        // Remove the readiness deadline, restoring the unbounded retry loop that
        // left a dead popup showing a convincing "Generating..." forever.
        id: 'MUT-POPUP-UNBOUNDED-WAIT',
        file: 'src/js/live-tabs.js',
        from: '      if (Date.now() >= deadline) { reportPopupFailure(win); return; }',
        to: '      if (false) { reportPopupFailure(win); return; }',
        command: ['node', 'tests/unit/live-view.test.mjs'],
        expected: /a popup that never becomes ready is told so/
    },
    {
        // Restore wholesale replacement of a registry entry, which orphans any
        // live view already attached to it.
        id: 'MUT-STREAM-REINIT-REPLACE',
        file: 'src/js/live-tabs.js',
        from: '  return resetEntry(_replyStreams, _replyStreamOrder, recId,\n                    { tokens: \'\', count: 0, firstAt: 0, lastAt: 0, model: \'\', done: false });',
        to: '  _replyStreams[recId] = { tokens: \'\', listeners: [], count: 0, firstAt: 0, lastAt: 0, model: \'\', done: false };\n  _touchEvict(_replyStreams, _replyStreamOrder, recId);\n  return _replyStreams[recId];',
        command: ['node', 'tests/unit/live-view.test.mjs'],
        expected: /tokens still reach a popup opened before the stream was re-initialised/
    },
    {
        // Send every live view back to a popup. On a touch device that is a
        // window fed by a window the system just backgrounded, which renders
        // nothing and sits on "Generating..." forever.
        id: 'MUT-LIVE-VIEW-DESKTOP-ONLY',
        file: 'src/js/live-tabs.js',
        from: '  if (prefersInlineView()) return openInlineReplyStream(recId, recLabel);',
        to: '  if (false) return openInlineReplyStream(recId, recLabel);',
        command: ['node', 'tests/unit/live-view.test.mjs'],
        expected: /a touch device opens no second window/
    },
    {
        // Ignore the popup's readiness announcement, leaving only the property
        // poll - which throws on a popup the opener may not inspect, so the
        // handshake expires in silence behind a "Generating..." placeholder.
        id: 'MUT-POPUP-READY-MESSAGE',
        file: 'src/js/live-tabs.js',
        from: '    if (pending) pending.attach();',
        to: '    if (false) pending.attach();',
        command: ['node', 'tests/unit/live-view.test.mjs'],
        expected: /the announcement replays what polling could not deliver/
    },
    {
        // Grow a second copy of the version back into the application. It is
        // served cache-first like everything else, so a stale shell would show a
        // number for a build nobody is running - the exact thing the label is
        // looked at to rule out.
        id: 'MUT-VERSION-SECOND-COPY',
        file: 'src/js/config.js',
        from: 'export const CONFIG = {',
        to: "export const CONFIG = {\n    APP_VERSION:            'v34',",
        command: ['node', 'tests/unit/static.test.mjs'],
        expected: /src\/js\/config\.js carries no second copy of the version/
    },
    {
        // Ignore the preferred default when the stored model is not installed.
        // The reply is then sent to a name the server does not have, which fails
        // as "model not found" while transcription keeps working - the shape of
        // the reported fresh-profile bug.
        id: 'MUT-REPLY-MODEL-IGNORE-INSTALLED',
        file: 'src/js/reply-core.js',
        from: '    if (preferredName && list.includes(preferredName)) return preferredName;',
        to: '    if (false) return preferredName;',
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /falls back to the preferred default when the stored model is gone/
    },
    {
        // Reintroduce the single-backslash escape that made an evaluated browser
        // expression syntactically invalid and aborted the suite silently.
        id: 'MUT-HARNESS-BROKEN-EVAL',
        file: 'tests/integration/browser-integration.mjs',
        from: "alertText: window.__alerts.join('\\\\n')",
        to: "alertText: window.__alerts.join('\\n')",
        command: ['node', 'tests/unit/static.test.mjs'],
        expected: /every evaluated browser expression is syntactically valid JavaScript/
    },
    {
        // Drop a shipped module from the offline shell. Nothing at runtime would
        // notice; only the installed offline app breaks.
        id: 'MUT-SHELL-OMIT-MODULE',
        file: 'sw.js',
        from: "    './src/js/live-view.js',\n",
        to: '',
        command: ['node', 'tests/unit/static.test.mjs'],
        expected: /src\/js\/live-view\.js is cached by the service-worker shell/
    },
    {
        // Break NDJSON reassembly across a split read: the defect that silently
        // drops or corrupts tokens only when the network happens to cut an object.
        id: 'MUT-REPLY-STREAM-FRAMING',
        file: 'src/js/reply-core.js',
        from: "            while ((newline = buffer.indexOf('\\n')) >= 0) {",
        to: "            while (false && (newline = buffer.indexOf('\\n')) >= 0) {",
        command: ['node', 'tests/unit/pure.test.mjs'],
        expected: /reply stream: the first token announces itself exactly once|reply stream: the object completes on the next read/
    },
    {
        // Restore the trailing-slash-only API guard, under which the transcription
        // route as actually configured did not match its own exclusion.
        id: 'MUT-SW-ROUTE-EXACT',
        file: 'sw.js',
        from: "    API_ROUTES.some(route => pathname === route || pathname.startsWith(route + '/'));",
        to: "    API_ROUTES.some(route => pathname.startsWith(route + '/'));",
        command: ['node', 'tests/unit/static.test.mjs'],
        expected: /API exclusion matches the exact route as well as its subpaths/
    },
    {
        // Make the tap-to-watch target pointer-only again.
        id: 'MUT-LIVE-STATUS-KEYBOARD',
        file: 'src/js/live-tabs.js',
        from: "    main.setAttribute('tabindex', '0');",
        to: "",
        command: ['node', 'tests/unit/live-view.test.mjs'],
        expected: /the tap-to-watch target is focusable and exposed as a button/
    },
    {
        // Resolve a write before its transaction commits. Every durability claim in
        // the app - "a failed promise means the row was not committed" - rests on
        // this, and a crash in the gap would lose audio the app reported as saved.
        id: 'MUT-IDB-COMMIT-BEFORE-RESOLVE',
        file: 'src/js/idb-min.js',
        from: '            const res = await pReq(tx.objectStore(storeName).put(value));\n            await pTx(tx);',
        to: '            const res = await pReq(tx.objectStore(storeName).put(value));',
        command: ['node', 'tests/unit/platform.test.mjs'],
        expected: /a resolved put has already committed its transaction/
    },
    {
        // Stop re-acquiring the wake lock the OS drops when the tab is hidden, so
        // the screen sleeps partway through a long recording.
        id: 'MUT-WAKELOCK-NO-REACQUIRE',
        file: 'src/js/wake-lock.js',
        from: '        if (document.visibilityState === \'visible\' && _wantLock && !_sentinel) {',
        to: '        if (false && document.visibilityState === \'visible\' && _wantLock && !_sentinel) {',
        command: ['node', 'tests/unit/platform.test.mjs'],
        expected: /returning to the foreground re-acquires the dropped lock/
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
    }
];

const expectedGuards = new Set(contract.contracts
    .filter(item => item.severity === 'critical')
    .flatMap(item => item.mutationGuards || []));
const actualGuards = new Set(mutations.map(item => item.id));
ok(expectedGuards.size === actualGuards.size, 'every critical contract has exactly one implemented mutation guard');
for (const id of expectedGuards) ok(actualGuards.has(id), `${id} is implemented`);

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myai-mutations-'));
try {
    for (const mutation of mutations) {
        const copy = path.join(tempRoot, mutation.id);
        fs.cpSync(root, copy, {
            recursive: true,
            filter(source) {
                const rel = path.relative(root, source);
                const first = rel.split(path.sep)[0];
                return first !== 'artifacts' && first !== '.git';
            }
        });
        const target = path.join(copy, mutation.file);
        const before = fs.readFileSync(target, 'utf8');
        let after;
        if (mutation.transform) {
            after = mutation.transform(before);
        } else {
            const occurrences = before.split(mutation.from).length - 1;
            ok(occurrences === 1, `${mutation.id} mutation anchor occurs exactly once`);
            after = before.replace(mutation.from, mutation.to);
        }
        fs.writeFileSync(target, after);

        const [command, ...args] = mutation.command;
        const result = spawnSync(command, args, {
            cwd: copy,
            env: { ...process.env, MYAI_STRICT_TESTS: '1' },
            encoding: 'utf8',
            timeout: 30000
        });
        const output = `${result.stdout || ''}\n${result.stderr || ''}`;
        ok(result.status !== 0, `${mutation.id} is killed by its regression suite`);
        ok(mutation.expected.test(output), `${mutation.id} fails for the intended invariant`);
        console.log(`✓ ${mutation.id} detected`);
    }
} finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
}

console.log(`✓ all ${assertions} mutation-guard assertions passed`);
emitTestResult('mutation-guards', 'pass', { assertions, mutations: mutations.length });
