# Operations

## Serve

Serve the repository root over HTTPS in production. `localhost` is acceptable for development. A direct `file://` open is unsupported because service workers and module loading require an HTTP origin.

## Reverse proxy

Expose VTS at `/transcribe` and the Ollama-compatible service at `/ollama`, or deliberately change the two paths in `src/js/config.js`. The service worker treats those routes as network-owned and must never cache their API responses.

## Updates

The browser compares the bytes of `sw.js` to discover an updated service worker. Each release receives a new service-worker shell version tied to `BUILD_NUMBER`, producing a new cache generation. The version label shown by the UI is read from the active worker, which makes stale deployments visible.

From Build 138 a new build is put in use only when someone taps the version badge, or reloads a tab past the service worker (a hard reload, which already runs the new build). It is downloaded and installed next to the one serving and offered on the badge; pages also ask for a new build every 30 minutes while they are on screen. Open tabs keep running what they loaded, and closing every tab of the app no longer switches builds: the new worker takes over then, but keeps serving the shell of the build last accepted, recorded in the `myai-accepted` cache, until a tap accepts the new one. An ordinary reload does not switch either. Builds 129 to 137 put a new build in use when every tab had been closed; a worker that replaces one of them still does that once, because their pages can only accept a worker that waits, not one that already serves. Keep `src/js/live-view.js` on the server: tabs of Build 128 still open when a newer build is deployed load it into their pop-up views from the network. A server that redirects `index.html` (to `./`, say) is fine; the shell stores the page it ends up on. From Build 134 the service worker answers a navigation from its cache only for the app's own page, so other pages served on the same origin (the `docs/`, another service under the same host) are reached as usual; earlier builds answered them with a copy of the app.

## Diagnostics

Run `npm test` before production release. `npm run test:portable` is for environments where an external integration cannot run and may include explicit skips.

Generated baseline reports live under `artifacts/` and are deliberately excluded from release archives.

The frame counter over the recording waveform is hidden unless debugging is switched on in that browser: run `localStorage.setItem('myai-debug', '1')` in the developer console and start a new recording. `localStorage.removeItem('myai-debug')` hides it again. It counts the frames actually drawn, which is at most the **Recording waveform** setting (off, 10, 15, 30 or 60 a second, or Auto; 30 by default). With Auto it shows the refresh rate of the screen the window is on; Settings also labels Auto with the rate it measured when it opened.

The gate prints each suite's time when it finishes, slowest first; `MYAI_TEST_JOBS=1 npm test` runs everything one at a time, which helps when a timing-sensitive browser suite needs to be looked at on its own. `MYAI_MUTATION_WORKERS` sets the number of mutation workers for `npm run test:mutation`.
