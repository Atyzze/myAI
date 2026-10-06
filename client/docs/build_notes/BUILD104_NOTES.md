# myAI Build 104

Build 104 makes a version upgrade safe to meet halfway through a recording. No storage format change; database version stays at 9.

## The hazard build 103 created

`idb-min.js` had always answered a `versionchange` event by closing the connection:

```js
idb.onversionchange = () => { try { idb.close(); } catch (_) {} };
```

Until build 103 the database version had never moved, so that line had never run. Build 103 moved it to 9, which made it reachable, and the consequence is the one thing this application is built to prevent.

A tab open on an older build and recording. A second tab opens on build 103 and asks for version 9. `versionchange` fires on the recording tab, which closes its connection. `dbPromise` in `db.js` was a module-level singleton, already resolved with that handle, so from then on every `db.transaction(...)` threw `InvalidStateError` for the life of that tab. The next four-second fragment flush threw, capture was halted as a failure, and `buildEmergencyRecoveryBlob` needed the same dead handle so the salvage path threw too: no master blob, no recovery download, and a recording lost to an upgrade.

`onblocked` only wrote to the console, so if the recording tab did not close promptly, the new tab simply hung on load with nothing on screen.

## The recording outranks the upgrade

`openDB` now asks before it closes. The application supplies `canClose`, which reports whether this tab is holding a recording, and `onversionchange` keeps the connection when it is. The other tab's open stays blocked, which is the correct trade: a new build can wait a few minutes, a recording cannot be un-lost.

The waiting tab is no longer silent. `onBlocked` reaches the application, and the page says that a newer version is waiting, that a recording in another tab is being protected, what to do about it, and that it will continue by itself. The same notice covers the ordinary case with no recording involved.

## A tab whose connection was taken is not broken

`db.js` no longer holds one connection for the life of the tab. `database()` opens on demand and forgets the promise when the connection closes, so a tab that legitimately stepped aside reopens on next use and keeps working rather than throwing forever.

Where reopening is refused because the stored data has moved past this build, which is `VersionError: The requested version (9) is less than the existing version (10)`, that is recognised as a stale tab and reported as one: reload to continue, nothing has been lost. That message is the honest one, and it is worth saying plainly because the situation looks alarming and is not.

## What an upgrade actually does to stored data

Nothing, and the guide now says so, because the question is a fair one to ask of a version number. `indexedDB.open` at a higher version runs the upgrade callback, which creates stores that are absent and leaves every existing store and record alone. There is no reset, no cache to clear, and nothing for the user to do.

## Contracts

`DB-UPGRADE-001` is new: a newer version of the app never takes the database away from a tab that is holding a recording, and a tab it does take it from is not left broken. Suites `pure`, `static-integrity`, `browser-lifecycle`; guards `MUT-UPGRADE-CLOSES-RECORDING-TAB`, `MUT-RECORDING-NOT-BUSY`, `MUT-CLOSED-CONNECTION-BRICKS-TAB`, `MUT-STALE-TAB-UNRECOGNISED`.

The browser suite opens a second connection at a far higher version while the application reports itself recording, and asserts that the rival does not get the database, that the recording tab keeps reading and writing, that the wait is reported, and that the tab still has a working database once the recording ends. Removing the veto was confirmed to fail that test with the real `VersionError` the stale path is written to recognise.

Release gate: 16 suites passed (strict gate)
