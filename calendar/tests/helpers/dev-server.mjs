// The box's web server in miniature, for the browser tests and for trying the app on a laptop: the
// app's files under /calendar/, the calendar server (a real Radicale) under /dav/ the way the box's
// nginx passes it on (prefix stripped, X-Script-Name set), and /.well-known/caldav sending phones there.
//
//   node tests/helpers/dev-server.mjs [port]      (MYAI_RADICALE_PYTHON=... for Radicale)
//
// Accounts for trying it: alice / alice-secret-1 and bob / bob-secret-22.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startRadicale } from './radicale.mjs';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const TYPES = new Map([
    ['.html', 'text/html; charset=utf-8'], ['.js', 'text/javascript; charset=utf-8'], ['.mjs', 'text/javascript; charset=utf-8'],
    ['.json', 'application/json; charset=utf-8'], ['.webmanifest', 'application/manifest+json'], ['.png', 'image/png'],
    ['.svg', 'image/svg+xml'], ['.ics', 'text/calendar; charset=utf-8'], ['.md', 'text/plain; charset=utf-8']
]);

// Options: radicale (a started one; else one is started), root (the app folder), offline (a ref
// object: { dav: true } makes /dav/ answer as if the box could not be reached, { all: true } the
// whole site), onRequest (spy).
export async function startDevServer({ port = 0, radicale = null, root = appRoot, offline = { dav: false }, onRequest = null } = {}) {
    // A test can change what the app's files say (a newer build number, say) while the server runs.
    let transform = null;
    const dav = radicale || await startRadicale();
    if (!dav) throw new Error('Radicale not found (set MYAI_RADICALE_PYTHON).');
    const davUrl = new URL(dav.base);
    const server = http.createServer((req, res) => {
        if (onRequest) onRequest(req);
        // Everything unreachable, as with the laptop off the network.
        if (offline.all) { req.socket.destroy(); return; }
        const url = new URL(req.url, 'http://localhost');
        if (url.pathname === '/.well-known/caldav' || url.pathname === '/.well-known/carddav') {
            res.writeHead(301, { Location: '/dav/' });
            res.end();
            return;
        }
        if (url.pathname === '/dav' || url.pathname.startsWith('/dav/')) {
            if (offline.dav) { req.socket.destroy(); return; }
            const headers = { ...req.headers, host: davUrl.host, 'x-script-name': '/dav' };
            const upstream = http.request({
                hostname: davUrl.hostname, port: davUrl.port, method: req.method,
                path: (url.pathname.slice('/dav'.length) || '/') + url.search, headers
            }, up => {
                const out = { ...up.headers, 'cache-control': 'no-store' };
                res.writeHead(up.statusCode, out);
                up.pipe(res);
            });
            upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
            req.pipe(upstream);
            return;
        }
        if (url.pathname === '/' || url.pathname === '/calendar') {
            res.writeHead(302, { Location: '/calendar/' });
            res.end();
            return;
        }
        if (!url.pathname.startsWith('/calendar/')) { res.writeHead(404); res.end('not here'); return; }
        let rel = decodeURIComponent(url.pathname.slice('/calendar/'.length)) || 'index.html';
        if (rel.endsWith('/')) rel += 'index.html';
        const file = path.resolve(root, rel);
        if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
            res.writeHead(404); res.end('not found'); return;
        }
        res.writeHead(200, {
            'Content-Type': TYPES.get(path.extname(file)) || 'application/octet-stream',
            'Cache-Control': 'no-cache'
        });
        if (transform) {
            const body = fs.readFileSync(file);
            res.end(transform(rel, body) ?? body);
            return;
        }
        fs.createReadStream(file).pipe(res);
    });
    await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    return {
        base, appUrl: `${base}/calendar/`, radicale: dav, offline,
        setTransform(fn) { transform = fn; },
        async stop() {
            await new Promise(resolve => server.close(resolve));
            server.closeAllConnections && server.closeAllConnections();
            if (!radicale) await dav.stop();
        }
    };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const port = Number(process.argv[2]) || 8090;
    const dev = await startDevServer({ port });
    console.log(`Calendar: ${dev.appUrl}  (alice / alice-secret-1, bob / bob-secret-22)`);
    const stop = async () => { await dev.stop(); process.exit(0); };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
}
