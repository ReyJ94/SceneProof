import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";

import { launchBrowser, mountBundle } from "./browser-runtime.js";
import { scoreReferenceFit } from "./reference-fit.js";
import { agentReviewStatus } from "./report-status.js";
import type {
  EvidenceStatus,
  ExecutionStatus,
  LogicalRegion,
  ReferenceComparisonReport,
  RenderQuality,
  VisualAssessment,
} from "./scene-schema.js";
import { bundleBrowserDriver } from "./source-bundle.js";
import type { GraphicsInfo } from "./three-backend.js";
import {
  renderThree,
  type ThreeProjection,
  type ThreeTargetView,
} from "./three-renderer.js";

type RenderThreeOptions = Parameters<typeof renderThree>[0];

export type ReferenceViewInput = {
  backgroundSeeds: [number, number][];
  framing?: "fill" | "fit" | "source";
  foregroundSeeds: [number, number][];
  label: string;
  maskPath?: string;
  path: string;
  projection: ThreeProjection;
  probes: [number, number][];
  region?: LogicalRegion;
  view?: ThreeTargetView;
  viewLabel: string;
  zoom?: number;
};

type ReferenceSetOptions = Omit<
  RenderThreeOptions,
  "out" | "preparedPage" | "reference" | "silhouette" | "stats" | "view"
> & {
  out: string;
  references: ReferenceViewInput[];
};

type ReferenceViewReport = {
  artifact: string;
  camera: NonNullable<Awaited<ReturnType<typeof renderThree>>["camera"]>;
  label: string;
  quality?: RenderQuality;
  reference: ReferenceComparisonReport;
  referenceFit?: ReturnType<typeof scoreReferenceFit>;
  success: boolean;
  view: string;
};

function safeLabel(label: string): string {
  return label.replace(/[^a-zA-Z0-9_.-]+/g, "-").slice(0, 80);
}

function referenceSetDriverSource(options: ReferenceSetOptions): string {
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
          throw new Error("Requested scene export was not found.");
        }
        const result = await factory({
          width: ${options.width},
          height: ${options.height},
          pixelRatio: ${options.scale},
          assets: {},
          props: ${JSON.stringify(options.props)},
        });
        if (!result?.scene?.isScene || !result?.camera?.isCamera) {
          throw new Error("Scene factory must return { scene, camera }.");
        }
        await result.ready;
        const actionName = ${JSON.stringify(options.action ?? null)};
        if (actionName !== null) {
          const action = result.actions?.[actionName];
          if (typeof action !== "function") {
            throw new Error("Scene fixture action " + actionName + " was not found.");
          }
          await action(${JSON.stringify(options.actionInput ?? {})});
        }
        const requestedTime = ${JSON.stringify(options.timeMs ?? null)};
        if (requestedTime !== null) {
          if (typeof result.seek !== "function") {
            throw new Error("Scene fixture does not expose seek(timeMs), required by --time.");
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
        window.__UISCENE_ERROR__ = error instanceof Error ? error.message : String(error);
      }
    })();
  `;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: One reference-set transaction owns validated per-view setup, evidence attribution, aggregation, and lifecycle cleanup.
export async function renderThreeReferenceSet(
  options: ReferenceSetOptions
): Promise<{
  aggregate: {
    analyzedViews: number;
    meanBalancedFit: number | null;
    worstView: { label: string; score: number } | null;
  };
  artifacts: { contactSheet: string; directory: string; manifest: string };
  assessment: VisualAssessment;
  command: "render-reference-set";
  evidence: EvidenceStatus;
  execution: ExecutionStatus;
  graphics?: GraphicsInfo;
  lifecycle: {
    browserLaunches: number;
    bundles: number;
    sceneInstances: number;
  };
  success: boolean;
  views: ReferenceViewReport[];
  warnings: string[];
}> {
  if (options.references.length < 2 || options.references.length > 8) {
    throw new Error("--reference-set requires between 2 and 8 labeled views.");
  }
  const labels = new Set<string>();
  for (const reference of options.references) {
    if (labels.has(reference.label)) {
      throw new Error(`Duplicate reference label: ${reference.label}`);
    }
    labels.add(reference.label);
  }
  const requested = resolve(options.out);
  const directory = extname(requested)
    ? join(
        resolve(requested, ".."),
        `${basename(requested, extname(requested))}-references`
      )
    : requested;
  const manifest = join(directory, "reference-set.json");
  const contactSheet = join(directory, "contact-sheet.png");
  await mkdir(directory, { recursive: true });
  const views: ReferenceViewReport[] = [];
  let graphics: GraphicsInfo | undefined;
  const warnings: string[] = [];
  const { out: _out, references: _references, ...base } = options;
  const bundle = await bundleBrowserDriver({
    aliases: options.aliases,
    discoverCss: false,
    entry: options.entry,
    extraCss: [],
    source: referenceSetDriverSource(options),
    ...(options.threeBackend ? { threeBackend: options.threeBackend } : {}),
  });
  const browser = await launchBrowser({
    threeBackend: options.threeBackend ?? "webgl",
  });
  try {
    const browserContext = await browser.newContext({
      viewport: { height: options.height, width: options.width },
    });
    for (const [index, reference] of options.references.entries()) {
      const artifact = join(
        directory,
        `${String(index + 1).padStart(2, "0")}-${safeLabel(reference.label)}.png`
      );
      // biome-ignore lint/performance/noAwaitInLoops: Each page is one attributable view within the shared bundle/browser lifecycle.
      const page = await browserContext.newPage();
      try {
        await mountBundle({
          css: "",
          javascript: bundle.javascript,
          page,
        });
        const framing =
          reference.framing ?? (reference.view ? "fit" : base.framing);
        const zoom = reference.zoom ?? base.zoom;
        const report = await renderThree({
          ...base,
          ...(framing ? { framing } : {}),
          out: artifact,
          preparedPage: page,
          reference: {
            backgroundSeeds: reference.backgroundSeeds,
            foregroundSeeds: reference.foregroundSeeds,
            ...(reference.maskPath ? { maskPath: reference.maskPath } : {}),
            path: reference.path,
            probes: reference.probes,
            ...(reference.region ? { region: reference.region } : {}),
          },
          ...(reference.view ? { view: reference.view } : {}),
          projection: reference.projection,
          ...(zoom ? { zoom } : {}),
        });
        graphics ??= report.graphics;
        if (!(report.reference && report.camera)) {
          throw new Error(
            `Reference evidence or resolved camera was not produced for ${reference.label}.`
          );
        }
        const referenceFit = scoreReferenceFit(report.reference, "balanced");
        views.push({
          artifact,
          camera: report.camera,
          label: reference.label,
          ...(report.quality ? { quality: report.quality } : {}),
          reference: report.reference,
          ...(referenceFit ? { referenceFit } : {}),
          success: report.success,
          view: reference.viewLabel,
        });
        warnings.push(...(report.warnings ?? []));
      } finally {
        await page.close();
      }
    }
    const contactPage = await browserContext.newPage();
    try {
      const rows = await Promise.all(
        views.map(async (view) => ({
          comparison: `data:image/png;base64,${(
            await readFile(view.reference.artifacts.contactSheet)
          ).toString("base64")}`,
          overlay: view.reference.artifacts.silhouetteOverlay
            ? `data:image/png;base64,${(
                await readFile(view.reference.artifacts.silhouetteOverlay)
              ).toString("base64")}`
            : null,
        }))
      );
      const dataUrl = await contactPage.evaluate(
        async ({ imageRows, rowHeight, rowWidth }) => {
          const canvas = document.createElement("canvas");
          canvas.width = rowWidth * 4;
          canvas.height = rowHeight * imageRows.length;
          const context = canvas.getContext("2d");
          if (!context) {
            throw new Error(
              "A 2D canvas is required for reference-set evidence."
            );
          }
          const decode = async (source: string): Promise<HTMLImageElement> => {
            const image = new Image();
            image.src = source;
            await image.decode();
            return image;
          };
          const decodedRows = await Promise.all(
            imageRows.map(async (row) => ({
              comparison: await decode(row.comparison),
              overlay: row.overlay ? await decode(row.overlay) : null,
            }))
          );
          for (const [index, row] of decodedRows.entries()) {
            const y = index * rowHeight;
            context.drawImage(row.comparison, 0, y, rowWidth * 3, rowHeight);
            if (row.overlay) {
              context.drawImage(
                row.overlay,
                rowWidth * 3,
                y,
                rowWidth,
                rowHeight
              );
            }
          }
          return canvas.toDataURL("image/png");
        },
        {
          imageRows: rows,
          rowHeight: options.height,
          rowWidth: options.width,
        }
      );
      await writeFile(
        contactSheet,
        Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64")
      );
    } finally {
      await contactPage.close();
    }
  } finally {
    await browser.close();
  }
  const scored = views.flatMap((view) =>
    view.referenceFit ? [view.referenceFit.score] : []
  );
  const worstView = views.reduce<ReferenceViewReport | null>((worst, view) => {
    if (!view.referenceFit) {
      return worst;
    }
    if (
      !worst?.referenceFit ||
      view.referenceFit.score <= worst.referenceFit.score
    ) {
      return view;
    }
    return worst;
  }, null);
  const executionSucceeded =
    views.every((view) => view.success) &&
    views.length === options.references.length &&
    (await stat(contactSheet)).size > 0;
  const evidenceJudgeable =
    views.length === options.references.length &&
    views.every((view) => view.reference.analysisAvailable);
  const status = agentReviewStatus({
    evidenceJudgeable,
    executionSucceeded,
    reason: evidenceJudgeable
      ? "SceneProof measured every labeled reference view; the agent must inspect each perspective before accepting the implementation."
      : "At least one labeled reference view is unjudgeable; the agent must not claim a multi-view match.",
  });
  const result = {
    ...status,
    aggregate: {
      analyzedViews: scored.length,
      meanBalancedFit:
        scored.length > 0
          ? scored.reduce((sum, score) => sum + score, 0) / scored.length
          : null,
      worstView: worstView?.referenceFit
        ? { label: worstView.label, score: worstView.referenceFit.score }
        : null,
    },
    artifacts: { contactSheet, directory, manifest },
    command: "render-reference-set" as const,
    ...(graphics ? { graphics } : {}),
    lifecycle: {
      browserLaunches: 1,
      bundles: 1,
      sceneInstances: views.length,
    },
    provenance: {
      aliases: options.aliases,
      entry: options.entry,
      export: options.exportName,
      fixture: options.fixture,
    },
    success: executionSucceeded,
    views,
    warnings: [
      ...new Set([
        ...warnings,
        "Each reference view is evaluated independently; aggregate fit never substitutes one perspective for another.",
      ]),
    ],
  };
  await writeFile(manifest, `${JSON.stringify(result, null, 2)}\n`);
  if ((await stat(manifest)).size === 0) {
    throw new Error("Reference-set manifest was empty after writing.");
  }
  return result;
}
