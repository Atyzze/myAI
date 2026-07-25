import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { emitTestResult } from './helpers/test-result.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = [];
function collect(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) collect(full);
        else if (entry.isFile() && /\.(?:m?js)$/.test(entry.name)) files.push(full);
    }
}
collect(path.join(root, 'src'));
collect(path.join(root, 'tests'));
files.push(path.join(root, 'sw.js'));
files.sort();

for (const file of files) {
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (result.status !== 0) {
        process.stderr.write(result.stderr || result.stdout || `Syntax check failed: ${file}\n`);
        process.exit(result.status || 1);
    }
}
console.log(`✓ syntax checked ${files.length} JavaScript files`);
emitTestResult('syntax', 'pass', { files: files.length });
