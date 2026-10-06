# Privacy

## Browser storage

In a normal browser session, myAI deliberately persists recordings and associated text in the browser's origin storage. This is what allows recording fragments to survive a reload/crash and be finalized or recovered later. Automatic retention settings can delete older audio/text, and the user can export a backup.

myAI does not offer a separate "Transient session" switch. For a browser-managed ephemeral session, use Private/Incognito browsing. Private browsing is not a promise about remote services: network requests still reach the configured servers.

A database schema change keeps stored data: upgrades only add what the new layout needs. Deletion happens only when you delete something, when automatic retention removes it, or when the browser clears site data.

## Transcription boundary

The browser posts bounded 16 kHz mono PCM WAV data directly to `/transcribe`. There is no multipart upload field, no `store_backup` field and no client setting capable of requesting server retention.

The corresponding VTS deployment is designed so recording-derived request content is processed in RAM and cannot be intentionally retained by the application. Server operational metadata such as source IP, byte count, status and latency is a separate policy controlled by VTS.

For live repetition checks, myAI temporarily keeps only a small bounded tail of already-captured 16 kHz PCM in JavaScript memory and may resubmit a wider region to VTS. This refinement buffer is not a second persistence path; it is discarded as the live tail advances or the session ends.

## Pop-up views

A live transcript or reply opened in a window of its own is drawn into that window by the tab that opened it. Nothing is posted to the window, and it runs no script, so what it shows cannot reach a page the window was later navigated to. Builds before 129 posted the transcript to the window without naming the page that was to receive it.

## Reply/translation boundary

Replies and translation use the configured Ollama-compatible route and the same selected AI model. Text sent to that service follows that service's own deployment/storage policy; myAI cannot turn a separately configured model server into an ephemeral service.

## Local deletion

Deleting browser data is destructive. Downloaded exports are the recovery mechanism; there is no hidden in-app trash copy whose presence would contradict deletion. Audio is written only in the same transaction as the recording that owns it, so a conversion finishing after a deletion cannot write the deleted audio back, and startup removes any audio no recording owns. Deleting the last transcript made from a recording's live transcript deletes that live transcript too, so the text does not stay behind unseen, and a backup does not carry a live transcript that no transcript shows. A deletion that a closed tab left half done is finished by the next tab that opens. Transcripts deleted before Build 128 may still have their live transcript stored; it goes when text retention removes it, or with Delete all text.
