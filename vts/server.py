#!/usr/bin/env python3
"""Privacy-oriented transcription API.

Design invariant for request data:

    Audio, transcript text, translations and speaker embeddings are never written
    to a filesystem by this process. Request bodies are accepted as raw PCM WAV,
    held in bounded RAM, decoded in RAM, processed in RAM, and released.

This process has no application data store and opens no recording-data file for
writing. Operational events are emitted only to stderr. Under the supplied
systemd unit those events go to journald and are deliberately limited to source
IP, request size/duration, status, latency, and non-content error classes.

This is intentionally not a claim that the whole process is physically diskless:
model weights, TLS keys and Python packages are read from disk at startup, while
the host journal may persist the permitted operational metadata. OS swap/core
dumps and a reverse proxy are outside a Python process's control; install.py
hardens the systemd service against those paths and puts temporary paths on tmpfs.
"""

import ipaddress
import logging
import os
import re
import struct
import sys
import sysconfig
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
VENV = ROOT / ".venv"
VENV_PYTHON = VENV / "bin" / "python"
PROJECT_ID = "VTS"
PROJECT_NAME = "Voice Transcribe Server"
BUILD_FILE = ROOT / "BUILD_NUMBER"


def _read_build_number() -> int:
    try:
        value = int(BUILD_FILE.read_text(encoding="ascii").strip())
    except Exception as exc:
        raise RuntimeError(f"Invalid or missing {BUILD_FILE.name}: {exc}") from exc
    if value < 1:
        raise RuntimeError(f"{BUILD_FILE.name} must be a positive integer")
    return value


BUILD_NUMBER = _read_build_number()

# Do not create .pyc files, caches or CUDA JIT cache files. These are not request
# data, but a privacy-oriented service should avoid unnecessary filesystem writes.
sys.dont_write_bytecode = True
os.umask(0o077)
os.environ["PYTHONDONTWRITEBYTECODE"] = "1"
os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"
os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
os.environ["CUDA_CACHE_DISABLE"] = "1"
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

# Running ./server.py or python3 server.py automatically switches to .venv.
if Path(sys.prefix).resolve() != VENV.resolve():
    if not VENV_PYTHON.is_file():
        raise SystemExit("Run python3 install.py once before starting the server.")
    env = os.environ.copy()
    os.execve(str(VENV_PYTHON), [str(VENV_PYTHON), str(__file__), *sys.argv[1:]], env)

# Expose CUDA libraries installed inside the venv before importing CTranslate2.
if os.environ.get("VTS_SERVER_BOOTSTRAPPED") != "1":
    nvidia = Path(sysconfig.get_paths()["purelib"]) / "nvidia"
    cuda_libs = [str(path) for path in nvidia.glob("*/lib*") if path.is_dir()]
    if cuda_libs:
        env = os.environ.copy()
        env["LD_LIBRARY_PATH"] = ":".join(cuda_libs + [env.get("LD_LIBRARY_PATH", "")]).rstrip(":")
        env["VTS_SERVER_BOOTSTRAPPED"] = "1"
        os.execve(sys.executable, [sys.executable, str(__file__), *sys.argv[1:]], env)


TRUE_VALUES = {"1", "true", "yes", "on"}
FALSE_VALUES = {"0", "false", "no", "off"}

HOST = os.getenv("VTS_BIND_HOST") or os.getenv("HOST", "127.0.0.1")
PORT = int(os.getenv("VTS_BIND_PORT") or os.getenv("PORT", "4444"))
DEVICE = os.getenv("DEVICE", "cuda")
COMPUTE_TYPE = os.getenv("COMPUTE_TYPE", "float16" if DEVICE == "cuda" else "int8")
SAMPLE_RATE = 16000
MAX_BODY_MB = float(os.getenv("MAX_BODY_MB", "8"))
MAX_BODY_BYTES = int(MAX_BODY_MB * 1024 * 1024)
LOG_CLIENT_IP = os.getenv("LOG_CLIENT_IP", "1").strip().lower() not in FALSE_VALUES
TRUST_PROXY_HEADERS = os.getenv("TRUST_PROXY_HEADERS", "0").strip().lower() in TRUE_VALUES

MODEL_DIR = Path(os.getenv("MODEL_DIR") or (ROOT / "model")).expanduser()
DIARIZE = os.getenv("DIARIZE", "auto").strip().lower()
EMBED_DIR = Path(os.getenv("EMBED_DIR") or (ROOT / "embed")).expanduser()
EMBED_MIN_SEC = float(os.getenv("EMBED_MIN_SEC", "0.8"))
# Upper bound on padded audio per speaker-embedding forward pass. ECAPA needs
# roughly 0.5 GiB of activations per 30 s of padded audio, so this caps the
# embedding step's peak VRAM regardless of how many segments a request has.
EMBED_BATCH_SEC = max(1.0, float(os.getenv("EMBED_BATCH_SEC", "30")))

# No file logger exists. Operational metadata is emitted to stderr; the supplied
# systemd unit routes it to journald. Keep third-party libraries at WARNING so
# normal model chatter cannot become a second, uncontrolled request log.
_handler = logging.StreamHandler(sys.stderr)
_handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))

_root_log = logging.getLogger()
_root_log.handlers.clear()
_root_log.addHandler(_handler)
_root_log.setLevel(logging.WARNING)

log = logging.getLogger("vts")
log.handlers.clear()
log.addHandler(_handler)
log.setLevel(logging.INFO)
log.propagate = False


# Put every conventional temporary/cache path on tmpfs. This is defense in depth:
# the request path below never asks for a temp file at all.
def _mount_fs_type(path: Path) -> str | None:
    """Return the Linux filesystem type containing path, or None if unknown."""
    try:
        target = path.resolve()
        best_len = -1
        best_type = None
        with open("/proc/self/mountinfo", encoding="utf-8") as handle:
            for line in handle:
                left, sep, right = line.partition(" - ")
                if not sep:
                    continue
                fields = left.split()
                rhs = right.split()
                if len(fields) < 5 or not rhs:
                    continue
                mountpoint = Path(fields[4].replace("\\040", " "))
                try:
                    target.relative_to(mountpoint)
                except ValueError:
                    continue
                if len(str(mountpoint)) > best_len:
                    best_len = len(str(mountpoint))
                    best_type = rhs[0]
        return best_type
    except Exception:
        return None


RAM_TMP_DIR = Path(os.getenv("RAM_TMP_DIR", "/dev/shm/vts")).expanduser()
RAM_TMP_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
_ram_fs = _mount_fs_type(RAM_TMP_DIR)
if _ram_fs != "tmpfs":
    raise RuntimeError(
        f"RAM_TMP_DIR must live on tmpfs; {RAM_TMP_DIR} is on {_ram_fs or 'an unknown filesystem'}"
    )
for _key in ("TMPDIR", "TMP", "TEMP", "XDG_CACHE_HOME"):
    os.environ[_key] = str(RAM_TMP_DIR)


REQUIRED = ("model.bin", "config.json", "tokenizer.json", "preprocessor_config.json")
missing = [name for name in REQUIRED if not (MODEL_DIR / name).is_file()]
if missing:
    raise RuntimeError(f"Incomplete model directory {MODEL_DIR}; missing: {', '.join(missing)}")


import numpy as np
import uvicorn
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool
from faster_whisper import WhisperModel


NO_STORE_HEADERS = {
    "Cache-Control": "no-store, no-cache, must-revalidate, private, max-age=0",
    "Pragma": "no-cache",
    "Expires": "0",
}
SUPPORTED_CONTENT_TYPES = {"audio/wav", "audio/wave", "audio/x-wav"}
LANGUAGE_RE = re.compile(r"^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8})?$|^auto$")


def _wipe_bytearray(buf: bytearray | None) -> None:
    if buf is None:
        return
    try:
        buf[:] = b"\x00" * len(buf)
    except Exception:
        pass


def _client_ip(request: Request) -> str:
    if not LOG_CLIENT_IP:
        return "-"

    candidate = request.client.host if request.client else "unknown"
    if TRUST_PROXY_HEADERS:
        forwarded = request.headers.get("x-forwarded-for", "")
        if forwarded:
            candidate = forwarded.split(",", 1)[0].strip()

    # Never allow arbitrary header text into the persistent log.
    try:
        return str(ipaddress.ip_address(candidate))
    except ValueError:
        return "unknown"


def _language_from_request(request: Request) -> str | None:
    raw = request.headers.get("x-transcription-language", "").strip()
    if not raw or raw.lower() == "auto":
        return None
    if len(raw) > 16 or not LANGUAGE_RE.fullmatch(raw):
        raise HTTPException(400, "Invalid X-Transcription-Language header")
    return raw.lower()


def _parse_pcm_wav(payload: bytearray) -> np.ndarray:
    """Parse exactly the format emitted by this application's browser client.

    Accepted input is RIFF/WAVE, PCM integer, mono, 16 kHz, 16 bit. Restricting
    the endpoint to one simple format avoids invoking a general media decoder
    (FFmpeg/PyAV) and therefore removes another class of hidden temp/cache paths.
    The returned float32 waveform is RAM-backed and is wiped after inference.
    """
    if len(payload) < 44 or payload[0:4] != b"RIFF" or payload[8:12] != b"WAVE":
        raise HTTPException(415, "Expected a PCM WAV request body")

    declared_size = struct.unpack_from("<I", payload, 4)[0] + 8
    if declared_size > len(payload):
        raise HTTPException(400, "Truncated WAV body")

    fmt = None
    data_offset = None
    data_size = None
    cursor = 12
    boundary = min(declared_size, len(payload))

    while cursor + 8 <= boundary:
        chunk_id = bytes(payload[cursor:cursor + 4])
        chunk_size = struct.unpack_from("<I", payload, cursor + 4)[0]
        chunk_start = cursor + 8
        chunk_end = chunk_start + chunk_size
        if chunk_end > boundary:
            raise HTTPException(400, "Malformed WAV chunk")

        if chunk_id == b"fmt ":
            if chunk_size < 16:
                raise HTTPException(400, "Malformed WAV format chunk")
            fmt = struct.unpack_from("<HHIIHH", payload, chunk_start)
        elif chunk_id == b"data" and data_offset is None:
            data_offset = chunk_start
            data_size = chunk_size

        cursor = chunk_end + (chunk_size & 1)

    if fmt is None or data_offset is None or data_size is None:
        raise HTTPException(400, "WAV is missing format or audio data")

    audio_format, channels, sample_rate, _byte_rate, block_align, bits_per_sample = fmt
    if (audio_format, channels, sample_rate, block_align, bits_per_sample) != (1, 1, SAMPLE_RATE, 2, 16):
        raise HTTPException(415, "Expected 16 kHz mono 16-bit PCM WAV")
    if data_size % 2:
        raise HTTPException(400, "PCM data length is not sample-aligned")

    # View the request bytearray directly; do not create an immutable PCM copy.
    pcm = np.frombuffer(payload, dtype="<i2", count=data_size // 2, offset=data_offset)
    audio = pcm.astype(np.float32)
    audio *= (1.0 / 32768.0)
    return audio


def resolve_tls():
    """Return TLS files. TLS is required unless plaintext was explicitly enabled."""
    mode = (os.getenv("VTS_TLS_ENABLED") or os.getenv("TLS_ENABLED", "1")).strip().lower()
    cert = Path(os.getenv("TLS_CERT") or (ROOT / "fullchain.pem")).expanduser()
    key = Path(os.getenv("TLS_KEY") or (ROOT / "privkey.pem")).expanduser()

    if mode in FALSE_VALUES:
        return None, None
    if mode not in TRUE_VALUES:
        raise RuntimeError("TLS_ENABLED must be 1/true/on or 0/false/off")

    absent = [str(p) for p in (cert, key) if not p.is_file()]
    if absent:
        raise RuntimeError(
            "TLS is required by default, but certificate material is missing: "
            + ", ".join(absent)
            + ". Provide TLS_CERT/TLS_KEY (or fullchain.pem/privkey.pem beside server.py), "
              "or explicitly opt into plaintext with the installer --allow-plaintext flag."
        )
    return str(cert), str(key)


log.info("event=model_loading device=%s compute=%s", DEVICE, COMPUTE_TYPE)
model = WhisperModel(
    str(MODEL_DIR),
    device=DEVICE,
    compute_type=COMPUTE_TYPE,
    cpu_threads=int(os.getenv("CPU_THREADS", "0")),
    num_workers=int(os.getenv("MODEL_WORKERS", "1")),
    local_files_only=True,
)
log.info("event=model_ready")


class DirectEcapaEmbedder:
    """Load only the local speaker embedding network; never invoke Hub/cache code."""

    def __init__(self, embed_dir: Path, device: str):
        import torch
        from hyperpyyaml import load_hyperpyyaml

        with open(embed_dir / "hyperparams.yaml", encoding="utf-8") as handle:
            hparams = load_hyperpyyaml(handle, {"pretrained_path": str(embed_dir)})

        self.device = device
        self.features = hparams["compute_features"].to(device)
        self.norm = hparams.get("mean_var_norm") or hparams.get("mean_var_norm_emb")
        self.model = hparams["embedding_model"].to(device)
        self.model.load_state_dict(
            torch.load(embed_dir / "embedding_model.ckpt", map_location=device)
        )
        self.model.eval()
        for module in (self.features, self.norm):
            if module is not None and hasattr(module, "eval"):
                module.eval()

    def release_cached_memory(self) -> None:
        """Return PyTorch's cached-but-unused CUDA blocks to the driver.

        Without this the caching allocator keeps the largest request's working
        set reserved for the life of the process, which is what nvidia-smi shows.
        """
        import torch

        if str(self.device).startswith("cuda") and torch.cuda.is_available():
            torch.cuda.empty_cache()

    def encode_batch(self, wavs, wav_lens):
        device_wavs = None
        device_lens = None
        feats = None
        try:
            device_wavs = wavs.to(self.device)
            device_lens = wav_lens.to(self.device)
            feats = self.features(device_wavs)
            if self.norm is not None:
                feats = self.norm(feats, device_lens)
            return self.model(feats, device_lens)
        finally:
            # Best-effort sanitisation of application-owned tensor buffers. This
            # does not pretend to control copies held inside CUDA/runtime internals.
            for tensor in (feats, device_wavs, device_lens):
                try:
                    if tensor is not None:
                        tensor.zero_()
                except Exception:
                    pass


embedder = None
embedder_error = None
if DIARIZE not in FALSE_VALUES:
    try:
        if not EMBED_DIR.is_dir():
            raise FileNotFoundError(
                f"{EMBED_DIR} not found - run python3 install.py install --with-diarization once"
            )
        embedder = DirectEcapaEmbedder(EMBED_DIR, DEVICE)
        log.info("event=embedding_model_ready backend=DirectEcapaEmbedder")
    except Exception as exc:
        embedder = None
        embedder_error = type(exc).__name__
        if DIARIZE in TRUE_VALUES:
            raise RuntimeError(
                f"DIARIZE is set but speaker embeddings are unavailable ({type(exc).__name__})"
            ) from None
        log.warning("event=embedding_model_unavailable error=%s", type(exc).__name__)


# One embedding pass on the GPU at a time: concurrent requests would otherwise
# stack their peak working sets on top of each other.
_embed_lock = threading.Lock()


def plan_embedding_batches(spans: list[tuple[int, int]], max_padded_samples: int) -> list[list[int]]:
    """Group segment indices into batches whose padded size stays bounded.

    A batch is padded to its longest clip, so its memory cost is
    len(batch) * longest. Sorting by length keeps similar clips together (less
    padding); a single clip longer than the budget still gets its own batch.
    """
    order = sorted(range(len(spans)), key=lambda i: spans[i][1] - spans[i][0])
    batches: list[list[int]] = []
    current: list[int] = []
    for i in order:
        length = spans[i][1] - spans[i][0]
        # Sorted ascending, so this clip is the longest in the batch if added.
        if current and (len(current) + 1) * length > max_padded_samples:
            batches.append(current)
            current = []
        current.append(i)
    if current:
        batches.append(current)
    return batches


def _embed_one_batch(audio: np.ndarray, spans: list[tuple[int, int]]) -> list[list[float]]:
    import torch

    longest = max(end - start for start, end in spans)
    batch = torch.zeros(len(spans), longest)
    lengths = torch.zeros(len(spans))
    device_vectors = None
    vectors = None
    try:
        for i, (start, end) in enumerate(spans):
            batch[i, : end - start] = torch.from_numpy(audio[start:end])
            lengths[i] = (end - start) / longest
        with torch.no_grad():
            device_vectors = embedder.encode_batch(batch, wav_lens=lengths).squeeze(1)
            vectors = device_vectors.float().cpu()
        return [[round(float(v), 5) for v in vec] for vec in vectors.tolist()]
    finally:
        for tensor in (batch, lengths, device_vectors, vectors):
            try:
                if tensor is not None:
                    tensor.zero_()
            except Exception:
                pass


def embed_segments(audio: np.ndarray, rows: list[dict]) -> None:
    if embedder is None or not rows:
        return

    picked: list[int] = []
    spans: list[tuple[int, int]] = []
    for index, row in enumerate(rows):
        start = max(0, int(row["start"] * SAMPLE_RATE))
        end = min(len(audio), int(row["end"] * SAMPLE_RATE))
        if (end - start) < int(EMBED_MIN_SEC * SAMPLE_RATE):
            continue
        picked.append(index)
        spans.append((start, end))
    if not spans:
        return

    budget = int(EMBED_BATCH_SEC * SAMPLE_RATE)
    with _embed_lock:
        try:
            for group in plan_embedding_batches(spans, budget):
                vectors = _embed_one_batch(audio, [spans[i] for i in group])
                for i, vector in zip(group, vectors):
                    rows[picked[i]]["embedding"] = vector
        except Exception as exc:
            # Never persist model/library error text: only the exception class.
            # All-or-nothing, as before: no partially embedded response.
            for index in picked:
                rows[index].pop("embedding", None)
            log.warning("event=speaker_embedding_failed error=%s", type(exc).__name__)
        finally:
            try:
                embedder.release_cached_memory()
            except Exception as exc:
                log.warning("event=cuda_cache_release_failed error=%s", type(exc).__name__)


def transcribe_in_memory(payload: bytearray, language: str | None) -> tuple[dict, float]:
    audio = None
    try:
        audio = _parse_pcm_wav(payload)
        duration_sec = len(audio) / SAMPLE_RATE

        # The original encoded request is no longer needed once float32 PCM exists.
        _wipe_bytearray(payload)

        segments, info = model.transcribe(
            audio,
            language=language,
            beam_size=1,
            vad_filter=True,
            condition_on_previous_text=False,
        )
        rows = [
            {"start": round(s.start, 2), "end": round(s.end, 2), "text": s.text.strip()}
            for s in segments
            if s.text.strip()
        ]
        embed_segments(audio, rows)
        embedded = sum(1 for row in rows if "embedding" in row)
        body = {
            "language": info.language,
            "diarization": embedder is not None,
            "embedded_segments": embedded,
            "duration": round(info.duration, 2),
            "text": " ".join(row["text"] for row in rows),
            "segments": rows,
        }
        return body, duration_sec
    finally:
        if audio is not None:
            try:
                audio.fill(0.0)
            except Exception:
                pass


async def read_bounded_body(request: Request) -> bytearray:
    declared = request.headers.get("content-length")
    if declared:
        try:
            declared_n = int(declared)
        except ValueError:
            raise HTTPException(400, "Invalid Content-Length") from None
        if declared_n < 0:
            raise HTTPException(400, "Invalid Content-Length")
        if declared_n > MAX_BODY_BYTES:
            raise HTTPException(413, f"Request body exceeds the {MAX_BODY_MB:g} MiB RAM limit")
    else:
        declared_n = None

    body = bytearray()
    try:
        async for chunk in request.stream():
            if not chunk:
                continue
            if len(body) + len(chunk) > MAX_BODY_BYTES:
                raise HTTPException(413, f"Request body exceeds the {MAX_BODY_MB:g} MiB RAM limit")
            body.extend(chunk)
        if declared_n is not None and len(body) != declared_n:
            raise HTTPException(400, "Request body length did not match Content-Length")
        if not body:
            raise HTTPException(400, "Empty audio request body")
        return body
    except Exception:
        _wipe_bytearray(body)
        raise


ACTIVE_TRANSPORT = "unknown"

app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)


@app.middleware("http")
async def force_no_store(request: Request, call_next):
    response = await call_next(request)
    for key, value in NO_STORE_HEADERS.items():
        response.headers[key] = value
    return response


@app.get("/healthz")
def health():
    body = {
        "status": "ready",
        "service": PROJECT_ID,
        "name": PROJECT_NAME,
        "build": BUILD_NUMBER,
        "diarization": embedder is not None,
        "stores_audio": False,
        "stores_transcripts": False,
        "retention_supported": False,
        "content_persistence": "none",
        "request_payload_storage": "memory_only",
        "transport_security": ACTIVE_TRANSPORT,
        "input": "pcm_s16le_wav_16000_mono",
        "max_body_bytes": MAX_BODY_BYTES,
    }
    if embedder is None and DIARIZE not in FALSE_VALUES:
        body["diarization_error"] = embedder_error or "disabled"
    elif embedder is not None:
        body["embedding_backend"] = type(embedder).__name__
    return JSONResponse(body, headers=NO_STORE_HEADERS)


@app.post("/transcribe")
async def transcribe(request: Request):
    started = time.monotonic()
    source_ip = _client_ip(request)
    payload = None
    size_bytes = 0

    media_type = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
    if media_type not in SUPPORTED_CONTENT_TYPES:
        log.info("event=request_rejected ip=%s status=415 reason=content_type", source_ip)
        raise HTTPException(415, "POST raw audio/wav bytes; multipart uploads are not accepted")

    try:
        language = _language_from_request(request)
        payload = await read_bounded_body(request)
        size_bytes = len(payload)
        body, audio_sec = await run_in_threadpool(transcribe_in_memory, payload, language)
        latency_ms = round((time.monotonic() - started) * 1000)
        log.info(
            "event=transcribe ip=%s status=200 bytes=%d audio_ms=%d latency_ms=%d",
            source_ip,
            size_bytes,
            round(audio_sec * 1000),
            latency_ms,
        )
        return JSONResponse(body, headers=NO_STORE_HEADERS)
    except HTTPException as exc:
        latency_ms = round((time.monotonic() - started) * 1000)
        log.info(
            "event=request_rejected ip=%s status=%d bytes=%d latency_ms=%d",
            source_ip,
            exc.status_code,
            size_bytes,
            latency_ms,
        )
        raise
    except Exception as exc:
        latency_ms = round((time.monotonic() - started) * 1000)
        log.warning(
            "event=transcribe_error ip=%s status=500 bytes=%d latency_ms=%d error=%s",
            source_ip,
            size_bytes,
            latency_ms,
            type(exc).__name__,
        )
        raise HTTPException(500, "Transcription failed") from None
    finally:
        _wipe_bytearray(payload)


if __name__ == "__main__":
    certfile, keyfile = resolve_tls()
    scheme = "https" if certfile else "http"
    ACTIVE_TRANSPORT = "tls" if certfile else "plaintext"
    log.info(
        "event=listen scheme=%s host=%s port=%d payload_storage=memory_only content_persistence=none",
        scheme,
        HOST,
        PORT,
    )

    # log_config=None prevents Uvicorn from replacing the privacy-oriented logger;
    # access_log=False prevents request URLs/IPs being duplicated elsewhere.
    for logger_name in ("uvicorn", "uvicorn.error", "uvicorn.access"):
        logger = logging.getLogger(logger_name)
        logger.handlers.clear()
        logger.propagate = True
        logger.setLevel(logging.WARNING)

    uvicorn.run(
        app,
        host=HOST,
        port=PORT,
        ssl_certfile=certfile,
        ssl_keyfile=keyfile,
        access_log=False,
        server_header=False,
        log_config=None,
    )
