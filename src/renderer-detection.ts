import { spawn } from "node:child_process";

import { launchBrowser, mountBundle } from "./browser-runtime.js";
import { bundleBrowserDriver } from "./source-bundle.js";

export type RendererKind = "react" | "three";

export type RendererProbeInput = {
  aliases?: Record<string, string>;
  entry: string;
  exportName: string;
  height: number;
  props: Record<string, unknown>;
  width: number;
};

const PROBE_ENV = "SCENEPROOF_INTERNAL_RENDERER_PROBE";
const PROBE_TIMEOUT_MS = 30_000;
const SOURCE_ENTRYPOINT = /\.[cm]?[jt]sx?$/;

function probeCommand(): string[] {
  const [, entrypoint] = process.argv;
  const isSourceEntrypoint =
    typeof entrypoint === "string" && SOURCE_ENTRYPOINT.test(entrypoint);
  return [process.execPath, ...(isSourceEntrypoint ? [entrypoint] : [])];
}

export async function detectRenderer(
  input: RendererProbeInput
): Promise<RendererKind> {
  return await new Promise((resolve, reject) => {
    const child = spawn(probeCommand()[0] as string, probeCommand().slice(1), {
      env: {
        ...process.env,
        [PROBE_ENV]: JSON.stringify(input),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(
        new Error(
          `Renderer auto-detection timed out after ${PROBE_TIMEOUT_MS}ms. Rerun with --renderer react or --renderer three.`
        )
      );
    }, PROBE_TIMEOUT_MS);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      const errorText = Buffer.concat(stderr).toString("utf8").trim();
      if (code !== 0) {
        reject(
          new Error(
            errorText ||
              `Renderer auto-detection exited with code ${String(code)}. Rerun with --renderer react or --renderer three.`
          )
        );
        return;
      }
      const kind = Buffer.concat(stdout).toString("utf8").trim();
      if (kind !== "react" && kind !== "three") {
        reject(
          new Error(
            `Renderer auto-detection returned ${JSON.stringify(kind)}. Rerun with --renderer react or --renderer three.`
          )
        );
        return;
      }
      resolve(kind);
    });
  });
}

export function rendererProbeInputFromEnvironment(): RendererProbeInput | null {
  const encoded = process.env[PROBE_ENV];
  return encoded ? (JSON.parse(encoded) as RendererProbeInput) : null;
}

export async function probeRenderer(
  input: RendererProbeInput
): Promise<RendererKind> {
  const bundle = await bundleBrowserDriver({
    ...(input.aliases ? { aliases: input.aliases } : {}),
    discoverCss: false,
    entry: input.entry,
    extraCss: [],
    source: `
      import * as SourceModule from ${JSON.stringify(input.entry)};

      (async () => {
        const selected = SourceModule[${JSON.stringify(input.exportName)}];
        try {
          if (typeof selected !== "function") {
            throw new Error(
              "Requested export ${input.exportName.replaceAll('"', '\\"')} not found in ${input.entry.replaceAll('"', '\\"')}"
            );
          }
          if (selected.sceneproofRenderer === "three") {
            window.__UISCENE_RENDERER_KIND__ = "three";
            window.__UISCENE_READY__ = true;
            return;
          }
          if (selected.prototype?.isReactComponent) {
            window.__UISCENE_RENDERER_KIND__ = "react";
            window.__UISCENE_READY__ = true;
            return;
          }
          let result;
          try {
            result = await selected({
              assets: {},
              height: ${input.height},
              pixelRatio: 1,
              props: ${JSON.stringify(input.props)},
              width: ${input.width},
            });
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            if (
              /invalid hook call|dispatcher|reading ['"]use[A-Z]/i.test(message)
            ) {
              window.__UISCENE_RENDERER_KIND__ = "react";
              window.__UISCENE_READY__ = true;
              return;
            }
            throw new Error(
              "Renderer auto-detection could not safely invoke export ${input.exportName.replaceAll('"', '\\"')}: " +
                message +
                ". Rerun with --renderer react or --renderer three."
            );
          }
          if (result?.scene?.isScene && result?.camera?.isCamera) {
            await result.dispose?.();
            window.__UISCENE_RENDERER_KIND__ = "three";
            window.__UISCENE_READY__ = true;
            return;
          }
          window.__UISCENE_RENDERER_KIND__ = "react";
          window.__UISCENE_READY__ = true;
        } catch (error) {
          window.__UISCENE_ERROR__ =
            error instanceof Error ? error.message : String(error);
        }
      })();
    `,
  });
  const browser = await launchBrowser();
  try {
    const context = await browser.newContext({
      viewport: { height: input.height, width: input.width },
    });
    const page = await context.newPage();
    await mountBundle({ css: "", javascript: bundle.javascript, page });
    const kind = await page.evaluate(() =>
      Reflect.get(window, "__UISCENE_RENDERER_KIND__")
    );
    if (kind !== "react" && kind !== "three") {
      throw new Error(
        `Renderer auto-detection produced no decision for export ${input.exportName}. Rerun with --renderer react or --renderer three.`
      );
    }
    return kind;
  } finally {
    await browser.close();
  }
}
