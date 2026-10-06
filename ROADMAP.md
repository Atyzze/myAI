# Roadmap

What exists today is in the [README](README.md): one image for almost any hardware, the voice app, VTS, Ollama, the three folders with enforced rules, the transcribe pipeline, feeds, email and backups. These are the next tracks, roughly in the order they build on each other. Each is a design sketch, not a promise.

## 1. More pipelines on the three folders

The pipeline runner already takes any processor; only `transcribe` exists.

- **summarize**: tunes into `output/transcribe/` (read-only), writes `output/summarize/<file>.md` through Ollama. First example of chaining.
- **translate**: transcripts into one or more languages, the same model the app uses live.
- **retention**: the only thing allowed to delete from `input/`, by age or by rule, as its own user with write access to `input/` and nothing else. Today nothing deletes.
- **upload from the app**: a "send to box" button that puts a recording into `input/transcribe/` (nginx WebDAV `PUT` into a dedicated `input/uploads/`, tailnet only), so long recordings go through the pipeline instead of live windows.

## 2. Two boxes, one room: the sound map

Every microphone hears every voice, slightly later the further away it is, and coloured by the room's reverb. With two or more boxes (or phones) in the same room and their clocks aligned, the differences say where each speaker is.

- **Clock alignment**: each device records a shared reference (an inaudible chirp one of them plays, or the first seconds of speech) and cross-correlates; NTP over the tailnet gets within milliseconds, the correlation within samples.
- **Delay per voice**: GCC-PHAT between device pairs per segment gives the time difference of arrival; at 16 kHz one sample is about 2 cm of path difference.
- **Positions**: with three or more devices, multilateration gives a 2D/3D position per voice; with two, a bearing. Positions make speaker identification much stronger than voice vectors alone, and stable across a meeting.
- **Better capture**: delay-and-sum beamforming toward the active speaker from all devices gives cleaner audio for Whisper than any single microphone.
- **First step**: a pure-Python proof of concept in `box/` that takes two recordings of the same meeting and reports the delay per segment. Measure before optimizing.

## 3. Rust where it pays

Python first, everywhere, until profiling shows where time goes. Likely candidates once the sound map exists: cross-correlation and beamforming over long multi-channel audio, the audio windowing in the pipeline runner, and the speaker clustering. The path is a Rust crate exposed to Python with PyO3, built by Nix like everything else, swapped in one function at a time behind the same tests.

## 4. Devices that find each other

- **Same network**: boxes and phones discover each other over mDNS (already published as `myai.local`).
- **Anywhere**: Tailscale. A box shows a QR code that carries an invite (a pre-approved, tagged auth key or a share link); scanning it on another box or phone joins it with exactly the access its tag allows.
- **Bluetooth**: pairing two phones or a phone and a box nearby to exchange that same invite without typing anything.
- **Sync**: devices sync `input/` folders (two boxes in one room both see both recordings) with a plain file sync, Syncthing or rsync, never through an AI.

## 5. Users, groups, access

Two layers that already exist, made easy to manage:

- **Who can reach the box**: Tailscale ACLs and tags (for example: family can use the app; only you can reach `/output/` and SSH).
- **Who can write which folder**: Unix groups on the box (`myai-input`, `myai-output`), per-pipeline users, and later per-user input subfolders (`input/<user>/...`) with outputs only that user's group can read.

The point is compartments: each AI processor gets exactly the inputs it is given and writes exactly one folder; anything that must never involve an AI (backups, retention, access control) stays plain code.

## 6. Folders that survive a broken disk

`app/`, `input/` and `output/` on separately replaceable storage (three datasets or disks), each with its own redundancy and backup schedule. `app/` is reproducible from the flake and needs no backup beyond the models cache; `input/` is the irreplaceable one; `output/` can be regenerated from `input/` by re-running pipelines, at a cost. Remote backup targets (rsync over SSH to another box, which also gives off-site redundancy between friends' boxes) come after local snapshots.

## 7. Distribution

The goal: buy it, write it to a stick or start it in a VM, talk to your AI. Open questions before a store listing (Steam or otherwise):

- **What is sold**: Steam distributes applications, not operating system images. The likely shape is a small launcher app that writes the image to a USB stick, or runs the box in a local VM, with the image as its downloadable content.
- **Models**: Whisper (MIT) and Qwen3 (Apache-2.0) allow redistribution; bundling them makes the first boot work offline. Every bundled model's licence needs checking per version.
- **Unfree parts**: the CUDA image contains NVIDIA's redistributable libraries and driver; the lite image has none, so it is the natural default to ship, with CUDA as a download on first boot where an NVIDIA card is found.
- **Updates**: the box already rebuilds from the flake; a signed release channel plus `system.autoUpgrade` makes that automatic.
