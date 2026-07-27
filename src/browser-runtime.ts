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
  };
  chromiumPath: string;
  executionGuidance: string;
  rasterizer: {
    kind: "hardware-or-unknown" | "swiftshader-cpu";
    renderer: string | null;
  };
  renderer: string | null;
  success: boolean;
}> {
  const executable = chromePath();
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    const webgl = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
      if (!context) {
        return { available: false, renderer: null };
      }
      const extension = context.getExtension("WEBGL_debug_renderer_info");
      const renderer =
        extension === null
          ? context.getParameter(context.RENDERER)
          : context.getParameter(extension.UNMASKED_RENDERER_WEBGL);
      return {
        available: true,
        renderer: typeof renderer === "string" ? renderer : String(renderer),
      };
    });
    const checks = {
      browserLaunched: true,
      chromiumFound: true,
      webglAvailable: webgl.available,
    };
    return {
      checks,
      chromiumPath: executable,
      executionGuidance:
        "Invoke sceneproof as the direct command with unsandboxed/local-render permission; compound shells and pipes can prevent Chromium from launching before SceneProof can report an error.",
      rasterizer: {
        kind:
          webgl.renderer?.toLowerCase().includes("swiftshader") === true
            ? "swiftshader-cpu"
            : "hardware-or-unknown",
        renderer: webgl.renderer,
      },
      renderer: webgl.renderer,
      success: Object.values(checks).every(Boolean),
    };
  } finally {
    await browser.close();
  }
}

export async function launchBrowser(): Promise<Browser> {
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
        "--use-angle=swiftshader",
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

export async function mountBundle(input: {
  page: Page;
  javascript: string;
  css: string;
}): Promise<void> {
  const errors: string[] = [];
  input.page.on("pageerror", (error) => errors.push(error.message));
  await input.page.emulateMedia({ reducedMotion: "reduce" });
  await input.page.setContent(
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
    <script>globalThis.__name = globalThis.__name || ((value) => value);</script>
    <script>${input.javascript.replaceAll("</script", "<\\/script")}</script>
  </body>
</html>`,
    { waitUntil: "load" }
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
