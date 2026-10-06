# VTS Build 21

Build 21 fixes fresh build 20 installs with diarization, where `vts.service`
restarted until systemd gave up and `/healthz` never answered.

- cause: `requirements-diarization.txt` allowed `torch>=2.5,<3`. PyTorch's PyPI
  wheels moved from CUDA 12 to CUDA 13 at torch 2.11, so a fresh venv resolved
  torch 2.14 with `nvidia-cudnn-cu13`. That wheel installs into the same
  `nvidia/cudnn/lib/libcudnn*.so.9` files as `nvidia-cudnn-cu12`, and because the
  diarization requirements install second, it replaced the CUDA 12 cuDNN that
  CTranslate2 (Whisper) loads. The resolver also paired torch 2.14 with
  torchaudio 2.11, which does not match. Older venvs predated torch 2.11 and
  were unaffected;
- `torch==2.10.0` and `torchaudio==2.10.0` are now pinned: the last PyPI pair
  built for CUDA 12, sharing `nvidia-cudnn-cu12` / `nvidia-cublas-cu12` with
  CTranslate2;
- the installer now checks the venv's package metadata after every dependency
  install and refuses a venv that holds CUDA 13 packages (`*-cu13`,
  `cuda-toolkit`) or a torchaudio that does not match torch, instead of starting
  a service that cannot run;
- an existing venv that already mixes the two lines is removed and rebuilt,
  since uninstalling the CUDA 13 wheels would also delete the shared cuDNN files;
- `install.py verify` reports the CUDA library line;
- server: build 20's default `PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True`
  is removed again. The VRAM fix (bounded embedding batches, one pass at a time,
  cache released after each request) does not need it, and it kept an
  allocator mode in the startup path that was never verified on the target GPU;
  operators can still set it in `server.env`.

Release gate: 76 tests passed.
