import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const COMMAND_NAMES = ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable'];
const FIXED_LOCATIONS = [
    '/snap/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium'
];

function listDir(dir) {
    try { return fs.readdirSync(dir); } catch (_) { return []; }
}

export function playwrightChromiums(dir) {
    if (!dir || dir === '0') return [];
    const revisions = listDir(dir)
        .filter(name => /^chromium-\d+$/.test(name))
        .sort((a, b) => Number(b.slice('chromium-'.length)) - Number(a.slice('chromium-'.length)));
    const found = [];
    for (const revision of revisions) {
        for (const build of listDir(path.join(dir, revision)).sort()) {
            if (/^chrome-linux/.test(build)) found.push(path.join(dir, revision, build, 'chrome'));
            if (/^chrome-mac/.test(build)) found.push(path.join(dir, revision, build, 'Chromium.app', 'Contents', 'MacOS', 'Chromium'));
        }
    }
    return found;
}

export function chromiumCandidates(env = process.env, home = os.homedir()) {
    const candidates = [];
    if (env.CHROME_BIN) candidates.push(env.CHROME_BIN);
    for (const dir of [env.PLAYWRIGHT_BROWSERS_PATH, home ? path.join(home, '.cache', 'ms-playwright') : '', '/opt/pw-browsers']) {
        candidates.push(...playwrightChromiums(dir));
    }
    for (const dir of String(env.PATH || '').split(path.delimiter).filter(Boolean)) {
        for (const name of COMMAND_NAMES) candidates.push(path.join(dir, name));
    }
    candidates.push(...COMMAND_NAMES.map(name => `/usr/bin/${name}`), ...FIXED_LOCATIONS);
    return [...new Set(candidates)];
}

function isFile(file) {
    try { return fs.statSync(file).isFile(); } catch (_) { return false; }
}

export function findChromium(env = process.env, { home = os.homedir(), exists = isFile } = {}) {
    return chromiumCandidates(env, home).find(candidate => exists(candidate)) || null;
}
