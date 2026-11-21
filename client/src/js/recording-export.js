import { CONFIG, getSetting, fmtSize } from './config.js';
import { dbExec } from './db.js';
import { buildRecordingCopy, buildRecordingExport, recordingExportName, recordingChain,
         shownTranscript, repliesTo, RECORDING_EXPORT_JSON_NAME } from './export-core.js';
import { zipFiles } from './backup-core.js';
import { displayTitle, contextStats } from './naming.js';

// 📑 on a recording opens three choices, and only the second tap acts (Build 146). Both texts are
// built when the box opens, so a choice writes the clipboard straight from its own tap: Safari
// refuses a clipboard write that waits for the database first.

let _closeOpen = null;

const byId = id => document.getElementById(id);

function appBuild() {
    try { return document.querySelector('meta[name="myai-build"]')?.getAttribute('content') || null; }
    catch (_) { return null; }
}

function flashRowButton(recId, ok) {
    const button = byId(`btn-export-${recId}`);
    if (!button) return;
    button.textContent = ok ? '✓' : '✗';
    button.classList.toggle('copied', ok);
    setTimeout(() => { button.textContent = '📑'; button.classList.remove('copied'); }, 1200);
}

function copyText(text) {
    try {
        if (!text || !navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') return Promise.resolve(false);
        return navigator.clipboard.writeText(text).then(() => true, err => {
            console.warn('Copying the recording was refused:', err);
            return false;
        });
    } catch (err) {
        console.warn('Copying the recording failed:', err);
        return Promise.resolve(false);
    }
}

function downloadZip(rec, data) {
    try {
        const parts = zipFiles([{ name: RECORDING_EXPORT_JSON_NAME, text: JSON.stringify(data, null, 2), timestamp: Date.now() }]);
        const url = URL.createObjectURL(new Blob(parts, { type: 'application/zip' }));
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = recordingExportName(rec);
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        setTimeout(() => { try { URL.revokeObjectURL(url); } catch (_) {} }, 60000);
        return Promise.resolve(true);
    } catch (err) {
        console.warn('The recording could not be put in a ZIP:', err);
        return Promise.resolve(false);
    }
}

function describeReplies(count) {
    if (count === 0) return 'no AI reply yet';
    return count === 1 ? 'the AI reply' : `the ${count} AI replies`;
}

export async function openRecordingExport(recId, { transcriptId = null, returnFocus = null } = {}) {
    if (_closeOpen) _closeOpen(null);
    const rec = await dbExec(CONFIG.STORE_REC, 'get', recId);
    if (!rec) return null;

    const instructions = getSetting('set-ai-instructions');
    const everything = buildRecordingCopy(rec, { instructions, transcriptId, withReplies: true });
    const userOnly = buildRecordingCopy(rec, { instructions, transcriptId, withReplies: false });
    const shown = shownTranscript(rec, transcriptId);
    const replies = shown ? repliesTo(rec, shown.id).length : 0;
    const items = contextStats(recordingChain(rec)).parts;

    const overlay = byId('exportOverlay');
    const all = byId('exportCopyAll');
    const user = byId('exportCopyUser');
    const zip = byId('exportZip');
    const cancel = byId('exportCancel');

    byId('exportHint').textContent = `${displayTitle(rec)}${items ? ` · ${items} context ${items === 1 ? 'item' : 'items'}` : ''}`;
    byId('exportCopyAllInfo').textContent =
        `Context, transcript and ${describeReplies(replies)}, without the AI's thinking · ${fmtSize(everything.length)}`;
    byId('exportCopyUserInfo').textContent =
        `Context and transcript, exactly what the AI was given, never shortened · ${fmtSize(userOnly.length)}`;
    byId('exportZipInfo').textContent =
        `Every transcript, reply and context item as structured JSON (${RECORDING_EXPORT_JSON_NAME}), no audio`;
    all.disabled = !everything;
    user.disabled = !userOnly;

    return new Promise(resolve => {
        const teardown = () => {
            _closeOpen = null;
            overlay.classList.remove('open');
            overlay.setAttribute('aria-hidden', 'true');
            all.onclick = null;
            user.onclick = null;
            zip.onclick = null;
            cancel.onclick = null;
            overlay.onclick = null;
            overlay.onkeydown = null;
            try { returnFocus?.focus(); } catch (_) {}
        };
        const close = result => { teardown(); resolve(result); };
        const choose = (choice, work) => {
            const done = work();
            teardown();
            done.then(ok => {
                flashRowButton(recId, ok);
                resolve({ choice, ok });
            });
        };
        all.onclick = () => choose('all', () => copyText(everything));
        user.onclick = () => choose('user', () => copyText(userOnly));
        zip.onclick = () => choose('zip', () => downloadZip(rec, buildRecordingExport(rec, {
            instructions, transcriptId, exportedAt: Date.now(), build: appBuild()
        })));
        cancel.onclick = () => close(null);
        overlay.onclick = event => { if (event.target === overlay) close(null); };
        overlay.onkeydown = event => { if (event.key === 'Escape') { event.preventDefault(); close(null); } };
        _closeOpen = close;
        overlay.classList.add('open');
        overlay.setAttribute('aria-hidden', 'false');
        (all.disabled ? zip : all).focus();
    });
}

export function recordingExportOpen() {
    return !!_closeOpen;
}
