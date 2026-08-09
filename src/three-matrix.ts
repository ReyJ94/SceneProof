import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { writeAnimatedPng } from "./animated-png.js";
import { launchBrowser, mountBundle } from "./browser-runtime.js";
import {
  type FrameSample,
  parseFrameSchedule,
  representativeFrameIndices,
} from "./frame-schedule.js";
import { comparePngSequence } from "./raster-evidence.js";
import { bundleBrowserDriver } from "./source-bundle.js";
import type { ThreeBackend } from "./three-backend.js";
import { type FixtureProvenance, renderThree } from "./three-renderer.js";
import { mergeVariantProps } from "./variant-matrix.js";

type MatrixOptions = {
  action?: string;
  actionInput?: Record<string, unknown>;
  aliases: Readonly<Record<string, string>>;
  entry: string;
  exportName: string;
  fixture?: FixtureProvenance;
  frames: string;
  height: number;
  nodeId: string;
  out: string;
  props: Record<string, unknown>;
  provenance: Record<string, unknown>;
  scale: number;
  threeBackend?: ThreeBackend;
  timeMs?: number;
  variants: Array<{ label: string; props: Record<string, unknown> }>;
  width: number;
};

function safeLabel(value: string): string {
  return (
    value
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 48) || "variant"
  );
}

function driverSource(
  options: MatrixOptions,
  variantProps: Record<string, unknown>[]
): string {
  return `
    import * as THREE from "three";
    import { WebGPURenderer } from "three/webgpu";
    import * as SourceModule from ${JSON.stringify(options.entry)};
    (async () => {
      try {
        const factory = SourceModule[${JSON.stringify(options.exportName)}];
        window.__UISCENE_STATUS__ = { moduleLoaded: true, exportFound: factory !== undefined };
        if (typeof factory !== "function") throw new Error("Requested matrix export was not found or is not a scene factory.");
        const variants = ${JSON.stringify(variantProps)};
        const index = Number(window.__SCENEPROOF_MATRIX_VARIANT_INDEX__ ?? 0);
        const result = await factory({
          width: ${options.width}, height: ${options.height}, pixelRatio: ${options.scale}, assets: {}, props: variants[index]
        });
        if (!result?.scene?.isScene || !result?.camera?.isCamera) throw new Error("Scene factory must return { scene, camera }.");
        await result.ready;
        const actionName = ${JSON.stringify(options.action ?? null)};
        if (actionName !== null) {
          const action = result.actions?.[actionName];
          if (typeof action !== "function") throw new Error("Scene fixture action " + actionName + " was not found.");
          await action(${JSON.stringify(options.actionInput ?? {})});
        }
        const requestedTime = ${JSON.stringify(options.frames ? null : (options.timeMs ?? null))};
        if (requestedTime !== null) {
          if (typeof result.seek !== "function") throw new Error("Scene fixture does not expose seek(timeMs), required by --time.");
          await result.seek(requestedTime);
        }
        result.scene.updateMatrixWorld(true);
        result.camera.updateMatrixWorld(true);
        window.__UISCENE_THREE__ = { THREE, WebGPURenderer, result };
        window.__UISCENE_READY__ = true;
      } catch (error) {
        window.__UISCENE_ERROR__ = error instanceof Error ? error.message : String(error);
      }
    })();
  `;
}

async function applyFrame(
  page: import("playwright-core").Page,
  frame: FrameSample
): Promise<void> {
  await page.evaluate(async (sample) => {
    const runtime = Reflect.get(window, "__UISCENE_THREE__") as
      | {
          result: {
            seek?: (timeMs: number) => void | Promise<void>;
            settle?: () => void | Promise<void>;
          };
        }
      | undefined;
    if (!runtime) {
      throw new Error("Three.js matrix runtime was not created.");
    }
    if (sample.kind === "time") {
      if (typeof runtime.result.seek !== "function") {
        throw new Error(
          "Scene fixture does not expose seek(timeMs), required by matrix --frames."
        );
      }
      await runtime.result.seek(sample.timeMs);
    } else if (sample.kind === "settled") {
      if (typeof runtime.result.settle !== "function") {
        throw new Error(
          "Scene fixture does not expose settle(), required by matrix --frames."
        );
      }
      await runtime.result.settle();
    }
  }, frame);
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Temporal matrices coordinate one shared source bundle and browser, one fixture lifecycle per variant, two evidence axes, APNG packaging, and the labeled grid as a single ownership boundary.
export async function renderThreeMatrix(options: MatrixOptions) {
  const schedule = parseFrameSchedule(options.frames);
  if (options.timeMs !== undefined) {
    throw new Error("Matrix --frames and --time are mutually exclusive.");
  }
  const cellCount = schedule.frames.length * options.variants.length;
  if (schedule.kind === "checkpoint" && cellCount > 48) {
    throw new Error("A checkpoint matrix accepts at most 48 visible cells.");
  }
  if (schedule.kind === "continuous" && cellCount > 240) {
    throw new Error(
      "A continuous matrix accepts at most 240 raw frames across variants."
    );
  }
  const directory = resolve(options.out);
  const contactSheet = join(directory, "contact-sheet.png");
  const manifest = join(directory, "manifest.json");
  await mkdir(directory, { recursive: true });
  const variantInputs = options.variants.map((variant) => ({
    label: variant.label,
    props: mergeVariantProps(options.props, variant.props),
  }));
  const bundle = await bundleBrowserDriver({
    aliases: options.aliases,
    discoverCss: false,
    entry: options.entry,
    extraCss: [],
    source: driverSource(
      options,
      variantInputs.map((variant) => variant.props)
    ),
    ...(options.threeBackend ? { threeBackend: options.threeBackend } : {}),
  });
  const browser = await launchBrowser({
    threeBackend: options.threeBackend ?? "webgl",
  });
  const variants: Array<{
    animatedPng?: string;
    frames: Array<{ artifact: string; label: string; timeMs: number | null }>;
    index: number;
    label: string;
    props: Record<string, unknown>;
  }> = [];
  const warnings: string[] = [];
  const frameSamples = schedule.frames;
  let graphics: unknown;
  try {
    const context = await browser.newContext({
      viewport: { height: options.height, width: options.width },
    });
    for (const [variantIndex, variant] of variantInputs.entries()) {
      // biome-ignore lint/performance/noAwaitInLoops: Each variant intentionally owns one isolated scene instance in the shared browser and bundle lifecycle.
      const page = await context.newPage();
      try {
        await page.addInitScript((index) => {
          Reflect.set(window, "__SCENEPROOF_MATRIX_VARIANT_INDEX__", index);
        }, variantIndex);
        await mountBundle({ css: "", javascript: bundle.javascript, page });
        const variantDirectory = join(
          directory,
          `${String(variantIndex + 1).padStart(2, "0")}-${safeLabel(variant.label)}`
        );
        await mkdir(variantDirectory, { recursive: true });
        const frames: Array<{
          artifact: string;
          label: string;
          timeMs: number | null;
        }> = [];
        for (const [frameIndex, frame] of frameSamples.entries()) {
          // biome-ignore lint/performance/noAwaitInLoops: Matrix time advances sequentially inside one live fixture.
          await applyFrame(page, frame);
          const artifact = join(
            variantDirectory,
            `${String(frameIndex + 1).padStart(3, "0")}-${safeLabel(frame.label)}.png`
          );
          const report = await renderThree({
            aliases: options.aliases,
            entry: options.entry,
            exportName: options.exportName,
            ...(options.fixture ? { fixture: options.fixture } : {}),
            framing: "source",
            height: options.height,
            margin: 0.12,
            nodeId: options.nodeId,
            out: artifact,
            preparedPage: page,
            preserveFixture: true,
            projection: "source",
            props: variant.props,
            scale: options.scale,
            silhouette: false,
            stats: false,
            ...(options.threeBackend
              ? { threeBackend: options.threeBackend }
              : {}),
            width: options.width,
            zoom: 1,
          });
          graphics ??= report.graphics;
          warnings.push(...(report.warnings ?? []));
          frames.push({ artifact, label: frame.label, timeMs: frame.timeMs });
        }
        const animatedPng =
          schedule.kind === "continuous"
            ? join(variantDirectory, "motion.apng")
            : null;
        if (animatedPng) {
          await writeAnimatedPng({
            delayMs: schedule.stepMs ?? 1,
            framePaths: frames.map((frame) => frame.artifact),
            out: animatedPng,
          });
        }
        variants.push({
          ...(animatedPng ? { animatedPng } : {}),
          frames,
          index: variantIndex,
          label: variant.label,
          props: variant.props,
        });
        await page.evaluate(async () => {
          const runtime = Reflect.get(window, "__UISCENE_THREE__") as
            | { result: { dispose?: () => void | Promise<void> } }
            | undefined;
          await (
            runtime as { result: { dispose?: () => void | Promise<void> } }
          ).result.dispose?.();
        });
      } finally {
        await page.close();
      }
    }

    const contactPage = await context.newPage();
    const representative =
      schedule.kind === "continuous"
        ? representativeFrameIndices(
            frameSamples.length,
            Math.max(2, Math.min(12, Math.floor(48 / variants.length)))
          )
        : representativeFrameIndices(frameSamples.length, frameSamples.length);
    const cells = variants.flatMap((variant) =>
      representative.map((frameIndex) => ({
        label: `${variant.label} / ${variant.frames[frameIndex]?.label ?? ""}`,
        path: variant.frames[frameIndex]?.artifact ?? "",
      }))
    );
    const loaded = await Promise.all(
      cells.map(async (cell) => ({
        dataUrl: `data:image/png;base64,${(await readFile(cell.path)).toString("base64")}`,
        label: cell.label,
      }))
    );
    const tileWidth = Math.round(options.width * options.scale);
    const tileHeight = Math.round(options.height * options.scale);
    const columns = representative.length;
    await contactPage.setViewportSize({
      height: variants.length * (tileHeight + 28),
      width: columns * tileWidth,
    });
    await contactPage.evaluate(
      async ({ columnCount, entries, height, width }) => {
        const main = document.createElement("main");
        main.dataset.sceneproofMatrix = "true";
        main.style.display = "grid";
        main.style.gridTemplateColumns = `repeat(${columnCount}, ${width}px)`;
        main.style.margin = "0";
        for (const entry of entries) {
          const tile = document.createElement("section");
          tile.style.background = "#11111b";
          tile.style.color = "#f4f4f5";
          tile.style.font = "12px monospace";
          const label = document.createElement("div");
          label.style.boxSizing = "border-box";
          label.style.height = "28px";
          label.style.padding = "6px 8px";
          label.textContent = entry.label;
          const image = new Image();
          image.src = entry.dataUrl;
          image.height = height;
          image.width = width;
          // biome-ignore lint/performance/noAwaitInLoops: Grid decode order preserves row and time labels.
          await image.decode();
          tile.append(label, image);
          main.append(tile);
        }
        document.body.style.margin = "0";
        document.body.replaceChildren(main);
      },
      {
        columnCount: columns,
        entries: loaded,
        height: tileHeight,
        width: tileWidth,
      }
    );
    await contactPage
      .locator("main[data-sceneproof-matrix='true']")
      .screenshot({
        animations: "disabled",
        caret: "hide",
        path: contactSheet,
        scale: "css",
        timeout: 120_000,
      });

    const motionComparisons: Array<{
      comparisons: unknown[];
      variant: string;
    }> = [];
    for (const variant of variants) {
      if (variant.frames.length < 2) {
        continue;
      }
      // biome-ignore lint/performance/noAwaitInLoops: Each variant owns its within-variant temporal comparison series.
      const compared = await comparePngSequence({
        frames: variant.frames.map((frame) => ({
          label: frame.label,
          path: frame.artifact,
        })),
        page: contactPage,
      });
      motionComparisons.push({
        comparisons: compared.comparisons.map(
          ({ differenceDataUrl: _difference, ...comparison }) => comparison
        ),
        variant: variant.label,
      });
    }
    const variantComparisons: Array<{
      comparisons: unknown[];
      time: string;
    }> = [];
    for (const [frameIndex, frame] of frameSamples.entries()) {
      if (variants.length < 2) {
        continue;
      }
      // biome-ignore lint/performance/noAwaitInLoops: Each time sample owns a same-time cross-variant comparison series.
      const compared = await comparePngSequence({
        frames: variants.map((variant) => ({
          label: variant.label,
          path: variant.frames[frameIndex]?.artifact ?? "",
        })),
        page: contactPage,
      });
      variantComparisons.push({
        comparisons: compared.comparisons.map(
          ({ differenceDataUrl: _difference, ...comparison }) => comparison
        ),
        time: frame.label,
      });
    }
    await contactPage.close();
    const executionSucceeded =
      variants.every((variant) =>
        variant.frames.every((frame) => frame.artifact.length > 0)
      ) && (await stat(contactSheet)).size > 0;
    const report = {
      artifacts: { contactSheet, directory, manifest },
      command: "matrix",
      comparisons: { motion: motionComparisons, variants: variantComparisons },
      execution: {
        meaning: "command-execution-only",
        status: executionSucceeded ? "succeeded" : "failed",
      },
      ...(graphics ? { graphics } : {}),
      lifecycle: {
        bundles: 1,
        frames: cellCount,
        renderBrowserLaunches: 1,
        variants: variants.length,
      },
      provenance: options.provenance,
      timeline: { kind: schedule.kind, stepMs: schedule.stepMs },
      variants,
      warnings: [...new Set(warnings)],
    };
    await writeFile(manifest, `${JSON.stringify(report, null, 2)}\n`);
    return report;
  } finally {
    await browser.close();
  }
}
