# VTS Build 23

Build 23 lets the same server run without an NVIDIA GPU, and lets a packaged
runtime start it with its own interpreter. It is the first VTS build in the
myAI monorepo (`vts/`), where the box image chooses the Whisper model, device and
compute type at boot from the hardware that is present.

- `DEVICE` now defaults to `auto`: CUDA when CTranslate2 reports a CUDA device,
  otherwise the CPU. Before, the default was `cuda` and a box without an NVIDIA
  GPU failed at model load. `DEVICE=cuda` still insists on the GPU and fails
  without one; `DEVICE=cpu` keeps the GPU free. Any other value is refused at
  startup instead of being handed to CTranslate2;
- `COMPUTE_TYPE` follows the resolved device when it is not set: `float16` on
  CUDA, `int8` on the CPU. Set explicitly, it is used as given;
- speaker embeddings follow Whisper onto CUDA only when torch can use CUDA too,
  and fall back to the CPU otherwise. A CPU-only torch next to a CUDA
  CTranslate2 (which the box image ships, because a CUDA torch would add many
  gigabytes for a small speed-up on short segments) used to fail diarization
  with a device error. `EMBED_DEVICE` overrides the choice;
- `preprocessor_config.json` is no longer required in the model folder. It only
  exists for the large-v3 family; the tiny to medium models that a small box
  uses do not have it, and faster-whisper falls back to 80 mel bins, which is
  what those models need. `install.py` still downloads it for large-v3-turbo;
- `VTS_SYSTEM_PYTHON=1` skips the `.venv` switch and the venv CUDA library
  bootstrap, so a packaged runtime can start `server.py` with an interpreter
  that already has every dependency. Without it nothing changes: `install.py`
  installs remain the supported path on an ordinary host;
- `/healthz` also reports the resolved `device`, the `compute_type` and the
  Whisper `model` folder name, so a client or operator can see whether a box
  transcribes on the GPU or the CPU without reading the journal;
- the model-load log line records the requested device next to the resolved
  one (`device=cpu requested=auto`).

The request path, the in-memory body handling and the no-store responses are
unchanged. `PYTHON_VERSION` stays at 3.12 for `install.py` installs, whose
pinned wheels are built for it. The box image uses nixpkgs' default Python
(3.13 in NixOS 26.05) and its package versions, because every package there is
in the binary cache for that interpreter; the code needs nothing newer than
3.12. Verified there end to end: Whisper and speaker embeddings on the CPU,
through nginx and through the folder pipeline.

One integration problem was found and fixed on the box side, not in VTS: the
nixpkgs CTranslate2 and torch linked two different OpenBLAS builds with the
same soname, and the process crashed (SIGFPE in sgemm) on the first speaker
embedding after a transcription. The box now builds CTranslate2 against
torch's BLAS.

Tests: `test_device_selection.py` covers the device and compute-type choice, the
embedding device fallback, the packaged-runtime switch, the relaxed model check
and the new health fields.

103 tests passed
