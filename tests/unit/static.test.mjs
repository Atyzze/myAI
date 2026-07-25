import { emitTestResult } from '../helpers/test-result.mjs';
/* Zero-dependency release-integrity checks. Run from repository root:
 *   node tests/unit/static.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
let assertions = 0;
function ok(value, message) {
    assertions++;
    if (!value) throw new Error(`Assertion failed: ${message}`);
}

const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');
const index = read('index.html');
const gui = read('src/js/gui.js');
const config = read('src/js/config.js');
const sw = read('sw.js');
const db = read('src/js/db.js');
const recorder = read('src/js/recorder.js');
const main = read('src/js/main.js');
const webm = read('src/js/webm-duration.js');
const transcribe = read('src/js/transcribe.js');
const pkg = JSON.parse(read('package.json'));
const baseline = JSON.parse(read('tests/baseline-contract.json'));
const readme = read('README.md');
const baselineRunner = read('tests/run-baseline.mjs');
const browserIntegration = read('tests/integration/browser-integration.mjs');
const desktopIntegration = read('tests/integration/webm-player-integration.mjs');
const ci = read('.github/workflows/ci.yml');


// The release gate must be strict, machine-readable and non-skippable.
ok(pkg.scripts?.test === 'node tests/run-baseline.mjs', 'npm test invokes the strict baseline runner');
ok(pkg.scripts?.['test:portable']?.includes('--portable'), 'portable diagnostics are explicitly separate from the release gate');
ok(baseline.baseline === 'myAI-v30' && baseline.rules?.strictSkipsAllowed === false,
   'machine-readable contract names v30 and forbids strict skips');
ok(readme.includes('Mutation guards') && readme.includes('npm test'), 'baseline policy is documented in README');
ok(baselineRunner.includes("MYAI_STRICT_TESTS: portable ? '0' : '1'"), 'runner forces strict integration prerequisites by default');
ok(baselineRunner.includes('sourceTreeDigest()'), 'baseline report is bound to a digest of the tested source tree');
ok(baselineRunner.includes('report.sourceTree.unchanged'), 'baseline fails if a test mutates the source tree');
ok(browserIntegration.includes('strictTestsRequired()'), 'browser integration fails rather than skips in strict mode');
ok(browserIntegration.includes('Opus lifecycle cannot run'), 'strict browser baseline cannot silently omit the Opus lifecycle');
ok(desktopIntegration.includes('strictTestsRequired()'), 'desktop media integration fails rather than skips in strict mode');
ok(ci.includes('compatibility-baseline:') && ci.includes('run: npm test'), 'CI exposes one required compatibility-baseline job');
ok(ci.includes('artifacts/baseline-report.json'), 'CI preserves the machine-readable baseline report');


// Repository layout is intentionally split between production source and tests.
ok(!fs.existsSync(path.join(root, 'scripts')), 'standalone scripts directory is not shipped');
ok(!fs.existsSync(path.join(root, 'src/tests')), 'production source does not contain test infrastructure');
ok(fs.existsSync(path.join(root, 'tests/unit')) && fs.existsSync(path.join(root, 'tests/integration')), 'all test infrastructure is consolidated under tests');
for (const legacyDoc of ['BASELINE.md', 'CHANGELOG.md', 'SECURITY.md']) {
    ok(!fs.existsSync(path.join(root, legacyDoc)), `${legacyDoc} is consolidated into README`);
}
const assetNames = fs.readdirSync(path.join(root, 'assets')).sort();
ok(JSON.stringify(assetNames) === JSON.stringify(['icon-192.png', 'icon-512.png']), 'PWA ships only the two required icon sizes');
const manifest = JSON.parse(read('manifest.webmanifest'));
ok(manifest.icons?.some(icon => icon.src === 'assets/icon-512.png' && icon.purpose === 'any maskable'), '512 icon serves regular and maskable installation contexts');

// Strict script CSP: event attributes would require unsafe-inline.
ok(!/\son[a-z]+\s*=/g.test(index), 'index.html has no inline event attributes');
ok(!/\son[a-z]+\s*=/g.test(gui), 'render templates have no inline event attributes');
const scriptPolicy = index.match(/script-src\s+([^;]+);/i)?.[1] || '';
ok(scriptPolicy.length > 0, 'script-src policy exists');
ok(!scriptPolicy.includes("'unsafe-inline'"), 'script-src does not allow unsafe-inline');

/* The other half of that invariant.
   `script-src 'self' blob:` is only safe to ship if NOTHING relies on inline
   script. A blob: document inherits the opener's CSP, so a popup built with an
   inline <script> is refused and renders nothing at all - which is exactly how
   every live view silently stopped working. Assert both halves together so they
   can never drift apart again. */
const liveTabs = read('src/js/live-tabs.js');
const liveView = read('src/js/live-view.js');
const stripComments = src => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const liveTabsCode = stripComments(liveTabs);
const generatedScriptTags = [...liveTabsCode.matchAll(/<script\b[^>]*>/gi)].map(m => m[0]);
ok(generatedScriptTags.length > 0, 'the popup builder emits a script tag');
for (const tag of generatedScriptTags) {
    ok(/\ssrc\s*=/.test(tag), 'every generated popup script is external, not inline');
}
ok(liveTabs.includes("new URL('./live-view.js', import.meta.url)"),
   'popup behaviour is loaded from a same-origin module URL');
ok(!/\son[a-z]+\s*=\s*["'`]/.test(liveTabsCode), 'the popup builder emits no inline event attributes');
ok(liveTabs.includes('READY_TIMEOUT_MS') && liveTabs.includes('reportPopupFailure'),
   'the popup readiness handshake is bounded and reports failure visibly');
ok(liveView.includes("window._ready = true"), 'the popup module signals readiness to its opener');
ok(liveView.includes('liveReady') && liveTabs.includes('liveReady'),
   'readiness is also announced by message, the only channel that survives an opaque popup origin');
ok(liveTabs.includes('prefersInlineView') && liveTabs.includes('openInlineLiveView'),
   'a live view can render in page, where a popup fed by a backgrounded opener cannot work');

/* Throughput is measured in the registry, not in a view. A view can be opened at
   any moment and is handed the whole buffer as one message, so a view counting
   its own messages would report a finished answer as a single token. */
ok(/entry\.count \+= 1/.test(liveTabs) && liveTabs.includes('elapsedMs'),
   'the reply registry counts tokens and measures the interval itself');
ok(read('src/js/live-render.js').includes('tok/s')
   && !/Date\.now\(\)/.test(read('src/js/live-render.js')),
   'the view formats the reported numbers instead of timing anything itself');
ok(read('src/js/reply.js').includes('replyStreamModel(recId, model)'),
   'the live view is told which model is answering');
ok(/data-live-config/.test(liveTabs) && /dataset\s*\n?\s*\?\s*document\.body\.dataset\.liveConfig|dataset\.liveConfig/.test(liveView),
   'popup configuration is passed as data, not as a second inline script');

/* Re-initialising a live registry must reset IN PLACE. Replacing the object
   detaches any popup already attached to it, which is the second half of the
   same bug: the reply stream is initialised once by the caller and again inside
   runSummary(), so a window opened between the two received nothing. */
ok(liveTabs.includes('function resetEntry(') && liveTabs.includes('Object.assign(existing, blank)'),
   'live registries reset in place so open popups stay attached');
ok(!/_replyStreams\[recId\]\s*=\s*\{/.test(liveTabs) && !/_liveLogs\[recId\]\s*=\s*\{/.test(liveTabs),
   'no live registry entry is replaced wholesale on re-initialisation');

/* The service worker cannot import the application config, so the routes it
   refuses to cache are duplicated. Assert the duplication stays honest. */
const configuredRoutes = ['OLLAMA_URL', 'TRANSCRIBE_URL']
    .map(key => config.match(new RegExp(`${key}:\\s*'([^']+)'`))?.[1])
    .filter(Boolean);
ok(configuredRoutes.length === 2, 'both proxied service routes are configured');
const swRoutes = (sw.match(/const API_ROUTES\s*=\s*\[([^\]]*)\]/)?.[1] || '')
    .split(',').map(part => part.trim().replace(/^'|'$/g, '')).filter(Boolean);
ok(JSON.stringify(swRoutes.slice().sort()) === JSON.stringify(configuredRoutes.slice().sort()),
   'service-worker API exclusions match the configured service routes exactly');
ok(sw.includes("pathname === route || pathname.startsWith(route + '/')"),
   'API exclusion matches the exact route as well as its subpaths');

/* dbUpdate's synchronous-mutate rule is enforced, not merely documented. */
ok(db.includes("typeof next.then === 'function'"),
   'dbUpdate rejects an asynchronous mutate instead of failing later with TransactionInactiveError');

/* The cross-tab freshness poll must not repaint on every tick. */
ok(main.includes('_refreshedForRecId'),
   'a remote recording triggers at most one cross-tab repaint, not one per poll');

/* The live-status bar is operable without a pointer. */
ok(liveTabs.includes("main.setAttribute('role', 'button')") && liveTabs.includes("main.setAttribute('tabindex', '0')"),
   'the tap-to-watch live-status target is focusable and exposed as a button');

/* Reply stream framing is a pure, testable module rather than inline network code. */
ok(read('src/js/reply-core.js').includes('export function createReplyStreamReader'),
   'NDJSON reply framing lives in the pure core module');
ok(read('src/js/reply.js').includes('createReplyStreamReader(')
   && !read('src/js/reply.js').includes('buffer.indexOf('),
   'reply.js delegates stream framing instead of reimplementing it inline');

/* Offline shell completeness, in BOTH directions. A module missing from the
   service-worker shell breaks only the offline install, which no runtime test
   would notice. */
const shellEntries = [...sw.matchAll(/'\.\/([^']+)'/g)].map(m => m[1]);
const shippedModules = fs.readdirSync(path.join(root, 'src/js')).filter(name => name.endsWith('.js')).sort();
for (const name of shippedModules) {
    ok(shellEntries.includes(`src/js/${name}`), `src/js/${name} is cached by the service-worker shell`);
}
for (const entry of shellEntries) {
    ok(fs.existsSync(path.join(root, entry)), `service-worker shell entry ${entry} exists on disk`);
}

/* Every shipped module must be claimed by at least one test suite, or be listed
   explicitly as untested. live-tabs.js had no coverage at all, and nothing in
   the baseline said so. */
const testSources = [];
(function collectTests(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) collectTests(full);
        else if (entry.isFile() && full.endsWith('.mjs')) testSources.push(fs.readFileSync(full, 'utf8'));
    }
})(path.join(root, 'tests'));
const allTestText = testSources.join('\n');
const untestedAllowlist = new Set(baseline.untestedModules || []);
for (const name of shippedModules) {
    const referenced = allTestText.includes(`src/js/${name}`) || allTestText.includes(`../../src/js/${name}`);
    ok(referenced || untestedAllowlist.has(name),
       `src/js/${name} is exercised by a test suite, or explicitly allowlisted as untested`);
}
for (const name of untestedAllowlist) {
    ok(shippedModules.includes(name), `untested-module allowlist entry ${name} still exists`);
}

/* The harness itself must be executable. A test file that builds JavaScript as a
   template literal can silently produce a syntax error - a single-backslash \n
   inside the template becomes a real newline and breaks the string it sits in -
   which aborts the suite before a single assertion runs. */
const evaluateTemplates = [];
for (const source of testSources) {
    for (const match of source.matchAll(/evaluate\(`/g)) {
        let i = match.index + match[0].length;
        const start = i;
        while (i < source.length) {
            if (source[i] === '\\') { i += 2; continue; }
            if (source[i] === '`') break;
            i++;
        }
        evaluateTemplates.push(source.slice(start, i));
    }
}
ok(evaluateTemplates.length > 0, 'browser suites evaluate expressions in the page');

/* Expand the template the way the JS engine will before the string is handed to
   the browser. Validating the RAW source text would miss the real defect: a
   single-backslash \n inside a template is a source-level escape that expands to
   a literal newline, breaking whatever string it sits in at runtime. */
const TEMPLATE_ESCAPES = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0' };
function expandTemplate(raw) {
    let out = '';
    for (let i = 0; i < raw.length; i++) {
        if (raw[i] !== '\\') { out += raw[i]; continue; }
        const next = raw[++i];
        if (next === undefined) break;
        if (next === 'u' || next === 'x') {
            const width = next === 'u' ? 4 : 2;
            const code = raw.slice(i + 1, i + 1 + width);
            if (new RegExp(`^[0-9a-fA-F]{${width}}$`).test(code)) {
                out += String.fromCharCode(parseInt(code, 16));
                i += width;
                continue;
            }
            out += next;
            continue;
        }
        out += Object.prototype.hasOwnProperty.call(TEMPLATE_ESCAPES, next) ? TEMPLATE_ESCAPES[next] : next;
    }
    return out;
}

for (const template of evaluateTemplates) {
    const filled = expandTemplate(template).replace(/\$\{[^}]*\}/g, '0');
    let valid = true;
    try { new Function(`return (async () => { ${filled} })`); } catch (_) { valid = false; }
    ok(valid, 'every evaluated browser expression is syntactically valid JavaScript');
}

/* ONE declared version.

   It lives in sw.js and nowhere else. Two properties make that the only correct
   home: this script's bytes are what the browser compares on every update
   check, so a version declared elsewhere could change without any update
   happening at all; and it names the cache that serves the GUI, so it is the
   only value that can honestly answer "which build is on screen?". A constant
   compiled into the application is served cache-first like everything else, so
   a stale shell would keep showing a number for a build nobody is running.

   The label asks the worker for it at runtime. Assert that no second copy grows
   back, in any of the places one previously lived. */
const swVersion = sw.match(/const VERSION\s*=\s*'(v\d+)'/)?.[1];
ok(!!swVersion, 'the service worker declares the single application version');
const versionModule = read('src/js/version.js');
for (const file of ['src/js/config.js', 'src/js/main.js', 'src/js/gui.js', 'src/js/version.js']) {
    ok(!read(file).includes('APP_VERSION'), `${file} carries no second copy of the version`);
    ok(!/\bconst VERSION\s*=/.test(read(file)), `${file} declares no version constant of its own`);
}
ok(!/'v\d+'/.test(versionModule), 'the version module hardcodes no version string');
ok(/id="app-version"[^>]*>\s*<\/div>/.test(index), 'the version label ships empty and is filled at runtime');
ok(versionModule.includes("{ type: 'version' }") && sw.includes("data.type !== 'version'"),
   'the label is answered by the worker that actually served the shell');
ok(main.includes('paintAppVersion('), 'the application paints the label from that answer');
ok(pkg.version.split('.')[0] === swVersion.replace(/^v/, ''),
   'package version tracks the service-worker version - run: npm run version:sync');
ok((pkg.scripts?.['version:sync'] || '').includes("readFileSync('sw.js'"),
   'one command carries the declared version into package.json');

// The recording screen presents saved audio, estimated remaining quota and fullness.
ok(index.includes('id="storage-info"') && index.includes('Audio: 0.00 MB • Available: calculating… • calculating…'),
   'storage line starts with two-decimal MB and compact quota placeholders');
ok(db.includes('fmtAudioMegabytes(_storageTotal)') && db.includes('fmtStorageGigabytes(availableBytes)'),
   'storage repaint uses stable MB and compact GB formatters');
ok(db.includes('fmtStorageFullPercent(_storageTotal, _storageQuota)') && db.includes('_storageQuota - _storageTotal'),
   'storage fullness uses saved audio against the browser quota and reports remaining capacity');
ok(db.includes('navigator.storage.estimate()') && db.includes('refreshStorageQuota()'),
   'storage quota is refreshed from the browser estimate');
ok(!db.includes('App origin:') && !db.includes('Storage: ${'),
   'storage line omits the old app-origin and persistence labels');



// Multi-tab storage isolation and seekable Opus output must remain wired.
ok(config.includes("STORE_WAV:              'audio_fragments_v2'"), 'new writes use the isolated fragment store');
ok(config.includes("LEGACY_STORE_WAV:       'wav_4s_chunks'"), 'legacy fragments remain available to recovery');
ok(db.includes("keyPath: 'fragmentId', autoIncrement: true"), 'fragment rows use independent primary keys');
ok(db.includes("['recId', 'sessionId', 'seq']"), 'fragment store enforces per-session sequence identity');
ok(recorder.includes('sessionId: AppState.sessionId'), 'recording chunks persist their capture session id');
ok(recorder.includes("makeWebmSeekable(rawMaster, effectiveDuration)"), 'Opus finalization performs the indexed WebM remux');
ok(gui.includes('makeWebmSeekable(rec.blob, rec.durationMs)'), 'older valid WebM downloads are remuxed lazily');
ok(gui.includes('webmSeekableVersion'), 'legacy duration-only files are not mistaken for fully seekable files');
ok(webm.includes('WEBM_SEEKABLE_VERSION = 2'), 'WebM remux schema version is pinned');
ok(webm.includes('buildCues') && webm.includes('buildSeekHead'), 'WebM remux builds both Cues and SeekHead');
ok(webm.includes('encodeElementSize(bodyLength, SEGMENT_SIZE_BYTES)'), 'WebM remux writes a finite Segment size');
ok(webm.includes('prepareWebmChunkSource') && webm.includes('makeWebmDecodeChunk'), 'WebM exposes bounded Cluster-window decoding');
ok(transcribe.includes('resampleWebmRangeTo16k') && transcribe.includes('Streaming ${webmSource.clusters.length} WebM/Opus Clusters'), 'compressed transcription uses bounded WebM decode windows');
ok(!config.includes('NON_WAV_TRANSCRIBE_MAX_MS') && !transcribe.includes('Compressed recordings longer than'), 'compressed transcription has no arbitrary duration cutoff');
ok(/TRANSCRIBE_CONCURRENCY:\s*10\b/.test(config), 'server transcription target concurrency is pinned to ten');
ok(transcribe.includes('runPool(chunks, concurrency') && transcribe.includes('const concurrency = CONFIG.TRANSCRIBE_CONCURRENCY'), 'server pipeline uses the tested ten-request pool');
ok(config.includes("'set-remote-backups':   'off'"), 'server backup storage defaults to off');

/* A reply must not depend on the user having visited Settings. The stored model
   name and the installed models are reconciled where the reply is sent, not only
   where the picker is drawn, and a corrected choice is written back so the two
   surfaces cannot disagree. */
const replySrc = read('src/js/reply.js');
ok(config.includes("'set-ollama-model':     'gemma4:e4b'"), 'the reply model has a real soft default');
ok(!/llama3\.2/.test(replySrc + config + read('src/js/settings.js')),
   'no stale hardcoded model name survives anywhere');
ok(replySrc.includes('resolveReplyModel(') && replySrc.includes('/api/tags'),
   'the reply path resolves its model against the installed list');
ok(replySrc.includes("localStorage.setItem('set-ollama-model'")
   && read('src/js/settings.js').includes("localStorage.setItem('set-ollama-model'"),
   'both surfaces persist the resolved model instead of only displaying it');
ok(read('src/js/settings.js').includes('chooseReplyModel(models, stored'),
   'the picker and the reply path share one selection rule');
ok(config.includes('DEFAULT_AI_INSTRUCTIONS')
   && config.includes("'set-ai-instructions':  DEFAULT_AI_INSTRUCTIONS"),
   'reply instructions ship with a default that suits plain-text rendering');
ok(/never LaTeX/.test(config) && /plain text/.test(config),
   'that default rules out the notation this client cannot render');
ok(index.includes('id="set-remote-backups"'), 'settings exposes the server backup toggle');
ok(transcribe.includes("form.append('store_backup', getSetting('set-remote-backups') === 'on' ? 'true' : 'false')"), 'server requests send the backup preference explicitly');
ok(read('src/js/settings.js').includes("'set-remote-backups'"), 'server backup toggle participates in settings persistence');
ok(!index.includes('clearDownloadedModels'), 'unrequested model-cache control is absent');
ok(!index.includes('runDatabaseHealer') && !index.includes('Database recovery'), 'database repair UI is absent');
ok(!fs.existsSync(path.join(root, 'src/js/db-healer.js')), 'database healer implementation is not shipped');
ok(!index.includes('id="app-live-status"') && !index.includes('#app-live-status'), 'duplicate global LIVE status beside the version is absent');
ok(!index.includes('id="codec-status"') && !index.includes('#codec-status'), 'no extra global codec label is rendered beneath the help button');
ok(!fs.existsSync(path.join(root, 'src/js/codec-status.js')) && !main.includes('paintCodecStatus') && !recorder.includes('paintCodecStatus'),
   'the accidental global codec-indicator implementation is removed');
ok(gui.includes('const fmtBadge = rec.blob') && gui.includes('Stored as ${recFmt.toUpperCase()}') && !gui.includes("const showFmt  = pref && pref !== 'wav'"),
   'every stored recording card shows its own codec regardless of the current recording preference');
ok(!sw.includes("'./src/js/codec-status.js'"), 'offline shell no longer references the removed global codec module');
ok(gui.includes('LIVE · OTHER TAB'), 'remote tabs render the protected live recording state');

// The release is server-only: no browser model runtime, model CDN, or dual-mode UI.
ok(!fs.existsSync(path.join(root, 'src/js/ai-worker.js')), 'browser AI worker is not shipped');
ok(!/https:\/\/(?:cdn\.jsdelivr|[^\s'\"]*huggingface)|@xenova\/transformers/i.test(index + transcribe + gui), 'production client contains no model-CDN URLs or Transformers.js imports');
ok(!scriptPolicy.includes('wasm-unsafe-eval') && !scriptPolicy.includes('https:'), 'script CSP permits no third-party code or WASM eval');
const connectPolicy = index.match(/connect-src\s+([^;]+);/i)?.[1] || '';
ok(connectPolicy.trim() === "'self'", 'network CSP permits only same-origin server routes');
ok(!gui.includes('btn-t-l-') && !gui.includes('btn-t-r-') && !gui.includes('btn-s-l-') && !gui.includes('btn-s-r-'), 'recording cards expose one Scribe and one Reply action');
ok(!transcribe.includes('transcribeChunkLocal') && !read('src/js/reply.js').includes('runLocalSummary'), 'local AI code paths are absent');
ok(index.includes('id="set-auto-transcribe"') && index.includes('<option value="off">Off</option>') && index.includes('<option value="on">On</option>'), 'automatic processing uses simple Off/On controls');
ok(sw.includes("normalized.startsWith('myai-runtime-')") && sw.includes("normalized.includes('transformers')"), 'service-worker activation removes legacy model caches');

// Recording failures must become visible and fatal immediately. Failed bytes
// remain in memory through stop, are retried once, and can be exported if the
// browser still cannot commit them.
ok(recorder.includes('AppState.uncommittedFragments.set(key, fragment)')
   && recorder.includes('AppState.uncommittedFragments.delete(key)'),
   'uncommitted fragments remain retained until a confirmed IndexedDB commit');
ok(recorder.includes('haltCaptureInputImmediately();')
   && recorder.includes('scheduleCaptureFailureStop();'),
   'fatal capture errors halt the input immediately and force the stop lifecycle');
ok(recorder.includes('ERROR · STOPPING') && gui.includes('ERROR · STOPPING'),
   'button/live-row GUI switches from LIVE to an explicit error-stopping state');
ok(recorder.includes('retryUncommittedFragments(currentId, currentSessionId)')
   && recorder.includes('buildEmergencyRecoveryBlob('),
   'stop retries retained fragments and prepares an emergency recovery download');
ok(!recorder.includes('Audio captured up to this point has been saved.'),
   'quota messaging never claims the newest segment was saved without proof');
ok(recorder.includes('await ensureFinalizationHeadroom(chunks);'),
   'finalization checks estimated duplicate-storage headroom before master-blob creation');
ok(db.includes('export async function requestPersistentStorage()')
   && main.includes('requestPersistentStorage().catch'),
   'record-button user gesture requests persistent origin storage');

// Static IDs should be unique.
const ids = [...index.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]);
ok(ids.length === new Set(ids).size, 'index.html contains no duplicate static IDs');

// Every delegated action used in markup/templates must be explicitly handled.
const actionValues = new Set([
    ...index.matchAll(/data-action="([^"]+)"/g),
    ...gui.matchAll(/data-action=\\?"([^"\\]+)\\?"/g)
].map(match => match[1]));
for (const action of actionValues) {
    ok(gui.includes(`case '${action}':`), `delegated action ${action} has a router case`);
}

// Every local module import must resolve, and every named import must be
// exported by its target. This catches browser module-link failures that syntax
// checking alone cannot see.
const jsDir = path.join(root, 'src/js');
const jsFiles = fs.readdirSync(jsDir).filter(name => name.endsWith('.js'));
const exportCache = new Map();
function namedExports(file) {
    if (exportCache.has(file)) return exportCache.get(file);
    const source = fs.readFileSync(file, 'utf8');
    const names = new Set();
    for (const match of source.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) names.add(match[1]);
    for (const match of source.matchAll(/export\s+(?:const|let|var|class)\s+([A-Za-z_$][\w$]*)/g)) names.add(match[1]);
    for (const match of source.matchAll(/export\s*\{([\s\S]*?)\}/g)) {
        for (const item of match[1].split(',')) {
            const parts = item.trim().split(/\s+as\s+/);
            if (parts[0]) names.add(parts[1] || parts[0]);
        }
    }
    exportCache.set(file, names);
    return names;
}
for (const name of jsFiles) {
    const source = read(`src/js/${name}`);
    for (const match of source.matchAll(/(?:from\s+|import\s*\()(['"])(\.\.?\/[^'"]+)\1/g)) {
        const target = path.resolve(jsDir, match[2]);
        ok(fs.existsSync(target), `${name} import resolves: ${match[2]}`);
    }
    for (const match of source.matchAll(/import\s*\{([\s\S]*?)\}\s*from\s*(['"])(\.\.?\/[^'"]+)\2/g)) {
        const target = path.resolve(jsDir, match[3]);
        const exports = namedExports(target);
        for (const item of match[1].split(',')) {
            const imported = item.trim().split(/\s+as\s+/)[0];
            if (imported) ok(exports.has(imported), `${name} imports exported name ${imported} from ${match[3]}`);
        }
    }
}

// The offline shell must contain every runtime JS module and every listed path.
const shellBlock = sw.match(/const SHELL\s*=\s*\[([\s\S]*?)\];/)?.[1] || '';
const shellPaths = [...shellBlock.matchAll(/'([^']+)'/g)].map(match => match[1]);
for (const shellPath of shellPaths) {
    const rel = shellPath.replace(/^\.\//, '');
    ok(fs.existsSync(path.join(root, rel)), `service-worker shell path exists: ${rel}`);
}
for (const name of jsFiles) {
    ok(shellPaths.includes(`./src/js/${name}`), `service-worker shell includes ${name}`);
}

console.log(`✓ all ${assertions} static integrity assertions passed`);
emitTestResult('static-integrity', 'pass', { assertions });
