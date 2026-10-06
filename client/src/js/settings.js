import { CONFIG, SETTINGS_DEFAULTS, getSetting, escapeHtml, escapeAttr, fmtBytes,
         readStored, writeStored } from './config.js';
import { chooseReplyModel, isFallbackChoice } from './reply-core.js';
import { describeBox } from './capabilities-core.js';
import { boxCapabilities, loadBoxCapabilities } from './capabilities.js';
import { loadedModels, forgetModelChoices } from './reply.js';
import { dbExec, dbUpdate, calcTotalStorage, clearAllAudioFragments, deleteAudioFragments,
         getRecordingsOlderThan, readAudio, deleteAudio, audioFragmentSummary,
         readLiveTranscript, deleteLiveTranscript, readCaptureBeats, deleteCaptureBeat } from './db.js';
import { planTranscriptDeletion, describeTranscriptDeletion, describeRecordingDeletion,
         backupIncludesLiveTranscript, INTERRUPTED_DELETIONS_KEY, parseDeletionIds,
         withDeletionId } from './deletion-core.js';
import { AppState, applyWaveformRate, measureScreenRefresh, buildRecoverableAudio } from './recorder.js';
import { describeAutoWaveform }                        from './waveform-core.js';
import { cancelAllForRec, cancelAllJobs, hasJob }       from './jobs.js';
import { acquireRecordingLock, releaseRecordingLock, isFreshHeartbeat,
         recordHeartbeatAt } from './recording-lock.js';
import { openSavedReplyView, openSavedTranscriptView }  from './live-tabs.js';
import { confirmSpeakerDetection }                     from './live-scribe.js';
import { displayTitle, buildDownloadName }             from './naming.js';
import { recordingExt }                                from './audio-format.js';
import { crc32Init, crc32Update, crc32Final, localHeader, centralHeader,
         endOfCentralDirectory, uniqueEntryName, zipArchiveBytes, ZIP_MAX_BYTES } from './backup-core.js';
import { RETENTION_OPTIONS, retentionMs, retentionLabel, retentionScanCutoff,
         planRecordRetention, planRetentionSweep, retentionPlanTouchesAnything,
         isShorterRetention, retentionAckToken, retentionAckCovers,
         describeRetentionChange, planDeleteAllText, hasLiveTranscript } from './retention-core.js';

let _renderList = async () => {};
export function setSettingsRenderList(fn) { _renderList = fn; }

let _settingsReturnFocus = null;

const ELEMENT_KEYS = [
    'set-auto-transcribe', 'set-auto-reply', 'set-compact-mode',
    'set-ai-instructions', 'set-transcribe-lang', 'set-ollama-model',
    'set-recording-format', 'set-opus-bitrate', 'set-waveform-fps',
    'set-retention-audio', 'set-retention-text', 'set-live-transcribe',
    'set-second-pass',
    'set-speaker-detection', 'set-speaker-policy', 'set-max-speakers',
    'set-translate-panels'
];

function populateRetentionSelects() {
    const markup = RETENTION_OPTIONS
        .map(option => `<option value="${escapeAttr(option.value)}">${escapeHtml(option.label)}</option>`)
        .join('');
    for (const key of ['set-retention-audio', 'set-retention-text']) {
        const el = document.getElementById(key);
        if (el && !el.options.length) el.innerHTML = markup;
    }
}

function labelAutoWaveform() {
    const option = document.querySelector('#set-waveform-fps option[value="auto"]');
    if (!option) return;
    measureScreenRefresh()
        .then(hz => { option.textContent = describeAutoWaveform(hz); })
        .catch(() => {});
}

const RETENTION_KEYS = ['set-retention-audio', 'set-retention-text'];
const _editedHere = new Set();

function persistEditedHere() {
    for (const key of _editedHere) {
        if (!RETENTION_KEYS.includes(key)) persistControl(key);
    }
    _editedHere.clear();
}

export function openSettings() {
    populateRetentionSelects();
    _settingsReturnFocus = document.activeElement;
    _editedHere.clear();
    ELEMENT_KEYS.forEach(k => {
        const el = document.getElementById(k);
        if (el) el.value = getSetting(k);
    });
    labelAutoWaveform();
    const overlay = document.getElementById('settingsOverlay');
    overlay.classList.add('open');
    overlay.setAttribute('aria-hidden', 'false');
    requestAnimationFrame(() => document.getElementById('settingsPanel')?.focus());
    refreshOllamaModels();
    refreshLoadedModels();
    paintBoxCapabilities();
}

// A myAI box says what hardware it has and what that means for this app; other servers say
// nothing, and the row stays hidden.
async function paintBoxCapabilities() {
    const row = document.getElementById('box-capabilities-row');
    const status = document.getElementById('box-capabilities-status');
    const list = document.getElementById('box-capabilities-warnings');
    if (!row || !status || !list) return;
    const caps = await loadBoxCapabilities().catch(() => boxCapabilities());
    row.hidden = !caps.known;
    if (!caps.known) return;
    status.textContent = describeBox(caps);
    list.innerHTML = [...caps.warnings.map(text => `<li class="box-warning">⚠️ ${escapeHtml(text)}</li>`),
                      ...caps.notes.map(text => `<li>${escapeHtml(text)}</li>`)].join('');
    list.hidden = list.children.length === 0;
}

function persistControl(key) {
    const el = document.getElementById(key);
    if (!el) return;
    const value = el.value;
    if (value === '' && el.tagName === 'SELECT' && (readStored(key) || '') !== '') return;
    writeStored(key, value);
}

export function closeSettings() {
    const modelBefore = getSetting('set-ollama-model');
    persistEditedHere();
    if (getSetting('set-ollama-model') !== modelBefore) forgetModelChoices();
    const overlay = document.getElementById('settingsOverlay');
    overlay.classList.remove('open');
    overlay.setAttribute('aria-hidden', 'true');
    applyCompactMode();
    applyWaveformRate();
    _renderList({ force: true });
    runRetentionSweep().catch(err => console.warn('Retention sweep failed:', err));
    try { _settingsReturnFocus?.focus(); } catch (_) {}
    _settingsReturnFocus = null;
}

let _persistWired = false;
export function wireSettingsPersistence() {
    if (_persistWired) return;
    _persistWired = true;
    populateRetentionSelects();

    ELEMENT_KEYS.forEach(k => {
        const el = document.getElementById(k);
        if (!el) return;
        el.addEventListener('input', () => { if (!RETENTION_KEYS.includes(k)) _editedHere.add(k); });
        el.addEventListener('change', () => {
            if (RETENTION_KEYS.includes(k)) {
                confirmRetentionChange(k, el).catch(err => {
                    console.warn('Retention change could not be checked:', err);
                });
                return;
            }
            persistControl(k);
            if (k === 'set-ollama-model') {
                forgetModelChoices();
                refreshLoadedModels();
            }
            if (k === 'set-compact-mode') { applyCompactMode(); _renderList(); }
            if (k === 'set-waveform-fps') applyWaveformRate();
            if (k === 'set-speaker-detection' && el.value === 'on' && !confirmSpeakerDetection()) {
                el.value = 'off';
                persistControl(k);
            }
        });
    });

    const settingsOpen = () => {
        const ov = document.getElementById('settingsOverlay');
        return !!ov && ov.classList.contains('open');
    };
    const flush = () => {
        if (!settingsOpen()) return;
        persistEditedHere();
    };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') flush();
    });
}

async function refreshOllamaModels() {
    const sel      = document.getElementById('set-ollama-model');
    const statusEl = document.getElementById('ollama-model-status');
    if (!sel) return;

    const base   = CONFIG.OLLAMA_URL.replace(/\/+$/, '');
    const stored = getSetting('set-ollama-model');
    if (!sel.options.length) {
        sel.innerHTML = `<option value="${escapeAttr(stored)}">${escapeHtml(stored)}</option>`;
        sel.value = stored;
    }
    if (statusEl) statusEl.textContent = 'Loading models…';

    try {
        const res = await fetch(`${base}/api/tags`, { method: 'GET' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data   = await res.json();
        const models = (data.models || []).map(m => m.name).filter(Boolean);
        if (models.length === 0) throw new Error('no models installed');

        sel.innerHTML = models
            .map(n => `<option value="${escapeAttr(n)}">${escapeHtml(n)}</option>`)
            .join('');
        const chosen = chooseReplyModel(models, stored, SETTINGS_DEFAULTS['set-ollama-model']);
        sel.value = chosen;
        const replacingDefault = stored === SETTINGS_DEFAULTS['set-ollama-model'];
        if (chosen !== stored && (replacingDefault || !isFallbackChoice(chosen, stored, models))) {
            writeStored('set-ollama-model', chosen);
        }
        if (statusEl) {
            statusEl.textContent = chosen === stored
                ? `${models.length} model(s) available`
                : `${models.length} model(s) available - ${stored} is not installed, using ${chosen}`;
        }
    } catch (e) {
        sel.innerHTML = `<option value="${escapeAttr(stored)}">${escapeHtml(stored)} (saved)</option>`;
        sel.value = stored;
        if (statusEl) statusEl.textContent = `Couldn't reach the reply server (${e.message}). Using saved model.`;
    }
}


async function refreshLoadedModels() {
    const el = document.getElementById('ollama-loaded-status');
    if (!el) return;
    el.textContent = 'Asking the server what it has loaded…';
    try {
        const loaded = await loadedModels();
        if (!loaded.length) { el.textContent = 'The server has no model loaded right now.'; return; }
        el.textContent = loaded.map(item => {
            const size = item.sizeBytes ? ` ${fmtBytes(item.sizeBytes)}` : '';
            if (item.gpuPercent === null) return `${item.name}${size}`;
            return item.onCpu
                ? `${item.name}${size} - ${item.gpuPercent}% on GPU, the rest on CPU`
                : `${item.name}${size} - fully on GPU`;
        }).join(' · ');
    } catch (e) {
        el.textContent = `Could not read the loaded models (${e.message}).`;
    }
}

export function applyCompactMode() {
    document.body.classList.toggle('compact', getSetting('set-compact-mode') === 'on');
}
export function isCompact() {
    return getSetting('set-compact-mode') === 'on';
}

function invalidatePendingResults(rec) {
    rec.resultGeneration = (rec.resultGeneration || 0) + 1;
    return rec;
}

function rowHasLiveAudioOwner(rec, beats = null) {
    const beat = rec && beats ? beats.get(Number(rec.id)) : null;
    return !!rec?.processing && (
        isFreshHeartbeat(recordHeartbeatAt(rec, beat)) ||
        isFreshHeartbeat(rec.finalizerHeartbeatAt)
    );
}

function stripAudioFields(rec) {
    delete rec.audioBytes;
    delete rec.webmSeekableVersion;
    delete rec.webmDurationFixed;
    delete rec.webmRemuxError;
    return rec;
}

async function withAudioLifecycleLock(work, { quiet = false } = {}) {
    const locked = await acquireRecordingLock();
    if (!locked) {
        if (!quiet) alert('Another tab is recording or finalizing audio. Try again after it finishes.');
        return false;
    }
    try {
        return await work();
    } finally {
        await releaseRecordingLock();
    }
}

const DELETE_TAIL = 'This cannot be undone. The only copy that survives a browser '
    + 'clearing its own storage is a downloaded one (Settings › Download backup).';

function confirmDeletion(question, detail = '') {
    return confirm(`${question}\n\n${detail ? `${detail}\n\n` : ''}${DELETE_TAIL}`);
}

async function offerBackupFirst() {
    if (!confirm('Download a backup ZIP first?\n\n'
        + 'OK starts the download, and nothing is deleted until you say the file was saved. '
        + 'Cancel continues without a backup.')) return true;
    let started = false;
    try { started = await downloadBackup(); } catch (_) { started = false; }
    if (!started) {
        return confirm('No backup was saved.\n\n'
            + 'Deleting now destroys what the backup would have held, and browser storage has no undelete. '
            + 'Continue and delete anyway?');
    }
    return confirm('The backup download has started.\n\n'
        + 'Check that the ZIP has finished downloading and was saved, then press OK to delete. '
        + 'Press Cancel to delete nothing now.');
}

async function deleteAllAudio() {
    if (AppState.recId != null) {
        alert('Stop the current recording before deleting audio.');
        return;
    }
    if (!confirmDeletion('Delete ALL saved audio?',
        'Every recording loses its audio. Transcripts and replies are kept.')) return;
    if (!await offerBackupFirst()) return;

    try {
        await withAudioLifecycleLock(async () => {
            const all = await dbExec(CONFIG.STORE_REC, 'getAllFromIndex', { index: 'by-date' });
            const beats = await readCaptureBeats();
            if (all.some(rec => rowHasLiveAudioOwner(rec, beats))) {
                alert('A recording is still active or being finalized. Audio was not deleted.');
                return false;
            }

            cancelAllJobs();
            await clearAllAudioFragments();
            for (const row of all) {
                const hasText = (row.transcripts || []).length > 0
                             || (row.summaries || []).length > 0
                             || (row.contextChain || (row.context ? [row.context] : [])).length > 0
                             || hasLiveTranscript(row);
                await deleteAudio(row.id).catch(() => {});
                if (!hasText) {
                    await deleteLiveTranscript(row.id).catch(() => {});
                    await dbExec(CONFIG.STORE_REC, 'delete', row.id);
                    continue;
                }
                await dbUpdate(CONFIG.STORE_REC, row.id, rec => {
                    if (!rec) return null;
                    stripAudioFields(rec);
                    rec.audioDeletedAt = Date.now();
                    invalidatePendingResults(rec);
                    rec.processing = false;
                    rec.captureState = 'ready';
                    delete rec.deleting;
                    delete rec.finalizationError;
                    delete rec.finalizationErrorAt;
                    delete rec.ownerId;
                    delete rec.heartbeatAt;
                    delete rec.finalizerId;
                    delete rec.finalizerHeartbeatAt;
                    return rec;
                });
            }
            await calcTotalStorage();
            await _renderList({ force: true });
            return true;
        });
    } catch (err) {
        alert('Could not delete all audio: ' + (err && err.message ? err.message : err));
    }
}

async function deleteAllText() {
    if (AppState.recId != null) {
        alert('Stop the current recording before deleting text.');
        return;
    }
    if (!confirmDeletion('Delete ALL transcripts, replies and context chains?',
        'Audio is kept, but everything written from it goes.')) return;
    if (!await offerBackupFirst()) return;

    try {
        await withAudioLifecycleLock(async () => {
            const all = await dbExec(CONFIG.STORE_REC, 'getAllFromIndex', { index: 'by-date' });
            const beats = await readCaptureBeats();
            if (all.some(rec => rowHasLiveAudioOwner(rec, beats))) {
                alert('A recording is still active or being finalized. Text was not deleted.');
                return false;
            }

            cancelAllJobs();
            const plan = planDeleteAllText(all);
            for (const id of plan.deleteIds) {
                await deleteLiveTranscript(id).catch(() => {});
                await dbExec(CONFIG.STORE_REC, 'delete', id);
            }
            for (const id of plan.clearIds) {
                await deleteLiveTranscript(id).catch(() => {});
                await dbUpdate(CONFIG.STORE_REC, id, rec => {
                    if (!rec) return null;
                    invalidatePendingResults(rec);
                    rec.transcripts = [];
                    rec.summaries = [];
                    delete rec.context;
                    delete rec.contextChain;
                    delete rec.liveTranscriptLines;
                    delete rec.pipelineError;
                    delete rec.pipelineErrorAt;
                    return rec;
                });
            }
            await _renderList({ force: true });
            return true;
        });
    } catch (err) {
        alert('Could not delete all text: ' + (err && err.message ? err.message : err));
    }
}

async function deleteTranscript(recId, tId) {
    const rec = await dbExec(CONFIG.STORE_REC, 'get', recId);
    if (!rec) return;
    if (!confirmDeletion('Delete this transcript?', describeTranscriptDeletion(planTranscriptDeletion(rec, tId)))) return;
    let dropLive = false;
    await dbUpdate(CONFIG.STORE_REC, recId, rec => {
        if (!rec) return null;
        const plan = planTranscriptDeletion(rec, tId);
        if (!plan.found) return null;
        rec.transcripts = plan.transcripts;
        rec.summaries = plan.summaries;
        dropLive = plan.dropsLiveTranscript;
        if (dropLive) delete rec.liveTranscriptLines;
        return rec;
    });
    if (dropLive) await deleteLiveTranscript(recId).catch(() => {});
    await _renderList({ force: true });
}

async function deleteSummary(recId, sId) {
    if (!confirmDeletion('Delete this reply?',
        'The transcript it was written from is kept.')) return;
    await dbUpdate(CONFIG.STORE_REC, recId, rec => {
        if (!rec) return null;
        rec.summaries = (rec.summaries || []).filter(item => item.id != sId);
        return rec;
    });
    await _renderList({ force: true });
}

const _deletingHere = new Set();

function noteDeletionStarted(id) {
    _deletingHere.add(Number(id));
    writeStored(INTERRUPTED_DELETIONS_KEY, withDeletionId(readStored(INTERRUPTED_DELETIONS_KEY), id, true));
}

function noteDeletionFinished(id) {
    _deletingHere.delete(Number(id));
    writeStored(INTERRUPTED_DELETIONS_KEY, withDeletionId(readStored(INTERRUPTED_DELETIONS_KEY), id, false));
}

async function removeRecordingData(id, sessionId) {
    await deleteAudioFragments(id, sessionId, { allSessions: !sessionId });
    await deleteAudio(id).catch(() => {});
    await deleteLiveTranscript(id).catch(() => {});
    await dbExec(CONFIG.STORE_REC, 'delete', id);
}

const _staleDeletionsSeen = new Set();

export function noticeInterruptedDeletion(rec) {
    if (rec && rec.deleting && rec.id != null && !_deletingHere.has(Number(rec.id))) _staleDeletionsSeen.add(Number(rec.id));
}

// Every deletion runs from marking the row to removing it while holding the recording lock, so a
// row still marked once this tab holds that lock was left behind by a tab that closed mid-way.
// The user asked for it to go; it is finished here instead of lingering, skipped by recovery and
// by automatic deletion alike.
export async function finishInterruptedDeletions() {
    const ids = [...new Set([...parseDeletionIds(readStored(INTERRUPTED_DELETIONS_KEY)), ..._staleDeletionsSeen])]
        .filter(id => !_deletingHere.has(id));
    if (!ids.length || AppState.recId != null) return { finished: 0 };
    let finished = 0;
    const ran = await withAudioLifecycleLock(async () => {
        const beats = await readCaptureBeats();
        for (const id of ids) {
            if (_deletingHere.has(id)) continue;
            const rec = await dbExec(CONFIG.STORE_REC, 'get', id);
            if (rec && rec.deleting && rowHasLiveAudioOwner(rec, beats)) continue;
            if (rec && rec.deleting) {
                await removeRecordingData(id, rec.sessionId || null);
                await deleteCaptureBeat(id).catch(() => {});
                finished++;
            }
            _staleDeletionsSeen.delete(id);
            writeStored(INTERRUPTED_DELETIONS_KEY, withDeletionId(readStored(INTERRUPTED_DELETIONS_KEY), id, false));
        }
        return true;
    }, { quiet: true });
    if (finished) {
        await calcTotalStorage();
        await _renderList({ force: true });
    }
    return { finished, skipped: ran ? null : 'locked' };
}

export async function deleteRec(id) {
    const existing = await dbExec(CONFIG.STORE_REC, 'get', id);
    if (!existing) return;
    const savedSoFar = Number(existing.audioBytes) > 0
        ? { pieces: 0, bytes: 0 }
        : await audioFragmentSummary(id).catch(() => ({ pieces: 0, bytes: 0 }));
    if (!confirmDeletion(`Delete "${displayTitle(existing)}"?`,
        describeRecordingDeletion(existing, { savedSoFarBytes: savedSoFar.bytes, savedSoFarPieces: savedSoFar.pieces }))) return;

    try {
        await withAudioLifecycleLock(async () => {
            const beats = await readCaptureBeats();
            noteDeletionStarted(id);
            let marked = null;
            try {
                marked = await dbUpdate(CONFIG.STORE_REC, id, rec => {
                    if (!rec || rowHasLiveAudioOwner(rec, beats)) return null;
                    invalidatePendingResults(rec);
                    rec.deleting = true;
                    return rec;
                });
            } catch (err) {
                noteDeletionFinished(id);
                throw err;
            }
            if (!marked) {
                noteDeletionFinished(id);
                const current = await dbExec(CONFIG.STORE_REC, 'get', id);
                if (current) alert('This recording is active or being finalized in another tab. It was not deleted.');
                return false;
            }

            cancelAllForRec(id);
            try {
                await removeRecordingData(id, marked.sessionId || null);
            } catch (err) {
                await dbUpdate(CONFIG.STORE_REC, id, rec => {
                    if (!rec) return null;
                    delete rec.deleting;
                    return rec;
                }).catch(() => {});
                throw err;
            } finally {
                noteDeletionFinished(id);
            }
            await calcTotalStorage();
            await _renderList({ force: true });
            return true;
        });
    } catch (err) {
        alert('Could not delete this recording: ' + (err && err.message ? err.message : err));
        await _renderList({ force: true });
    }
}

async function deleteRecAudio(id) {
    const key = Number(id);
    const rec = await dbExec(CONFIG.STORE_REC, 'get', key);
    if (!rec) return;
    if (!(rec.audioBytes > 0)) { alert('This recording has no stored audio.'); return; }
    if (AppState.recId === key || rowHasLiveAudioOwner(rec, await readCaptureBeats())) {
        alert('This recording is still being captured or finalized. Its audio was not deleted.');
        return;
    }
    if (hasJob('t', key)) {
        alert('Transcription is still running for this recording. Let it finish or cancel it first.');
        return;
    }

    const transcripts = (rec.transcripts || []).length;
    const replies = (rec.summaries || []).length;
    const kept = transcripts || replies
        ? `${transcripts} transcript(s) and ${replies} reply/replies are kept.`
        : 'This recording has no transcript yet, so nothing written from it will remain.';
    if (!confirmDeletion(`Delete the audio for "${displayTitle(rec)}"?`,
        `${fmtBytes(rec.audioBytes)} is freed. ${kept}`)) return;

    try {
        await withAudioLifecycleLock(async () => {
            const beats = await readCaptureBeats();
            const stored = await dbUpdate(CONFIG.STORE_REC, key, current => {
                if (!current || !(current.audioBytes > 0) || rowHasLiveAudioOwner(current, beats)) return null;
                stripAudioFields(current);
                current.audioDeletedAt = Date.now();
                return current;
            });
            if (!stored) {
                alert('This recording is active in another tab, or its audio was already removed. Nothing was deleted.');
                return false;
            }
            await deleteAudioFragments(key, stored.sessionId || null, { allSessions: !stored.sessionId });
            await deleteAudio(key).catch(() => {});
            await calcTotalStorage();
            await _renderList({ force: true });
            return true;
        });
    } catch (err) {
        alert('Could not delete this recording\'s audio: ' + (err && err.message ? err.message : err));
        await _renderList({ force: true });
    }
}

const BACKUP_CRC_SLICE = 4 * 1024 * 1024;

async function crcOfBlob(blob, onProgress) {
    let crc = crc32Init();
    for (let offset = 0; offset < blob.size; offset += BACKUP_CRC_SLICE) {
        const end = Math.min(blob.size, offset + BACKUP_CRC_SLICE);
        crc = crc32Update(crc, new Uint8Array(await blob.slice(offset, end).arrayBuffer()));
        if (onProgress) onProgress(end - offset);
    }
    return crc32Final(crc);
}

let _backupRunning = false;
export function backupRunning() { return _backupRunning; }

async function downloadBackup() {
    const button = document.querySelector('[data-action="downloadBackup"]');
    const setLabel = text => { if (button) button.textContent = text; };
    if (_backupRunning || (button && button.dataset.busy)) return false;
    _backupRunning = true;
    if (button) { button.dataset.busy = '1'; button.disabled = true; }

    try {
        const all = await dbExec(CONFIG.STORE_REC, 'getAllFromIndex', { index: 'by-date' });
        all.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
        if (all.length === 0) { alert('There is nothing stored to back up yet.'); return; }

        const recoverable = new Map();
        for (const rec of all) {
            if (Number(rec.audioBytes) > 0 || rec.captureState !== 'finalize-error') continue;
            try {
                const blob = await buildRecoverableAudio(rec.id);
                if (blob && blob.size) recoverable.set(rec.id, blob);
            } catch (err) {
                console.warn('The audio saved so far could not be put together for the backup:', err);
            }
        }
        const audioSize = rec => recoverable.has(rec.id) ? recoverable.get(rec.id).size : (Number(rec.audioBytes) || 0);
        const audioBytes = all.reduce((sum, rec) => sum + audioSize(rec), 0);
        const taken = new Set();
        const transcriptsName = uniqueEntryName('transcripts.json', taken);
        const withAudio = all.filter(rec => Number(rec.audioBytes) > 0 || recoverable.has(rec.id));
        const audioNames = new Map(withAudio.map(rec => [rec.id, uniqueEntryName(buildDownloadName(rec, recordingExt(rec)), taken)]));
        const liveById = new Map();
        for (const rec of all) {
            if (!backupIncludesLiveTranscript(rec)) continue;
            const live = await readLiveTranscript(rec.id).catch(() => null);
            if (live) liveById.set(rec.id, live);
        }
        const index = all.map(rec => ({
            id: rec.id,
            filename: rec.filename,
            title: rec.title,
            recordedAt: new Date(rec.timestamp || 0).toISOString(),
            durationMs: rec.durationMs || 0,
            format: rec.format || 'wav',
            audioFile: audioNames.get(rec.id) || null,
            audioBytes: audioSize(rec),
            audioSavedSoFar: recoverable.has(rec.id),
            transcripts: rec.transcripts || [],
            summaries: rec.summaries || [],
            contextChain: rec.contextChain || (rec.context ? [rec.context] : []),
            liveTranscript: liveById.get(rec.id) || null
        }));
        const manifest = {
            app: 'myAI', exportedAt: new Date().toISOString(),
            recordings: index.length, audioBytes,
            note: 'Audio files are stored uncompressed in this archive. transcripts.json holds all text; each entry names its audio file.'
        };
        const transcriptsBlob = new Blob([JSON.stringify({ manifest, recordings: index }, null, 2)], { type: 'application/json' });
        const archiveBytes = zipArchiveBytes([
            { name: transcriptsName, size: transcriptsBlob.size },
            ...withAudio.map(rec => ({ name: audioNames.get(rec.id), size: audioSize(rec) }))
        ]);
        if (archiveBytes > ZIP_MAX_BYTES) {
            alert(`This backup would be ${fmtBytes(archiveBytes)}, past the 4 GB a plain ZIP can describe. `
                + `Delete or download some recordings individually first, then back up the rest.`);
            return false;
        }
        if (!confirm(`Back up ${all.length} recording(s), ${fmtBytes(audioBytes)} of audio plus all transcripts, `
            + `replies and context, as a single ZIP?\n\nThis is the only copy that survives clearing your browser data.`)) return false;

        const parts = [];
        const central = [];
        let offset = 0;
        let hashed = 0;

        const addEntry = async (entryName, blob, timestamp) => {
            const crc = await crcOfBlob(blob, done => {
                hashed += done;
                setLabel(`📦 ${Math.round((hashed / Math.max(1, audioBytes)) * 100)}%`);
            });
            const entry = { name: entryName, crc, size: blob.size, timestamp, offset };
            const header = localHeader(entry);
            parts.push(header, blob);
            central.push(centralHeader(entry));
            offset += header.length + blob.size;
        };

        const missing = [];
        for (const rec of withAudio) {
            const blob = recoverable.get(rec.id) || await readAudio(rec.id).catch(() => null);
            if (blob) await addEntry(audioNames.get(rec.id), blob, rec.timestamp);
            else missing.push(rec.id);
        }
        if (missing.length) {
            const gone = new Set(missing);
            for (const entry of index) if (gone.has(entry.id)) { entry.audioFile = null; entry.audioMissing = true; }
            manifest.audioMissing = missing.length;
        }
        await addEntry(transcriptsName,
            new Blob([JSON.stringify({ manifest, recordings: index }, null, 2)], { type: 'application/json' }), Date.now());

        const directorySize = central.reduce((sum, item) => sum + item.length, 0);
        parts.push(...central, endOfCentralDirectory(central.length, directorySize, offset));

        const zip = new Blob(parts, { type: 'application/zip' });
        const url = URL.createObjectURL(zip);
        const anchorEl = document.createElement('a');
        anchorEl.href = url;
        anchorEl.download = `myAI-backup-${new Date().toISOString().slice(0, 10)}.zip`;
        document.body.appendChild(anchorEl);
        anchorEl.click();
        anchorEl.remove();
        setTimeout(() => { try { URL.revokeObjectURL(url); } catch (_) {} }, 60000);
        if (missing.length) {
            alert(`The audio of ${missing.length} recording(s) could not be read while the backup was made, `
                + 'so the backup holds their text but not their audio. transcripts.json lists them.');
        }
        return true;
    } catch (err) {
        console.error('Backup failed:', err);
        alert('Could not build the backup: ' + (err && err.message ? err.message : err));
        return false;
    } finally {
        _backupRunning = false;
        if (button) { delete button.dataset.busy; button.disabled = false; }
        setLabel('📦 Download backup (.zip)');
    }
}

const RETENTION_ACK_KEY = 'retention-policy-acknowledged-v2';
let _retentionSweeping = false;
let _retentionDeclinedThisSession = false;

function retentionSettings() {
    return {
        audio: getSetting('set-retention-audio'),
        text: getSetting('set-retention-text')
    };
}

async function previewRetention(policy, now = Date.now()) {
    const audioMs = retentionMs(policy.audio);
    const textMs = retentionMs(policy.text);
    const cutoff = retentionScanCutoff({ now, audioMs, textMs });
    const candidates = await getRecordingsOlderThan(cutoff);
    if (candidates.length === 0) return { actions: [], empty: true, counts: null };
    return planRetentionSweep(candidates, { now, audioMs, textMs });
}

async function confirmRetentionChange(key, el) {
    el.disabled = true;
    try {
        await checkRetentionChange(key, el);
    } finally {
        el.disabled = false;
    }
}

async function checkRetentionChange(key, el) {
    const previous = getSetting(key);
    const next = el.value;
    if (!next || next === previous) return;
    if (!isShorterRetention(next, previous)) { writeStored(key, next); return; }

    const clock = key === 'set-retention-audio' ? 'audio' : 'text';
    const policy = { ...retentionSettings(), [clock]: next };
    let preview;
    try {
        preview = await previewRetention(policy);
    } catch (err) {
        alert('Could not check what this would delete, so the setting was left unchanged.');
        el.value = previous;
        return;
    }

    if (preview.empty) {
        writeStored(key, next);
        return;
    }

    const message = describeRetentionChange(preview.counts, {
        clock,
        fromLabel: retentionLabel(previous),
        toLabel: retentionLabel(next),
        oldestAt: preview.counts.oldestAt,
        formatBytes: fmtBytes,
        formatDate: at => new Date(at).toLocaleDateString()
    });
    if (!confirm(message)) {
        el.value = previous;
        return;
    }
    if (!await offerBackupFirst()) {
        el.value = previous;
        return;
    }
    writeStored(key, next);
    writeStored(RETENTION_ACK_KEY, retentionAckToken(policy));
}

function describeSweep(counts, policy) {
    const lines = [];
    if (counts.audioRecordings > 0) {
        lines.push(`• audio from ${counts.audioRecordings} recording(s) (${fmtBytes(counts.audioBytes)})`);
    }
    if (counts.transcripts > 0) lines.push(`• ${counts.transcripts} transcript(s)`);
    if (counts.summaries > 0) lines.push(`• ${counts.summaries} reply/replies`);
    if (counts.rows > 0) lines.push(`• ${counts.rows} recording(s) with nothing left in them`);
    const since = counts.oldestAt ? `, going back to ${new Date(counts.oldestAt).toLocaleDateString()}` : '';
    return `Automatic deletion is on.\n\n`
        + `Audio is deleted ${retentionLabel(policy.audio)} after the recording ended. `
        + `Text is deleted ${retentionLabel(policy.text)} after it was generated. `
        + `There is no "keep forever" setting: browser storage can be cleared at any time, so the only way to keep a recording is to download it.\n\n`
        + `Right now that means removing${since}:\n${lines.join('\n')}\n\n`
        + `Continue? Choosing Cancel leaves everything in place for now and asks again next time you open the app.`;
}

export async function runRetentionSweep({ announce = true } = {}) {
    if (_retentionSweeping) return { swept: 0, skipped: 'in-progress' };
    if (AppState.recId != null) return { swept: 0, skipped: 'recording' };
    if (_backupRunning) return { swept: 0, skipped: 'backup' };
    _retentionSweeping = true;
    try {
        const policy = retentionSettings();
        const audioMs = retentionMs(policy.audio);
        const textMs = retentionMs(policy.text);
        const now = Date.now();

        const sweep = await previewRetention(policy, now);
        if (sweep.empty) return { swept: 0 };

        const acknowledged = retentionAckCovers(readStored(RETENTION_ACK_KEY), policy);
        if (!acknowledged) {
            if (!announce || _retentionDeclinedThisSession) return { swept: 0, skipped: 'unacknowledged' };
            if (!confirm(describeSweep(sweep.counts, policy))) {
                _retentionDeclinedThisSession = true;
                return { swept: 0, declined: true };
            }
            writeStored(RETENTION_ACK_KEY, retentionAckToken(policy));
        }

        let swept = 0;
        const ran = await withAudioLifecycleLock(async () => {
            const beats = await readCaptureBeats();
            for (const { id } of sweep.actions) {
                if (hasJob('t', id) || hasJob('r', id)) continue;

                let outcome = null;
                let sessionId = null;
                let dropLive = false;
                noteDeletionStarted(id);
                try {
                    const applied = await dbUpdate(CONFIG.STORE_REC, id, rec => {
                        if (!rec || rowHasLiveAudioOwner(rec, beats) || rec.deleting) return null;
                        const fresh = planRecordRetention(rec, { now, audioMs, textMs });
                        if (!retentionPlanTouchesAnything(fresh)) return null;
                        sessionId = rec.sessionId || null;
                        dropLive = fresh.dropLive;

                        if (fresh.dropRow) {
                            invalidatePendingResults(rec);
                            rec.deleting = true;
                            outcome = 'row';
                            return rec;
                        }
                        if (fresh.dropAudio) {
                            stripAudioFields(rec);
                            rec.audioDeletedAt = Date.now();
                        }
                        if (fresh.dropTranscriptIds.length) {
                            const gone = new Set(fresh.dropTranscriptIds.map(String));
                            rec.transcripts = (rec.transcripts || []).filter(item => !gone.has(String(item.id)));
                            rec.summaries = (rec.summaries || []).filter(item => !gone.has(String(item.transcriptId)));
                        }
                        if (fresh.dropSummaryIds.length) {
                            const gone = new Set(fresh.dropSummaryIds.map(String));
                            rec.summaries = (rec.summaries || []).filter(item => !gone.has(String(item.id)));
                        }
                        if (fresh.dropContext) {
                            delete rec.contextChain;
                            delete rec.context;
                        }
                        if (fresh.dropLive) {
                            delete rec.liveTranscriptLines;
                        }
                        rec.retentionSweptAt = Date.now();
                        outcome = fresh.dropAudio ? 'audio' : 'text';
                        return rec;
                    });
                    if (!applied || !outcome) continue;
                    if (dropLive) await deleteLiveTranscript(id).catch(() => {});

                    if (outcome === 'row') {
                        await removeRecordingData(id, sessionId);
                    } else if (outcome === 'audio') {
                        await deleteAudioFragments(id, sessionId, { allSessions: !sessionId });
                        await deleteAudio(id).catch(() => {});
                    }
                    swept++;
                } catch (err) {
                    console.warn(`Retention sweep could not finish recording ${id}:`, err);
                    if (outcome === 'row') {
                        await dbUpdate(CONFIG.STORE_REC, id, rec => {
                            if (!rec) return null;
                            delete rec.deleting;
                            return rec;
                        }).catch(() => {});
                    }
                } finally {
                    noteDeletionFinished(id);
                }
            }
            return true;
        }, { quiet: true });
        if (!ran) return { swept: 0, skipped: 'locked' };

        if (swept > 0) {
            await calcTotalStorage();
            await _renderList({ force: true });
        }
        return { swept };
    } catch (err) {
        console.warn('Retention sweep failed:', err);
        return { swept: 0, skipped: 'error' };
    } finally {
        _retentionSweeping = false;
    }
}

async function unlinkContextPart(recId, itemIdx, part) {
    await dbUpdate(CONFIG.STORE_REC, recId, (rec) => {
        if (!rec) return null;
        const chain = rec.contextChain ? [...rec.contextChain] : (rec.context ? [rec.context] : []);
        const item = chain[itemIdx];
        if (!item) return null;
        if (part === 'input')  item.inputText  = '';
        if (part === 'output') item.outputText = '';
        item.text = (item.inputText ? `[User Scribe Input]: ${item.inputText}\n` : '')
                  + (item.outputText ? `[AI Summary/Reply Output]: ${item.outputText}\n` : '');
        if (!item.inputText && !item.outputText) chain.splice(itemIdx, 1);
        rec.contextChain = chain;
        if (rec.context) delete rec.context;
        return rec;
    });
    _renderList({ force: true });
}

async function viewTranscriptById(recId, tId) {
    const rec  = await dbExec(CONFIG.STORE_REC, 'get', recId);
    if (!rec) return;
    const item = (rec.transcripts || []).find(t => t.id == tId);
    if (!item) return;
    openSavedTranscriptView({
        key:        `saved-transcript-${recId}-${tId}`,
        windowName: `saved-transcript-${recId}`,
        label: rec.filename,
        text:  item.text || item.plain || '',
        charCount: (item.plain || item.text || '').length
    });
}

async function viewSummaryById(recId, sId) {
    const rec  = await dbExec(CONFIG.STORE_REC, 'get', recId);
    if (!rec) return;
    const item = (rec.summaries || []).find(s => s.id == sId);
    if (!item) return;
    openSavedReplyView({
        key:        `saved-reply-${recId}-${sId}`,
        windowName: `saved-reply-${recId}`,
        label: rec.filename,
        text:  item.text || '',
        model:      item.model,
        tokenCount: item.tokenCount,
        elapsedMs:  item.elapsedMs
    });
}

async function viewContextPart(recId, itemIdx, part) {
    const rec   = await dbExec(CONFIG.STORE_REC, 'get', recId);
    if (!rec) return;
    const chain = rec.contextChain || (rec.context ? [rec.context] : []);
    const item  = chain[itemIdx];
    if (!item) return;
    const label = item.label || rec.filename;
    const key   = `saved-context-${recId}-${itemIdx}-${part}`;
    if (part === 'output') {
        openSavedReplyView({ key, windowName: `saved-context-${recId}`, label, text: item.outputText || '' });
        return;
    }
    openSavedTranscriptView({
        key, windowName: `saved-context-${recId}`, label,
        text: part === 'input' ? (item.inputText || item.text || '') : (item.text || '')
    });
}

function contextPartText(item, part) {
    if (!item) return '';
    if (part === 'output') return item.outputText || '';
    return item.inputText || item.text || '';
}

function copyContextPart(recId, itemIdx, part, button) {
    const text = dbExec(CONFIG.STORE_REC, 'get', recId).then(rec => {
        const chain = rec ? (rec.contextChain || (rec.context ? [rec.context] : [])) : [];
        return contextPartText(chain[itemIdx], part);
    });
    let written;
    if (typeof ClipboardItem === 'function' && navigator.clipboard && navigator.clipboard.write) {
        const blob = text.then(value => {
            if (!value) throw new Error('nothing to copy');
            return new Blob([value], { type: 'text/plain' });
        });
        written = navigator.clipboard.write([new ClipboardItem({ 'text/plain': blob })]);
    } else {
        written = text.then(value => {
            if (!value) throw new Error('nothing to copy');
            return navigator.clipboard.writeText(value);
        });
    }
    return Promise.resolve(written).then(() => true, () => false).then(copied => {
        if (button) {
            button.textContent = copied ? '✓' : '✗';
            button.classList.toggle('copied', copied);
            setTimeout(() => { button.textContent = '📋'; button.classList.remove('copied'); }, 1200);
        }
        return copied;
    });
}

async function scrollToRecording(identifier) {
    const id = Number(identifier);
    let match = Number.isFinite(id) && String(identifier).trim() !== ''
        ? await dbExec(CONFIG.STORE_REC, 'get', id)
        : null;
    if (!match) {
        const all = await dbExec(CONFIG.STORE_REC, 'getAllFromIndex', { index: 'by-date' });
        match = all.find(rec => rec.filename && rec.filename.startsWith(String(identifier)));
    }
    if (!match) return;
    if (typeof window.showRecordingById === 'function') {
        await window.showRecordingById(match.id);
        return;
    }
    const el = document.getElementById(`rec-${match.id}`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

export function exposeSettingsGlobals() {
    window.closeSettings       = closeSettings;
    window.refreshOllamaModels = refreshOllamaModels;
    window.refreshLoadedModels = refreshLoadedModels;
    window.deleteAllAudio      = deleteAllAudio;
    window.deleteAllText       = deleteAllText;
    window.deleteTranscript    = deleteTranscript;
    window.deleteSummary       = deleteSummary;
    window.deleteRec           = deleteRec;
    window.deleteRecAudio      = deleteRecAudio;
    window.runRetentionSweep   = runRetentionSweep;
    window.downloadBackup      = downloadBackup;
    window.unlinkContextPart   = unlinkContextPart;
    window.viewTranscriptById  = viewTranscriptById;
    window.viewSummaryById     = viewSummaryById;
    window.viewContextPart     = viewContextPart;
    window.copyContextPart     = copyContextPart;
    window.scrollToRecording   = scrollToRecording;
}
