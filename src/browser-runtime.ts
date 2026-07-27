import { existsSync } from "node:fs";
import type { Browser, Page } from "playwright-core";

import { loadRuntimeDependency } from "./runtime-dependency.js";

const CHROME_CANDIDATES = [
  process.env.SCENEPROOF_CHROME_PATH,
  process.env.UISCENE_CHROME_PATH,
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
].filter((path): path is string => Boolean(path));

export function chromePath(): string {
  const path = CHROME_CANDIDATES.find(existsSync);
  if (!path) {
    throw new Error(
      "No Chromium executable found. Set SCENEPROOF_CHROME_PATH to a local Chrome or Chromium binary."
    );
  }
  return path;
}

export async function diagnoseBrowser(): Promise<{
  checks: {
    browserLaunched: boolean;
    chromiumFound: boolean;
    webglAvailable: boolean;
    webgpuAvailable: boolean;
  };
  chromiumPath: string;
  executionGuidance: string;
  rasterizer: {
    kind: "hardware-or-unknown" | "software-cpu" | "swiftshader-cpu";
    renderer: string | null;
  };
  renderer: string | null;
  webgpu: {
    adapter: {
      architecture: string | null;
      available: boolean;
      description: string | null;
      device: string | null;
      isFallbackAdapter: boolean | null;
      vendor: string | null;
    };
    rasterizer: {
      kind: "hardware-or-unknown" | "software-cpu" | "swiftshader-cpu";
      renderer: string | null;
    };
    renderError: string | null;
    rendered: boolean;
  };
  success: boolean;
}> {
  const executable = chromePath();
  const browser = await launchBrowser({ threeBackend: "webgpu" });
  try {
    const page = await browser.newPage();
    await mountTrustedPage(
      page,
      "<!doctype html><title>SceneProof doctor</title>"
    );
    const capabilities = await page.evaluate(
      // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: One browser-local probe must distinguish API exposure, adapter discovery, real GPU execution, WebGL availability, and attributable failure.
      async () => {
        const canvas = document.createElement("canvas");
        const context =
          canvas.getContext("webgl2") ?? canvas.getContext("webgl");
        const extension = context?.getExtension("WEBGL_debug_renderer_info");
        let renderer: unknown = null;
        if (context && extension) {
          renderer = context.getParameter(extension.UNMASKED_RENDERER_WEBGL);
        } else if (context) {
          renderer = context.getParameter(context.RENDERER);
        }
        let rendererName: string | null = null;
        if (typeof renderer === "string") {
          rendererName = renderer;
        } else if (renderer !== null) {
          rendererName = String(renderer);
        }
        const adapter = await navigator.gpu?.requestAdapter({
          powerPreference: "high-performance",
        });
        const text = (value: unknown): string | null =>
          typeof value === "string" && value.length > 0 ? value : null;
        let rendered = false;
        let renderError: string | null = null;
        if (adapter) {
          try {
            const device = await adapter.requestDevice();
            const webgpuCanvas = document.createElement("canvas");
            webgpuCanvas.width = 1;
            webgpuCanvas.height = 1;
            const webgpuContext = webgpuCanvas.getContext(
              "webgpu"
            ) as GPUCanvasContext | null;
            if (!webgpuContext) {
              throw new Error(
                "Chromium did not provide a WebGPU canvas context."
              );
            }
            const textureUsage = 0x01 + 0x10; // COPY_SRC + RENDER_ATTACHMENT
            webgpuContext.configure({
              alphaMode: "opaque",
              device,
              format: navigator.gpu.getPreferredCanvasFormat(),
              usage: textureUsage,
            });
            const texture = webgpuContext.getCurrentTexture();
            const buffer = device.createBuffer({
              size: 256,
              usage: 0x08 + 0x01, // COPY_DST + MAP_READ
            });
            const encoder = device.createCommandEncoder();
            const pass = encoder.beginRenderPass({
              colorAttachments: [
                {
                  clearValue: { a: 1, b: 0.75, g: 0.5, r: 0.25 },
                  loadOp: "clear",
                  storeOp: "store",
                  view: texture.createView(),
                },
              ],
            });
            pass.end();
            encoder.copyTextureToBuffer(
              { texture },
              { buffer, bytesPerRow: 256 },
              { height: 1, width: 1 }
            );
            device.queue.submit([encoder.finish()]);
            await buffer.mapAsync(0x01); // READ
            const pixel = new Uint8Array(buffer.getMappedRange()).slice(0, 4);
            buffer.unmap();
            buffer.destroy();
            device.destroy();
            rendered =
              (pixel[0] ?? 0) > 40 &&
              (pixel[1] ?? 0) > 90 &&
              (pixel[2] ?? 0) > 140 &&
              (pixel[3] ?? 0) > 240;
            if (!rendered) {
              renderError = `WebGPU readback returned [${pixel.join(", ")}].`;
            }
          } catch (error) {
            renderError =
              error instanceof Error ? error.message : String(error);
          }
        }
        return {
          webgl: {
            available: context !== null,
            renderer: rendererName,
          },
          webgpu: {
            adapter: {
              architecture: text(adapter?.info.architecture),
              available: Boolean(adapter),
              description: text(adapter?.info.description),
              device: text(adapter?.info.device),
              isFallbackAdapter: adapter
                ? adapter.info.isFallbackAdapter
                : null,
              vendor: text(adapter?.info.vendor),
            },
            renderError,
            rendered,
          },
        };
      }
    );
    const checks = {
      browserLaunched: true,
      chromiumFound: true,
      webglAvailable: capabilities.webgl.available,
      webgpuAvailable: capabilities.webgpu.rendered,
    };
    let webglRasterizerKind:
      | "hardware-or-unknown"
      | "software-cpu"
      | "swiftshader-cpu" = "hardware-or-unknown";
    const normalizedWebGlRenderer =
      capabilities.webgl.renderer?.toLowerCase() ?? "";
    if (normalizedWebGlRenderer.includes("swiftshader")) {
      webglRasterizerKind = "swiftshader-cpu";
    } else if (normalizedWebGlRenderer.includes("llvmpipe")) {
      webglRasterizerKind = "software-cpu";
    }
    return {
      checks,
      chromiumPath: executable,
      executionGuidance:
        "Invoke sceneproof as the direct command with unsandboxed/local-render permission; compound shells and pipes can prevent Chromium from launching before SceneProof can report an error.",
      rasterizer: {
        kind: webglRasterizerKind,
        renderer: capabilities.webgl.renderer,
      },
      renderer: capabilities.webgl.renderer,
      success: checks.webglAvailable || checks.webgpuAvailable,
      webgpu: {
        ...capabilities.webgpu,
        rasterizer: {
          kind:
            capabilities.webgpu.adapter.architecture
              ?.toLowerCase()
              .includes("swiftshader") === true ||
            capabilities.webgpu.adapter.isFallbackAdapter === true
              ? "swiftshader-cpu"
              : "hardware-or-unknown",
          renderer:
            [
              capabilities.webgpu.adapter.vendor,
              capabilities.webgpu.adapter.architecture,
            ]
              .filter(Boolean)
              .join(" ") || null,
        },
      },
    };
  } finally {
    await browser.close();
  }
}

export async function launchBrowser(
  options: { threeBackend?: "webgl" | "webgpu" } = {}
): Promise<Browser> {
  const { chromium } =
    await loadRuntimeDependency<typeof import("playwright-core")>(
      "playwright-core"
    );
  try {
    return await chromium.launch({
      args: [
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--enable-webgl",
        "--ignore-gpu-blocklist",
        ...(options.threeBackend === "webgpu" && process.platform === "linux"
          ? [
              "--disable-vulkan-surface",
              "--enable-accelerated-2d-canvas",
              "--enable-features=Vulkan",
              "--enable-unsafe-webgpu",
              "--use-angle=vulkan",
              "--use-gpu-in-tests",
              "--use-vulkan=swiftshader",
              "--use-webgpu-adapter=swiftshader",
            ]
          : ["--use-angle=swiftshader"]),
      ],
      executablePath: chromePath(),
      headless: true,
    });
  } catch (error) {
    const detail =
      error instanceof Error
        ? (error.message.split("\n")[0] ?? error.message)
        : String(error);
    throw new Error(
      `Chromium could not start. SceneProof rendering requires unsandboxed/local-render permission. Run "sceneproof doctor" as the direct command. ${detail}`,
      { cause: error }
    );
  }
}

async function mountTrustedPage(page: Page, html: string): Promise<void> {
  const url = "http://127.0.0.1/sceneproof";
  await page.route(url, (route) =>
    route.fulfill({ body: html, contentType: "text/html", status: 200 })
  );
  await page.goto(url, { waitUntil: "load" });
}

export async function assertNoBrowserPageErrors(page: Page): Promise<void> {
  const errors = await page.evaluate(() => {
    const stored = Reflect.get(window, "__SCENEPROOF_PAGE_ERRORS__");
    return Array.isArray(stored)
      ? stored.filter((value): value is string => typeof value === "string")
      : [];
  });
  if (errors.length > 0) {
    throw new Error(errors.join("\n"));
  }
}

export async function mountBundle(input: {
  page: Page;
  javascript: string;
  css: string;
}): Promise<void> {
  const errors: string[] = [];
  input.page.on("pageerror", (error) => errors.push(error.message));
  await input.page.emulateMedia({ reducedMotion: "reduce" });
  await mountTrustedPage(
    input.page,
    `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <style>
      html, body { min-width: 100%; min-height: 100%; }
      #uiscene-root { min-width: 1px; min-height: 1px; }
      ${input.css.replaceAll("</style", "<\\/style")}
    </style>
  </head>
  <body>
    <div id="uiscene-root"></div>
    <script>
      globalThis.__SCENEPROOF_PAGE_ERRORS__ = [];
      window.addEventListener("error", (event) => {
        globalThis.__SCENEPROOF_PAGE_ERRORS__.push(
          event.error?.message || event.message || "Unknown browser page error"
        );
      });
    </script>
    <script>globalThis.__name = globalThis.__name || ((value) => value);</script>
    <script>${input.javascript.replaceAll("</script", "<\\/script")}</script>
  </body>
</html>`
  );
  try {
    await input.page.waitForFunction(
      () =>
        Reflect.get(window, "__UISCENE_READY__") === true ||
        typeof Reflect.get(window, "__UISCENE_ERROR__") === "string",
      undefined,
      { timeout: 20_000 }
    );
  } catch (error) {
    if (errors.length > 0) {
      throw new Error(errors.join("\n"), { cause: error });
    }
    throw error;
  }
  await input.page.waitForTimeout(250);

  const runtimeError = await input.page.evaluate(() =>
    Reflect.get(window, "__UISCENE_ERROR__")
  );
  if (typeof runtimeError === "string") {
    throw new Error(runtimeError);
  }
  if (errors.length > 0) {
    throw new Error(errors.join("\n"));
  }
}
