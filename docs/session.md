# Source and page evidence sessions

`sceneproof session session.ts --out artifacts/run` runs a checkout-owned script
through one SceneProof-owned **host-headless** browser and page. No consumer
imports from `src/browser-runtime`, external browser session, or separate capture
backend is needed. The host chooses the GPU (environment, job runner); the
receipt records the actual adapter, `VK_DRIVER_FILES`, observed fixture device
admissions and, when set, `SCENEPROOF_GPU_VENDOR`: the adapter vendor the caller
expects, which makes the session fail if the browser picked another GPU. WebGPU admission rejects missing/software/fallback
adapters. This does not prove an application draw unless its own ready/fence and
evidence controls establish that draw.

CLI surface: `session <module> --out <fresh-directory> [--export <name>]
[--props <JSON-or-file>] [--width <logical-pixels>] [--height <logical-pixels>]
[--scale <source-DPR>] [--region x,y,width,height] [--source-overlays <manifest>]
[--resume]`. Device selection belongs to the host, not a GPU flag on this
command. A source-DPR zoom creates new source pixels; never enlarge a saved crop
and present it as source zoom evidence.

```ts
import { defineSession, frameClock } from "sceneproof/session";

export default defineSession({
  source: { entry: "/absolute/checkout/scripts/sceneproof/real.scene.tsx",
    export: "realReview", aliases: {}, css: [] },
  viewport: { width: 1920, height: 1080, scale: 1 },
  identity: () => ({ camera: "supply actual camera identity", seed: 123 }),
  async run(session) {
    function* rows() {
      for (let index = 0; index < 150; index += 1)
        yield { index, clock: frameClock(index) }; // exact index/30 seconds
    }
    await session.frames({ id: "native", rows: rows(),
      restore: async row => { await session.invoke("seek", row); } });
  },
});
```

The React fixture exports `actions`, asynchronous `seek(frame)`, `settle`,
`fence`, and optional `dispose` alongside `ready`, `document`, `render`.
`fence` is the real owner's committed-draw signal, not a generic guessed sleep.
For page mode, the source page or passive init adapter declares equivalent
controls on `globalThis.__SCENEPROOF_CONTROLS__`. `session.invoke(name, input)`
uses its `actions[name]` or named method. `session.page` is a supported public
Playwright Page for domain callbacks; it is already owned/admitted and must not
be replaced by a consumer-created browser.

For long or layered recordings handed to a compositor, see
[Recording a real app or scene over time](../skills/sceneproof/references/long-captures.md).

## Page mode and local resources

Declare `page: {url, sourcePins}` to reuse a source server, or
`page: {async start({props}) { return {url, sourcePins, dispose}; }}` to own one.
URLs are credential-free loopback HTTP(S). Pins map absolute source filenames
to `sha256:<hex>` and are checked before loading. A URL without pins is recorded
as URL-only evidence, not an asserted source build. `ready(session)` must await
the real page owner. Cleanup closes the browser and calls only the returned
owned server disposer, even after an action or fence rejects.

`init: [browserModulePath]` installs bundled passive modules before source load.
Each may export a synchronous default initializer; they must not await setup
that needs the page's later source. `routes: [{pattern, identity, handle}]`
mounts browser-context resource handlers before load, including dedicated
worker entry scripts, worker module imports and worker fetches; `handle`
receives Playwright Route. The loopback guard runs before these handlers.
Relative `/packs/*`, `/api/asset-packs/keys`, WASM and review routes thus keep one
origin/lifecycle. External HTTP requests and service workers are not admitted.

`ready(predicate)` observes a browser predicate until it resolves; predicates
must be self-contained browser functions (no host closure variables).
`click(selector)` provides genuine headless input activation for WebAudio.
`capture({name,region?})` writes native PNG pixels at the session's source DPR,
never upscales a saved raster. `evidence(name,value)` writes JSON;
`binary(name,bytes,mime?)` writes arbitrary binary evidence. Names are relative
to the owned output directory and never overwrite previous artifacts.

## Streaming and interruption

`frames({id,rows,seek?,fence?,restore?,region?})` consumes iterable or async
iterable rows lazily. A row contains `index`, rational seconds `clock`, optional
domain `input`. It awaits seek, awaits the owner fence, then publishes the PNG
and a per-frame receipt before requesting another row. Receipts store the row,
identity and saved-byte hash. There is no frame count cap or accumulated
integer-millisecond clock. Only the current image is retained in memory.

`--resume` requires the same source/bundle, module, props, routes, overlays,
viewport/DPR, executing engine fingerprint, backend, adapter, driver selection and explicit domain identity
(camera, seeds, asset/manifest pins) and default `--region`. Every committed
frame of a sequence must be matched, in order, by its first incoming rows (same
row, crop and saved PNG hash) before any source action; only then does it invoke
`restore(lastCompletedRow)` once and continue. Missing receipts are incomplete
frames, even when an orphan PNG exists. Corruption, changed inputs or crop, a
non-prefix checkpoint, rows that end before every committed frame is matched,
and missing restore capability fail closed. Restore must rebuild actual domain state; never reuse a dead GPU object
or silently replay a live/provider/audio turn. Completed artifacts remain
immutable; attempt cleanup and completion receipts have independent names.

Existing legacy Three `--frames` presentation/packaging remains unchanged; the
streaming session path does not inherit its old 180/240 frame constraints.

## External checkouts and native capture

The CLI resolves every exported public `sceneproof/*` entry from its own
installation. External session modules need no local SceneProof dependency,
symlink, or private source import. Local helper modules are bundled while their
original `import.meta.dir`, `import.meta.path`, and `import.meta.url` are
preserved. Their bundled source digest participates in resume identity. Other
installed dependencies resolve from the consumer checkout. The linked CLI
does not automatically load private environment files; supplied process
environment remains owned by the caller and gate.

Native WebGPU canvases default to `nativeCapture: "readback"`. SceneProof
copies the actual source swapchain draw before headless presentation discards
it, reads those pixels, and composites them in place with the source DOM for
capture. PNG sidecars explicitly identify
`native-framebuffer-readback-composite`; this is not desktop compositor proof.
It does not replace source geometry, materials, compute, camera, or draw fence.
`nativeCapture: "presentation"` instead captures the browser's presented DOM
without the native readback path. Native readback staging is disabled during
CPU measurement windows. SIGINT/SIGTERM close the owned browser so pending page
actions unwind through the same server cleanup path.
`measure()` pauses the native capture hook before its start clock; source
actions, submissions and source-owned readbacks continue unchanged. It stays
paused until a later explicit seek/fence/settle or frame sequence arms capture.
PNG/frame capture inside a CPU window is rejected, rather than contaminating
that window with SceneProof readback work.

## Separate CPU and GPU windows

```ts
export default defineSession({
  // ...source or page, ready and actual device controls...
  gpuTimings: true, // request timestamp-query before the owner loads
  async run(session) {
    await session.measure({ name: "cpu.json", longTasks: true,
      run: s => s.invoke("idleAndNewRow") });
    await session.gpuTimings({ name: "gpu",
      run: s => s.invoke("drawMeasuredRows") });
  },
});
```

`measure` records browser wall elapsed time, optional supported long-task
entries and returned owner telemetry. Wall time is not mislabeled as GPU time
or pure main-thread execution. `gpuTimings` reads actual WebGPU timestamp
queries around render/compute passes, streams per-pass samples to separate
JSON artifacts, and records device identities and online count/min/max/mean
summaries. A queue fence is never used as GPU duration. Unsupported devices,
unsubmitted passes, existing owner timestamp writes or collection errors are
reported explicitly. CPU and GPU windows cannot overlap. GPU timing is a
diagnostic run, not a claim that instrumentation-free production has identical
performance.
