# myAI

Private voice notes, live transcription, live translation and AI replies, on a box you own. Talk to it from any device, anywhere, over your own tailnet; nothing leaves the box unless you send it somewhere.

One image runs on almost anything: a workstation with a big NVIDIA card, a gaming PC, a laptop with integrated graphics, a Raspberry Pi. The box measures its own hardware at boot and sizes everything to it: which Whisper model, which AI model, how many translation boxes the app may open, how much runs in parallel. A small box never refuses to run; it uses smaller models and says so in plain words.

```
client/   the browser app (PWA): recording, live transcript, up to 4 live translation
          boxes, speaker numbers, replies, hands-free auto-scroll of opened texts; updates only on your tap. Build 140.
vts/      VTS, the in-memory Whisper transcription server. Build 23.
box/      what makes a box: hardware probe, model fetcher, pipeline runner, feeds,
          email notifier, backup loop, status screen. Python standard library only.
nix/      the NixOS module and the box definition.
flake.nix images, packages, checks.
```

## Will my machine run it?

```bash
nix run github:Atyzze/myAI#probe
```

prints what this machine would get, for example:

```
myAI box: standard - 8 cores, 16 GiB RAM, GTX 1650 (4 GiB, cuda)
  Whisper  large-v3-turbo on cuda (int8_float16)
  AI model qwen3:4b (~3.6 GiB, cuda, 70% on CPU)
  Client   up to 3 translation boxes, 10 parallel transcriptions
  WARNING  Insufficient VRAM: 'qwen3:4b' needs about 3.6 GiB, the GPU has 4 GiB.
           It will still run: Ollama splits it, about 70% on the CPU, so replies are slower.
```

## Make a box

| Output | For |
|---|---|
| `.#image` | x86_64 disk image, NVIDIA via CUDA, any other GPU via Vulkan, else CPU |
| `.#image-lite` | x86_64 disk image without CUDA: smaller, built entirely from the binary cache (laptops, Intel/AMD graphics) |
| `.#iso`, `.#iso-lite` | try it from a USB stick without installing (nothing persists) |
| `.#qcow2`, `.#qcow2-lite` | virtual machines |
| `.#sd-image` (aarch64) | Raspberry Pi 4/5 class boards, CPU only |

```bash
nix build github:Atyzze/myAI#image-lite
sudo dd if=result/*.img of=/dev/sdX bs=4M status=progress conv=fsync
```

The CUDA image compiles CTranslate2 and Ollama with CUDA once (they are unfree, so not in the public cache); everything else downloads. The disk grows to fill whatever it is written to.

Before the first boot, open the stick's small FAT partition on any computer and create a folder `myai` with any of:

| File | Effect |
|---|---|
| `tailscale-authkey.txt` | joins your tailnet without touching the box; removed once used |
| `wifi.txt` | `ssid=...` and `password=...` lines; removed once used |
| `authorized_keys` | SSH keys for root (over the tailnet only) |
| `drop_authorized_keys` | SSH keys for the SFTP drop box |
| `overrides.json` | e.g. `{"llm_model": "qwen3:8b", "whisper_model": "small"}` |

Without an auth key, the box's own screen shows its status and **[L]** shows a QR code: scan it with your phone, log in to Tailscale, done. On first boot it downloads the models it planned for (this needs internet once).

Then open `https://myai.<your-tailnet>.ts.net` on your phone or computer. On the local network it is also at `https://<its IP>` and `https://myai.local` (self-signed certificate; the browser asks once).

Already on NixOS? Add `nixosModules.default` and set `services.myai.enable = true;` (see `nix/module.nix` for every option).

## The three folders

Everything a box keeps is in three folders under `/srv/myai`, and the operating system enforces who may write where. The programs cannot break these rules even if they try: ownership and ACLs decide, and every service runs with the whole filesystem read-only except the one folder it owns.

```
app/      what runs: the web app, app/pipelines/*.json, the models.
          Written only by the update manager (user myai-update).
input/    where files come in. Writable by the myai-input group, or by everyone
          (services.myai.inputAccess = "everyone"). Pipelines only read here.
output/   what came out. Nobody writes here except each pipeline, into
          output/<its name>/ only, as its own user. People read.
```

A pipeline is a data file in `app/pipelines/<name>.json`: the input folder it tunes into, the processor, its settings. It reads `input/<input>/` (and may read other pipelines' outputs, so pipelines chain) and writes only `output/<name>/`. It runs as its own user and cannot reach the network beyond the box itself.

The first pipeline is voice: put an audio or video file of any length and almost any format into `input/transcribe/` and `output/transcribe/` gets

- `<file>.txt` with timestamps and speaker numbers,
- `<file>.srt` subtitles,
- `<file>.json` with every segment, the language and the speaker count.

Files are streamed through ffmpeg and sent to VTS in windows of about two minutes cut at a quiet moment, so a six-hour recording costs no more memory than a short one. A file still being copied in is left until it settles; a file already done is not done again until it changes; a file that keeps failing is tried three times and reported once. Options for one file sit beside it as `<file>.json`, e.g. `{"language": "nl"}`. Voice vectors are used in memory to number speakers and never written to disk.

Getting files in: over the tailnet, `sftp myai-drop@myai` sees exactly `app/` (read), `input/` (write) and `output/` (read). Results are also browsable at `/output/` on the tailnet address.

More pipelines are a few lines of configuration:

```nix
services.myai.pipelines.dictation = {
  processor = "transcribe";
  settings.language = "nl";
};
```

## Events, feeds and email

Every pipeline appends what happened to `output/<name>/events.jsonl`. From those:

- **Atom feeds** at `/feeds/events.atom` and `/feeds/<pipeline>.atom` (tailnet only), for any feed reader.
- **Email**, the universal way out: subscribe to any pipeline's events, by kind, and get at most one message per run.

```nix
services.myai.email = {
  enable = true;
  to = [ "you@example.org" ];
  kinds = [ "failed" "report" ];          # or [ "*" ]
  smtp = { host = "smtp.example.org"; user = "box"; passwordFile = "/var/lib/myai/provision/smtp-password"; };
};
```

## Backups

A plain rsync loop with no AI in it: dated snapshots of `input/` and `output/` (plus the app's manifest and pipeline definitions), unchanged files hard-linked to the previous snapshot, old ones pruned. The target must contain a file `.myai-backup-target`, so an unmounted backup disk is a loud failure instead of a silent copy onto the system disk. Every run is an event, and a weekly report says how many backups succeeded; with email on, you hear about it when they stop.

```nix
services.myai.backup.target = "/mnt/backup";   # chown myai-backup; touch .myai-backup-target
```

## Privacy and access

- The app records in your browser. Audio goes to VTS, which holds it in RAM only, refuses to persist anything, and keeps it out of swap; nginx is configured so request bodies never touch disk either.
- The only ways in are Tailscale (who may connect is your tailnet's access control) and, optionally, the local network for the app itself. `/output/`, `/feeds/` and SSH are tailnet only.
- Pipelines, feeds, email and backups each run as their own user with their own single writable folder. That is the compartment model: an AI processor can be given exactly the inputs it needs and nothing else, and backups never involve an AI at all.

## Develop

```bash
nix flake check                         # box, VTS and client unit tests, and the lite system
(cd client && npm test)                 # the client's full gate (needs browsers for integration)
(cd vts && python3 -m unittest discover -s tests)
(cd box && python3 -m unittest discover -s tests)
```

Each part keeps its own release discipline: `client/` and `vts/` have their own `BUILD_NUMBER`, build notes and release packager. Where this is heading is in [ROADMAP.md](ROADMAP.md).
