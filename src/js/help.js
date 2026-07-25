/* ==========================================================================
   help.js - The "?" guide overlay.

   Content is static markup in index.html (#helpOverlay); this module only
   toggles it open and closed.
   ========================================================================== */
let _helpReturnFocus = null;

export function openHelp() {
    _helpReturnFocus = document.activeElement;
    const o = document.getElementById('helpOverlay');
    if (o) {
        o.classList.add('open');
        o.setAttribute('aria-hidden', 'false');
        requestAnimationFrame(() => document.getElementById('helpPanel')?.focus());
    }
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
