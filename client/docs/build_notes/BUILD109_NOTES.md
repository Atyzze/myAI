# myAI Build 109

Build 109 deliberately stops carrying old database layouts. This is a single-user application, so schema version 11 is a clean boundary: the upgrade transaction removes the previous object stores and creates only the current `recordings`, `audio`, `audio_fragments` and `live_transcripts` stores. There is no row migration, legacy-store reader, boot-time audio mover or migration completion flag. A schema-changing update therefore clears local app data; export first if anything needs to survive it. The existing multi-tab version-change guard stays because an active recording must be allowed to finish before the destructive reset can run.

## One AI model

Settings now has one **AI model** dropdown. Replies and live translation resolve the same selected Ollama model. Translation still has its own prompt, 4096-token context and output budget, but no separate model selector or automatic "smallest translator" resolver. This removes a second configuration state and avoids an unnecessary model swap when the same instruct model can do both jobs.

The diagnostics were updated accordingly: slow or malformed translation points to Settings › AI model rather than a removed translation-model control.

## Retention scope bug

The automatic retention sweep used `const fresh` inside the synchronous `dbUpdate` callback and then referenced `fresh.dropLive` after that callback had returned. That identifier is out of scope. A sweep could commit the row mutation and then throw before deleting the separate live transcript/audio stores, leaving partial cleanup behind.

Build 109 carries the `dropLive` decision out through an outer boolean and uses that after the row transaction. A static invariant and mutation guard now specifically reject losing that decision again.

## Build 108 migration issue removed rather than patched

Build 108's audio mover could mark its migration complete even if moving an individual recording failed, and startup began a storage total before the migration completed. Build 109 does not repair those migration paths: it removes them. `calcTotalStorage()` now runs after the initial list paint against the current lightweight schema, and no startup code knows how to move audio out of legacy recording rows.

## Documentation cleanup

The README and architecture guide no longer describe the removed `system z` numeric command system or nonexistent `system-z-core.js`. Storage/privacy/protocol documentation now describes the destructive current-schema policy and the single shared AI model. The in-app update help no longer promises that every schema-changing update preserves browser data.

## Contracts

- `AI-MODEL-001` now guarantees that replies and live translation use the same selected model, guarded by `MUT-TRANSLATE-SPLITS-MODEL`.
- `DB-CURRENT-SCHEMA-001` states that schema changes rebuild only the current layout and carry no legacy migration path.
- `DATA-RETENTION-001` gains `MUT-RETENTION-LOSES-LIVE-DECISION` for the retention scope regression.
- `LIVE-TEXT-STORE-001` no longer claims that legacy inline transcript data survives an upgrade.

Release gate: 16 suites passed; 1 skipped (portable gate; Chromium navigation blocked by runtime policy; 137 mutation guards passed in isolated chunks)
