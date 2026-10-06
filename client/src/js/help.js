import { checkForUpdate } from './version.js';

let _helpReturnFocus = null;

export function openHelp() {
    _helpReturnFocus = document.activeElement;
    const o = document.getElementById('helpOverlay');
    if (o) {
        o.classList.add('open');
        o.setAttribute('aria-hidden', 'false');
        requestAnimationFrame(() => document.getElementById('helpPanel')?.focus());
    }
    try { Promise.resolve(checkForUpdate()).catch(() => {}); } catch (_) {}
}

export function closeHelp() {
    const o = document.getElementById('helpOverlay');
    if (o) { o.classList.remove('open'); o.setAttribute('aria-hidden', 'true'); }
    try { _helpReturnFocus?.focus(); } catch (_) {}
    _helpReturnFocus = null;
}

export function exposeHelpGlobals() {
    window.openHelp  = openHelp;
    window.closeHelp = closeHelp;
}
