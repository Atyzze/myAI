// Imported first by main.js, so the system log is listening before any other module of the app
// runs a line of its own.
import { installSystemLog } from './debug-log.js';

const build = typeof document !== 'undefined'
    ? document.querySelector('meta[name="myai-build"]')?.getAttribute('content') || null
    : null;
installSystemLog({ build }).catch(() => {});
