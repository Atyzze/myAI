import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { emitTestResult } from '../helpers/test-result.mjs';
import { blockAt } from '../helpers/source-blocks.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
let assertions = 0;
function ok(value, message) {
    assertions++;
    if (!value) throw new Error(`Assertion failed: ${message}`);
}
function read(rel) {
    const file = path.join(root, rel);
    ok(fs.existsSync(file), `required file ${rel} is present`);
    return fs.readFileSync(file, 'utf8');
}

// The checks below read source text; none of them may depend on how that text is indented, so a
// block is found by its braces (blockAt) and a line break by \n\s*.
const ownSource = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
const BACKSLASH = String.fromCharCode(92);
const indentPins = [BACKSLASH + 'n  ', BACKSLASH + 'n' + BACKSLASH + '}', BACKSLASH.repeat(2) + 'n' + BACKSLASH.repeat(2) + '}'];
ok(indentPins.every(pin => !ownSource.includes(pin)),
   `no check here depends on how the code it reads is indented (${indentPins.filter(pin => ownSource.includes(pin)).join(' ')})`);

const pkg = JSON.parse(read('package.json'));
ok(pkg.scripts?.test === 'node tests/run-baseline.mjs', 'npm test runs the strict baseline');
ok(pkg.scripts?.['test:portable']?.includes('--portable'), 'the portable run is a separate script');

const buildNumber = read('BUILD_NUMBER').trim();
const sw = read('sw.js');
ok(/^\d+$/.test(buildNumber), 'BUILD_NUMBER is an integer');
ok(sw.match(/const VERSION\s*=\s*'(v\d+)'/)?.[1] === `v${buildNumber}`, 'the service worker version mirrors BUILD_NUMBER');
ok(pkg.version === `${buildNumber}.0.0`, 'package.json mirrors BUILD_NUMBER');
ok(fs.existsSync(path.join(root, `docs/build_notes/BUILD${buildNumber}_NOTES.md`)), 'the current build has build notes');
ok(!/'v\d+'/.test(read('src/js/version.js')), 'version.js hardcodes no version');

const index = read('index.html').replace(/<!--[\s\S]*?-->/g, '');
const scriptPolicy = index.match(/script-src\s+([^;]+);/i)?.[1] || '';
ok(scriptPolicy && !scriptPolicy.includes("'unsafe-inline'"), 'the CSP forbids inline script');
ok([...index.matchAll(/<script\b[^>]*>/gi)].every(match => /\ssrc\s*=/.test(match[0])), 'index.html has no inline script');
ok(!/\son[a-z]+\s*=/.test(index), 'index.html has no inline event attributes');

const config = read('src/js/config.js');
const defaultModel = config.match(/'set-ollama-model':\s*'([^']+)'/)?.[1] || '';
ok(defaultModel && read('README.md').includes(`\`${defaultModel}\``),
   `the README names the default AI model the code uses (${defaultModel}), so the two cannot drift apart again`);
const configuredRoutes = ['OLLAMA_URL', 'TRANSCRIBE_URL', 'CAPABILITIES_URL'].map(key => config.match(new RegExp(`${key}:\\s*'([^']+)'`))?.[1]);
const swRoutes = (sw.match(/const API_ROUTES\s*=\s*\[([^\]]*)\]/)?.[1] || '')
    .split(',').map(part => part.trim().replace(/^'|'$/g, '')).filter(Boolean);
ok(JSON.stringify(swRoutes.sort()) === JSON.stringify(configuredRoutes.sort()), 'the service worker excludes exactly the configured API routes');

const shellPaths = [...(sw.match(/const SHELL\s*=\s*\[([\s\S]*?)\];/)?.[1] || '').matchAll(/'([^']+)'/g)].map(match => match[1]);
for (const shellPath of shellPaths) ok(fs.existsSync(path.join(root, shellPath.replace(/^\.\//, ''))), `shell path exists: ${shellPath}`);
// Served for pages of older builds only, and never loaded by this one.
const KEPT_FOR_OLDER_PAGES = ['live-view.js'];
for (const name of fs.readdirSync(path.join(root, 'src/js')).filter(name => name.endsWith('.js'))) {
    if (KEPT_FOR_OLDER_PAGES.includes(name)) continue;
    ok(shellPaths.includes(`./src/js/${name}`), `the offline shell includes ${name}`);
}
for (const name of KEPT_FOR_OLDER_PAGES) {
    const users = fs.readdirSync(path.join(root, 'src/js')).filter(other => other !== name && other.endsWith('.js'))
        .filter(other => read(`src/js/${other}`).includes(name));
    ok(users.length === 0 && !shellPaths.includes(`./src/js/${name}`) && !read('index.html').includes(name),
       `${name} is kept on the server for pages of older builds only: nothing of this build loads it (${users.join(', ')})`);
}

const recorderSource = read('src/js/recorder.js');
const teardown = blockAt(recorderSource, /function cleanupRecordingState\(\)\s*\{/);
ok(teardown.length > 0, 'the recorder has a single recording-teardown function');
ok(/paintRunway\(''/.test(teardown),
   'tearing down a recording blanks the session runway line rather than leaving the last estimate on screen');
ok(/if \(!AppState\.startTime\) \{ paintRunway\(''/.test(recorderSource),
   'and a runway sample that arrives after the recording ended blanks the line too');

const helpPanel = index.match(/<div id="helpPanel"[\s\S]*?<button id="helpClose"/)?.[0] || '';
ok(helpPanel.length > 0, 'the help overlay is present');
ok(!/system z/i.test(helpPanel),
   'the help overlay documents no spoken-instruction syntax, which is still moving');

for (const id of ['paginationTop', 'pageInfoTop', 'prevPageTopBtn', 'nextPageTopBtn',
                  'pagination', 'pageInfo', 'prevPageBtn', 'nextPageBtn']) {
    ok(index.includes(`id="${id}"`), `index.html carries the page control ${id}`);
}

const replySource = read('src/js/reply.js');
const summary = blockAt(replySource, /export async function runSummary\(/);
ok(summary.length > 0, 'the reply path has a single entry point');
ok(/keep_alive/.test(summary),
   'and asks the server to hold the model afterwards, so switching back is not another cold load');
const liveTranslateSource = read('src/js/live-scribe.js');
const liveFunction = name => blockAt(liveTranslateSource, new RegExp(`(?:^|\\n)\\s*(?:export )?(?:async )?function ${name}\\(`));
const translationPath = ['requestTranslations', 'recordTranslationTiming', 'checkModelPlacement', 'setTranslateCause']
    .map(liveFunction);
ok(translationPath.every(body => body.length > 0),
   'the live translation path is found where the next checks expect it');
ok(translationPath.every(body => !/echoCommand\(/.test(body)),
   'live translation never writes a line of its own into the transcript: how fast it is, and why, belongs in the box heading');
const translateRequest = liveFunction('requestTranslations');
const translateFailure = blockAt(translateRequest, /\.catch\(err => \{/);
ok(translateFailure.length > 0, 'live translation has one place that handles a failed batch');
ok(translateFailure.indexOf("err.name === 'AbortError'") > -1
   && translateFailure.indexOf('planTranslationFailure(') > translateFailure.indexOf("err.name === 'AbortError'")
   && /state\.batchSize\[target\] = failure\.batchSize/.test(translateFailure)
   && /recordTranslationTiming\(/.test(translateFailure),
   'a batch that runs out of time is a failure: it is retried smaller, after a pause, and counted as slow, never ignored like a cancel');
ok(/if \(epoch !== state\.epoch\) return;/.test(translateFailure)
   && /\.finally\(\(\) => \{\n\s*if \(epoch !== state\.epoch\) return;/.test(translateRequest),
   'a translation from a paused session cannot change the state of the session that replaced it');
const onlineHandler = liveFunction('handleOnline');
ok(/state\.translateFailures = 0;/.test(onlineHandler) && /state\.translateNextAt = 0;/.test(onlineHandler)
   && /paintText\(\);/.test(onlineHandler),
   'when the connection comes back, translation boxes try again at once instead of sitting out their backoff');
const snapshotUsers = ['liveScribeResult', 'liveScribeTranscriptText'].map(liveFunction);
ok(snapshotUsers.every(body => /labelledSnapshot\(\)/.test(body)),
   'the copied transcript and the saved transcript are built from the same snapshot');
ok(/transcriptSnapshot\(state\)/.test(liveFunction('labelledSnapshot')),
   'and that snapshot includes the lines that scrolled out of view and leaves out notices');
ok((liveTranslateSource.match(/archiveDroppedLines\(state\.archivedLines, [\w.]+, state\.translations,\s*translatedLanguages\(\)\)/g) || []).length === 2
   && /function translatedLanguages\(\) \{\n\s*return Object\.keys\(state\.languages \|\| \{\}\);\n\s*\}/.test(liveTranslateSource),
   'a line that scrolls out of view keeps its translation into every language heard, before those translations are let go');
ok(/Object\.assign\(state, freshSession\(settingsPolicy\(\)\), carried,/.test(liveFunction('startLiveScribe'))
   && /carryAcrossResume\(state\)/.test(liveFunction('startLiveScribe')),
   'a live session starts from one fresh state, and a resume carries only the listed per-line state across');
const lineKeys = liveTranslateSource.match(/key: `(?:w|b|cmd-)\$\{[^}]+\}/g) || [];
ok(lineKeys.length >= 5 && lineKeys.every(key => /\$\{(?:state\.)?epoch\}/.test(key)),
   'every line key names the session it came from, so a resumed session never reuses a key');
ok(/warmAiModel\(/.test(liveFunction('startLiveScribe')),
   'live transcription with translation boxes loads the AI model as it starts, so the first translated line does not wait for it');
ok(/forgetModelChoices/.test(read('src/js/settings.js')),
   'changing the model in Settings drops the cached model choices rather than leaving a stale one in place');

const indexStamp = index.match(/<meta name="myai-build" content="(\d+)">/)?.[1];
ok(indexStamp === buildNumber,
   'the document carries the build it was released as, so a page can never be wrong about what it is running');
ok(/myai-build/.test(read('tools/package_release.py')),
   'and the release tool keeps that stamp synchronized with BUILD_NUMBER');
ok(/myai-build/.test(read('src/js/version.js')),
   'the version label reads the document stamp rather than inferring the build from whichever worker answers');

ok(/cache: 'reload'/.test(read('src/js/version.js')),
   'the update check re-fetches the worker script past the HTTP cache, so a stale cached copy cannot hide a new build');
ok(/unregister/.test(read('src/js/version.js')),
   'and a worker the browser refuses to replace can be cleared outright');
ok(!/indexedDB|deleteDatabase/.test(read('src/js/version.js')),
   'clearing the installed shell never reaches for the recordings');
const packager = read('tools/package_release.py');
ok(/def release_mtime\([^)]*\)[^:]*:\s*\n\s*return [^\n]*\bbuild\b/.test(packager),
   'every build carries its own modification time, derived from the build number, so a conditional request cannot answer 304 across two builds');
ok(!/\.mtime = 0\b/.test(packager),
   'and nothing is pinned to the epoch, which is what made two builds indistinguishable to a caching server');
ok(/tempfile\.TemporaryDirectory\(prefix=f"\.myai-build-\{target\}-", dir=output_dir\)/.test(packager),
   'a release is staged inside the output folder, so moving it into place cannot fail for being on another disk');
ok(/checksum_staged = write_checksum\(zst_path, final\.name\)\n\s*publish\(\[\(zst_path, final\), \(checksum_staged, checksum\)\]\)/.test(packager)
   && /except BaseException:\n\s*for target in done:\n\s*target\.unlink\(missing_ok=True\)/.test(packager),
   'the archive and its checksum are published together, and a failed move takes back what it moved, so a half-published build cannot block the next release');
ok(/except KeyboardInterrupt:\n\s*print\("\\nrelease interrupted; nothing was published"/.test(packager),
   'stopping a release with Ctrl-C says the tree was restored instead of printing a traceback');
ok(/timing = describe_gate_time\(report\)/.test(packager) && /slowest \{slowest\['id'\]\}/.test(packager),
   'the gate line in the build notes says how long the gate took and which suite was slowest');

ok(!/'v\d+'/.test(read('src/js/update-core.js')),
   'the update rules hardcode no version either, so the worker stays the only source of build identity');
const versionBadge = index.match(/<button id="app-version"[^>]*>/)?.[0] || '';
ok(versionBadge.length > 0,
   'the version under the help button is a button, so it can be tapped to check for a newer build');
ok(/data-action="appUpdate"/.test(versionBadge),
   'and it reaches the delegated action router rather than an inline handler');
ok(/case 'appUpdate'/.test(read('src/js/gui.js')), 'which routes it to the update action');
ok(/id="help-version-state"/.test(index) && /id="help-update-btn"/.test(index),
   'the guide overlay carries the same build state and the same control in words');
ok(/checkForUpdate/.test(read('src/js/help.js')),
   'opening the guide checks for a newer build, so the state shown there is current');

const scribe = read('src/js/live-scribe.js');
const dropBuffer = blockAt(scribe, /function dropFromBuffer\(/);
ok(dropBuffer.length > 0, 'the live transcriber has a single place where it discards buffered audio');
ok(/state\.consumedSec \+=/.test(dropBuffer),
   'discarded audio still advances the position in the recording, so the span is reported as a gap rather than as covered');
const enqueue = blockAt(scribe, /async function enqueueWindow\(/);
ok(/\} catch \(err\) \{\n\s*abandonWindowIndex\(index, recId, epoch\);\n\s*throw err;\n\s*\}/.test(enqueue),
   'a window that cannot be prepared still claims its sequence number, instead of stranding every window after it');
const abandon = blockAt(scribe, /function abandonWindowIndex\(/);
ok(abandon.length > 0 && !/coverage/.test(abandon),
   'and claims it without coverage, so the audio is transcribed after the recording');

const settingsSource = read('src/js/settings.js');
ok(!/set-translate-model/.test(index + settingsSource + replySource),
   'settings expose one AI model choice rather than a separate translation model');
const translateFn = blockAt(replySource, /export async function translateLines\(/);
ok(/const model = await resolveReplyModel\(base\);/.test(translateFn),
   'translation resolves the same selected AI model as replies');
ok(!/^\s*await offerBackupFirst\(\);/m.test(settingsSource),
   'no destructive action runs the backup offer without reading its answer');
const deleteAllTextFn = blockAt(settingsSource, /async function deleteAllText\(/);
ok(deleteAllTextFn.length > 0, 'there is a single delete-all-text entry point');
ok(/hasLiveTranscript/.test(settingsSource),
   'and a row that holds only that text is not treated as an empty row');
ok(/liveTranscript: liveById\.get\(rec\.id\) \|\| null/.test(settingsSource)
   && !/liveById\.get\(rec\.id\) \|\| rec\.liveTranscript/.test(settingsSource),
   'and backup reads it only from the current live-transcript store, with no inline-row fallback');

const liveScribeSource = read('src/js/live-scribe.js');
ok(/if \(epoch === state\.epoch\) \{\n\s+state\.inFlight--;/.test(liveScribeSource),
   'the in-flight count is only ever adjusted by the session that owns it, so a request left over '
   + 'from a stopped session cannot drive it negative and let the next one over-send');
ok(/const epoch = state\.epoch;/.test(liveScribeSource) && /state\.epoch\+\+;/.test(liveScribeSource),
   'every live transcription session is stamped, and stopping one ends that stamp');

const transcribeSource = read('src/js/transcribe.js');
ok(/if \(err && err\.name === 'AbortError'\) throw err;/.test(transcribeSource),
   'a cancelled transcription is never mistaken for a server failure worth retrying');
ok(/silent:\s+!trimmedText && coreSegments\.length === 0 && isNearSilent\(level\)/.test(transcribeSource),
   'a section is called silent only when the audio measured silent and no words came back');
ok(/const hardFailures = state\.failCount - state\.silentCount;/.test(transcribeSource),
   'a recording that was simply quiet throughout is a transcript that says so, not a failed job');
ok(!/\u26a0\ufe0f transcription unavailable/.test(read('src/js/transcribe-core.js')),
   'a gap in the transcript is stated plainly instead of being flagged with a warning icon');

const clipboardHost = read('src/js/main.js');
ok(/buildClipboardContextItem/.test(clipboardHost),
   'the clipboard button turns a paste into a context item rather than inventing its own store');
ok(/AppState\.pendingContext = \[item\];/.test(clipboardHost),
   'and hands it to the recording through the same pending-context path as Continue and Link');
ok(!/STORE_|dbExec|createObjectStore/.test(read('src/js/clipboard-core.js')),
   'clipboard handling stays pure, with no storage path of its own');

const dbSource = read('src/js/db.js');
ok(/openDB\(CONFIG\.DB_NAME, CONFIG\.DB_VERSION,/.test(dbSource),
   'the database version is declared in config rather than buried in the open call');
ok(/DB_VERSION:\s+13/.test(read('src/js/config.js')),
   'the local database schema is version 13, which added the small capture-beat store without touching stored notes');
ok(!/deleteObjectStore/.test(dbSource + read('src/js/db-lifecycle-core.js')),
   'no upgrade deletes a store, so installing a new version can never take stored notes with it');
ok(/applySchema\(db, upgradeTx, schemaLayout\(CONFIG\)\)/.test(dbSource),
   'a schema change adds what is missing through one shared, tested layout');
ok(!/moveAudioOutOfRow|audio-moved-out-of-rows|recordingIds\(\)/.test(dbSource + read('src/js/main.js')),
   'the Build 108 audio migration and its completion flag are gone');
ok(/name: config\.STORE_AUDIO/.test(read('src/js/db-lifecycle-core.js')),
   'the audio store is part of that layout, created for browsers that do not have it yet');
ok(/name: config\.STORE_LIVE/.test(read('src/js/db-lifecycle-core.js')),
   'as is the live transcript store');
ok(!/rec\.liveTranscript/.test(dbSource),
   'and a transcript is read only from the store that owns it, with no fallback into the recording row');
const heartbeat = blockAt(read('src/js/recorder.js'), /async function persistOwnedHeartbeat\(/);
ok(heartbeat.length > 0, 'there is a single recording heartbeat');
ok(!/rec\.liveTranscript = /.test(heartbeat),
   'the three-second heartbeat never carries the live transcript through the recording row, which grows all session');
ok(/writeLiveTranscript\(recId, liveTranscript\)[\s\S]*dbUpdate\(CONFIG\.STORE_REC/.test(heartbeat),
   'and the transcript is stored before its lightweight row metadata is updated');
ok(/deleteLiveTranscript/.test(settingsSource),
   'every path that deletes a recording deletes its live transcript with it');
ok(/cleanupOrphanLiveTranscripts/.test(read('src/js/main.js')),
   'and anything left behind is swept on start');
ok(/storeLiveTranscript/.test(blockAt(read('src/js/recorder.js'), /export async function recoverIncompleteRecordings/)),
   'a recording recovered after a crash keeps the transcript it captured live, rather than hiding it in a field nothing reads');

const mainSource = read('src/js/main.js');
const toggle = blockAt(mainSource, /const toggleFullscreen = \(\) => \{/);
ok(toggle.length > 0, 'there is a single fullscreen toggle');
ok(/showingFs \|\| browserFs\(\)/.test(toggle),
   'the fullscreen toggle asks what the page is actually showing, not only what the browser granted, so a request the browser ignored can still be undone');
ok(/if \(!on\) document\.dispatchEvent\(new CustomEvent\(WAVEFORM_HIDDEN_EVENT\)\);/.test(read('src/js/recorder.js'))
   && /document\.addEventListener\(WAVEFORM_HIDDEN_EVENT, \(\) => \{\n\s*if \(showingFs \|\| browserFs\(\)\) leaveFullscreen\(\);/.test(mainSource),
   'when the waveform is hidden (the recording stops, capture fails or the waveform is turned off) its fullscreen view is left too, so the page is not left locked with its controls hidden');

const persist = blockAt(settingsSource, /function persistControl\(/);
ok(/tagName === 'SELECT'/.test(persist),
   'only a dropdown refuses to store an empty value; a text box the guide says can be emptied really can be');

ok(/final: !!part\.final/.test(read('src/js/live-tabs.js')),
   'a transcript replayed into the viewer is marked as already finished');
ok(/chunk\.final \|\| !tail/.test(read('src/js/live-render.js')),
   'and a finished transcript is rendered word for word, without the overlap trimming that belongs to live windows');

const guiSource = read('src/js/gui.js');
ok(/hasJob\('t', rec\.id\)/.test(guiSource) && /hasJob\('r', rec\.id\)/.test(guiSource),
   'a rebuilt row asks whether a job is running rather than trusting the DOM it just replaced');
ok(/for \(const rec of page\) restoreRunningJobStatus\(rec\);/.test(guiSource),
   'and the progress bar with its cancel control is restored with the row');

ok(/track\.addEventListener\('mute'/.test(recorderSource) && /track\.addEventListener\('unmute'/.test(recorderSource),
   'a microphone that goes quiet without ending the track is noticed, which is how another app taking the microphone presents');
ok(/AppState\.samplesSeen = \(AppState\.samplesSeen \|\| 0\) \+ audio\.length;/.test(recorderSource),
   'every sample the graph delivers is counted, so the recording can be checked against what really arrived rather than against the clock');
ok(/checkCaptureHealth\(Date\.now\(\)\);/.test(recorderSource),
   'and that count is checked on every tick while recording');
const stallHandler = blockAt(recorderSource, /function checkCaptureHealth\(/);
ok(stallHandler.length > 0, 'there is a single capture-health check');
ok(/markAudioIncomplete/.test(stallHandler),
   'a gap in the audio marks the file incomplete rather than letting it pass as whole');
ok(!/stopRecording|handleCaptureFailure/.test(stallHandler),
   'and never stops the recording, because a false alarm must not be able to end one');
ok(/AppState\.uncommittedFragments\.set\(key, fragment\);\n\s*if \(AppState\.fragmentWriteFailed\) return false;/.test(recorderSource)
   && /the pieces after it stay in memory so the stored audio has no hole:', err\);\n\s*break;/.test(recorderSource),
   'after one piece of audio cannot be stored, later pieces wait in memory, so the stored audio never has a hole in the middle');
ok(/if \(Number\(rec\.audioBytes\) > 0 \|\| rec\.captureState !== 'finalize-error'\) continue;/.test(settingsSource),
   'a recording whose save failed is in the backup with the audio saved so far');
const finalizeOpusSource = blockAt(recorderSource, /async function finalizeOpus\(/);
ok(/fileMs = await webmAudioEndMs\(rawMaster\);/.test(finalizeOpusSource)
   && /const effectiveDuration = opusLengthMs\(\{\s*fileMs,/.test(finalizeOpusSource)
   && /return honestDuration\(wallMs, capturedMs\);/.test(read('src/js/capture-health-core.js')),
   'a finished Opus file is as long as the audio it holds, read from its last block; when that cannot be read it still never claims more audio than arrived');

ok(/capBackfillLines\(\);/.test(scribe) && /BACKFILL_MAX_CHARS/.test(scribe),
   'the backfilled prefix is bounded, so a long session cannot make every repaint cost more than the last');
ok(/\[\.\.\.state\.backfillLines, \.\.\.state\.lines\]\.map\(line => line\.key\)/.test(scribe),
   'and backfilled lines count as live when translations are pruned, instead of losing theirs');

const fillSource = blockAt(read('src/js/transcribe.js'), /export async function fillTranslations\(/);
ok(fillSource.length > 0, 'completing the translations of a saved transcript has one entry point');
ok(/fillMissingTranslations\(/.test(fillSource) && !/translateLines\([^)]*buildFinalPrompt/.test(fillSource),
   'completing the translations of a saved transcript goes through the loop that gives up on a server that will not answer');
ok(/beginJob\('f', recId\)/.test(fillSource),
   'and it is a job, so deleting the recording stops it instead of sending a deleted recording\'s text on');

const idbSource = read('src/js/idb-min.js');
ok(/canClose\(\) !== false/.test(idbSource),
   'a connection asks before closing itself for an upgrade, so a tab holding a recording is not closed under it');
const versionChange = blockAt(idbSource, /idb\.onversionchange = \(\) => \{/);
ok(versionChange.length > 0, 'there is a single place a connection gives itself up');
ok(versionChange.indexOf('canClose') < versionChange.indexOf('idb.close()'),
   'and it asks before it closes, not after');
ok(/onBlocked/.test(idbSource),
   'a blocked upgrade is reported to the application rather than only to the console');

ok(!/const dbPromise = openDB/.test(dbSource) && /function database\(\)/.test(dbSource),
   'nothing holds a single connection for the life of the tab');
const workingHere = read('src/js/main.js').match(/const workingHere = \(\) => [\s\S]*?;\n/)?.[0] || '';
ok(/recordingHere\(\)/.test(workingHere) && /AppState\.busy/.test(workingHere) && /holdsRecordingLock\(\)/.test(workingHere),
   'the recorder is what answers that question, and a recording still being saved counts as busy');
ok(/followUpsRunning\(\)/.test(workingHere),
   'so does the automatic work a stopped recording starts, so the tab cannot hand the database over underneath it');
ok(/hasAnyJob\(\)/.test(workingHere) && /isConverting\(\)/.test(workingHere),
   'and so does a transcription, reply or conversion that is still running');
ok(/setDatabaseBusyCheck\(workingHere, recordingHere\);/.test(read('src/js/main.js')),
   'with recording told apart from other work, so the notice names the right reason');
ok(/trackFollowUp\(runAfterRecording\(currentId\)\);/.test(recorderSource)
   && /return runInOrderUntilCancelled\(\[\(\) => runAutoPipeline\(recId\), \(\) => runSecondPass\(recId\)\]/.test(recorderSource)
   && /trackFollowUp\(completeTranscriptColumns\(currentId\)/.test(recorderSource),
   'every piece of work a stopped recording starts is counted while it runs'); 
ok(/if \(info && info\.holding && typeof info\.release === 'function'\) _releaseWhenIdle = info\.release;/.test(dbSource),
   'a connection kept for a recording remembers that a newer version is waiting for it');
ok(/export function noteDatabaseIdle\(\) \{\n\s*if \(!_releaseWhenIdle\) return false;\n\s*if \(_busy\(\) === true\) \{ refreshGuard\(\); return false; \}[\s\S]*?release\(\);/.test(dbSource),
   'and gives the connection up once the tab is no longer busy, keeping its notice current while it waits');
ok(/setInterval\(noteDatabaseIdle, 1000\);/.test(read('src/js/main.js')),
   'which is checked continuously, so stopping the recording really is enough for the waiting version to start');
const guardListener = blockAt(read('src/js/main.js'), /setDatabaseGuardListener\(\(state, \{ recording, busy \}\) => \{/);
ok(/node\.dataset\.owner = 'guard';/.test(guardListener),
   'an upgrade notice claims the alert line, so the startup note cannot paint over it and a stale tab is never left blank');
ok(/id="storage-alert"/.test(index),
   'and a tab waiting on, or left behind by, an upgrade says so on screen');

const opusData = blockAt(recorderSource, /mr\.ondataavailable = \(ev\) => \{/);
ok(opusData.length > 0, 'compressed recording has one place where a block of audio arrives');
ok(/AppState\.captureProgress/.test(opusData),
   'and that arrival counts as capture progress, because in this mode it is the only evidence the '
   + 'recorder ever gets that sound is still being captured');
const healthCheck = blockAt(recorderSource, /function checkCaptureHealth\(/);
ok(/captureStallMs\(CONFIG\.IO_FLUSH_SEC \* 1000\)/.test(healthCheck),
   'and is judged on how often blocks actually arrive, not on a window shorter than the gap between them');
ok(/progress: AppState\.captureProgress/.test(healthCheck),
   'and the watchdog reads the counter both capture paths feed, not one that only the tap can move');
const buildItem = blockAt(guiSource, /function buildRecordingItem\(rec\) \{/);
ok(buildItem.length > 0, 'there is one place that builds a row in the list');
ok(!/rec\.blob/.test(guiSource) && !/createObjectURL\(rec\./.test(guiSource),
   'building the list never touches a recording audio, which is what made a page of long notes unrenderable');
ok(/data-rec-audio=/.test(buildItem) && /preload="none"/.test(buildItem),
   'a player is rendered empty and names the recording it would load, rather than holding the audio up front');
ok(/async function attachAudioSource/.test(guiSource) && /await readAudio\(recId\)/.test(guiSource),
   'and the audio is fetched only when somebody actually presses play');
const attachFn = blockAt(guiSource, /async function attachAudioSource\(/);
ok(/detachAudioSource\(\)/.test(attachFn) && /revokeAllObjectUrls\(\)/.test(attachFn),
   'with the previous one released first, so at most one recording is ever held in memory');
ok(!/writeAudio\(/.test(recorderSource + guiSource),
   'no finished, converted or remuxed recording writes its audio apart from the row that owns it');
const commitFn = blockAt(dbSource, /export async function commitAudio\(/);
ok(commitFn.length > 0 && /transactionOver\(\[CONFIG\.STORE_REC, CONFIG\.STORE_AUDIO\], 'readwrite'\)/.test(commitFn),
   'audio and the row that owns it are written in one transaction');
const convertFn = blockAt(guiSource, /window\.convertRecFormat = async function/);
ok(/await commitAudio\(key, storedBlob, \(r\) => \{\n\s+if \(!conversionStillApplies\(r, rec\)\) return null;/.test(convertFn),
   'a conversion that finishes after its recording was deleted writes nothing, instead of leaving audio nobody can see');
ok(/cleanupOrphanAudio\(\)/.test(read('src/js/main.js')),
   'and audio left behind by an older build is swept on start');
ok(!/\.blob\b/.test(read('src/js/retention-core.js')),
   'retention decides from recorded sizes rather than by loading audio it is about to delete');
ok(/total \+= Number\(cursor\.value && cursor\.value\.bytes\)/.test(dbSource),
   'and the storage total is counted from recorded sizes too, rather than by opening every recording at startup');
ok(/'set-recording-format': 'opus'/.test(config),
   'compressed audio is what a new install records, with uncompressed left as the fallback it always was');
const follow = blockAt(mainSource, /function followDeviceOrientation\(/);
ok(follow.length > 0, 'there is one place that decides whether the screen may turn with the phone');
ok(/unlock\(\)/.test(follow) && /lock\('portrait'\)/.test(follow),
   'which both releases the orientation and puts it back, rather than only one of the two');
const enterFs = blockAt(mainSource, /const enterFsUI = \(\) => \{/);
const exitFs = blockAt(mainSource, /const exitFsUI = \(\) => \{/);
ok(/followDeviceOrientation\(true\)/.test(enterFs),
   'the maximised waveform turns with the phone, which is the one view where that helps');
ok(/followDeviceOrientation\(false\)/.test(exitFs),
   'and leaving it puts the ordinary interface back to portrait, which never turns');
ok(!/followDeviceOrientation\(true\)/.test(exitFs),
   'so rotation cannot be left switched on after the waveform is closed');

const bootBlock = blockAt(mainSource, /window\.onload = async \(\) => \{/);
const bootSource = bootBlock.slice(0, Math.max(0, bootBlock.indexOf('(async () => {')));
ok(/renderList\(\)\.catch\(/.test(bootSource),
   'the first list paint reports its own failure instead of leaving an empty page and no explanation');
ok(/Promise\.race/.test(bootSource) && /FIRST_PAINT_BUDGET_MS/.test(bootSource),
   'and gets a clear run at the database before startup maintenance, without being able to block it forever');
ok(/paintStartupNote\('Checking for interrupted recordings/.test(mainSource),
   'while work that delays the list says on screen that it is happening and that nothing is lost');

const transcribe = read('src/js/transcribe.js');
ok(!/reviewTranscriptEchoes/.test(transcribe),
   'there is no third pass re-listening to passages the live refiner and the pre-save replay already policed');
ok(/findTimedRepetitionCandidates/.test(transcribe) && /suspectLive/.test(transcribe),
   'a suspect live passage is dropped and re-derived from audio as part of the gap fill, which costs no extra request');

const inferBlock = blockAt(scribe, /function inferSpeakerNames\(/);
ok(inferBlock.length > 0, 'the live transcriber has a single place where it acts on what it inferred');
ok(!/applySpeakerCommand/.test(inferBlock),
   'a name or merge worked out from the conversation is never applied there; inference only proposes');
ok(/nextProposals/.test(inferBlock),
   'it records the suggestion instead, so the speaker keeps their number until somebody confirms');
const confirmBlock = blockAt(scribe, /function confirmSpeaker\(/);
ok(/applySpeakerCommand/.test(confirmBlock) && /takeProposal/.test(confirmBlock),
   'and confirming is the only path that applies one, and only a suggestion that was standing');
ok(/origin: 'confirmed'/.test(confirmBlock),
   'a confirmed name is marked as confirmed, so it is locked rather than left open to being re-guessed');
ok(!/system-z-core/.test(scribe) && !fs.existsSync(path.join(root, 'src/js/system-z-core.js')),
   'the numeric spoken-command system is gone, not merely unreferenced');

ok(/data-lang="\$\{escapeAttr\(target\)\}"/.test(scribe),
   'a language code placed inside an attribute is escaped for attribute position, not merely for text');
ok(!/="\$\{escapeHtml\(/.test(scribe),
   'and no attribute in the live transcriber is built with the text-only escaper, which leaves quotes intact');

const manifest = JSON.parse(read('manifest.webmanifest'));
for (const icon of manifest.icons || []) ok(fs.existsSync(path.join(root, icon.src)), `manifest icon exists: ${icon.src}`);

const continueFn = blockAt(guiSource, /window\.continueConv = async \(recId\) => \{/);
ok(/^window\.continueConv = async \(recId\) => \{\n\s*if \(AppState\.recId != null \|\| AppState\.busy\) \{/.test(continueFn),
   'Continue during a recording does nothing silently, so its context cannot ride along with a later, unrelated recording');
ok(!/myai:system-stop/.test(read('src/js/main.js')),
   'no listener is left for the spoken stop command removed in Build 106');

const startFn = blockAt(recorderSource, /export async function startRecording\([^)]*\) \{/);
ok(/\} catch \(err\) \{[\s\S]*?AppState\.pendingContext = null;/.test(startFn) && !/AppState\.pendingContext = contextForRecording/.test(startFn),
   'a recording that fails to start drops the context it was given, so nothing invisible rides along with the next one');
ok(/hint: hint != null \? hint : '',/.test(scribe),
   'a system line carries a hint only when one is given, so a capture or space warning never tells you to confirm a speaker');
const jumpFn = blockAt(guiSource, /window\.showRecordingById = async function/);
ok(/recordingPosition\(/.test(jumpFn) && !/getAllFromIndex/.test(jumpFn),
   'jumping to a recording counts the newer ones instead of reading every recording');
const mainNow = read('src/js/main.js');
ok(!/setInterval\(paint(LiveScribe|PasteRecord)Button/.test(mainNow)
   && /onRecordingStateChange\(\(\) => \{ paintLiveScribeButton\(\); paintPasteRecordButton\(\); \}\);/.test(mainNow),
   'the buttons beside Start Recording are repainted when recording state changes, not polled twice a second');
const cleanupFn = blockAt(recorderSource, /function cleanupRecordingState\(\) \{/);
ok(/announceRecordingState\(\);\n\s*\}$/.test(cleanupFn),
   'and a recording ending announces itself, so those buttons never lag behind');
const contextFn = blockAt(guiSource, /function buildContextItemHtml\(/);
ok((contextFn.match(/class="context-preview" role="button" tabindex="0" data-action="viewContextPart"/g) || []).length === 2,
   'tapping the text of a context item opens it in full, for input and output alike');
ok(!/👁/.test(contextFn) && (contextFn.match(/data-action="copyContextPart"/g) || []).length === 2,
   'and the button beside it copies the whole text, for input and output alike, instead of a second way to view it');
ok(/case 'copyContextPart': return window\.copyContextPart\(/.test(guiSource),
   'the copy button is wired');

const paintLive = blockAt(mainNow, /function paintLiveScribeButton\(\) \{/);
ok(/liveScribeBtn\.hidden = false;/.test(paintLive),
   '📝 stays beside Start Recording when nothing is recording, mirroring 📋 on the other side');
ok(/if \(AppState\.recId == null\) \{\n\s*if \(!AppState\.busy\) beginRecordingSession\(\{ live: true \}\);\n\s*return;\n\s*\}/.test(mainNow),
   'and tapping it then starts a recording with live transcription on');
ok(/AppState\.liveScribe = live === true \|\| liveTranscriptionByDefault\(\);/.test(recorderSource),
   'every recording decides afresh whether live transcription runs, so a plain start never inherits the previous recording');
ok(!/<button id="liveScribeBtn" hidden/.test(index),
   'the page is served with 📝 visible from the start');

const pastePaint = blockAt(mainNow, /function paintPasteRecordButton\(\) \{/);
ok(/pasteRecordBtn\.hidden = false;/.test(pastePaint),
   '📋 stays beside Start Recording during a recording, so something found halfway through can still be added');
const pasteClick = blockAt(mainNow, /pasteRecordBtn\.onclick = async \(\) => \{/);
ok(/if \(recordingId != null\) \{\n\s+const count = await addContextToRecording\(recordingId, item\);/.test(pasteClick),
   'and tapping it then adds the clipboard to the recording that is running instead of starting another');
ok(/rec\.contextChain = chain;/.test(blockAt(read('src/js/recorder.js'), /export async function addContextToRecording/)),
   'as one more ordinary context item on that recording, where the AI reply reads it');

const liveGui = blockAt(recorderSource, /function updateLiveGUI\(\) \{/);
ok(/recordBtn\.textContent = 'Stop Recording';/.test(liveGui) && !/Stop Recording \(/.test(liveGui),
   'the big button says Stop Recording without a timer, so its width does not change as the recording runs');
ok(/rowClock\.textContent = fmtDur\(elapsed\)/.test(liveGui),
   'the running time is shown in the live row instead');
ok(/filename: getLocalIso\(now\),/.test(recorderSource) && !/ - Recording\.\.\./.test(recorderSource),
   'a recording in progress is titled by its date and time alone');
ok(/#record-controls\{display:flex;flex-wrap:nowrap;/.test(index) && !/#record-controls\{[^}]*flex-wrap:wrap/.test(index),
   'the buttons beside Start Recording never wrap onto a second line');

ok(/\.live-scribe-info\{flex:1 1 0;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis/.test(index)
   && /<span class="live-scribe-info"><span id="live-scribe-speakers"><\/span><span id="live-scribe-languages"><\/span>/.test(index),
   'the speaker and language details in the live header share one line that shortens itself, instead of pushing the buttons off screen');
ok(/\.live-scribe-copy\{flex-shrink:0;/.test(index) && /\.live-scribe-close\{flex-shrink:0;/.test(index),
   'and 📋 and ✕ keep their size');
ok(/\.live-scribe-status\{flex:1 0 100%;/.test(index) && /\.live-scribe-status:empty\{display:none\}/.test(index),
   'the connection status gets a line of its own when there is something to say');

ok(/const modelBefore = getSetting\('set-ollama-model'\);\n\s*persistEditedHere\(\);/.test(settingsSource)
   && /const flush = \(\) => \{\n\s*if \(!settingsOpen\(\)\) return;\n\s*persistEditedHere\(\);/.test(settingsSource)
   && /el\.addEventListener\('input', \(\) => \{ if \(!RETENTION_KEYS\.includes\(k\)\) _editedHere\.add\(k\); \}\);/.test(settingsSource),
   'closing Settings writes only what was edited in this tab, never values another tab changed while it was open');
ok(/if \(!RETENTION_KEYS\.includes\(key\)\) persistControl\(key\);/.test(settingsSource)
   && /el\.disabled = true;\n\s*try \{\n\s*await checkRetentionChange\(key, el\);/.test(settingsSource)
   && /writeStored\(key, next\);\n\s*writeStored\(RETENTION_ACK_KEY/.test(settingsSource)
   && !/persistControl/.test((blockAt(settingsSource, /async function checkRetentionChange\(/) || 'persistControl')),
   'a retention setting is only ever saved as the value that was confirmed, and cannot change while it is being checked');
ok(/const kept = transcriptsAfterCleanup\(rec\.transcripts, rec\.summaries\);/.test(recorderSource)
   && /if \(mode !== 'replace' \|\| hasJob\('r', recId\)\) return;/.test(recorderSource)
   && (read('src/js/transcribe.js').match(/'S',\s*\{ fromLive: (?:true|liveResults\.length > 0) \}\)/g) || []).length === 2,
   'the cleanup pass that keeps only its own reading removes the live reading and its automatic copy, but not one a reply was written from or is being written from');
ok(/setUpdateBusyCheck\(\(\) => workingHere\(\) \|\| backupRunning\(\)\);/.test(mainSource),
   'an update never reloads the page while this tab is recording, saving, transcribing, replying or making a backup');
const chunkedSource = blockAt(read('src/js/transcribe.js'), /export async function transcribeChunked\(/);
ok(/const replay = settleLiveReplays\(reviews, results, missingRanges\);/.test(chunkedSource)
   && /liveResults = \[\.\.\.liveResults, \.\.\.replay\.restore\];/.test(chunkedSource)
   && /const merged = \[\.\.\.replay\.results, \.\.\.liveResults\];/.test(chunkedSource)
   && chunkedSource.indexOf('settleLiveReplays(') < chunkedSource.indexOf('successCount === 0'),
   'live lines set aside for a replay come back when the replay fails or hears nothing, before deciding whether anything was transcribed');
const stopSource = blockAt(recorderSource, /async function stopRecordingNow\(\) \{/);
const tapDetachAt = stopSource.indexOf('AppState.workletNode.disconnect();');
ok(tapDetachAt > 0 && tapDetachAt < stopSource.indexOf('await flushLiveScribe()')
   && /\n\s*if \(AppState\.workletNode\) await flushWorkletTail\(\);\n/.test(stopSource),
   'at Stop the audio tap hands over its last samples and is detached before the live transcript is finished, for Opus as well as WAV, so silence does not keep arriving');
const waveSource = blockAt(recorderSource, /function drawWave\(now = performance\.now\(\)\) \{/);
ok(waveSource.length > 0, 'the waveform is drawn in one place');
ok(/const frame = nextWaveFrame\(now, AppState\._vizDue, AppState\._vizFps\);/.test(waveSource)
   && /if \(frame\.draw\) paintWave\(now\);/.test(waveSource)
   && (recorderSource.match(/paintWave\(/g) || []).length === 2,
   'the waveform is painted only on the frames its frame rate allows, not on every display frame');
ok(/if \(wait > 0\) \{\s*AppState\._vizTimer = setTimeout\(/.test(recorderSource),
   'and between two frames it waits on a timer instead of waking up on every display frame');
const waveOptions = [...(index.match(/<select class="settings-select" id="set-waveform-fps">([\s\S]*?)<\/select>/)?.[1] || '')
    .matchAll(/<option value="([^"]+)">/g)].map(match => match[1]).join(',');
ok(/AppState\._vizFps = waveformFps\(getSetting\('set-waveform-fps'\)\);/.test(recorderSource)
   && /'set-waveform-fps':\s+'30'/.test(read('src/js/config.js'))
   && /'set-waveform-fps'/.test(settingsSource.match(/const ELEMENT_KEYS = \[[\s\S]*?\];/)?.[0] || '')
   && waveOptions === '0,10,15,30,60,auto' && /<option value="30">[^<]*\(default\)/.test(index),
   `the waveform's frame rate is a setting: off, 10, 15, 30 (the default), 60 frames a second or auto (${waveOptions})`);
ok(/function labelAutoWaveform\(\) \{[\s\S]*?measureScreenRefresh\(\)[\s\S]*?describeAutoWaveform\(hz\)/.test(settingsSource)
   && /el\.value = getSetting\(k\);\n\s*\}\);\n\s*labelAutoWaveform\(\);/.test(settingsSource),
   'when Settings opens, Auto is labelled with the refresh rate measured from this screen');
ok(/if \(k === 'set-waveform-fps'\) applyWaveformRate\(\);/.test(settingsSource)
   && /applyCompactMode\(\);\s*applyWaveformRate\(\);/.test(settingsSource),
   'a new waveform frame rate applies at once, also to a recording in progress');
ok(/AppState\._fpsEl = on && fpsCounterWanted\(\) \? fpsDisplay : null;/.test(recorderSource)
   && /#fpsDisplay\{[^}]*display:none\}/.test(index) && /#fpsDisplay\.on\{display:block\}/.test(index)
   && !/fps\.style\.cssText/.test(mainSource),
   'the frame counter is shown only when debugging is switched on, and fullscreen no longer forces it visible');
ok(/body\.live-scribe-on #visualizer\{height:44px/.test(index),
   'with the live panel open the waveform is a thin strip, so it does not cover the live row');

const previewSource = liveFunction('pumpPreview');
ok(/shown: !translationBoxesShown\(\)/.test(previewSource)
   && /hidden: typeof document !== 'undefined' && document\.visibilityState === 'hidden'/.test(previewSource)
   && /heardSpeech: state\.speech\.speaking \|\| state\.speech\.speakingUntil > state\.previewAt/.test(previewSource)
   && /windowSlotFree: state\.inFlight < MAX_IN_FLIGHT/.test(previewSource),
   'a preview is only asked for when it can be seen, someone spoke, and no window is about to settle the same words');
ok(/if \(preview === state\.preview\) return;/.test(liveFunction('sendPreview')),
   'an unchanged preview does not repaint the transcript');
ok(/syncRows\(nodes\.text, singleRows\(labelled\)\);/.test(liveFunction('paintText'))
   && !/nodes\.text\.innerHTML = committed/.test(liveTranslateSource),
   'the transcript without translation boxes is kept as rows too, instead of being rebuilt on every paint');

const beatSource = blockAt(recorderSource, /async function persistOwnedHeartbeat\(/);
ok(beatSource.length > 0, 'the recording heartbeat is written in one place');
ok(beatSource.indexOf('writeCaptureBeat(') > -1
   && beatSource.indexOf('writeCaptureBeat(') < beatSource.indexOf('dbUpdate(CONFIG.STORE_REC')
   && /if \(beatStored && !heartbeatRowDue\(\{ last: AppState\.rowBeat, recId, state, now, force, snapshotted \}\)\) return;/.test(beatSource),
   'every three seconds the heartbeat writes a small beat, and rewrites the recording only when it is due or the beat could not be written');
const recoverySource = blockAt(recorderSource, /export async function recoverIncompleteRecordings\([^)]*\) \{/);
ok(/absorbCaptureBeat\(rec\.id, beat, rec\.durationMs \|\| 0\)/.test(recoverySource),
   'recovery keeps the length the beat recorded');
ok(/const beat = _captureBeats\.get\(Number\(rec\.id\)\);/.test(guiSource)
   && /ownedByLiveTab: isRecordOwnedByLiveTab\(rec, now, beat\)/.test(guiSource),
   'and so does the list, when another tab is recording');

const tapSource = blockAt(recorderSource, /async function attachCaptureWorklet\(\) \{/);
ok(tapSource.length > 0, 'the live audio tap is attached in one place');
ok(/AppState\.recFormat === 'opus' && AppState\.graphStartSec != null/.test(tapSource)
   && /samplesBeforeTap\(AppState\.audioCtx\.currentTime, AppState\.graphStartSec/.test(tapSource)
   && /AppState\.graphStartSec = AppState\.audioCtx\.currentTime;/.test(recorderSource),
   'turning on 📝 during an Opus recording counts the audio recorded before the tap, so the saved length is the whole recording');

ok(!/window\.prompt\(/.test(mainNow) && /askForPastedText\(/.test(mainNow),
   'when the clipboard cannot be read, a multi-line box of the app is offered, never the browser prompt that truncates and flattens text');
ok(/<textarea id="pasteText"(?![^>]*maxlength)[^>]*>/.test(index),
   'and that box sets no length limit of its own');

const replyStart = read('src/js/reply.js').match(/export async function runSummary\([\s\S]*?const resultGeneration/)?.[0] || '';
ok(replyStart.indexOf("beginJob('r', recId)") > 0 && replyStart.indexOf("beginJob('r', recId)") < replyStart.indexOf('await ')
   && /if \(ctrl\.signal\.aborted\) throw abortError\(\);/.test(replyStart),
   'a reply is cancellable from its first moment: ✕ pressed while the model is still being looked up is not lost');
const autoSource = read('src/js/auto-pipeline.js');
ok(/if \(isAbort\(error\)\) outcome = CANCELLED;/.test(autoSource) && /return outcome;\n\s*\}/.test(autoSource)
   && !/if \(!isAbort\(error\)\) throw error;/.test(autoSource),
   'the automatic transcription and reply say when they were cancelled, instead of swallowing it, so the chain after a recording stops');
const secondPass = blockAt(recorderSource, /async function runSecondPass\(/);
ok(/showLiveStatus\(recId, 'scribe', '🧹 Cleanup pass… \(tap to watch\)'/.test(secondPass)
   && /removeLiveStatus\(recId, 'scribe'\);/.test(secondPass),
   'the cleanup pass shows its progress with a ✕ like any transcription');
const columns = blockAt(recorderSource, /async function completeTranscriptColumns\(/);
ok(/rec\.fillError = result\.stopped;/.test(columns) && !/rec\.pipelineError/.test(columns)
   && /rec\.fillError\s*\n?\s*\? `<div class="rec-warning" role="status">\$\{escapeHtml\(rec\.fillError\)\}<\/div>`/.test(read('src/js/gui.js')),
   'a translation fill that had to stop says so in a notice of its own, which the next transcription or reply does not wipe');
ok(/fillTranslations\(recId, \{\n\s*onProgress: text => \{/.test(columns)
   && /showLiveStatus\(recId, 'translate', text, null, \(\) => cancelJob\('f', recId\)\)/.test(columns)
   && /\} finally \{\n\s*removeLiveStatus\(recId, 'translate'\);/.test(columns),
   'the translations finished after a recording show on it while they run, and their ✕ stops only them, not a transcription or reply');
ok(/showLiveStatus\(rec\.id, 'translate', liveStatusText\(rec\.id, 'translate'\) \|\| describeFillProgress\(null\),\n\s*null, \(\) => cancelJob\('f', rec\.id\)\)/.test(guiSource)
   && /if \(hasJob\('f', rec\.id\)\) \{/.test(guiSource),
   'and a repaint of the list puts their status line back as it was, with the same ✕');
ok(/function requestTranslations\(rows, target\) \{[\s\S]{0,400}?if \(!state\.active \|\| state\.stopping\) return;/.test(scribe),
   'once Stop is finishing the last windows nothing new is sent to be translated, since no answer could reach what is saved; what is left is translated after the recording');

const guiNow = read('src/js/gui.js');
const mainNowSource = read('src/js/main.js');
ok(/AppState\.savingId = currentId;\n\s*cleanupRecordingState\(\);/.test(recorderSource),
   'the recording this tab is saving is known while its state is torn down, so its row can say so');
ok(/const stopStillSaving = AppState\.captureStopping;/.test(recorderSource)
   && /if \(!stopStillSaving\) document\.getElementById\('recordBtn'\)\.textContent = 'Start Recording';/.test(recorderSource),
   'while Stop is still saving, the record button keeps saying so instead of offering to start');
ok(/\} else if \(wasOtherTabLive\) \{[\s\S]*?scheduleRecoveryOfClosedTabRecordings\(\);\n\s*\}/.test(mainNowSource)
   && /setInterval\(\(\) => scheduleRecoveryOfClosedTabRecordings\(0\), CONFIG\.RECOVERY_SWEEP_MS\);/.test(mainNowSource)
   && /recoverIncompleteRecordings\(\{ retryFailed \}\)/.test(mainNowSource),
   'an open tab recovers a recording whose tab closed without saving it, soon after that tab disappears and every minute, without a reload');
ok(/case 'recoverNowRec': return window\.recoverNowRec\(recId\);/.test(guiNow),
   'the Recover now a row offers reaches the recovery');
const renderNow = blockAt(guiNow, /async function _renderListNow\(\) \{/);
ok(/const keptAudio = audioToKeepAcrossRepaint\(\);/.test(renderNow) && /revokeAllObjectUrls\(\{ except: keptAudio \? keptAudio\.recId : null \}\);/.test(renderNow)
   && /if \(keptAudio && !moveKeptAudioIntoRebuiltRow\(fragment, keptAudio\)\) revokeAllObjectUrls\(\);/.test(renderNow)
   && /const paintPlayerHoldingThisAudio = \(\) => \{ const current = audio\.closest\('\.player'\); if \(current\) paintPlayer\(current\); \};/.test(guiNow),
   'a repaint of the list moves the audio being listened to into the rebuilt row, so it neither stops nor rewinds');
ok(/const keptTitle = titleEditToKeepAcrossRepaint\(\);/.test(renderNow) && /if \(keptTitle\) moveTitleEditIntoRebuiltRow\(fragment, keptTitle\);/.test(renderNow)
   && /refocusMovedTitleEdit\(keptTitle\);/.test(renderNow) && /if \(!input\._moving\) finish\(true\);/.test(guiNow),
   'and moves a title being typed along with it, still focused, without saving it half-typed');
ok((guiNow.match(/if \(!repainted\) repaintIfRowRebuiltDuringJob\(li\);/g) || []).length === 2,
   'when a transcription or reply ends after its row was rebuilt, the row on screen is repainted so its button works again');
const listKeys = blockAt(guiNow, /UI\.list\.addEventListener\('keydown', \(e\) => \{/);
ok(/if \(e\.defaultPrevented\) return;/.test(listKeys)
   && /const handledCloserToElement = event\.defaultPrevented;\n\s*if \(handledCloserToElement\) return;/.test(guiNow),
   'Enter on a transcript preview or a context title is handled once, so it opens one view');
ok(/const focusOutsideControls = !focusable\.includes\(document\.activeElement\);\n\s*if \(focusOutsideControls\) \{ event\.preventDefault\(\); \(event\.shiftKey \? last : first\)\.focus\(\); \}/.test(mainNowSource)
   && /if \(document\.getElementById\('pasteOverlay'\)\.classList\.contains\('open'\)\) return document\.getElementById\('pastePanel'\);/.test(mainNowSource),
   'Tab and Shift+Tab stay inside an open dialog, the paste box included, also from the dialog itself');

const snapshotPlan = blockAt(recorderSource, /function liveSnapshotIfDue\(/);
ok(/const sizeAndSignature = liveTranscriptSizeAndSignature\(\);/.test(snapshotPlan)
   && /if \(!liveSnapshotDue\(\{ now, last: AppState\.liveSnapshot, \.\.\.sizeAndSignature \}\)\) return null;/.test(snapshotPlan)
   && /liveSnapshotIfDue\(started, beats\)/.test(recorderSource),
   'while recording, the live transcript is saved when it has grown enough or five minutes passed, not rewritten whole every minute');
const scribeNow = read('src/js/live-scribe.js');
const enqueueNew = blockAt(scribeNow, /async function enqueueWindow\(/);
ok(/bytes: queuedWindowBytes\(blob, resampled\)/.test(enqueueNew) && /releaseReviewAudioOfWaitingWindows\(state\.queue\);\n\s*const capped = capRetryQueue\(state\.queue\);/.test(enqueueNew),
   'a queued live window counts all the audio it holds, and windows waiting out an outage let their review samples go');
const diarizeSource = read('src/js/diarize-core.js');
const clusterSource = diarizeSource.slice(diarizeSource.indexOf('export function recluster('),
                                          diarizeSource.indexOf('function assignIdentities('));
const joinSource = blockAt(diarizeSource, /function joinGroup\(group, point\) \{/);
const leaveSource = blockAt(diarizeSource, /function leaveGroup\(group, point\) \{/);
ok(/joinGroup\(best, point\);/.test(clusterSource)
   && /for \(let i = 0; i < group\.sum\.length; i\+\+\) group\.sum\[i\] \+= point\.vec\[i\];/.test(joinSource)
   && /for \(let i = 0; i < group\.sum\.length; i\+\+\) group\.sum\[i\] -= point\.vec\[i\];/.test(leaveSource)
   && !/members\.(?:reduce|map|forEach)\(/.test(joinSource + leaveSource),
   'speaker clustering keeps a running sum per speaker instead of adding up every member again for each new line');
ok(/if \(learned\) state\.diarization = addEmbeddings\(state\.diarization, heard, \{ maxSpeakers: maxSpeakers\(\) \}\);/.test(scribeNow),
   'and the lines of one live window are clustered together, once');

const transcribeNow = read('src/js/transcribe.js');
ok(/runAdaptivePool\(chunks, state\.pool,/.test(transcribeNow)
   && /adjustPool\(recId, state, \{ ok: true, ms: Date\.now\(\) - started \}\);/.test(transcribeNow)
   && /adjustPool\(recId, state, \{ ok: false, timedOut: !!err\.timedOut, busy: !!err\.busy \}\);/.test(transcribeNow)
   && /timeout\.timedOut = true;/.test(transcribeNow),
   'a transcription adapts to how fast the server answers, halving on a timeout or a busy answer');


ok(/requestAnimationFrame\(runOnce\);\n\s*setTimeout\(runOnce, FRAME_FALLBACK_TIMER_MS\);/.test(read('src/js/live-render.js')),
   'a viewer whose window gets no animation frames, a popup behind the app, still shows the stream on a timer');

console.log(`✓ all ${assertions} static integrity assertions passed`);
emitTestResult('static-integrity', 'pass', { assertions });
