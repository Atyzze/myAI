# HTTP protocol

## Health

`GET /healthz`

The response is JSON and carries no-store cache headers. Important fields:

    status: "ready"
    stores_audio: false
    stores_transcripts: false
    retention_supported: false
    content_persistence: "none"
    request_payload_storage: "memory_only"
    transport_security: "tls" | "plaintext"
    input: "pcm_s16le_wav_16000_mono"
    max_body_bytes: <integer>
    device: "cuda" | "cpu"          (resolved, after DEVICE=auto)
    compute_type: <string>          (for example float16 or int8)
    model: <string>                 (name of the Whisper model folder)

The installer uses these fields as part of deployment verification. Managed
installs require `transport_security: "tls"` unless the operator explicitly used
`--allow-plaintext`.

## Transcribe

`POST /transcribe`

Required:

    Content-Type: audio/wav

Optional:

    X-Transcription-Language: en

Omit the language header (or send `auto`) for model auto-detection.

The request body is the WAV file itself, not a multipart form. Accepted audio is
strictly:

- RIFF/WAVE;
- PCM integer format 1;
- one channel;
- 16,000 Hz;
- 16 bits/sample, little-endian.

The default body cap is 8 MiB (`MAX_BODY_MB`). Oversized bodies are refused while
streaming; they are not accepted and then spilled to a temporary file.

Successful response shape:

    {
      "language": "en",
      "diarization": true,
      "embedded_segments": 3,
      "duration": 12.34,
      "text": "...",
      "segments": [
        {"start": 0.0, "end": 2.1, "text": "...", "embedding": [...]}
      ]
    }

`embedding` is present only when optional diarization support is installed and a
segment is long enough to embed.

All application responses include cache-prevention headers. The API exposes no
retention or backup parameter by design.

## Why `/healthz` exists

`/healthz` is a lightweight GET endpoint for installers, service managers and
operators. It never accepts recording content. It reports whether VTS is ready,
which VTS build answered, the configured transport mode, and the server's
non-retention/privacy capabilities. The installer uses it to detect stale or
foreign processes on the expected port and to verify that the running service
matches the release being installed.
