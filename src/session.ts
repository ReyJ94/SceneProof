import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Page, Route } from "playwright-core";
import { launchBrowser } from "./browser-runtime.js";
import { reactDriverSource } from "./react-renderer.js";
import { installNativeCanvasCapture } from "./session-canvas.js";
import { streamFrames } from "./session-frames.js";
import {
  addGpuSample,
  type GpuPassSummary,
  installGpuTimings,
} from "./session-gpu.js";
import { loadSessionModule } from "./session-loader.js";
import {
  atomicArtifact,
  canonical,
  frameClock as clockAtFrame,
  digest,
  type RationalClock,
  readReceipt,
} from "./session-store.js";
import {
  type BrowserBundle,
  bundleBrowserDriver,
  type SourceOverlay,
} from "./source-bundle.js";

const SOURCE_SEPARATOR = /[\\/]/;
const HTTP_REQUEST = /^https?:/;
const SOFTWARE_ADAPTER = /swiftshader|software|llvmpipe|lavapipe/i;
const MEASUREMENT_ID = /^[a-zA-Z0-9_-]+$/;
const loadedSessionBundles = new WeakMap<SessionDefinition, string>();

export type SessionFrame = {
  index: number;
  clock: RationalClock;
  input?: unknown;
};
export type SessionArtifact = { path: string; bytes: number; sha256: string };
export type SessionRoute = {
  pattern: string;
  handle: (route: Route) => void | Promise<void>;
  identity: unknown;
};
export type SessionStart = {
  url: string;
  sourcePins: Record<string, string>;
  dispose: () => void | Promise<void>;
};
export type SessionSource = {
  entry: string;
  export?: string;
  props?: Record<string, unknown>;
  aliases?: Record<string, string>;
  css?: string[];
  /** Inline by default; disable for large bundles sent over Chromium's DevTools pipe. */
  sourcemap?: "inline" | false;
  sourceOverlays?: SourceOverlay[];
};
export type SessionDefinition = {
  /** Source mode currently mounts React; native canvases stay owned by that fixture. */
  source?: SessionSource;
  page?: {
    url?: string;
    start?: (context: {
      props: Record<string, unknown>;
    }) => Promise<SessionStart>;
    sourcePins?: Record<string, string>;
  };
  init?: string[];
  routes?: SessionRoute[];
  props?: Record<string, unknown>;
  viewport?: { width: number; height: number; scale?: number };
  backend?: "webgl" | "webgpu";
  /** Negotiate timestamp-query before source requests devices; collect only in explicit GPU windows. */
  gpuTimings?: boolean;
  /** Native readback is labeled explicitly, not promoted to desktop presentation proof. */
  nativeCapture?: "readback" | "presentation";
  /** Stable camera, seeds, assets and domain state identities required for resume. */
  identity?: (session: SessionContext) => unknown | Promise<unknown>;
  ready?: (session: SessionContext) => void | Promise<void>;
  run: (session: SessionContext) => void | Promise<void>;
};
export type FrameSequence = {
  id: string;
  rows: Iterable<SessionFrame> | AsyncIterable<SessionFrame>;
  seek?: (frame: SessionFrame) => void | Promise<void>;
  fence?: (frame: SessionFrame) => void | Promise<void>;
  restore?: (frame: SessionFrame) => void | Promise<void>;
  region?: { x: number; y: number; width: number; height: number };
};
export type SessionContext = {
  /** Public, session-owned page for typed domain callbacks; never launch another browser. */
  page: Page;
  props: Record<string, unknown>;
  resumed: boolean;
  ready: (predicate: () => boolean | Promise<boolean>) => Promise<void>;
  invoke: (name: string, input?: unknown) => Promise<unknown>;
  click: (selector: string) => Promise<void>;
  capture: (options: {
    name: string;
    region?: { x: number; y: number; width: number; height: number };
  }) => Promise<SessionArtifact>;
  evidence: (name: string, value: unknown) => Promise<SessionArtifact>;
  binary: (
    name: string,
    bytes: Uint8Array,
    mime?: string
  ) => Promise<SessionArtifact>;
  frames: (
    sequence: FrameSequence
  ) => Promise<{ committed: number; reused: number }>;
  measure: (options: {
    name: string;
    run: (session: SessionContext) => unknown | Promise<unknown>;
    longTasks?: boolean;
  }) => Promise<SessionArtifact>;
  gpuTimings: (options: {
    name: string;
    run: (session: SessionContext) => unknown | Promise<unknown>;
  }) => Promise<SessionArtifact>;
};
export type SessionOptions = {
  out: string;
  resume?: boolean;
  modulePath?: string;
  props?: Record<string, unknown>;
  width?: number;
  height?: number;
  scale?: number;
  region?: { x: number; y: number; width: number; height: number };
  sourceOverlays?: SourceOverlay[];
};

export function defineSession(
  definition: SessionDefinition
): SessionDefinition {
  return definition;
}
export function frameClock(index: number, fps?: RationalClock): RationalClock {
  return clockAtFrame(index, fps);
}

export function loopbackUrl(value: string): URL {
  const url = new URL(value);
  if (
    !(
      ["http:", "https:"].includes(url.protocol) &&
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    ) ||
    url.username ||
    url.password
  ) {
    throw new Error(
      "Session page mode requires a credential-free loopback URL."
    );
  }
  return url;
}
function checkSourcePath(path: string): string {
  const absolute = resolve(path);
  if (
    absolute.split(SOURCE_SEPARATOR).some((part) => part.startsWith(".env"))
  ) {
    throw new Error("Private configuration is not a session source.");
  }
  return absolute;
}
function positive(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be positive and finite.`);
  }
  return value;
}

/** Browser ready predicate observes actual frames, never a guessed wall-time budget. */
async function waitReady(
  page: Page,
  predicate: () => boolean | Promise<boolean>,
  errors: string[]
) {
  if (errors.length) {
    throw new Error(errors.join("\n"));
  }
  let onError: (error: Error) => void = () => {
    /* Installed synchronously by the promise below. */
  };
  const failed = new Promise<never>((_resolve, reject) => {
    onError = reject;
    page.on("pageerror", onError);
  });
  try {
    await Promise.race([
      page.waitForFunction(predicate, undefined, { timeout: 0 }),
      failed,
    ]);
  } finally {
    page.off("pageerror", onError);
  }
  if (errors.length) {
    throw new Error(errors.join("\n"));
  }
}

function invoke(page: Page, name: string, input?: unknown): Promise<unknown> {
  return page.evaluate(
    async ({ control, argument }) => {
      const controls = Reflect.get(globalThis, "__SCENEPROOF_CONTROLS__");
      const operation = controls?.actions?.[control] ?? controls?.[control];
      if (typeof operation !== "function") {
        throw new Error(
          `Session control ${control} is not declared by the fixture/page.`
        );
      }
      const result = await operation.call(controls, argument);
      return result === undefined ? null : result;
    },
    { argument: input ?? null, control: name }
  );
}

function sourceBundle(
  source: SessionSource,
  props: Record<string, unknown>,
  viewport: { width: number; height: number },
  overlays: SourceOverlay[]
) {
  const entry = checkSourcePath(source.entry);
  const input = {
    aliases: source.aliases ?? {},
    css: source.css ?? [],
    entry,
    exportName: source.export ?? "default",
    height: viewport.height,
    props: source.props ?? props,
    width: viewport.width,
  };
  return bundleBrowserDriver({
    aliases: input.aliases,
    entry,
    extraCss: input.css,
    source: reactDriverSource(input),
    sourcemap: source.sourcemap ?? "inline",
    sourceOverlays: overlays,
  });
}

/** Preserve the source document while rejecting oversized Fetch.fulfillRequest bodies. */
export function sessionSourceHtml(bundle: BrowserBundle): string {
  const html = `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;min-height:100%;}#uiscene-root{min-width:1px;min-height:1px;}${bundle.css.replaceAll("</style", "<\\/style")}</style><div id="uiscene-root"></div><script>${bundle.javascript.replaceAll("</script", "<\\/script")}</script>`;
  const htmlBytes = Buffer.byteLength(html, "utf8");
  // Playwright base64-encodes the response body for CDP. Leave room for its envelope.
  const pipeBodyBytes = 4 * Math.ceil(htmlBytes / 3);
  if (pipeBodyBytes > 90 * 1024 * 1024) {
    throw new Error(
      `SceneProof source page HTML is ${htmlBytes} bytes (${(htmlBytes / 1024 / 1024).toFixed(2)} MiB); its base64 DevTools pipe body is ${pipeBodyBytes} bytes (${(pipeBodyBytes / 1024 / 1024).toFixed(2)} MiB), above the 90 MiB safety threshold for Chromium's 100 MB (100 MiB, 104857600 bytes) pipe message cap. Large inline source maps can cause Chromium to close the connection: set \`source.sourcemap: false\`. If it still does not fit, serve the page over a local HTTP server using session page mode instead of inlining it over the pipe.`
    );
  }
  return html;
}

/** One owner holds the browser, page, resource server, evidence and cleanup. */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: The session transaction owns admission, route/init ordering, provenance, artifacts, and finally cleanup together.
export async function runSession(
  definition: SessionDefinition,
  options: SessionOptions
) {
  if (Boolean(definition.source) === Boolean(definition.page)) {
    throw new Error("Declare exactly one session source or page.");
  }
  const viewport = {
    height: positive(
      options.height ?? definition.viewport?.height ?? 720,
      "height"
    ),
    scale: positive(options.scale ?? definition.viewport?.scale ?? 1, "scale"),
    width: positive(
      options.width ?? definition.viewport?.width ?? 1280,
      "width"
    ),
  };
  const props = options.props ?? definition.props ?? {};
  const directory = resolve(options.out);
  if (options.resume) {
    await realpath(directory);
  } else {
    await mkdir(dirname(directory), { recursive: true });
    await mkdir(directory);
  }
  const attempt = randomUUID();
  const overlays = [
    ...(definition.source?.sourceOverlays ?? []),
    ...(options.sourceOverlays ?? []),
  ];
  const initBundles: BrowserBundle[] = [];
  for (const entry of definition.init ?? []) {
    const path = checkSourcePath(entry);
    initBundles.push(
      // biome-ignore lint/performance/noAwaitInLoops: Init provenance must preserve declaration order.
      await bundleBrowserDriver({
        discoverCss: false,
        entry: path,
        extraCss: [],
        source: `import * as Init from ${JSON.stringify(path)}; if (typeof Init.default === 'function') Init.default(${JSON.stringify(props)});`,
        sourcemap: definition.source?.sourcemap ?? "inline",
      })
    );
  }
  const bundle = definition.source
    ? await sourceBundle(definition.source, props, viewport, overlays)
    : null;
  const html = bundle ? sessionSourceHtml(bundle) : null;
  let started: SessionStart | undefined;
  let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined;
  let page: Page | undefined;
  const errors: string[] = [];
  let completed = false;
  let primaryError: unknown;
  let interrupted = false;
  const interrupt = () => {
    if (interrupted) {
      return;
    }
    interrupted = true;
    errors.push("Session interrupted by signal; owned resources are closing.");
    browser?.close().catch((error) => {
      errors.push(String(error));
    });
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  try {
    if (definition.page?.start) {
      started = await definition.page.start({ props });
    }
    if (errors.length) {
      throw new Error(errors.join("\n"));
    }
    const url = loopbackUrl(
      started?.url ?? definition.page?.url ?? "http://127.0.0.1/sceneproof"
    );
    if (definition.page && !started && !definition.page.url) {
      throw new Error("Page mode requires url or start().");
    }
    const sourcePins = started?.sourcePins ?? definition.page?.sourcePins ?? {};
    for (const [path, expected] of Object.entries(sourcePins)) {
      // biome-ignore lint/performance/noAwaitInLoops: Validate each file pin before source loading.
      if (digest(await readFile(checkSourcePath(path))) !== expected) {
        throw new Error(`Source pin changed: ${path}`);
      }
    }
    browser = await launchBrowser({
      ownsSignals: true,
      threeBackend: definition.backend ?? "webgpu",
    });
    const context = await browser.newContext({
      deviceScaleFactor: viewport.scale,
      reducedMotion: "no-preference",
      serviceWorkers: "block",
      viewport: { height: viewport.height, width: viewport.width },
    });
    context.setDefaultTimeout(0);
    context.setDefaultNavigationTimeout(0);
    page = await context.newPage();
    const ownedPage = page;
    let measuring: "cpu" | "gpu" | null = null;
    let gpuWindow: {
      name: string;
      counter: number;
      summary: Record<string, GpuPassSummary>;
    } | null = null;
    await page.exposeBinding(
      "__SCENEPROOF_TIMESTAMP_SINK__",
      async (
        _source,
        sample: {
          device: number;
          pass: string;
          kind: string;
          milliseconds: number;
          frame: unknown;
        }
      ) => {
        if (!gpuWindow) {
          throw new Error(
            "Timestamp sample arrived outside its GPU diagnostic window."
          );
        }
        const window = gpuWindow;
        const index = window.counter;
        window.counter += 1;
        const key = `${sample.device}:${sample.kind}:${sample.pass}`;
        window.summary[key] = addGpuSample(
          window.summary[key],
          sample.milliseconds
        );
        await atomicArtifact(
          directory,
          `gpu/${window.name}/${index}.json`,
          canonical(sample)
        );
      }
    );
    page.on("pageerror", (error) => {
      errors.push(error.message);
    });
    page.on("console", (message) => {
      appendFile(
        resolve(directory, `console-${attempt}.jsonl`),
        `${JSON.stringify({ text: message.text(), type: message.type() })}\n`
      ).catch((error) => errors.push(String(error)));
    });
    for (const route of definition.routes ?? []) {
      // biome-ignore lint/performance/noAwaitInLoops: Route priority follows declaration order.
      await context.route(route.pattern, route.handle);
    }
    // Register admission last: context handlers run newest first, including workers.
    await context.route("**/*", async (route) => {
      const request = route.request().url();
      if (HTTP_REQUEST.test(request)) {
        try {
          loopbackUrl(request);
        } catch {
          errors.push(`Session blocked non-loopback request: ${request}`);
          await route.abort();
          return;
        }
      }
      await route.fallback();
    });
    await page.addInitScript(() => {
      Reflect.set(globalThis, "__name", (value: unknown) => value);
      const admissions: unknown[] = [];
      const losses: unknown[] = [];
      Reflect.set(globalThis, "__SCENEPROOF_DEVICE_ADMISSIONS__", admissions);
      Reflect.set(globalThis, "__SCENEPROOF_DEVICE_LOSSES__", losses);
      if (typeof GPUAdapter !== "undefined") {
        const request = GPUAdapter.prototype.requestDevice;
        GPUAdapter.prototype.requestDevice = async function (descriptor) {
          const device = await request.call(this, descriptor);
          admissions.push({
            architecture: this.info.architecture,
            description: this.info.description,
            device: this.info.device,
            features: [...device.features],
            isFallbackAdapter: this.info.isFallbackAdapter,
            vendor: this.info.vendor,
          });
          device.lost.then((info) => {
            if (info.reason !== "destroyed") {
              losses.push({ message: info.message, reason: info.reason });
            }
          });
          return device;
        };
      }
    });
    if (definition.gpuTimings) {
      await page.addInitScript(installGpuTimings);
    }
    if ((definition.nativeCapture ?? "readback") === "readback") {
      await page.addInitScript(installNativeCanvasCapture);
    }
    for (const init of initBundles) {
      // biome-ignore lint/performance/noAwaitInLoops: Init modules run in their declared order.
      await page.addInitScript({ content: init.javascript });
    }
    if (html !== null) {
      await page.route(url.href, (route) =>
        route.fulfill({
          body: html,
          contentType: "text/html",
        })
      );
    }
    await page.goto(url.href);
    const adapter = await page.evaluate(async () => {
      const selected = await navigator.gpu?.requestAdapter();
      return selected
        ? {
            architecture: selected.info.architecture,
            description: selected.info.description,
            device: selected.info.device,
            isFallbackAdapter: selected.info.isFallbackAdapter,
            vendor: selected.info.vendor,
          }
        : null;
    });
    if (
      (definition.backend ?? "webgpu") === "webgpu" &&
      (!adapter ||
        adapter.isFallbackAdapter ||
        SOFTWARE_ADAPTER.test(
          `${adapter.vendor} ${adapter.architecture} ${adapter.description}`
        ))
    ) {
      throw new Error(
        "Session WebGPU admission requires a real non-fallback hardware adapter."
      );
    }
    // Optional host assertion: the GPU the caller reserved must be the one the browser chose.
    const expectedVendor = process.env.SCENEPROOF_GPU_VENDOR;
    if (expectedVendor && adapter && adapter.vendor !== expectedVendor) {
      throw new Error(
        `Actual adapter ${adapter.vendor} does not match SCENEPROOF_GPU_VENDOR=${expectedVendor}.`
      );
    }
    const binary = async (
      name: string,
      bytes: Uint8Array,
      mime = "application/octet-stream"
    ) => {
      const artifact = await atomicArtifact(directory, name, bytes);
      await atomicArtifact(
        directory,
        `${name}.artifact.json`,
        canonical({ ...artifact, mime })
      );
      return artifact;
    };
    const evidence = (name: string, value: unknown) =>
      atomicArtifact(directory, name, `${canonical(value)}\n`);
    const capture = async ({
      name,
      region = options.region,
    }: {
      name: string;
      region?: { x: number; y: number; width: number; height: number };
    }) => {
      if (measuring === "cpu") {
        throw new Error("Capture cannot run inside a CPU measurement window.");
      }
      if (
        region &&
        (region.x < 0 ||
          region.y < 0 ||
          region.width <= 0 ||
          region.height <= 0 ||
          region.x + region.width > viewport.width ||
          region.y + region.height > viewport.height)
      ) {
        throw new Error("Capture region leaves the literal source viewport.");
      }
      if (errors.length) {
        throw new Error(errors.join("\n"));
      }
      const losses = await ownedPage.evaluate(() =>
        Reflect.get(globalThis, "__SCENEPROOF_DEVICE_LOSSES__")
      );
      if (Array.isArray(losses) && losses.length) {
        throw new Error(`Session GPU device lost: ${JSON.stringify(losses)}`);
      }
      if (new URL(ownedPage.url()).origin !== url.origin) {
        throw new Error("Session page left its declared source origin.");
      }
      const ready = await ownedPage.evaluate(
        () =>
          Reflect.get(globalThis, "__SCENEPROOF_NATIVE_CAPTURE__")?.ready() ??
          true
      );
      if (!ready) {
        await session.invoke("fence");
      }
      try {
        const native = await ownedPage.evaluate(
          async () =>
            (await Reflect.get(
              globalThis,
              "__SCENEPROOF_NATIVE_CAPTURE__"
            )?.stage()) ?? []
        );
        const bytes = await ownedPage.screenshot({
          type: "png",
          ...(region ? { clip: region } : {}),
          animations: "allow",
          scale: "device",
          timeout: 0,
        });
        const artifact = await atomicArtifact(directory, name, bytes);
        await evidence(`${name}.artifact.json`, {
          ...artifact,
          method: native.length
            ? "native-framebuffer-readback-composite"
            : "dom-presentation",
          mime: "image/png",
          native,
        });
        return artifact;
      } finally {
        await ownedPage.evaluate(() =>
          Reflect.get(globalThis, "__SCENEPROOF_NATIVE_CAPTURE__")?.restore()
        );
      }
    };
    let identityDigest = "";
    const session: SessionContext = {
      binary,
      capture,
      click: (selector) => ownedPage.locator(selector).click({ timeout: 0 }),
      evidence,
      frames: (sequence) => {
        if (measuring === "cpu") {
          throw new Error("Frames cannot run inside a CPU measurement window.");
        }
        return streamFrames({
          attempt,
          beforeFrame: (row) =>
            ownedPage.evaluate((frame) => {
              Reflect.set(globalThis, "__SCENEPROOF_FRAME_CONTEXT__", frame);
              Reflect.get(globalThis, "__SCENEPROOF_NATIVE_CAPTURE__")?.arm();
            }, row),
          directory,
          identity: identityDigest,
          resume: options.resume ?? false,
          sequence,
          session,
        });
      },
      gpuTimings: async (measurement) => {
        if (measuring) {
          throw new Error(
            "CPU and GPU measurements must use separate non-overlapping windows."
          );
        }
        if (!MEASUREMENT_ID.test(measurement.name)) {
          throw new Error(
            "GPU measurement name must be a safe artifact segment."
          );
        }
        measuring = "gpu";
        gpuWindow = {
          counter: 0,
          name: `${attempt}-${measurement.name}`,
          summary: {},
        };
        const window = gpuWindow;
        await ownedPage.evaluate(() =>
          Reflect.get(globalThis, "__SCENEPROOF_GPU_TIMINGS__")?.start()
        );
        try {
          const result = await measurement.run(session);
          await ownedPage.evaluate(async () => {
            const collector = Reflect.get(
              globalThis,
              "__SCENEPROOF_GPU_TIMINGS__"
            );
            collector?.stop();
            await collector?.flush();
          });
          const status = await ownedPage.evaluate(
            () =>
              Reflect.get(
                globalThis,
                "__SCENEPROOF_GPU_TIMINGS__"
              )?.status() ?? {
                errors: [],
                limitations: [
                  "Session gpuTimings was not enabled before source loading",
                ],
                supportedDevices: 0,
                unsubmittedPasses: 0,
              }
          );
          const artifact = await evidence(`${measurement.name}.json`, {
            kind: "gpu-timestamp-pass-duration",
            status:
              status.supportedDevices > 0 &&
              window.counter > 0 &&
              status.errors.length === 0 &&
              status.limitations.length === 0 &&
              status.unsubmittedPasses === 0
                ? "collected"
                : "unsupported-or-incomplete",
            ...status,
            owner: result ?? null,
            queueFenceIsGpuTime: false,
            rawDirectory: `gpu/${window.name}`,
            samples: window.counter,
            summary: window.summary,
          });
          if (status.errors.length) {
            throw new Error(
              `GPU timestamp collection failed: ${status.errors.join("; ")}`
            );
          }
          return artifact;
        } finally {
          await ownedPage.evaluate(async () => {
            const collector = Reflect.get(
              globalThis,
              "__SCENEPROOF_GPU_TIMINGS__"
            );
            collector?.stop();
            await collector?.flush();
          });
          gpuWindow = null;
          measuring = null;
        }
      },
      invoke: async (name, value) => {
        await appendFile(
          resolve(directory, `lifecycle-${attempt}.jsonl`),
          `${JSON.stringify({ action: name, stage: "start" })}\n`
        );
        if (measuring !== "cpu" && ["seek", "fence", "settle"].includes(name)) {
          await ownedPage.evaluate(() =>
            Reflect.get(globalThis, "__SCENEPROOF_NATIVE_CAPTURE__")?.arm()
          );
        }
        const result = await invoke(ownedPage, name, value);
        await appendFile(
          resolve(directory, `lifecycle-${attempt}.jsonl`),
          `${JSON.stringify({ action: name, stage: "complete" })}\n`
        );
        return result;
      },
      measure: async (measurement) => {
        if (measuring) {
          throw new Error(
            "CPU and GPU measurements must use separate non-overlapping windows."
          );
        }
        measuring = "cpu";
        await ownedPage.evaluate(() =>
          Reflect.get(globalThis, "__SCENEPROOF_NATIVE_CAPTURE__")?.pause()
        );
        const begin = await ownedPage.evaluate((longTasks) => {
          const entries: Array<{ startTime: number; duration: number }> = [];
          const supported =
            longTasks &&
            PerformanceObserver.supportedEntryTypes.includes("longtask");
          const observer = supported
            ? new PerformanceObserver((list) => {
                for (const entry of list.getEntries()) {
                  entries.push({
                    duration: entry.duration,
                    startTime: entry.startTime,
                  });
                }
              })
            : null;
          observer?.observe({ buffered: false, type: "longtask" });
          Reflect.set(globalThis, "__SCENEPROOF_CPU_WINDOW__", {
            entries,
            observer,
            supported,
          });
          return performance.now();
        }, measurement.longTasks ?? false);
        try {
          const result = await measurement.run(session);
          const timing = await ownedPage.evaluate(() => {
            const window = Reflect.get(globalThis, "__SCENEPROOF_CPU_WINDOW__");
            for (const entry of window.observer?.takeRecords() ?? []) {
              window.entries.push({
                duration: entry.duration,
                startTime: entry.startTime,
              });
            }
            window.observer?.disconnect();
            return {
              end: performance.now(),
              longTasks: {
                entries: window.entries,
                requested: true,
                supported: window.supported,
              },
            };
          });
          return evidence(measurement.name, {
            elapsedMs: timing.end - begin,
            gpuTimestamps: false,
            kind: "cpu-wall-and-owner-telemetry",
            longTasks: {
              ...timing.longTasks,
              requested: measurement.longTasks ?? false,
            },
            owner: result ?? null,
          });
        } finally {
          measuring = null;
          await ownedPage.evaluate(() => {
            Reflect.get(
              globalThis,
              "__SCENEPROOF_CPU_WINDOW__"
            )?.observer?.disconnect();
            Reflect.deleteProperty(globalThis, "__SCENEPROOF_CPU_WINDOW__");
          });
        }
      },
      page,
      props,
      ready: async (predicate) => {
        await evidence(`attempts/${attempt}/ready-${randomUUID()}.json`, {
          stage: "waiting",
          url: ownedPage.url(),
        });
        return waitReady(ownedPage, predicate, errors);
      },
      resumed: options.resume ?? false,
    };
    if (bundle) {
      await waitReady(
        page,
        () =>
          Reflect.get(globalThis, "__UISCENE_READY__") === true ||
          typeof Reflect.get(globalThis, "__UISCENE_ERROR__") === "string",
        errors
      );
      const failure = await page.evaluate(() =>
        Reflect.get(globalThis, "__UISCENE_ERROR__")
      );
      if (typeof failure === "string") {
        throw new Error(failure);
      }
    }
    if (definition.ready) {
      await definition.ready(session);
    } else if (definition.page) {
      throw new Error("Page sessions must declare their real ready boundary.");
    }
    const identity = {
      adapter,
      backend: definition.backend ?? "webgpu",
      browserVersion: browser.version(),
      css: bundle ? digest(bundle.css) : null,
      deviceAdmissions: await page.evaluate(() =>
        Reflect.get(globalThis, "__SCENEPROOF_DEVICE_ADMISSIONS__")
      ),
      domain: definition.identity ? await definition.identity(session) : null,
      engine: digest(
        canonical({
          atomicArtifact: atomicArtifact.toString(),
          browser: launchBrowser.toString(),
          bundle: bundleBrowserDriver.toString(),
          canonical: canonical.toString(),
          clock: clockAtFrame.toString(),
          driver: reactDriverSource.toString(),
          frames: streamFrames.toString(),
          gpu: installGpuTimings.toString(),
          loader: loadSessionModule.toString(),
          nativeCapture: installNativeCanvasCapture.toString(),
          session: runSession.toString(),
        })
      ),
      expectedGpuVendor: expectedVendor ?? null,
      gpuTimingRequested: definition.gpuTimings ?? false,
      init: initBundles.map((init) => digest(init.javascript)),
      nativeCapture: definition.nativeCapture ?? "readback",
      overlays,
      props,
      // Default capture crop; a resumed run must capture the same region.
      region: options.region ?? null,
      routes: (definition.routes ?? []).map((route) => ({
        identity: route.identity,
        pattern: route.pattern,
      })),
      sessionModule: options.modulePath
        ? digest(await readFile(checkSourcePath(options.modulePath)))
        : null,
      sessionModuleBundle: loadedSessionBundles.get(definition) ?? null,
      sourceBundle: bundle ? digest(bundle.javascript) : null,
      sourcePins,
      VK_DRIVER_FILES: process.env.VK_DRIVER_FILES ?? null,
      version: 1,
      viewport,
    };
    identityDigest = digest(canonical(identity));
    if (options.resume) {
      if (!definition.identity) {
        throw new Error(
          "Resume requires camera/seed/domain identity, not just source identity."
        );
      }
      const saved = await readReceipt(directory, "session-identity.json");
      if (!saved || canonical(saved) !== canonical(identity)) {
        throw new Error("Session resume identity mismatch.");
      }
    } else {
      await evidence("session-identity.json", identity);
    }
    await definition.run(session);
    if (errors.length) {
      throw new Error(errors.join("\n"));
    }
    completed = true;
    return {
      artifacts: { directory },
      execution: { meaning: "command-execution-only", status: "succeeded" },
      provenance: identity,
      review: { decisionOwner: "agent", required: true },
    };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    const cleanupErrors: string[] = [];
    try {
      if (page && !page.isClosed()) {
        await page.evaluate(async () => {
          Reflect.get(globalThis, "__SCENEPROOF_NATIVE_CAPTURE__")?.dispose();
          const collector = Reflect.get(
            globalThis,
            "__SCENEPROOF_GPU_TIMINGS__"
          );
          collector?.stop();
          await collector?.flush();
          collector?.dispose();
          const dispose = Reflect.get(
            globalThis,
            "__SCENEPROOF_CONTROLS__"
          )?.dispose;
          if (typeof dispose === "function") {
            await dispose();
          }
        });
      }
    } catch (error) {
      cleanupErrors.push(String(error));
    }
    try {
      await browser?.close();
    } catch (error) {
      cleanupErrors.push(String(error));
    }
    try {
      await started?.dispose();
    } catch (error) {
      cleanupErrors.push(String(error));
    }
    try {
      await atomicArtifact(
        directory,
        `attempts/${attempt}/cleanup.json`,
        canonical({
          browserClosed: !browser?.isConnected(),
          completed,
          errors: cleanupErrors,
          ownedServerDisposed: Boolean(started) && cleanupErrors.length === 0,
        })
      );
    } finally {
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", interrupt);
    }
    if (cleanupErrors.length) {
      // biome-ignore lint/correctness/noUnsafeFinally: Cleanup failure invalidates success, while the primary error is retained in the aggregate.
      throw new AggregateError(
        [...(primaryError ? [primaryError] : []), ...cleanupErrors],
        "Session cleanup failed"
      );
    }
  }
}

export async function loadSession(
  path: string,
  exportName = "default"
): Promise<SessionDefinition> {
  const { module, bundleDigest } = await loadSessionModule(
    checkSourcePath(path)
  );
  const definition: unknown = module[exportName];
  if (
    !definition ||
    typeof definition !== "object" ||
    typeof Reflect.get(definition, "run") !== "function"
  ) {
    throw new Error(`Session export ${exportName} must declare run(session).`);
  }
  const session = definition as SessionDefinition;
  loadedSessionBundles.set(session, bundleDigest);
  return session;
}
