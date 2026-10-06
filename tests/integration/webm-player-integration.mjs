import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeWebmSeekable, inspectWebmDurationBytes,
    prepareWebmChunkSource, makeWebmDecodeChunk } from '../../src/js/webm-duration.js';
import { emitTestResult, strictTestsRequired } from '../helpers/test-result.mjs';

function available(command) {
    const result = spawnSync(command, ['-version'], { stdio: 'ignore' });
    return !result.error && result.status === 0;
}
function run(command, args, options = {}) {
    const result = spawnSync(command, args, { encoding: 'utf8', ...options });
    if (result.error || result.status !== 0) {
        throw new Error(`${command} failed: ${result.error?.message || result.stderr || result.stdout}`);
    }
    return result.stdout;
}
function ok(value, message) {
    if (!value) throw new Error(`Assertion failed: ${message}`);
}

if (!available('ffmpeg') || !available('ffprobe')) {
    const message = 'ffmpeg/ffprobe unavailable; desktop WebM integration cannot run.';
    if (strictTestsRequired()) throw new Error(message);
    console.log(`↷ ${message}`);
    emitTestResult('webm-desktop', 'skip', { reason: message });
    process.exit(0);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myai-webm-'));
try {
    const sourcePath = path.join(dir, 'live.webm');
    const fixedPath = path.join(dir, 'seekable.webm');
    const chunkPath = path.join(dir, 'decode-window.webm');
    run('ffmpeg', [
        '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3.25',
        '-c:a', 'libopus', '-b:a', '32k', '-f', 'webm', '-live', '1', sourcePath
    ]);

    const source = new Uint8Array(fs.readFileSync(sourcePath));
    const sourceBlob = new Blob([source], { type: 'audio/webm;codecs=opus' });
    const fixedBlob = await makeWebmSeekable(sourceBlob, 3250);
    const fixedBytes = new Uint8Array(await fixedBlob.arrayBuffer());
    fs.writeFileSync(fixedPath, fixedBytes);

    const durationText = run('ffprobe', [
        '-v', 'error', '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1', fixedPath
    ]).trim();
    const duration = Number(durationText);
    ok(Number.isFinite(duration) && Math.abs(duration - 3.25) < 0.01,
        `ffprobe reads the remuxed duration (${durationText})`);

    run('ffmpeg', [
        '-hide_banner', '-loglevel', 'error', '-ss', '2', '-i', fixedPath,
        '-t', '0.5', '-map', '0:a:0', '-f', 'null', '-'
    ]);

    const sourceMd5 = run('ffmpeg', [
        '-hide_banner', '-loglevel', 'error', '-i', sourcePath,
        '-map', '0:a:0', '-f', 'md5', '-'
    ]).trim();
    const fixedMd5 = run('ffmpeg', [
        '-hide_banner', '-loglevel', 'error', '-i', fixedPath,
        '-map', '0:a:0', '-f', 'md5', '-'
    ]).trim();
    ok(sourceMd5 === fixedMd5, 'container remux does not alter decoded Opus audio');

    const meta = inspectWebmDurationBytes(fixedBytes);
    ok(meta.finiteSegment, 'Segment has a finite encoded size');
    ok(meta.cueCount > 0, 'file contains a Cue index');

    const prepared = await prepareWebmChunkSource(sourceBlob, 3250);
    const decodeWindow = await makeWebmDecodeChunk(prepared, 1.0, 2.5);
    fs.writeFileSync(chunkPath, new Uint8Array(await decodeWindow.blob.arrayBuffer()));
    const chunkDuration = Number(run('ffprobe', [
        '-v', 'error', '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1', chunkPath
    ]).trim());
    ok(Number.isFinite(chunkDuration) && chunkDuration > 1.4 && chunkDuration < 3.0,
        `bounded decode window has finite duration (${chunkDuration})`);
    const firstPts = Number(run('ffprobe', [
        '-v', 'error', '-select_streams', 'a:0', '-show_packets',
        '-show_entries', 'packet=pts_time', '-of', 'csv=p=0', chunkPath
    ]).trim().split(/\s+/)[0]);
    ok(Number.isFinite(firstPts) && Math.abs(firstPts) < 0.1,
        `bounded decode window timestamps are rebased near zero (${firstPts})`);
    run('ffmpeg', [
        '-hide_banner', '-loglevel', 'error', '-i', chunkPath,
        '-map', '0:a:0', '-f', 'null', '-'
    ]);
    ok(decodeWindow.requestedDurationSec === 1.5 && decodeWindow.clusterCount > 0,
        'bounded decode window reports exact trim duration and selected Clusters');

    console.log('✓ desktop WebM integration passed (finite duration, seeking, bounded decode windows, unchanged audio)');
    emitTestResult('webm-desktop', 'pass', { assertions: 8, tools: ['ffmpeg', 'ffprobe'] });
} finally {
    fs.rmSync(dir, { recursive: true, force: true });
}
