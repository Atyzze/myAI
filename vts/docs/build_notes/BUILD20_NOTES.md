# VTS Build 20

Build 20 fixes VRAM that grew by several GiB while the service ran and only
came back down after a restart.

- cause: speaker embeddings for all of a request's segments ran as a single
  batch, zero-padded to the request's longest segment. ECAPA needs about 0.5 GiB
  of activations per 30 s of padded audio, so a recording near the 8 MiB body
  limit with one ~30 s segment and a dozen short ones needed ~6 GiB for one pass;
  PyTorch's caching allocator then kept that peak reserved for the life of the
  process, and concurrent requests could stack their peaks;
- embeddings now run in length-sorted micro-batches capped at `EMBED_BATCH_SEC`
  (default 30) seconds of padded audio, so the embedding peak is ~0.5 GiB
  whatever the request length; sorting also cuts padding, and returned vectors
  match the previous ones (cosine ~1.0 on test audio);
- one embedding pass runs at a time (`threading.Lock`), and cached CUDA blocks
  are handed back to the driver with `torch.cuda.empty_cache()` after every
  request, so VRAM returns to baseline between requests;
- `PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True` is set by default (an
  operator-provided value wins) to limit fragmentation from varying shapes;
- the feature extractor and input normalisation are also put in eval mode, not
  only the embedding network;
- `server.env.example` documents `EMBED_BATCH_SEC`; new tests cover the batch
  planner and the memory invariants.

Release gate: 70 tests passed.
