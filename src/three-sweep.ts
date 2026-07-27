import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";

import { launchBrowser, mountBundle } from "./browser-runtime.js";
import {
  type ReferenceFit,
  type ReferenceObjective,
  scoreReferenceFit,
} from "./reference-fit.js";
import { agentReviewStatus, assertionStatus } from "./report-status.js";
import type { SweepRenderReport } from "./scene-schema.js";
import { bundleBrowserDriver } from "./source-bundle.js";
import type { GraphicsInfo } from "./three-backend.js";
import { renderThree } from "./three-renderer.js";

type RenderThreeOptions = Parameters<typeof renderThree>[0];

export type SweepObjective = ReferenceObjective;

type SweepOptions = Omit<
  RenderThreeOptions,
  "compare" | "out" | "preparedPage" | "silhouette" | "stats"
> & {
  out: string;
  sweep: {
    objective: SweepObjective;
    path: string;
    values: unknown[];
  };
};

function referenceEvidence(
  report: Awaited<ReturnType<typeof renderThree>>,
  objective: SweepOptions["sweep"]["objective"]
): Pick<SweepRenderReport["variants"][number], "reference" | "referenceFit"> {
  if (!report.reference) {
    return {};
  }
  const fit = scoreReferenceFit(report.reference, objective);
  return {
    reference: report.reference,
    ...(fit ? { referenceFit: fit } : {}),
  };
}

const PROHIBITED_PATH_SEGMENTS = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);
const PROP_PATH_SEGMENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function propsWithOverride(
  source: Record<string, unknown>,
  path: string,
  value: unknown
): Record<string, unknown> {
  const segments = path.split(".");
  if (
    segments.length === 0 ||
    segments.some(
      (segment) =>
        !PROP_PATH_SEGMENT.test(segment) ||
        PROHIBITED_PATH_SEGMENTS.has(segment)
    )
  ) {
    throw new Error(`Invalid sweep prop path: ${path}`);
  }
  const props = structuredClone(source);
  let owner: Record<string, unknown> = props;
  for (const segment of segments.slice(0, -1)) {
    const existing = owner[segment];
    if (
      existing !== undefined &&
      (typeof existing !== "object" ||
        existing === null ||
        Array.isArray(existing))
    ) {
      throw new Error(
        `Sweep prop path ${path} crosses non-object segment ${segment}.`
      );
    }
    if (existing === undefined) {
      owner[segment] = {};
    }
    owner = owner[segment] as Record<string, unknown>;
  }
  const finalSegment = segments.at(-1);
  if (!finalSegment) {
    throw new Error(`Invalid sweep prop path: ${path}`);
  }
  owner[finalSegment] = value;
  return props;
}

function labelValue(value: unknown): string {
  const serialized = JSON.stringify(value);
  return serialized === undefined ? String(value) : serialized;
}

function sweepDriverSource(
  options: SweepOptions,
  variantProps: Record<string, unknown>[]
): string {
  return `
    import * as THREE from "three";
    import { WebGPURenderer } from "three/webgpu";
    import * as SourceModule from ${JSON.stringify(options.entry)};

    (async () => {
      try {
        const factory = SourceModule[${JSON.stringify(options.exportName)}];
        window.__UISCENE_STATUS__ = {
          moduleLoaded: true,
          exportFound: factory !== undefined,
        };
        if (typeof factory !== "function") {
          throw new Error(
            "Requested export ${options.exportName.replaceAll('"', '\\"')} not found or is not a scene factory in ${options.entry.replaceAll('"', '\\"')}"
          );
        }
        const variantProps = ${JSON.stringify(variantProps)};
        const variantIndex = Number(
          window.__SCENEPROOF_SWEEP_VARIANT_INDEX__ ?? 0
        );
        const result = await factory({
          width: ${options.width},
          height: ${options.height},
          pixelRatio: ${options.scale},
          assets: {},
          props: variantProps[variantIndex],
        });
        if (!result?.scene?.isScene || !result?.camera?.isCamera) {
          throw new Error("Scene factory must return { scene, camera }.");
        }
        await result.ready;
        const actionName = ${JSON.stringify(options.action ?? null)};
        if (actionName !== null) {
          const action = result.actions?.[actionName];
          if (typeof action !== "function") {
            throw new Error(
              "Scene fixture action " + actionName + " was not found."
            );
          }
          await action(${JSON.stringify(options.actionInput ?? {})});
        }
        const requestedTime = ${JSON.stringify(options.timeMs ?? null)};
        if (requestedTime !== null) {
          if (typeof result.seek !== "function") {
            throw new Error(
              "Scene fixture does not expose seek(timeMs), required by --time."
            );
          }
          await result.seek(requestedTime);
        }
        result.scene.updateMatrixWorld(true);
        result.camera.updateMatrixWorld(true);
        window.__UISCENE_THREE__ = {
          THREE,
          WebGPURenderer,
          result,
        };
        window.__UISCENE_READY__ = true;
      } catch (error) {
        window.__UISCENE_ERROR__ =
          error instanceof Error ? error.message : String(error);
      }
    })();
  `;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: One sweep transaction owns variant lifecycles, GPU provenance, raster comparison, ranking, and manifest attribution.
export async function renderThreeSweep(
  options: SweepOptions
): Promise<SweepRenderReport> {
  if (options.sweep.values.length < 2 || options.sweep.values.length > 12) {
    throw new Error("--sweep requires between 2 and 12 scalar values.");
  }
  const requestedOutput = resolve(options.out);
  const contactSheetIsFile = extname(requestedOutput).toLowerCase() === ".png";
  const directory = contactSheetIsFile
    ? join(
        dirname(requestedOutput),
        `${basename(requestedOutput, extname(requestedOutput))}-sweep`
      )
    : requestedOutput;
  const contactSheet = contactSheetIsFile
    ? requestedOutput
    : join(directory, "contact-sheet.png");
  const manifest = join(directory, "sweep.json");
  await mkdir(directory, { recursive: true });
  await mkdir(dirname(contactSheet), { recursive: true });
  const variants: SweepRenderReport["variants"] = [];
  let graphics: GraphicsInfo | undefined;
  const childWarnings: string[] = [];
  const variantProps = options.sweep.values.map((value) =>
    propsWithOverride(options.props, options.sweep.path, value)
  );
  const bundle = await bundleBrowserDriver({
    entry: options.entry,
    extraCss: [],
    source: sweepDriverSource(options, variantProps),
    ...(options.threeBackend ? { threeBackend: options.threeBackend } : {}),
  });
  const tileWidth = Math.round(options.width * options.scale);
  const tileHeight = Math.round(options.height * options.scale);
  const labelHeight = 28;
  const browser = await launchBrowser({
    threeBackend: options.threeBackend ?? "webgl",
  });
  let comparisons: SweepRenderReport["comparisons"] = [];
  try {
    const browserContext = await browser.newContext({
      viewport: {
        height: options.height,
        width: options.width,
      },
    });
    const { out: _out, sweep: _sweep, ...baseRenderOptions } = options;
    for (const [index, value] of options.sweep.values.entries()) {
      const label = `${options.sweep.path}=${labelValue(value)}`;
      const artifact = join(
        directory,
        `${String(index + 1).padStart(2, "0")}-${label
          .replace(/[^a-zA-Z0-9_.-]+/g, "-")
          .slice(0, 80)}.png`
      );
      // biome-ignore lint/performance/noAwaitInLoops: Every page is one attributable fixture instance in the shared bundle/browser lifecycle.
      const page = await browserContext.newPage();
      try {
        await page.addInitScript((variantIndex) => {
          Reflect.set(
            window,
            "__SCENEPROOF_SWEEP_VARIANT_INDEX__",
            variantIndex
          );
        }, index);
        await mountBundle({
          css: "",
          javascript: bundle.javascript,
          page,
        });
        const report = await renderThree({
          ...baseRenderOptions,
          out: artifact,
          preparedPage: page,
          props: variantProps[index] ?? {},
          silhouette: false,
          stats: false,
        });
        graphics ??= report.graphics;
        variants.push({
          artifact,
          index,
          label,
          ...(report.quality ? { quality: report.quality } : {}),
          ...referenceEvidence(report, options.sweep.objective),
          success: report.success,
          value,
        });
        childWarnings.push(...(report.warnings ?? []));
      } finally {
        await page.close();
      }
    }

    const sources = await Promise.all(
      variants.map(async (variant) => {
        const bytes = await readFile(variant.artifact);
        return `data:image/png;base64,${bytes.toString("base64")}`;
      })
    );
    const contactPage = await browserContext.newPage();
    await contactPage.setViewportSize({
      height: tileHeight + labelHeight,
      width: tileWidth * variants.length,
    });
    comparisons = await contactPage.evaluate(
      async ({ height, labels, sources: imageSources, width }) => {
        const main = document.createElement("main");
        main.dataset.sceneproofSweep = "true";
        main.style.display = "flex";
        main.style.margin = "0";
        const images: HTMLImageElement[] = [];
        for (const [index, source] of imageSources.entries()) {
          const tile = document.createElement("section");
          tile.style.background = "#11111b";
          tile.style.color = "#f4f4f5";
          tile.style.font = "12px monospace";
          tile.style.height = `${height + 28}px`;
          tile.style.width = `${width}px`;
          const label = document.createElement("div");
          label.style.boxSizing = "border-box";
          label.style.height = "28px";
          label.style.overflow = "hidden";
          label.style.padding = "6px 8px";
          label.style.whiteSpace = "nowrap";
          label.textContent = labels[index] ?? "";
          const image = new Image();
          image.height = height;
          image.src = source;
          image.width = width;
          // biome-ignore lint/performance/noAwaitInLoops: Decode order preserves exact label-to-image attribution in the contact sheet.
          await image.decode();
          images.push(image);
          tile.append(label, image);
          main.append(tile);
        }
        document.documentElement.style.background = "transparent";
        document.body.style.background = "transparent";
        document.body.style.margin = "0";
        document.body.replaceChildren(main);
        const readPixels = (image: HTMLImageElement): Uint8ClampedArray => {
          const canvas = document.createElement("canvas");
          canvas.height = height;
          canvas.width = width;
          const readContext = canvas.getContext("2d", {
            willReadFrequently: true,
          });
          if (!readContext) {
            throw new Error("A 2D canvas is required for sweep comparison.");
          }
          readContext.drawImage(image, 0, 0, width, height);
          return readContext.getImageData(0, 0, width, height).data;
        };
        return images.slice(1).map(
          // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: One adjacent-pair pixel pass owns delta accumulation and perceptual-floor classification.
          (image, index) => {
            const previous = readPixels(images[index] as HTMLImageElement);
            const current = readPixels(image);
            let absoluteDelta = 0;
            let changedPixels = 0;
            for (let offset = 0; offset < current.length; offset += 4) {
              const redDelta = Math.abs(
                (current[offset] ?? 0) - (previous[offset] ?? 0)
              );
              const greenDelta = Math.abs(
                (current[offset + 1] ?? 0) - (previous[offset + 1] ?? 0)
              );
              const blueDelta = Math.abs(
                (current[offset + 2] ?? 0) - (previous[offset + 2] ?? 0)
              );
              absoluteDelta += redDelta + greenDelta + blueDelta;
              if (Math.max(redDelta, greenDelta, blueDelta) > 2) {
                changedPixels += 1;
              }
            }
            const pixelCount = Math.max(1, width * height);
            const normalizedRasterDelta =
              absoluteDelta / (pixelCount * 3 * 255);
            const changedPixelFraction = changedPixels / pixelCount;
            let classification:
              | "below-perceptual-floor"
              | "changed"
              | "identical" = "changed";
            if (absoluteDelta === 0) {
              classification = "identical";
            } else if (
              normalizedRasterDelta < 0.001 &&
              changedPixelFraction < 0.005
            ) {
              classification = "below-perceptual-floor";
            }
            return {
              changedPixelFraction,
              classification,
              from: labels[index] ?? "",
              normalizedRasterDelta,
              to: labels[index + 1] ?? "",
            };
          }
        );
      },
      {
        height: tileHeight,
        labels: variants.map((variant) =>
          variant.referenceFit
            ? `${variant.label} fit=${variant.referenceFit.score.toFixed(3)} IoU=${variant.referenceFit.components.silhouetteIoU.toFixed(3)}`
            : variant.label
        ),
        sources,
        width: tileWidth,
      }
    );
    await contactPage.locator("main[data-sceneproof-sweep='true']").screenshot({
      animations: "disabled",
      caret: "hide",
      path: contactSheet,
      scale: "css",
      timeout: 120_000,
    });
    await contactPage.close();
  } finally {
    await browser.close();
  }
  const changed = comparisons.some(
    (comparison) => comparison.classification === "changed"
  );
  const warnings = [
    ...new Set(childWarnings),
    ...(changed
      ? []
      : [
          "The sweep produced no adjacent visual change above the perceptual floor; verify the prop path and fixture ownership.",
        ]),
  ];
  const ranked = variants
    .filter(
      (variant): variant is typeof variant & { referenceFit: ReferenceFit } =>
        variant.referenceFit !== undefined
    )
    .toSorted(
      (left, right) => right.referenceFit.score - left.referenceFit.score
    );
  const [best] = ranked;
  const executionSucceeded =
    variants.every((variant) => variant.success) &&
    (await stat(contactSheet)).size > 0;
  const status = changed
    ? agentReviewStatus({
        evidenceJudgeable: true,
        executionSucceeded,
        reason: best
          ? `SceneProof ranked ${options.sweep.objective} reference evidence; the agent must inspect the variants before accepting one.`
          : "The sweep produced attributable visual variation; the agent must inspect the variants before choosing one.",
      })
    : assertionStatus({
        executionSucceeded,
        objective: "variation",
        passed: false,
        reason:
          "The sweep produced no adjacent visual change above the perceptual floor.",
      });
  const report: SweepRenderReport = {
    ...status,
    artifacts: { contactSheet, directory, manifest },
    command: "render-sweep",
    comparisons,
    ...(graphics ? { graphics } : {}),
    lifecycle: {
      browserLaunches: 1,
      bundles: 1,
      sceneInstances: variants.length,
    },
    ...(best && changed
      ? {
          recommendation: {
            basis: "highest-reference-fit" as const,
            caveat: `This ranks ${options.sweep.objective} reference evidence; it is not a taste verdict or proof of semantic equivalence.`,
            index: best.index,
            label: best.label,
            score: best.referenceFit.score,
            value: best.value,
          },
        }
      : {}),
    success: executionSucceeded,
    sweep: options.sweep,
    variants,
    warnings,
  };
  await writeFile(manifest, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}
