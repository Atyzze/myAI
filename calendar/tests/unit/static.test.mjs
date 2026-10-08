// The app as files: every module parses and finds what it imports, the offline shell holds every
// file the app needs (and the service worker leaves the calendar server alone), the build number is
// the same everywhere, and the page has what the code looks for.
import childProcess from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { suite } from '../helpers/check.mjs';

const { ok, eq, finish } = suite('static');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');
const jsDir = path.join(root, 'src/js');
const modules = fs.readdirSync(jsDir).filter(f => f.endsWith('.js')).sort();

// ---- every module parses, and every import names a file and an export that exist ------------------------------
{
    const broken = [];
    for (const file of modules) {
        const check = childProcess.spawnSync(process.execPath, ['--check', path.join(jsDir, file)], { encoding: 'utf8' });
        if (check.status !== 0) broken.push(`${file}: ${check.stderr.split('\n').slice(0, 4).join(' ')}`);
    }
    eq(broken, [], `all ${modules.length} modules parse`);

    const exportsOf = new Map();
    for (const file of modules) {
        const source = fs.readFileSync(path.join(jsDir, file), 'utf8');
        const names = new Set();
        for (const m of source.matchAll(/^export\s+(?:async\s+)?(?:function\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
        for (const m of source.matchAll(/^export\s*\{([^}]*)\}/gm)) {
            for (const part of m[1].split(',')) {
                const name = part.trim().split(/\s+as\s+/).pop().trim();
                if (name) names.add(name);
            }
        }
        exportsOf.set(file, names);
    }
    const missing = [];
    for (const file of modules) {
        const source = fs.readFileSync(path.join(jsDir, file), 'utf8');
        for (const m of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*'(\.\/[^']+)'/g)) {
            const target = path.basename(m[2]);
            if (!exportsOf.has(target)) { missing.push(`${file} imports ${m[2]}, which does not exist`); continue; }
            for (const part of m[1].split(',')) {
                const name = part.trim().split(/\s+as\s+/)[0].trim();
                if (name && !exportsOf.get(target).has(name)) missing.push(`${file} imports ${name} from ${target}, which does not export it`);
            }
        }
    }
    eq(missing, [], 'every name a module imports is exported by the module it names');
}

// ---- the offline shell ----------------------------------------------------------------------------------------------
const swSource = read('sw.js');
{
    const shell = [...swSource.matchAll(/^\s*'\.\/([^']+)',?$/gm)].map(m => m[1]);
    const missingFiles = shell.filter(rel => !fs.existsSync(path.join(root, rel)));
    eq(missingFiles, [], 'every file the shell lists exists');
    const notInShell = modules.map(f => `src/js/${f}`).filter(rel => !shell.includes(rel));
    eq(notInShell, [], 'every module of the app is in the shell, so the app opens offline');
    for (const rel of ['index.html', 'manifest.webmanifest', 'assets/icon-192.png', 'assets/icon-512.png']) {
        ok(shell.includes(rel), `the shell holds ${rel}`);
    }

    // The service worker, run against stand-ins, answers the app's own files and pages and nothing else.
    const handlers = {};
    const scope = 'https://box.example/calendar/';
    const context = {
        self: {
            registration: { scope },
            location: { origin: 'https://box.example' },
            addEventListener: (type, fn) => { handlers[type] = fn; },
            clients: { claim: async () => {}, matchAll: async () => [], openWindow: async () => {} },
            skipWaiting: async () => {}
        },
        caches: { open: async () => ({ match: async () => null, put: async () => {} }), keys: async () => [], delete: async () => true },
        fetch: async () => ({ ok: true }),
        URL, Request: class { constructor(url) { this.url = url; } }, Response: class {}, Promise, Set, Map
    };
    vm.runInNewContext(swSource, context);
    const answers = (url, { method = 'GET', mode = 'cors' } = {}) => {
        let answered = false;
        handlers.fetch({ request: { url, method, mode }, respondWith: () => { answered = true; } });
        return answered;
    };
    ok(answers(`${scope}src/js/app.js`) && answers(`${scope}src/js/app.js?v=2`), 'it answers the app\'s files from the shell');
    ok(answers(scope, { mode: 'navigate' }) && answers(`${scope}index.html`, { mode: 'navigate' }) && answers(`${scope}?open=x`, { mode: 'navigate' }),
       'and the app\'s page, also opened from a reminder');
    ok(!answers('https://box.example/dav/alice/', { method: 'PROPFIND' }) && !answers('https://box.example/dav/alice/personal/x.ics')
       && !answers('https://box.example/dav/alice/personal/x.ics', { method: 'PUT' }), 'but never the calendar server: events are not cached by the worker');
    ok(!answers('https://box.example/', { mode: 'navigate' }) && !answers('https://box.example/index.html', { mode: 'navigate' }),
       'nor the other apps on the box');
    ok(!answers(`${scope}src/js/app.js`, { method: 'POST' }) && !answers('https://elsewhere.example/calendar/src/js/app.js'),
       'nor anything that is not a GET on this site');
    ok(typeof handlers.notificationclick === 'function', 'a tapped reminder notification opens the app');
}

// ---- the calendar server's password stays the app's own ---------------------------------------------------------------
{
    const { DavClient, basicAuth } = await import('../../src/js/caldav.js');
    let seen = null;
    const dav = new DavClient({
        base: 'https://box.example/dav/', authorization: basicAuth('anna', 'secret'),
        fetchFn: async (url, init) => { seen = init; return new Response('', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="x"' } }); }
    });
    let error = null;
    try { await dav.discover(); } catch (err) { error = err; }
    ok(seen && seen.credentials === 'omit' && /^Basic /.test(seen.headers.Authorization),
       'requests carry the app\'s own Authorization and no browser credentials, so a refused password never pops up the browser\'s login box');
    ok(error && error.kind === 'auth', 'a refused password comes back to the app as such');
}

// ---- one build number everywhere ----------------------------------------------------------------------------------
{
    const build = read('BUILD_NUMBER').trim();
    const sw = (/^const VERSION\s*=\s*'v(\d+)';/m.exec(swSource) || [])[1];
    const meta = (/<meta name="myai-calendar-build" content="(\d+)">/.exec(read('index.html')) || [])[1];
    const pkg = String(JSON.parse(read('package.json')).version).split('.')[0];
    eq([sw, meta, pkg], [build, build, build], `BUILD_NUMBER (${build}) is the same in sw.js, index.html and package.json`);
}

// ---- the page --------------------------------------------------------------------------------------------------------
{
    const html = read('index.html');
    const csp = (/Content-Security-Policy" content="([^"]+)"/.exec(html) || [])[1] || '';
    ok(/connect-src 'self'/.test(csp) && /script-src 'self'/.test(csp) && !/unsafe-eval/.test(csp),
       'the page may talk only to its own site and run only its own scripts');
    ok(/<script type="module" src="src\/js\/app\.js"><\/script>/.test(html), 'it starts the app module');
    const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]));
    const wanted = new Set();
    for (const file of modules) {
        for (const m of fs.readFileSync(path.join(jsDir, file), 'utf8').matchAll(/byId\('([^']+)'\)/g)) wanted.add(m[1]);
    }
    // Elements the panels build themselves ({ id: '...' } in an h() call) are not on the page.
    const madeByCode = new Set();
    for (const file of modules) {
        for (const m of fs.readFileSync(path.join(jsDir, file), 'utf8').matchAll(/\bid: '([^']+)'/g)) madeByCode.add(m[1]);
    }
    const absent = [...wanted].filter(id => !ids.has(id) && !madeByCode.has(id));
    eq(absent, [], 'every element the code looks up by id is on the page');
    const manifest = JSON.parse(read('manifest.webmanifest'));
    const sizes = manifest.icons.map(icon => {
        const png = fs.readFileSync(path.join(root, icon.src));
        return `${png.readUInt32BE(16)}x${png.readUInt32BE(20)}` === icon.sizes;
    });
    ok(sizes.length === 2 && sizes.every(Boolean), 'the manifest\'s icons exist at the sizes it gives');
    ok(manifest.start_url === './' && manifest.scope === './', 'the app works from whatever folder it is unpacked in');
}

// ---- the release zip ----------------------------------------------------------------------------------------------------
{
    const python = childProcess.spawnSync('python3', ['-c', 'import zipfile'], { encoding: 'utf8' });
    if (python.status === 0) {
        const script = `
import json, sys, tempfile, zipfile, pathlib
sys.path.insert(0, 'tools')
import package_release as p
td = pathlib.Path(tempfile.mkdtemp())
build = p.read_build()
z = td / 'x.zip'
manifest = p.create_zip(z, build)
p.verify_zip(z, build, manifest)
names = zipfile.ZipFile(z).namelist()
stamps = {i.date_time for i in zipfile.ZipFile(z).infolist()}
tampered = td / 'y.zip'
with zipfile.ZipFile(z) as src, zipfile.ZipFile(tampered, 'w') as dst:
    for info in src.infolist():
        data = src.read(info)
        if info.filename == 'src/js/app.js':
            data = data + b'// changed'
        dst.writestr(info, data)
try:
    p.verify_zip(tampered, build, manifest)
    caught = False
except p.ReleaseError:
    caught = True
print(json.dumps({'names': names, 'stamps': len(stamps), 'caught': caught}))
`;
        const run = childProcess.spawnSync('python3', ['-c', script], { cwd: root, encoding: 'utf8' });
        let result = null;
        try { result = JSON.parse(run.stdout); } catch (_) { result = null; }
        ok(result, `the packager runs (${run.stderr.slice(-300)})`);
        if (result) {
            const files = ['index.html', 'manifest.webmanifest', 'sw.js', 'BUILD_NUMBER', 'assets/icon-192.png', 'assets/icon-512.png', ...modules.map(f => `src/js/${f}`)].sort();
            eq([...result.names].sort(), files, 'the release zip holds exactly the files the app is served from, at its top level, to unzip straight into a folder');
            ok(result.stamps === 1 && result.caught, 'every file carries the build\'s own time, and a zip that differs from the tree is refused');
        }
    } else {
        console.log('↷ python3 not found; the packager check is skipped');
    }
}

// ---- the person's wording preference: no long dashes ---------------------------------------------------------------------
{
    const files = ['index.html', 'sw.js', 'manifest.webmanifest', ...modules.map(f => `src/js/${f}`)];
    const dashes = files.filter(rel => /[–—]/.test(read(rel)));
    eq(dashes, [], 'no long dashes in anything the app shows or says');
}

finish();
