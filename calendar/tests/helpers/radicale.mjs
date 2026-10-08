// A real Radicale for the tests: its own folder, accounts written by the box's own tool
// (box/myai_calendar.py, so the password hashes the box writes are the ones the server is shown to
// accept), owner-only rights as on the box, on a free port on loopback.
//
// Radicale is found as MYAI_RADICALE_PYTHON (a Python with radicale installed), then `radicale` on
// the PATH, then python3 -m radicale.
import childProcess from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, '../../..');

export function freePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            server.close(() => resolve(port));
        });
        server.on('error', reject);
    });
}

function canRun(command, args) {
    const result = childProcess.spawnSync(command, args, { encoding: 'utf8' });
    return result.status === 0;
}

export function findRadicale(env = process.env) {
    if (env.MYAI_RADICALE_PYTHON && canRun(env.MYAI_RADICALE_PYTHON, ['-c', 'import radicale'])) {
        return { python: env.MYAI_RADICALE_PYTHON };
    }
    const which = childProcess.spawnSync('sh', ['-c', 'command -v radicale'], { encoding: 'utf8' });
    const script = which.status === 0 ? which.stdout.trim() : '';
    if (script) {
        const shebang = (fs.readFileSync(script, 'utf8').split('\n')[0] || '').replace(/^#!\s*/, '').trim();
        const python = shebang.split(/\s+/).pop();
        if (python && canRun(python, ['-c', 'import radicale'])) return { python };
    }
    if (canRun('python3', ['-c', 'import radicale'])) return { python: 'python3' };
    return null;
}

// The box runs Radicale with nix/vobject-keep-values.patch applied to vobject (which otherwise cuts
// Apple's "geo:52.37,4.89" at the comma). The tests run it the same way: the installed vobject is
// copied, the box's patch applied to the copy, and the copy put first on the Python path. The box's
// own build (in the Nix checks) has the patch already, and is used as it is.
function patchedVobjectPath(python, dir) {
    const probe = childProcess.spawnSync(python, ['-c',
        'import os, vobject, vobject.icalendar as i; print(os.path.dirname(vobject.__file__)); print(hasattr(i, "_is_text_value"))'],
        { encoding: 'utf8' });
    if (probe.status !== 0) throw new Error(`vobject not found for ${python}: ${probe.stderr}`);
    const [installed, patched] = probe.stdout.trim().split('\n');
    // A vobject that already carries the patch (the box's own build, in the Nix checks) is used as it is.
    if (patched === 'True') return null;
    const site = path.join(dir, 'patched-site');
    fs.cpSync(installed, path.join(site, 'vobject'), { recursive: true, dereference: true });
    childProcess.spawnSync('chmod', ['-R', 'u+w', site]);
    const patch = childProcess.spawnSync('patch', ['-p1', '--forward', '-d', site, '-i', path.join(repoRoot, 'nix', 'vobject-keep-values.patch')], { encoding: 'utf8' });
    if (patch.status !== 0) {
        throw new Error(`nix/vobject-keep-values.patch no longer applies to this vobject: ${patch.stdout}${patch.stderr}`);
    }
    return site;
}

export async function startRadicale({ users = { alice: 'alice-secret-1', bob: 'bob-secret-22' }, predefined = null, patchVobject = true } = {}) {
    const found = findRadicale();
    if (!found) return null;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myai-radicale-'));
    const storage = path.join(dir, 'collections');
    const usersFile = path.join(dir, 'users');
    const importFile = path.join(dir, 'import.txt');
    fs.writeFileSync(importFile, Object.entries(users).map(([u, p]) => `${u} ${p}`).join('\n') + '\n');
    const tool = childProcess.spawnSync('python3', [path.join(repoRoot, 'box', 'myai_calendar.py'), '--file', usersFile, 'import', importFile], { encoding: 'utf8' });
    if (tool.status !== 0) throw new Error(`myai_calendar.py import failed: ${tool.stderr}`);
    const port = await freePort();
    const config = [
        '[server]', `hosts = 127.0.0.1:${port}`,
        '[auth]', 'type = htpasswd', `htpasswd_filename = ${usersFile}`, 'htpasswd_encryption = autodetect', 'delay = 0',
        '[rights]', 'type = owner_only',
        '[storage]', `filesystem_folder = ${storage}`,
        ...(predefined ? [`predefined_collections = ${JSON.stringify(predefined)}`] : []),
        '[web]', 'type = none',
        '[logging]', 'level = warning', 'mask_passwords = True'
    ].join('\n') + '\n';
    const configFile = path.join(dir, 'config');
    fs.writeFileSync(configFile, config);
    const env = { ...process.env };
    if (patchVobject) {
        const site = patchedVobjectPath(found.python, dir);
        if (site) env.PYTHONPATH = [site, env.PYTHONPATH].filter(Boolean).join(path.delimiter);
    }
    const proc = childProcess.spawn(found.python, ['-m', 'radicale', '--config', configFile], { stdio: ['ignore', 'pipe', 'pipe'], env });
    let log = '';
    proc.stdout.on('data', d => { log += d; });
    proc.stderr.on('data', d => { log += d; });
    const base = `http://127.0.0.1:${port}/`;
    const deadline = Date.now() + 15000;
    for (;;) {
        try {
            const res = await fetch(base, { method: 'OPTIONS' });
            if (res.status < 500) break;
        } catch (_) {}
        if (Date.now() > deadline || proc.exitCode != null) {
            proc.kill('SIGKILL');
            throw new Error(`Radicale did not start: ${log.slice(-800)}`);
        }
        await new Promise(r => setTimeout(r, 100));
    }
    return {
        base, port, dir, storage, usersFile, log: () => log,
        async stop() {
            proc.kill('SIGTERM');
            await new Promise(r => setTimeout(r, 200));
            if (proc.exitCode == null) proc.kill('SIGKILL');
            fs.rmSync(dir, { recursive: true, force: true });
        }
    };
}
