// ❓ → 🧾 Open system logs: the system log as text, with Copy, Download and Clear. The installed
// app has no console to open, so this is where what went wrong can be read afterwards.
import { systemLog, logEvent } from './debug-log.js';
import { LOG_MAX_ENTRIES } from './debug-log-core.js';
import { getLocalIso } from './config.js';

function overlay() { return document.getElementById('logsOverlay'); }
function textBox() { return document.getElementById('logsText'); }

function setStatus(text) {
    const node = document.getElementById('logsStatus');
    if (node) node.textContent = text || '';
}

async function paintLogs() {
    const box = textBox();
    if (!box) return '';
    const text = await systemLog.text();
    box.textContent = text || 'The log is empty.';
    const lines = text ? text.split('\n').filter(line => !line.startsWith('────')).length : 0;
    setStatus(`${lines.toLocaleString('en')} entr${lines === 1 ? 'y' : 'ies'}${systemLog.stored ? '' : ' · only in memory: this browser would not open the log database'}`);
    try { box.scrollTop = box.scrollHeight; } catch (_) {}
    return text;
}

export async function openLogs() {
    const node = overlay();
    if (!node) return;
    logEvent('app', 'system logs opened');
    node.classList.add('open');
    node.setAttribute('aria-hidden', 'false');
    await paintLogs();
    try { document.getElementById('logsPanel')?.focus(); } catch (_) {}
}

export function closeLogs() {
    const node = overlay();
    if (!node) return;
    node.classList.remove('open');
    node.setAttribute('aria-hidden', 'true');
    try { document.getElementById('help-logs-btn')?.focus(); } catch (_) {}
}

export function logsOpen() {
    return !!overlay()?.classList.contains('open');
}

async function copyLogs() {
    const text = await systemLog.text();
    try {
        await navigator.clipboard.writeText(text);
        setStatus('Copied the whole log to the clipboard.');
        return true;
    } catch (_) {
        const box = textBox();
        try {
            const range = document.createRange();
            range.selectNodeContents(box);
            const selection = window.getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
            setStatus('The clipboard was refused here; the log is selected, so it can be copied by hand.');
        } catch (_) {
            setStatus('The clipboard was refused here. Use Download instead.');
        }
        return false;
    }
}

function downloadLogs() {
    return systemLog.text().then(text => {
        const blob = new Blob([text + '\n'], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = `myai-system-log-${getLocalIso(Date.now()).replace(/[: ]/g, '-')}.txt`;
        anchor.style.display = 'none';
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        setTimeout(() => URL.revokeObjectURL(url), 30000);
        setStatus('The log was handed to the browser as a download.');
        return true;
    });
}

async function clearLogs() {
    if (!confirm('Clear the system log?\n\nIt only holds what the app did, never recordings or transcripts, '
        + 'but anything you might still want to look into goes with it.')) return false;
    await systemLog.clear();
    logEvent('app', 'system log cleared');
    await paintLogs();
    return true;
}

export function exposeLogsGlobals() {
    window.openLogs = openLogs;
    window.closeLogs = closeLogs;
    window.copyLogs = copyLogs;
    window.downloadLogs = downloadLogs;
    window.clearLogs = clearLogs;
    const hint = document.getElementById('logsHint');
    if (hint) {
        hint.textContent = `What the app did, kept only on this device in a log of its own: the last `
            + `${LOG_MAX_ENTRIES.toLocaleString('en')} entries, across reloads and crashes. Nothing is sent anywhere `
            + `unless you copy or download it. It holds events and error messages, and can hold short snippets of `
            + `text the app was working on.`;
    }
}
