import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";

import { launchBrowser, mountBundle } from "./browser-runtime.js";
import { compareRenderToReference } from "./reference-comparison.js";
import {
  agentReviewStatus,
  frameStatus,
  renderStatus,
} from "./report-status.js";
import {
  type FrameRenderReport,
  type LogicalRegion,
  type RasterizerInfo,
  type RasterStats,
  type RegionRenderReport,
  type RenderReport,
  resolveSceneNodeId,
  type SceneArtifact,
  SceneArtifactSchema,
  type ScoutCandidate,
  type ScoutReport,
} from "./scene-schema.js";
import { bundleBrowserDriver } from "./source-bundle.js";

export type FixtureProvenance = {
  action: { inputPath?: string; name: string } | null;
  props: { digest: string; path: string } | null;
  propsCompletion?: {
    mode: "typed-placeholders";
    synthesizedPaths: string[];
    unsupportedPaths: string[];
  };
  timeMs: number | null;
};

export type ThreeFraming = "fill" | "fit" | "source";

type ThreeOptions = {
  action?: string;
  actionInput?: Record<string, unknown>;
  entry: string;
  exportName: string;
  width: number;
  height: number;
  scale?: number;
  isolate?: boolean;
  background?: string;
  compare?: string;
  deliveryScale?: number;
  deliveryTolerance?: number;
  out?: string;
  nodeId?: string;
  view?: ThreeTargetView;
  zoom?: number;
  focus?: [number, number, number];
  fixture?: FixtureProvenance;
  framing?: ThreeFraming;
  margin?: number;
  inContext?: boolean;
  props: Record<string, unknown>;
  preparedPage?: import("playwright-core").Page;
  preserveFixture?: boolean;
  reference?: {
    maskPath?: string;
    path: string;
    probes: [number, number][];
    region?: LogicalRegion;
  };
  timeMs?: number;
  silhouette?: boolean;
  stats?: boolean;
};

type PixelRect = {
  height: number;
  width: number;
  x: number;
  y: number;
};

const SURFACE_LUMINANCE_SPREAD_THRESHOLD = 0.08;
const SILHOUETTE_CAVEAT =
  "This is a geometric measurement, not a taste verdict; interpret it at the intended delivery scale and against relevant scene context.";

async function compareCanvasWithPng(
  page: import("playwright-core").Page,
  selector: string,
  previousPath: string,
  currentOutput: string
): Promise<NonNullable<RenderReport["comparison"]>> {
  const previousBytes = await readFile(previousPath);
  const previousDataUrl = `data:image/png;base64,${previousBytes.toString("base64")}`;
  const compared = await page.evaluate(
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: One browser-local comparison pass validates dimensions, measures raster change, localizes it, and emits the two evidence panels.
    async ({ canvasSelector, previousSource }) => {
      const current = document.querySelector(canvasSelector);
      if (!(current instanceof HTMLCanvasElement)) {
        throw new Error(`Comparison canvas not found: ${canvasSelector}`);
      }
      const previous = new Image();
      previous.src = previousSource;
      await previous.decode();
      if (
        previous.naturalWidth !== current.width ||
        previous.naturalHeight !== current.height
      ) {
        throw new Error(
          `Comparison dimensions differ: previous ${previous.naturalWidth}x${previous.naturalHeight}, current ${current.width}x${current.height}.`
        );
      }
      const readCanvas = document.createElement("canvas");
      readCanvas.width = current.width;
      readCanvas.height = current.height;
      const readContext = readCanvas.getContext("2d", {
        willReadFrequently: true,
      });
      if (!readContext) {
        throw new Error("A 2D canvas is required for render comparison.");
      }
      readContext.drawImage(previous, 0, 0);
      const previousPixels = readContext.getImageData(
        0,
        0,
        current.width,
        current.height
      ).data;
      readContext.clearRect(0, 0, current.width, current.height);
      readContext.drawImage(current, 0, 0);
      const currentPixels = readContext.getImageData(
        0,
        0,
        current.width,
        current.height
      ).data;
      const difference = document.createElement("canvas");
      difference.width = current.width;
      difference.height = current.height;
      const differenceContext = difference.getContext("2d");
      if (!differenceContext) {
        throw new Error("A 2D canvas is required for difference evidence.");
      }
      const differenceImage = differenceContext.createImageData(
        current.width,
        current.height
      );
      let absoluteDelta = 0;
      let changedPixels = 0;
      let maximumX = -1;
      let maximumY = -1;
      let minimumX = current.width;
      let minimumY = current.height;
      for (let offset = 0; offset < currentPixels.length; offset += 4) {
        const redDelta = Math.abs(
          (currentPixels[offset] ?? 0) - (previousPixels[offset] ?? 0)
        );
        const greenDelta = Math.abs(
          (currentPixels[offset + 1] ?? 0) - (previousPixels[offset + 1] ?? 0)
        );
        const blueDelta = Math.abs(
          (currentPixels[offset + 2] ?? 0) - (previousPixels[offset + 2] ?? 0)
        );
        absoluteDelta += redDelta + greenDelta + blueDelta;
        differenceImage.data[offset] = Math.min(255, redDelta * 4);
        differenceImage.data[offset + 1] = Math.min(255, greenDelta * 4);
        differenceImage.data[offset + 2] = Math.min(255, blueDelta * 4);
        differenceImage.data[offset + 3] = 255;
        if (Math.max(redDelta, greenDelta, blueDelta) > 2) {
          changedPixels += 1;
          const pixelIndex = offset / 4;
          const x = pixelIndex % current.width;
          const y = Math.floor(pixelIndex / current.width);
          minimumX = Math.min(minimumX, x);
          minimumY = Math.min(minimumY, y);
          maximumX = Math.max(maximumX, x);
          maximumY = Math.max(maximumY, y);
        }
      }
      differenceContext.putImageData(differenceImage, 0, 0);
      const sideBySide = document.createElement("canvas");
      sideBySide.width = current.width * 2;
      sideBySide.height = current.height;
      const sideContext = sideBySide.getContext("2d");
      if (!sideContext) {
        throw new Error("A 2D canvas is required for comparison evidence.");
      }
      sideContext.drawImage(previous, 0, 0);
      sideContext.drawImage(current, current.width, 0);
      const pixelCount = Math.max(1, current.width * current.height);
      const normalizedRasterDelta = absoluteDelta / (pixelCount * 3 * 255);
      const changedPixelFraction = changedPixels / pixelCount;
      let classification: "below-perceptual-floor" | "changed" | "identical" =
        "changed";
      if (absoluteDelta === 0) {
        classification = "identical";
      } else if (
        normalizedRasterDelta < 0.001 &&
        changedPixelFraction < 0.005
      ) {
        classification = "below-perceptual-floor";
      }
      return {
        changedBounds:
          changedPixels === 0
            ? null
            : {
                height: maximumY - minimumY + 1,
                width: maximumX - minimumX + 1,
                x: minimumX,
                y: minimumY,
              },
        changedPixelFraction,
        classification,
        differenceDataUrl: difference.toDataURL("image/png"),
        normalizedRasterDelta,
        sideBySideDataUrl: sideBySide.toDataURL("image/png"),
      };
    },
    { canvasSelector: selector, previousSource: previousDataUrl }
  );
  const extension = extname(currentOutput);
  const stem = extension
    ? currentOutput.slice(
        0,
        Math.max(0, currentOutput.length - extension.length)
      )
    : currentOutput;
  const difference = `${stem}-difference.png`;
  const sideBySide = `${stem}-compare.png`;
  const decodeDataUrl = (value: string): Uint8Array =>
    Buffer.from(value.slice(value.indexOf(",") + 1), "base64");
  await Promise.all([
    writeFile(difference, decodeDataUrl(compared.differenceDataUrl)),
    writeFile(sideBySide, decodeDataUrl(compared.sideBySideDataUrl)),
  ]);
  return {
    artifacts: { difference, sideBySide },
    changedBounds: compared.changedBounds,
    changedPixelFraction: compared.changedPixelFraction,
    classification: compared.classification,
    normalizedRasterDelta: compared.normalizedRasterDelta,
    previous: previousPath,
  };
}

function rasterizerInfo(renderer: string | null): RasterizerInfo {
  return {
    kind:
      renderer?.toLowerCase().includes("swiftshader") === true
        ? "swiftshader-cpu"
        : "hardware-or-unknown",
    renderer,
  };
}

function analyzeCanvasRaster(
  page: import("playwright-core").Page,
  selector: string,
  sampleRect?: PixelRect
): Promise<
  RasterStats & {
    sampleCoverageFraction: number;
    sampleLuminance: { p10: number; p90: number };
  }
> {
  return page.evaluate(
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: One browser-local pixel pass owns dominant background, signal coverage, sample coverage, and luminance percentiles.
    ({ canvasSelector, rect }) => {
      const source = document.querySelector(canvasSelector);
      if (!(source instanceof HTMLCanvasElement)) {
        throw new Error(`Raster analysis canvas not found: ${canvasSelector}`);
      }
      const copy = document.createElement("canvas");
      copy.height = source.height;
      copy.width = source.width;
      const context = copy.getContext("2d", { willReadFrequently: true });
      if (!context) {
        throw new Error("A 2D canvas is required for raster analysis.");
      }
      context.drawImage(source, 0, 0);
      const pixels = context.getImageData(0, 0, copy.width, copy.height).data;
      const colors = new Map<string, number>();
      for (let offset = 0; offset < pixels.length; offset += 4) {
        const key = `${pixels[offset] ?? 0},${pixels[offset + 1] ?? 0},${pixels[offset + 2] ?? 0},${pixels[offset + 3] ?? 0}`;
        colors.set(key, (colors.get(key) ?? 0) + 1);
      }
      const [dominant] = [...colors.entries()].sort(
        (left, right) => right[1] - left[1]
      );
      const background = (dominant?.[0] ?? "0,0,0,0")
        .split(",")
        .map(Number) as [number, number, number, number];
      const luminance = (red: number, green: number, blue: number): number =>
        (red * 0.2126 + green * 0.7152 + blue * 0.0722) / 255;
      const signalLuminances: number[] = [];
      const sampleLuminances: number[] = [];
      let samplePixels = 0;
      let sampleSignalPixels = 0;
      const sampleLeft = Math.max(0, Math.floor(rect?.x ?? 0));
      const sampleTop = Math.max(0, Math.floor(rect?.y ?? 0));
      const sampleRight = Math.min(
        copy.width,
        Math.ceil((rect?.x ?? 0) + (rect?.width ?? copy.width))
      );
      const sampleBottom = Math.min(
        copy.height,
        Math.ceil((rect?.y ?? 0) + (rect?.height ?? copy.height))
      );
      for (let offset = 0; offset < pixels.length; offset += 4) {
        const red = pixels[offset] ?? 0;
        const green = pixels[offset + 1] ?? 0;
        const blue = pixels[offset + 2] ?? 0;
        const alpha = pixels[offset + 3] ?? 0;
        const distance = Math.hypot(
          red - background[0],
          green - background[1],
          blue - background[2],
          (alpha - background[3]) * 0.5
        );
        const isSignal = distance > 4;
        if (isSignal) {
          signalLuminances.push(luminance(red, green, blue));
        }
        const pixelIndex = offset / 4;
        const x = pixelIndex % copy.width;
        const y = Math.floor(pixelIndex / copy.width);
        if (
          x >= sampleLeft &&
          x < sampleRight &&
          y >= sampleTop &&
          y < sampleBottom
        ) {
          samplePixels += 1;
          if (isSignal) {
            sampleSignalPixels += 1;
            sampleLuminances.push(luminance(red, green, blue));
          }
        }
      }
      signalLuminances.sort((left, right) => left - right);
      sampleLuminances.sort((left, right) => left - right);
      const percentile = (
        values: readonly number[],
        fraction: number
      ): number => {
        if (values.length === 0) {
          return 0;
        }
        const index = Math.min(
          values.length - 1,
          Math.floor((values.length - 1) * fraction)
        );
        return values[index] ?? 0;
      };
      const pixelCount = Math.max(1, copy.width * copy.height);
      return {
        background: {
          color: background,
          luminance: luminance(background[0], background[1], background[2]),
        },
        coverageFraction: signalLuminances.length / pixelCount,
        luminance: {
          max: signalLuminances.at(-1) ?? 0,
          p10: percentile(signalLuminances, 0.1),
          p50: percentile(signalLuminances, 0.5),
          p90: percentile(signalLuminances, 0.9),
          p99: percentile(signalLuminances, 0.99),
        },
        sampleCoverageFraction: sampleSignalPixels / Math.max(1, samplePixels),
        sampleLuminance: {
          p10: percentile(sampleLuminances, 0.1),
          p90: percentile(sampleLuminances, 0.9),
        },
      };
    },
    { canvasSelector: selector, rect: sampleRect ?? null }
  );
}

export type ThreeTargetView = {
  azimuth: number;
  elevation: number;
  label: string;
};

export type ThreeScoutOptions = {
  action?: string;
  actionInput?: Record<string, unknown>;
  background?: string;
  entry: string;
  exportName: string;
  focus?: [number, number, number];
  focusNodeId?: string;
  height: number;
  isolate?: boolean;
  nodeId: string;
  out: string;
  width: number;
  fixture?: FixtureProvenance;
  props: Record<string, unknown>;
  timeMs?: number;
};

type ScoutCandidateSpec = {
  id: string;
  sceneCamera: boolean;
  view: ThreeTargetView | null;
  zoom: number;
};

const SCOUT_VIEWS: ThreeTargetView[] = [
  { azimuth: -90, elevation: 18, label: "front" },
  { azimuth: 0, elevation: 18, label: "side" },
  { azimuth: -90, elevation: 89, label: "top" },
  { azimuth: -45, elevation: 35, label: "isometric" },
];

function scoutCandidateSpecs(): ScoutCandidateSpec[] {
  return [
    { id: "original", sceneCamera: true, view: null, zoom: 1 },
    ...SCOUT_VIEWS.flatMap((view) =>
      [1, 4, 8].map((zoom) => ({
        id: `${view.label}-${zoom}x`,
        sceneCamera: false,
        view,
        zoom,
      }))
    ),
  ];
}

function compactNumber(value: number): string {
  return Number(value.toFixed(4)).toString();
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function detailCommand(input: {
  candidate: ScoutCandidate;
  entry: string;
  exportName: string;
  focus: [number, number, number];
  height: number;
  isolate: boolean;
  nodeId: string;
  width: number;
  fixture?: FixtureProvenance;
}): string {
  const focus = input.focus.map(compactNumber).join(",");
  let viewArgument = `--view ${input.candidate.view}`;
  if (input.candidate.view.includes(",")) {
    viewArgument = `--view=${input.candidate.view}`;
  }
  return [
    "sceneproof render",
    shellQuote(input.entry),
    shellQuote(input.nodeId),
    `--export ${shellQuote(input.exportName)}`,
    `--width ${input.width}`,
    `--height ${input.height}`,
    viewArgument,
    "--framing fill",
    `--zoom ${compactNumber(input.candidate.zoom)}`,
    `--look-at ${focus}`,
    "--scale 1",
    ...(input.fixture?.props
      ? ["--props", shellQuote(input.fixture.props.path)]
      : []),
    ...(input.fixture?.action
      ? ["--action", shellQuote(input.fixture.action.name)]
      : []),
    ...(input.fixture?.action?.inputPath
      ? ["--action-input", shellQuote(input.fixture.action.inputPath)]
      : []),
    ...(input.fixture?.timeMs === null || input.fixture?.timeMs === undefined
      ? []
      : ["--time", compactNumber(input.fixture.timeMs)]),
    ...(input.isolate ? ["--isolate"] : []),
    "--out artifacts/sceneproof-detail.png",
  ].join(" ");
}

function sourceCameraCommand(input: {
  entry: string;
  exportName: string;
  fixture?: FixtureProvenance;
  height: number;
  nodeId: string;
  width: number;
}): string {
  return [
    "sceneproof render",
    shellQuote(input.entry),
    shellQuote(input.nodeId),
    `--export ${shellQuote(input.exportName)}`,
    "--renderer three",
    `--width ${input.width}`,
    `--height ${input.height}`,
    "--view original",
    "--framing source",
    "--scale 1",
    ...(input.fixture?.props
      ? ["--props", shellQuote(input.fixture.props.path)]
      : []),
    ...(input.fixture?.action
      ? ["--action", shellQuote(input.fixture.action.name)]
      : []),
    ...(input.fixture?.action?.inputPath
      ? ["--action-input", shellQuote(input.fixture.action.inputPath)]
      : []),
    ...(input.fixture?.timeMs === null || input.fixture?.timeMs === undefined
      ? []
      : ["--time", compactNumber(input.fixture.timeMs)]),
    "--out artifacts/sceneproof-context.png",
  ].join(" ");
}

function sourceRegionCommand(input: {
  entry: string;
  exportName: string;
  fixture?: FixtureProvenance;
  height: number;
  region: LogicalRegion;
  width: number;
}): string {
  const region = [
    input.region.x,
    input.region.y,
    input.region.width,
    input.region.height,
  ].join(",");
  return [
    "sceneproof render-region",
    shellQuote(input.entry),
    `--export ${shellQuote(input.exportName)}`,
    "--renderer three",
    `--width ${input.width}`,
    `--height ${input.height}`,
    `--region ${region}`,
    "--scale 1",
    ...(input.fixture?.props
      ? ["--props", shellQuote(input.fixture.props.path)]
      : []),
    ...(input.fixture?.action
      ? ["--action", shellQuote(input.fixture.action.name)]
      : []),
    ...(input.fixture?.action?.inputPath
      ? ["--action-input", shellQuote(input.fixture.action.inputPath)]
      : []),
    ...(input.fixture?.timeMs === null || input.fixture?.timeMs === undefined
      ? []
      : ["--time", compactNumber(input.fixture.timeMs)]),
    "--out artifacts/sceneproof-source-detail.png",
  ].join(" ");
}

export function driverSource(input: ThreeOptions): string {
  return `
    import * as THREE from "three";
    import * as SourceModule from ${JSON.stringify(input.entry)};

    (async () => {
      try {
        const factory = SourceModule[${JSON.stringify(input.exportName)}];
        window.__UISCENE_STATUS__ = {
          moduleLoaded: true,
          exportFound: factory !== undefined,
        };
        if (typeof factory !== "function") {
          throw new Error(
            "Requested export ${input.exportName.replaceAll('"', '\\"')} not found or is not a scene factory in ${input.entry.replaceAll('"', '\\"')}"
          );
        }
        const result = await factory({
          width: ${input.width},
          height: ${input.height},
          pixelRatio: ${input.scale ?? 1},
          assets: {},
          props: ${JSON.stringify(input.props)},
        });
        if (!result?.scene?.isScene || !result?.camera?.isCamera) {
          throw new Error("Scene factory must return { scene, camera }.");
        }
        await result.ready;
        const actionName = ${JSON.stringify(input.action ?? null)};
        if (actionName !== null) {
          const action = result.actions?.[actionName];
          if (typeof action !== "function") {
            throw new Error(
              "Scene fixture action " + actionName + " was not found."
            );
          }
          await action(${JSON.stringify(input.actionInput ?? {})});
        }
        const requestedTime = ${JSON.stringify(input.timeMs ?? null)};
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
        window.__UISCENE_THREE__ = { THREE, result };
        window.__UISCENE_READY__ = true;
      } catch (error) {
        window.__UISCENE_ERROR__ =
          error instanceof Error ? error.message : String(error);
      }
    })();
  `;
}

async function prepareThreePage(options: ThreeOptions) {
  const bundle = await bundleBrowserDriver({
    entry: options.entry,
    extraCss: [],
    source: driverSource(options),
  });
  const browser = await launchBrowser();
  try {
    const context = await browser.newContext({
      viewport: { height: options.height, width: options.width },
    });
    const page = await context.newPage();
    await mountBundle({
      css: "",
      javascript: bundle.javascript,
      page,
    });
    return { browser, page };
  } catch (error) {
    await browser.close();
    throw error;
  }
}

async function extractThreeScene(
  page: import("playwright-core").Page,
  options: ThreeOptions
): Promise<SceneArtifact> {
  const artifact = await page.evaluate(
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Playwright must serialize the full Three.js inspection transaction into one browser callback.
    ({ entry, exportName, width, height }) => {
      const browserRuntime = Reflect.get(window, "__UISCENE_THREE__") as
        | {
            THREE: typeof import("three");
            result: {
              camera: import("three").Camera;
              scene: import("three").Scene;
              targets?: Array<{
                bounds?: import("three").Box3 | (() => import("three").Box3);
                focus?:
                  | import("three").Vector3
                  | (() => import("three").Vector3);
                id: string;
                isolate?: () => void;
                label?: string;
                members?: Array<{
                  instanceId?: number;
                  object: import("three").Object3D;
                }>;
              }>;
            };
          }
        | undefined;
      if (!browserRuntime) {
        throw new Error("Three.js runtime was not created.");
      }
      const { THREE, result } = browserRuntime;
      result.scene.updateMatrixWorld(true);

      const objects: import("three").Object3D[] = [];
      result.scene.traverse((object) => objects.push(object));
      const used = new Map<string, number>();
      const ids = new Map<import("three").Object3D, string>();
      const clean = (value: string): string =>
        value
          .normalize("NFKD")
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "")
          .slice(0, 80);

      for (const object of objects) {
        const semantic =
          (typeof object.userData.sceneproofId === "string" &&
            clean(object.userData.sceneproofId)) ||
          (typeof object.userData.uisceneId === "string" &&
            clean(object.userData.uisceneId)) ||
          (object.name && clean(object.name)) ||
          object.uuid;
        const base = `three:${semantic}`;
        const count = (used.get(base) ?? 0) + 1;
        used.set(base, count);
        const id = count === 1 ? base : `${base}~${count}`;
        ids.set(object, id);
        object.userData.__uisceneRuntimeId = id;
      }

      const vector = (value: { x: number; y: number; z: number }) => [
        value.x,
        value.y,
        value.z,
      ];
      const finiteVector = (value: import("three").Vector3): boolean =>
        [value.x, value.y, value.z].every(Number.isFinite);
      const geometrySnapshot = (object: import("three").Object3D) => {
        const geometry = Reflect.get(object, "geometry") as
          | import("three").BufferGeometry
          | undefined;
        if (!geometry) {
          return;
        }
        const attributes = Object.fromEntries(
          Object.entries(geometry.attributes).map(([name, attribute]) => {
            const values = attribute.array;
            let maximum = Number.NEGATIVE_INFINITY;
            let minimum = Number.POSITIVE_INFINITY;
            let nonFiniteCount = 0;
            for (const value of values) {
              if (typeof value !== "number" || !Number.isFinite(value)) {
                nonFiniteCount += 1;
                continue;
              }
              maximum = Math.max(maximum, value);
              minimum = Math.min(minimum, value);
            }
            return [
              name,
              {
                count: attribute.count,
                itemSize: attribute.itemSize,
                nonFiniteCount,
                normalized: attribute.normalized,
                range:
                  minimum === Number.POSITIVE_INFINITY
                    ? null
                    : { max: maximum, min: minimum },
              },
            ];
          })
        );
        return {
          attributes,
          type: geometry.type,
          vertexCount: geometry.getAttribute("position")?.count ?? 0,
        };
      };
      const primaryMaterial = (object: import("three").Object3D) => {
        const rawMaterial = Reflect.get(object, "material") as
          | import("three").Material
          | import("three").Material[]
          | undefined;
        return Array.isArray(rawMaterial) ? rawMaterial[0] : rawMaterial;
      };
      const objectUniformValue = (value: Record<string, unknown>): unknown => {
        if (
          value.isColor === true &&
          typeof value.getHexString === "function"
        ) {
          return `#${(value.getHexString as () => string)()}`;
        }
        if (typeof value.toArray === "function") {
          const serialized = (value.toArray as () => unknown[])();
          if (
            serialized.every(
              (item) =>
                typeof item === "number" ||
                typeof item === "boolean" ||
                typeof item === "string"
            )
          ) {
            return serialized;
          }
        }
        if (value.isTexture === true) {
          const image = value.image as
            | { height?: unknown; width?: unknown }
            | undefined;
          return {
            colorSpace: value.colorSpace,
            image:
              image &&
              typeof image.width === "number" &&
              typeof image.height === "number"
                ? { height: image.height, width: image.width }
                : undefined,
            name: value.name,
            type: value.type,
            uuid: value.uuid,
          };
        }
        return `[${value.constructor?.name ?? "Object"}]`;
      };
      const uniformValue = (value: unknown): unknown => {
        if (
          value === null ||
          typeof value === "boolean" ||
          typeof value === "number" ||
          typeof value === "string"
        ) {
          return value;
        }
        if (Array.isArray(value)) {
          return value.map(uniformValue);
        }
        if (typeof value !== "object") {
          return String(value);
        }
        return objectUniformValue(value as Record<string, unknown>);
      };
      const materialSnapshot = (object: import("three").Object3D) => {
        const material = primaryMaterial(object);
        if (!material) {
          return;
        }
        const snapshot: Record<string, unknown> = {
          alphaTest: material.alphaTest,
          blending: material.blending,
          depthTest: material.depthTest,
          depthWrite: material.depthWrite,
          opacity: material.opacity,
          side: material.side,
          transparent: material.transparent,
          type: material.type,
          visible: material.visible,
        };
        const color = Reflect.get(material, "color") as
          | import("three").Color
          | undefined;
        if (color) {
          snapshot.color = `#${color.getHexString()}`;
        }
        const metalness = Reflect.get(material, "metalness");
        if (typeof metalness === "number") {
          snapshot.metalness = metalness;
        }
        const roughness = Reflect.get(material, "roughness");
        if (typeof roughness === "number") {
          snapshot.roughness = roughness;
        }
        const rawDefines = Reflect.get(material, "defines") as
          | Record<string, boolean | number | string>
          | undefined;
        if (rawDefines) {
          snapshot.defines = { ...rawDefines };
        }
        const rawUniforms = Reflect.get(material, "uniforms") as
          | Record<string, { value?: unknown }>
          | undefined;
        if (rawUniforms) {
          snapshot.uniforms = Object.fromEntries(
            Object.entries(rawUniforms).map(([name, uniform]) => [
              name,
              uniformValue(uniform.value),
            ])
          );
        }
        return snapshot;
      };
      const lightSnapshot = (object: import("three").Object3D) => {
        if (Reflect.get(object, "isLight") !== true) {
          return;
        }
        const light = object as import("three").Light;
        const worldPosition = light.getWorldPosition(new THREE.Vector3());
        const snapshot: Record<string, unknown> = {
          color: `#${light.color.getHexString()}`,
          intensity: light.intensity,
          position: vector(worldPosition),
          type: light.type,
        };
        const target = Reflect.get(light, "target") as
          | import("three").Object3D
          | undefined;
        if (target) {
          const targetPosition = target.getWorldPosition(new THREE.Vector3());
          snapshot.target = vector(targetPosition);
          snapshot.direction = vector(
            targetPosition.clone().sub(worldPosition).normalize()
          );
        }
        const groundColor = Reflect.get(light, "groundColor") as
          | import("three").Color
          | undefined;
        if (groundColor) {
          snapshot.groundColor = `#${groundColor.getHexString()}`;
        }
        for (const property of [
          "angle",
          "decay",
          "distance",
          "penumbra",
          "power",
          "width",
          "height",
        ] as const) {
          const value = Reflect.get(light, property);
          if (typeof value === "number") {
            snapshot[property] = value;
          }
        }
        return snapshot;
      };
      const boundsSnapshot = (object: import("three").Object3D) => {
        const box = new THREE.Box3().setFromObject(object);
        if (!(finiteVector(box.min) && finiteVector(box.max))) {
          return;
        }
        return {
          worldBox: {
            max: vector(box.max),
            min: vector(box.min),
          },
        };
      };
      const serializeObject = (object: import("three").Object3D) => {
        const id = ids.get(object);
        if (!id) {
          throw new Error("Three.js identity assignment failed.");
        }
        const node: Record<string, unknown> & {
          children: string[];
          id: string;
        } = {
          children: object.children
            .map((child) => ids.get(child))
            .filter((child): child is string => Boolean(child)),
          id,
          kind: object.type,
          name: object.name || undefined,
          parent: object.parent ? (ids.get(object.parent) ?? null) : null,
          source: { export: exportName, file: entry },
          transform: {
            position: vector(object.position),
            rotation: [object.rotation.x, object.rotation.y, object.rotation.z],
            scale: vector(object.scale),
          },
          uuid: object.uuid,
          visible: object.visible,
        };
        const bounds = boundsSnapshot(object);
        if (bounds) {
          node.bounds = bounds;
        }
        const geometry = geometrySnapshot(object);
        if (geometry) {
          node.geometry = geometry;
        }
        const material = materialSnapshot(object);
        if (material) {
          node.material = material;
        }
        const light = lightSnapshot(object);
        if (light) {
          node.light = light;
        }
        return node;
      };
      const nodes: Array<
        Record<string, unknown> & { children: string[]; id: string }
      > = objects.map(serializeObject);
      const warnings = nodes.flatMap((node) => {
        const geometry = Reflect.get(node, "geometry") as
          | {
              attributes?: Record<
                string,
                { range?: { max: number; min: number } | null }
              >;
            }
          | undefined;
        const opacityAttribute = Reflect.get(
          geometry?.attributes ?? {},
          "aOpacity"
        ) as { range?: { max: number; min: number } | null } | undefined;
        const maximumOpacity = opacityAttribute?.range?.max;
        if (typeof maximumOpacity === "number" && maximumOpacity <= 0) {
          return [
            `${node.id} is potentially invisible: geometry attribute aOpacity maximum is 0.`,
          ];
        }
        return [];
      });
      const rootId = ids.get(result.scene) as string;
      const targetDescriptors = new Map<
        string,
        {
          bounds?: import("three").Box3 | (() => import("three").Box3);
          focus?: import("three").Vector3 | (() => import("three").Vector3);
          id: string;
          isolate?: () => void;
          label?: string;
          members: Array<{
            instanceId?: number;
            object: import("three").Object3D;
          }>;
          source: "fixture" | "instances";
        }
      >();
      for (const descriptor of result.targets ?? []) {
        const semantic = descriptor.id.startsWith("three:")
          ? descriptor.id.slice("three:".length)
          : descriptor.id;
        const id = `three:${clean(semantic)}`;
        targetDescriptors.set(id, {
          ...descriptor,
          id,
          members: [...(descriptor.members ?? [])],
          source: "fixture",
        });
      }
      for (const object of objects) {
        const instanceIds = object.userData.sceneproofInstanceIds;
        if (
          Reflect.get(object, "isInstancedMesh") !== true ||
          !Array.isArray(instanceIds)
        ) {
          continue;
        }
        const count = Math.min(
          Number(Reflect.get(object, "count") ?? 0),
          instanceIds.length
        );
        for (let instanceId = 0; instanceId < count; instanceId += 1) {
          const rawId = instanceIds[instanceId];
          if (typeof rawId !== "string" || clean(rawId).length === 0) {
            continue;
          }
          const id = `three:${clean(rawId)}`;
          const existing = targetDescriptors.get(id);
          if (existing) {
            existing.members.push({ instanceId, object });
          } else {
            targetDescriptors.set(id, {
              id,
              members: [{ instanceId, object }],
              source: "instances",
            });
          }
        }
      }
      const memberBox = (
        member: {
          instanceId?: number;
          object: import("three").Object3D;
        },
        target: import("three").Box3
      ): void => {
        if (
          typeof member.instanceId === "number" &&
          Reflect.get(member.object, "isInstancedMesh") === true
        ) {
          const mesh = member.object as import("three").InstancedMesh;
          if (!mesh.geometry.boundingBox) {
            mesh.geometry.computeBoundingBox();
          }
          if (!mesh.geometry.boundingBox) {
            return;
          }
          const matrix = new THREE.Matrix4();
          mesh.getMatrixAt(member.instanceId, matrix);
          const world = matrix.premultiply(mesh.matrixWorld);
          target.union(mesh.geometry.boundingBox.clone().applyMatrix4(world));
          return;
        }
        target.union(new THREE.Box3().setFromObject(member.object));
      };
      for (const descriptor of targetDescriptors.values()) {
        const rawBounds =
          typeof descriptor.bounds === "function"
            ? descriptor.bounds()
            : descriptor.bounds;
        const box = rawBounds?.isBox3 ? rawBounds.clone() : new THREE.Box3();
        if (!rawBounds?.isBox3) {
          for (const member of descriptor.members) {
            memberBox(member, box);
          }
        }
        const size = box.getSize(new THREE.Vector3());
        if (
          !(
            finiteVector(box.min) &&
            finiteVector(box.max) &&
            finiteVector(size)
          ) ||
          Math.max(size.x, size.y, size.z) <= 0
        ) {
          warnings.push(
            `${descriptor.id} semantic target has empty or invalid bounds.`
          );
          continue;
        }
        const rawFocus =
          typeof descriptor.focus === "function"
            ? descriptor.focus()
            : descriptor.focus;
        const focus = rawFocus?.isVector3
          ? rawFocus
          : box.getCenter(new THREE.Vector3());
        let isolation = "instances";
        if (typeof descriptor.isolate === "function") {
          isolation = "fixture";
        } else if (
          descriptor.members.every((member) => member.instanceId === undefined)
        ) {
          isolation = "objects";
        }
        const uniqueMemberObjects = [
          ...new Set(descriptor.members.map((member) => member.object)),
        ];
        const soleMember =
          uniqueMemberObjects.length === 1 ? uniqueMemberObjects[0] : undefined;
        const drawOwnerId = soleMember ? ids.get(soleMember) : undefined;
        const drawOwner = drawOwnerId
          ? nodes.find((node) => node.id === drawOwnerId)
          : undefined;
        nodes.push({
          bounds: {
            worldBox: {
              max: vector(box.max),
              min: vector(box.min),
            },
          },
          children: [],
          focus: vector(focus),
          id: descriptor.id,
          kind: "SemanticTarget",
          name: descriptor.label,
          parent: rootId,
          selection: {
            boundsAggregateMultipleLogicalItems: false,
            granularity: "semantic",
            isolation,
            memberCount: descriptor.members.length,
            source: descriptor.source,
          },
          ...(drawOwner
            ? {
                drawOwner: {
                  ...(Reflect.has(drawOwner, "geometry")
                    ? { geometry: Reflect.get(drawOwner, "geometry") }
                    : {}),
                  id: drawOwner.id,
                  kind: Reflect.get(drawOwner, "kind"),
                  ...(Reflect.has(drawOwner, "material")
                    ? { material: Reflect.get(drawOwner, "material") }
                    : {}),
                  ...(Reflect.get(drawOwner, "name")
                    ? { name: Reflect.get(drawOwner, "name") }
                    : {}),
                },
              }
            : {}),
          source: { export: exportName, file: entry },
        });
        const root = nodes.find((node) => node.id === rootId);
        root?.children.push(descriptor.id);
      }
      return {
        assets: [],
        entry,
        export: exportName,
        nodes,
        relationships: nodes.flatMap((node) =>
          node.children.map((child) => ({
            from: node.id,
            kind: "parent-child" as const,
            to: child,
          }))
        ),
        root: rootId,
        rootIds: [rootId],
        version: 1 as const,
        viewport: { height, width },
        warnings,
      };
    },
    {
      entry: options.entry,
      exportName: options.exportName,
      height: options.height,
      width: options.width,
    }
  );
  return SceneArtifactSchema.parse(artifact);
}

async function disposeThree(
  page: import("playwright-core").Page
): Promise<void> {
  await page.evaluate(async () => {
    const runtime = Reflect.get(window, "__UISCENE_THREE__") as
      | { result?: { dispose?: () => void | Promise<void> } }
      | undefined;
    await runtime?.result?.dispose?.();
  });
}

export async function inspectThree(
  options: ThreeOptions
): Promise<SceneArtifact> {
  const runtime = await prepareThreePage(options);
  try {
    const artifact = await extractThreeScene(runtime.page, options);
    await disposeThree(runtime.page);
    return artifact;
  } finally {
    await runtime.browser.close();
  }
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Target resolution, camera framing, optional mask capture, raster evidence, comparison, and lifecycle cleanup are one atomic render transaction.
export async function renderThree(
  options: Required<
    Pick<
      ThreeOptions,
      "entry" | "exportName" | "width" | "height" | "scale" | "out" | "nodeId"
    >
  > &
    Pick<
      ThreeOptions,
      | "action"
      | "actionInput"
      | "background"
      | "compare"
      | "deliveryScale"
      | "deliveryTolerance"
      | "fixture"
      | "focus"
      | "framing"
      | "inContext"
      | "isolate"
      | "margin"
      | "props"
      | "preparedPage"
      | "preserveFixture"
      | "reference"
      | "silhouette"
      | "stats"
      | "timeMs"
      | "view"
      | "zoom"
    >
): Promise<RenderReport> {
  const totalStartedAt = performance.now();
  const ownedRuntime = options.preparedPage
    ? null
    : await prepareThreePage(options);
  const runtime = ownedRuntime ?? {
    browser: null,
    page: options.preparedPage as import("playwright-core").Page,
  };
  const output = resolve(options.out);
  try {
    const scene = await extractThreeScene(runtime.page, options);
    options.nodeId = resolveSceneNodeId(scene, options.nodeId);
    const targetNode = scene.nodes.find((node) => node.id === options.nodeId);
    if (!targetNode) {
      throw new Error(`Resolved node is missing: ${options.nodeId}`);
    }

    await mkdir(dirname(output), { recursive: true });
    const rendered = await runtime.page.evaluate(
      ({
        nodeId,
        width,
        height,
        scale,
        inContext,
        isolate,
        background,
        view,
        zoom,
        focus,
        framing,
        margin,
        silhouette,
        // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Playwright must serialize target resolution, framing, and rendering into one browser callback.
      }) => {
        const renderStartedAt = performance.now();
        const browserRuntime = Reflect.get(window, "__UISCENE_THREE__") as {
          THREE: typeof import("three");
          result: {
            camera: import("three").Camera;
            dispose?: () => void | Promise<void>;
            renderer?: import("three").WebGLRenderer;
            scene: import("three").Scene;
            targets?: Array<{
              bounds?: import("three").Box3 | (() => import("three").Box3);
              context?: Array<{
                instanceId?: number;
                object: import("three").Object3D;
              }>;
              focus?: import("three").Vector3 | (() => import("three").Vector3);
              id: string;
              isolate?: () => void;
              members?: Array<{
                instanceId?: number;
                object: import("three").Object3D;
              }>;
            }>;
          };
        };
        const { THREE, result } = browserRuntime;
        let target: import("three").Object3D | null = null;
        result.scene.traverse((object) => {
          if (object.userData.__uisceneRuntimeId === nodeId) {
            target = object;
          }
        });
        const selectedTarget = target as import("three").Object3D | null;
        const clean = (value: string): string =>
          value
            .normalize("NFKD")
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, "")
            .slice(0, 80);
        const descriptor = result.targets?.find((candidate) => {
          const id = candidate.id.startsWith("three:")
            ? candidate.id.slice("three:".length)
            : candidate.id;
          return `three:${clean(id)}` === nodeId;
        });
        const implicitMembers: Array<{
          instanceId: number;
          object: import("three").Object3D;
        }> = [];
        result.scene.traverse((object) => {
          const instanceIds = object.userData.sceneproofInstanceIds;
          if (
            Reflect.get(object, "isInstancedMesh") !== true ||
            !Array.isArray(instanceIds)
          ) {
            return;
          }
          const count = Math.min(
            Number(Reflect.get(object, "count") ?? 0),
            instanceIds.length
          );
          for (let instanceId = 0; instanceId < count; instanceId += 1) {
            const rawId = instanceIds[instanceId];
            if (
              typeof rawId === "string" &&
              `three:${clean(rawId)}` === nodeId
            ) {
              implicitMembers.push({ instanceId, object });
            }
          }
        });
        const semanticMembers = descriptor?.members ?? implicitMembers;
        const declaredContextMembers = descriptor?.context ?? [];
        if (!(selectedTarget || descriptor || semanticMembers.length > 0)) {
          throw new Error(`Target node not found: ${nodeId}`);
        }

        const isRenderable = (object: import("three").Object3D): boolean =>
          Reflect.get(object, "isMesh") === true ||
          Reflect.get(object, "isPoints") === true ||
          Reflect.get(object, "isLine") === true ||
          Reflect.get(object, "isSprite") === true;
        const targetRenderables = new Set<import("three").Object3D>();
        const collectRenderable = (object: import("three").Object3D): void => {
          object.traverse((descendant) => {
            if (isRenderable(descendant)) {
              targetRenderables.add(descendant);
            }
          });
        };
        if (selectedTarget) {
          collectRenderable(selectedTarget);
        }
        for (const member of semanticMembers) {
          collectRenderable(member.object);
        }

        result.scene.updateMatrixWorld(true);
        // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Semantic bounds support explicit boxes, objects, and individual InstancedMesh members inside the serialized page transaction.
        const resolveSemanticBox = (): import("three").Box3 => {
          const raw =
            typeof descriptor?.bounds === "function"
              ? descriptor.bounds()
              : descriptor?.bounds;
          if (raw?.isBox3) {
            return raw.clone();
          }
          const resolved = new THREE.Box3();
          for (const member of semanticMembers) {
            if (
              typeof member.instanceId === "number" &&
              Reflect.get(member.object, "isInstancedMesh") === true
            ) {
              const mesh = member.object as import("three").InstancedMesh;
              if (!mesh.geometry.boundingBox) {
                mesh.geometry.computeBoundingBox();
              }
              if (mesh.geometry.boundingBox) {
                const matrix = new THREE.Matrix4();
                mesh.getMatrixAt(member.instanceId, matrix);
                resolved.union(
                  mesh.geometry.boundingBox
                    .clone()
                    .applyMatrix4(matrix.premultiply(mesh.matrixWorld))
                );
              }
            } else {
              resolved.union(new THREE.Box3().setFromObject(member.object));
            }
          }
          return resolved;
        };
        const box = selectedTarget
          ? new THREE.Box3().setFromObject(selectedTarget)
          : resolveSemanticBox();
        const size = box.getSize(new THREE.Vector3());
        const boundsValid =
          [size.x, size.y, size.z].every(Number.isFinite) &&
          Math.max(size.x, size.y, size.z) > 0;
        if (!boundsValid) {
          throw new Error(`Target node has empty bounds: ${nodeId}`);
        }

        const contains = (
          ancestor: import("three").Object3D,
          object: import("three").Object3D
        ): boolean => {
          let current: import("three").Object3D | null = object;
          while (current) {
            if (current === ancestor) {
              return true;
            }
            current = current.parent;
          }
          return false;
        };
        const isolateTarget = (
          sceneRoot: import("three").Scene,
          isolatedTarget: import("three").Object3D
        ): void => {
          sceneRoot.traverse((object) => {
            if (object === sceneRoot) {
              return;
            }
            object.visible =
              Reflect.get(object, "isLight") === true ||
              contains(object, isolatedTarget) ||
              contains(isolatedTarget, object);
          });
        };
        if (isolate && descriptor?.isolate) {
          descriptor.isolate();
        } else if (isolate && selectedTarget) {
          isolateTarget(result.scene, selectedTarget);
        } else if (isolate && semanticMembers.length > 0) {
          const memberObjects = semanticMembers.map((member) => member.object);
          result.scene.traverse((object) => {
            if (object === result.scene) {
              return;
            }
            object.visible =
              Reflect.get(object, "isLight") === true ||
              memberObjects.some(
                (member) => contains(object, member) || contains(member, object)
              );
          });
        } else if (inContext && declaredContextMembers.length > 0) {
          const memberObjects = [
            ...semanticMembers.map((member) => member.object),
            ...declaredContextMembers.map((member) => member.object),
          ];
          if (selectedTarget) {
            memberObjects.push(selectedTarget);
          }
          result.scene.traverse((object) => {
            if (object === result.scene) {
              return;
            }
            object.visible =
              Reflect.get(object, "isLight") === true ||
              memberObjects.some(
                (member) => contains(object, member) || contains(member, object)
              );
          });
        }
        let lightsPreserved = 0;
        if (isolate) {
          result.scene.traverse((object) => {
            if (Reflect.get(object, "isLight") !== true) {
              return;
            }
            if (!object.visible) {
              lightsPreserved += 1;
            }
            let current: import("three").Object3D | null = object;
            while (current) {
              current.visible = true;
              current = current.parent;
            }
          });
        }
        const effectivelyVisible = (
          object: import("three").Object3D
        ): boolean => {
          let current: import("three").Object3D | null = object;
          while (current) {
            if (!current.visible) {
              return false;
            }
            current = current.parent;
          }
          return true;
        };
        const visibleRenderables: import("three").Object3D[] = [];
        result.scene.traverse((object) => {
          if (isRenderable(object) && effectivelyVisible(object)) {
            visibleRenderables.push(object);
          }
        });
        const contextRenderableCount = visibleRenderables.filter(
          (object) => !targetRenderables.has(object)
        ).length;
        const environmentPresent = result.scene.environment !== null;
        let contextSource: "declared" | "isolated" | "scene" = "scene";
        if (isolate) {
          contextSource = "isolated";
        } else if (inContext && declaredContextMembers.length > 0) {
          contextSource = "declared";
        }
        const contextEvidence = {
          backgroundPresent:
            background !== null || result.scene.background !== null,
          contextRenderableCount,
          empty: contextRenderableCount === 0 && !environmentPresent,
          environmentPresent,
          source: contextSource,
          targetRenderableCount: targetRenderables.size,
          totalRenderableCount: visibleRenderables.length,
        };

        const cameraSnapshot = (value: import("three").Camera) => {
          const perspective = Reflect.get(value, "isPerspectiveCamera")
            ? (value as import("three").PerspectiveCamera)
            : null;
          const orthographic = Reflect.get(value, "isOrthographicCamera")
            ? (value as import("three").OrthographicCamera)
            : null;
          return {
            ...(perspective
              ? { aspect: perspective.aspect, fov: perspective.fov }
              : {}),
            far: Number(Reflect.get(value, "far") ?? 0),
            near: Number(Reflect.get(value, "near") ?? 0),
            position: value.position.toArray(),
            quaternion: value.quaternion.toArray(),
            type: value.type,
            up: value.up.toArray(),
            ...((perspective || orthographic) && "zoom" in value
              ? { zoom: Number(Reflect.get(value, "zoom")) }
              : {}),
          };
        };
        // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Perspective and orthographic source, fit, and fill modes must resolve together in the serialized renderer.
        const frameCamera = (framedCamera: import("three").Camera): void => {
          if (framing === "source") {
            return;
          }
          const center = focus
            ? new THREE.Vector3(...focus)
            : box.getCenter(new THREE.Vector3());
          const radius = Math.max(
            box.getBoundingSphere(new THREE.Sphere()).radius,
            0.1
          );
          if (Reflect.get(framedCamera, "isPerspectiveCamera")) {
            const perspective =
              framedCamera as import("three").PerspectiveCamera;
            perspective.aspect = width / height;
            const direction = view
              ? (() => {
                  const up = perspective.up.clone().normalize();
                  const horizontalX = new THREE.Vector3(
                    1,
                    0,
                    0
                  ).addScaledVector(up, -up.x);
                  if (horizontalX.lengthSq() < 0.0001) {
                    horizontalX.set(0, 0, 1).addScaledVector(up, -up.z);
                  }
                  horizontalX.normalize();
                  const horizontalY = up.clone().cross(horizontalX).normalize();
                  const azimuth = THREE.MathUtils.degToRad(view.azimuth);
                  const elevation = THREE.MathUtils.degToRad(view.elevation);
                  return horizontalX
                    .multiplyScalar(Math.cos(elevation) * Math.cos(azimuth))
                    .addScaledVector(
                      horizontalY,
                      Math.cos(elevation) * Math.sin(azimuth)
                    )
                    .addScaledVector(up, Math.sin(elevation));
                })()
              : perspective
                  .getWorldDirection(new THREE.Vector3())
                  .multiplyScalar(-1);
            if (direction.lengthSq() === 0) {
              direction.set(1, -1, 1);
            }
            direction.normalize();
            const halfFov = THREE.MathUtils.degToRad(perspective.fov / 2);
            const paddingFactor =
              framing === "fill" ? Math.max(0.25, 1 - margin) : 1 + margin * 2;
            const distance =
              ((radius / Math.sin(halfFov)) * paddingFactor) /
              Math.max(zoom, 0.001);
            perspective.position
              .copy(center)
              .addScaledVector(direction, distance);
            perspective.near = Math.max(0.01, distance - radius * 4);
            perspective.far = Math.max(
              perspective.near + 1,
              distance + radius * 8
            );
            perspective.lookAt(center);
            perspective.updateProjectionMatrix();
            return;
          }
          if (Reflect.get(framedCamera, "isOrthographicCamera")) {
            const orthographic =
              framedCamera as import("three").OrthographicCamera;
            const paddingFactor =
              framing === "fill" ? Math.max(0.25, 1 - margin) : 1 + margin * 2;
            const extent = radius * paddingFactor;
            orthographic.left = -extent * (width / height);
            orthographic.right = extent * (width / height);
            orthographic.top = extent;
            orthographic.bottom = -extent;
            orthographic.lookAt(center);
            orthographic.updateProjectionMatrix();
          }
        };
        const camera = result.camera.clone();
        const sourceCamera = cameraSnapshot(camera);
        frameCamera(camera);
        camera.updateMatrixWorld(true);
        const resolvedCamera = cameraSnapshot(camera);
        const projectedCorners = [
          [box.min.x, box.min.y, box.min.z],
          [box.min.x, box.min.y, box.max.z],
          [box.min.x, box.max.y, box.min.z],
          [box.min.x, box.max.y, box.max.z],
          [box.max.x, box.min.y, box.min.z],
          [box.max.x, box.min.y, box.max.z],
          [box.max.x, box.max.y, box.min.z],
          [box.max.x, box.max.y, box.max.z],
        ].map(([x, y, z]) => new THREE.Vector3(x, y, z).project(camera));

        const ownRenderer = !result.renderer;
        const renderer =
          result.renderer ??
          new THREE.WebGLRenderer({
            alpha: background === "transparent",
            antialias: true,
            preserveDrawingBuffer: true,
          });
        const renderedWidth = Math.round(width * scale);
        const renderedHeight = Math.round(height * scale);
        renderer.setPixelRatio(1);
        renderer.setSize(renderedWidth, renderedHeight, false);
        const gl = renderer.getContext();
        const debugRenderer = gl.getExtension("WEBGL_debug_renderer_info");
        const rendererName = String(
          debugRenderer
            ? gl.getParameter(debugRenderer.UNMASKED_RENDERER_WEBGL)
            : gl.getParameter(gl.RENDERER)
        );
        if (background && background !== "transparent") {
          renderer.setClearColor(background, 1);
        } else if (background === "transparent") {
          renderer.setClearColor(0x00_00_00, 0);
        }
        renderer.render(result.scene, camera);
        let silhouetteEvidence:
          | {
              available: true;
              areaPixels: number;
              compactness: number;
              dataUrl: string;
              granularity: "draw-owner" | "target";
              ignoredNonMeshCount: number;
              perimeterPixels: number;
              profile: {
                curvatureSignChanges: number;
                highFrequencyDirectionReversals: number;
                maximumDeviationFromFittedSplinePx: number;
                maximumDeviationFromLocalTrendPx: number;
                splineAlgorithm: "reduced-knot-catmull-rom";
              };
              targetMeshCount: number;
            }
          | {
              available: false;
              reason: string;
            }
          | undefined;
        if (silhouette) {
          const targetMeshes = [...targetRenderables].filter(
            (object) => Reflect.get(object, "isMesh") === true
          );
          if (targetMeshes.length === 0) {
            silhouetteEvidence = {
              available: false,
              reason:
                "The resolved target has no mesh draw owner; point, line, and sprite silhouettes are not measured.",
            };
          } else {
            const visibility = new Map<import("three").Object3D, boolean>();
            result.scene.traverse((object) => {
              if (isRenderable(object)) {
                visibility.set(object, object.visible);
                object.visible = targetMeshes.includes(object);
              }
            });
            const priorBackground = result.scene.background;
            const priorOverrideMaterial = result.scene.overrideMaterial;
            const priorClearColor = renderer.getClearColor(new THREE.Color());
            const priorClearAlpha = renderer.getClearAlpha();
            const maskMaterial = new THREE.MeshBasicMaterial({
              color: 0xff_ff_ff,
              side: THREE.DoubleSide,
              toneMapped: false,
            });
            result.scene.background = null;
            result.scene.overrideMaterial = maskMaterial;
            renderer.setClearColor(0x00_00_00, 1);
            renderer.render(result.scene, camera);

            const maskCanvas = document.createElement("canvas");
            maskCanvas.width = renderedWidth;
            maskCanvas.height = renderedHeight;
            const maskContext = maskCanvas.getContext("2d", {
              willReadFrequently: true,
            });
            if (!maskContext) {
              throw new Error(
                "A 2D canvas is required for silhouette diagnostics."
              );
            }
            maskContext.drawImage(renderer.domElement, 0, 0);
            const maskImage = maskContext.getImageData(
              0,
              0,
              renderedWidth,
              renderedHeight
            );
            const binary = new Uint8Array(renderedWidth * renderedHeight);
            let areaPixels = 0;
            for (let pixel = 0; pixel < binary.length; pixel += 1) {
              const offset = pixel * 4;
              const luminance =
                ((maskImage.data[offset] ?? 0) +
                  (maskImage.data[offset + 1] ?? 0) +
                  (maskImage.data[offset + 2] ?? 0)) /
                3;
              if (luminance > 127) {
                binary[pixel] = 1;
                areaPixels += 1;
                maskImage.data[offset] = 255;
                maskImage.data[offset + 1] = 255;
                maskImage.data[offset + 2] = 255;
              } else {
                maskImage.data[offset] = 0;
                maskImage.data[offset + 1] = 0;
                maskImage.data[offset + 2] = 0;
              }
              maskImage.data[offset + 3] = 255;
            }
            maskContext.putImageData(maskImage, 0, 0);

            let perimeterPixels = 0;
            const leftByRow: number[] = [];
            const rightByRow: number[] = [];
            for (let y = 0; y < renderedHeight; y += 1) {
              let left = renderedWidth;
              let right = -1;
              for (let x = 0; x < renderedWidth; x += 1) {
                const pixel = y * renderedWidth + x;
                if (binary[pixel] !== 1) {
                  continue;
                }
                left = Math.min(left, x);
                right = Math.max(right, x);
                if (x === 0 || binary[pixel - 1] !== 1) {
                  perimeterPixels += 1;
                }
                if (x === renderedWidth - 1 || binary[pixel + 1] !== 1) {
                  perimeterPixels += 1;
                }
                if (y === 0 || binary[pixel - renderedWidth] !== 1) {
                  perimeterPixels += 1;
                }
                if (
                  y === renderedHeight - 1 ||
                  binary[pixel + renderedWidth] !== 1
                ) {
                  perimeterPixels += 1;
                }
              }
              if (right >= 0) {
                leftByRow.push(left);
                rightByRow.push(right);
              }
            }
            const topByColumn: number[] = [];
            const bottomByColumn: number[] = [];
            for (let x = 0; x < renderedWidth; x += 1) {
              let top = renderedHeight;
              let bottom = -1;
              for (let y = 0; y < renderedHeight; y += 1) {
                if (binary[y * renderedWidth + x] !== 1) {
                  continue;
                }
                top = Math.min(top, y);
                bottom = Math.max(bottom, y);
              }
              if (bottom >= 0) {
                topByColumn.push(top);
                bottomByColumn.push(bottom);
              }
            }
            const profiles = [
              leftByRow,
              rightByRow,
              topByColumn,
              bottomByColumn,
            ];
            let curvatureSignChanges = 0;
            let highFrequencyDirectionReversals = 0;
            let maximumDeviationFromFittedSplinePx = 0;
            let maximumDeviationFromLocalTrendPx = 0;
            const fittedSplineSegmentDeviation = (
              profile: number[],
              knotIndices: number[],
              knot: number
            ): number => {
              const start = knotIndices[knot] ?? 0;
              const end = knotIndices[knot + 1] ?? start;
              const p0 =
                profile[knotIndices[Math.max(0, knot - 1)] ?? start] ?? 0;
              const p1 = profile[start] ?? 0;
              const p2 = profile[end] ?? p1;
              const p3 =
                profile[
                  knotIndices[Math.min(knotIndices.length - 1, knot + 2)] ?? end
                ] ?? p2;
              let maximum = 0;
              for (let index = start; index <= end; index += 1) {
                const t = (index - start) / Math.max(1, end - start);
                const t2 = t * t;
                const t3 = t2 * t;
                const fitted =
                  0.5 *
                  (2 * p1 +
                    (-p0 + p2) * t +
                    (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
                    (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
                maximum = Math.max(
                  maximum,
                  Math.abs((profile[index] ?? fitted) - fitted)
                );
              }
              return maximum;
            };
            const fittedSplineDeviation = (profile: number[]): number => {
              if (profile.length < 8) {
                return 0;
              }
              const knotCount = Math.min(
                12,
                Math.max(4, Math.floor(profile.length / 8))
              );
              const knotIndices = Array.from(
                { length: knotCount },
                (_, index) =>
                  Math.round((index * (profile.length - 1)) / (knotCount - 1))
              );
              let maximum = 0;
              for (let knot = 0; knot < knotIndices.length - 1; knot += 1) {
                maximum = Math.max(
                  maximum,
                  fittedSplineSegmentDeviation(profile, knotIndices, knot)
                );
              }
              return maximum;
            };
            for (const profile of profiles) {
              maximumDeviationFromFittedSplinePx = Math.max(
                maximumDeviationFromFittedSplinePx,
                fittedSplineDeviation(profile)
              );
              let priorDirection = 0;
              let priorCurvature = 0;
              for (let index = 1; index < profile.length; index += 1) {
                const direction = Math.sign(
                  (profile[index] ?? 0) - (profile[index - 1] ?? 0)
                );
                if (
                  direction !== 0 &&
                  priorDirection !== 0 &&
                  direction !== priorDirection
                ) {
                  highFrequencyDirectionReversals += 1;
                }
                if (direction !== 0) {
                  priorDirection = direction;
                }
                if (index >= 2) {
                  const curvature = Math.sign(
                    (profile[index] ?? 0) -
                      2 * (profile[index - 1] ?? 0) +
                      (profile[index - 2] ?? 0)
                  );
                  if (
                    curvature !== 0 &&
                    priorCurvature !== 0 &&
                    curvature !== priorCurvature
                  ) {
                    curvatureSignChanges += 1;
                  }
                  if (curvature !== 0) {
                    priorCurvature = curvature;
                  }
                }
                if (index >= 3 && index + 3 < profile.length) {
                  let localSum = 0;
                  for (let offset = -3; offset <= 3; offset += 1) {
                    if (offset !== 0) {
                      localSum += profile[index + offset] ?? 0;
                    }
                  }
                  maximumDeviationFromLocalTrendPx = Math.max(
                    maximumDeviationFromLocalTrendPx,
                    Math.abs((profile[index] ?? 0) - localSum / 6)
                  );
                }
              }
            }
            silhouetteEvidence = {
              areaPixels,
              available: true,
              compactness:
                perimeterPixels === 0
                  ? 0
                  : (4 * Math.PI * areaPixels) /
                    (perimeterPixels * perimeterPixels),
              dataUrl: maskCanvas.toDataURL("image/png"),
              granularity: semanticMembers.some(
                (member) => typeof member.instanceId === "number"
              )
                ? "draw-owner"
                : "target",
              ignoredNonMeshCount: targetRenderables.size - targetMeshes.length,
              perimeterPixels,
              profile: {
                curvatureSignChanges,
                highFrequencyDirectionReversals,
                maximumDeviationFromFittedSplinePx,
                maximumDeviationFromLocalTrendPx,
                splineAlgorithm: "reduced-knot-catmull-rom",
              },
              targetMeshCount: targetMeshes.length,
            };

            for (const [object, wasVisible] of visibility) {
              object.visible = wasVisible;
            }
            result.scene.background = priorBackground;
            result.scene.overrideMaterial = priorOverrideMaterial;
            renderer.setClearColor(priorClearColor, priorClearAlpha);
            maskMaterial.dispose();
            renderer.render(result.scene, camera);
          }
        }
        const canvas = renderer.domElement;
        canvas.dataset.uisceneOutput = "true";
        canvas.style.display = "block";
        canvas.style.height = `${renderedHeight}px`;
        canvas.style.width = `${renderedWidth}px`;
        document.documentElement.style.background = "transparent";
        document.body.style.background = "transparent";
        document.body.style.margin = "0";
        document.body.replaceChildren(canvas);
        Reflect.set(window, "__UISCENE_OUTPUT_RENDERER__", {
          ownRenderer,
          renderer,
        });
        const center = focus
          ? new THREE.Vector3(...focus)
          : box.getCenter(new THREE.Vector3());
        const projectedX = projectedCorners.map(
          (corner) => (corner.x * 0.5 + 0.5) * renderedWidth
        );
        const projectedY = projectedCorners.map(
          (corner) => (1 - (corner.y * 0.5 + 0.5)) * renderedHeight
        );
        const targetLeft = Math.max(0, Math.min(...projectedX));
        const targetTop = Math.max(0, Math.min(...projectedY));
        const targetRight = Math.min(renderedWidth, Math.max(...projectedX));
        const targetBottom = Math.min(renderedHeight, Math.max(...projectedY));
        const targetScreenBounds = {
          height: Math.max(0, targetBottom - targetTop),
          width: Math.max(0, targetRight - targetLeft),
          x: targetLeft,
          y: targetTop,
        };

        return {
          boundsValid,
          camera: {
            ...(view
              ? {
                  azimuth: view.azimuth,
                  elevation: view.elevation,
                }
              : {}),
            framing,
            modified:
              JSON.stringify(sourceCamera) !== JSON.stringify(resolvedCamera),
            position: camera.position.toArray(),
            resolved: resolvedCamera,
            source: sourceCamera,
            target: center.toArray(),
            view: view?.label ?? "original",
            zoom,
          },
          contextEvidence,
          isolation: { lightsPreserved, requested: isolate },
          logicalSize: { height, width },
          renderedSize: {
            height: renderedHeight,
            width: renderedWidth,
          },
          rendererName,
          renderMs: performance.now() - renderStartedAt,
          silhouetteEvidence,
          targetProjectedCoverage:
            (targetScreenBounds.width * targetScreenBounds.height) /
            Math.max(1, renderedWidth * renderedHeight),
          targetScreenBounds,
        };
      },
      {
        background: options.background ?? null,
        focus: options.focus ?? null,
        framing: options.framing ?? "source",
        height: options.height,
        inContext: options.inContext ?? false,
        isolate: options.isolate ?? false,
        margin: options.margin ?? 0.12,
        nodeId: options.nodeId,
        scale: options.scale,
        silhouette:
          (options.silhouette ?? false) || options.reference !== undefined,
        view: options.view ?? null,
        width: options.width,
        zoom: options.zoom ?? 1,
      }
    );

    let silhouetteReport: RenderReport["silhouette"];
    if (rendered.silhouetteEvidence?.available === false) {
      silhouetteReport = {
        available: false,
        caveat: SILHOUETTE_CAVEAT,
        reason: rendered.silhouetteEvidence.reason,
      };
    } else if (rendered.silhouetteEvidence?.available === true) {
      const extension = extname(output);
      const stem = extension
        ? output.slice(0, Math.max(0, output.length - extension.length))
        : output;
      const artifact = `${stem}-silhouette.png`;
      await writeFile(
        artifact,
        Buffer.from(
          rendered.silhouetteEvidence.dataUrl.slice(
            rendered.silhouetteEvidence.dataUrl.indexOf(",") + 1
          ),
          "base64"
        )
      );
      silhouetteReport = {
        areaPixels: rendered.silhouetteEvidence.areaPixels,
        artifact,
        available: true,
        caveat: SILHOUETTE_CAVEAT,
        compactness: rendered.silhouetteEvidence.compactness,
        granularity: rendered.silhouetteEvidence.granularity,
        ignoredNonMeshCount: rendered.silhouetteEvidence.ignoredNonMeshCount,
        perimeterPixels: rendered.silhouetteEvidence.perimeterPixels,
        profile: rendered.silhouetteEvidence.profile,
        targetMeshCount: rendered.silhouetteEvidence.targetMeshCount,
      };
    }

    const captureStartedAt = performance.now();
    await runtime.page
      .locator("canvas[data-uiscene-output='true']")
      .screenshot({
        animations: "disabled",
        caret: "hide",
        path: output,
        scale: "css",
        timeout: 120_000,
      });
    const captureMs = performance.now() - captureStartedAt;
    const rasterStats = await analyzeCanvasRaster(
      runtime.page,
      "canvas[data-uiscene-output='true']",
      rendered.targetScreenBounds
    );
    const comparison = options.compare
      ? await compareCanvasWithPng(
          runtime.page,
          "canvas[data-uiscene-output='true']",
          options.compare,
          output
        )
      : undefined;
    if (options.reference && rendered.silhouetteEvidence?.available !== true) {
      throw new Error(
        "Reference comparison requires a mesh target with an available renderer-derived silhouette mask."
      );
    }
    const referenceComparison =
      options.reference && rendered.silhouetteEvidence?.available === true
        ? await compareRenderToReference({
            currentMaskDataUrl: rendered.silhouetteEvidence.dataUrl,
            currentOutput: output,
            ...(options.reference.maskPath
              ? { maskPath: options.reference.maskPath }
              : {}),
            page: runtime.page,
            probes: options.reference.probes,
            referencePath: options.reference.path,
            ...(options.reference.region
              ? { referenceRegion: options.reference.region }
              : {}),
            selector: "canvas[data-uiscene-output='true']",
          })
        : undefined;
    const luminanceSeparation = Math.abs(
      rasterStats.luminance.p50 - rasterStats.background.luminance
    );
    const surfaceLuminanceSpread =
      rasterStats.sampleLuminance.p90 - rasterStats.sampleLuminance.p10;
    const surfaceJudgeable =
      surfaceLuminanceSpread >= SURFACE_LUMINANCE_SPREAD_THRESHOLD;
    const deliveryScale = options.deliveryScale
      ? {
          actualHeightPx: rendered.targetScreenBounds.height / options.scale,
          requestedHeightPx: options.deliveryScale,
          satisfied:
            Math.abs(
              rendered.targetScreenBounds.height / options.scale -
                options.deliveryScale
            ) <=
            options.deliveryScale * (options.deliveryTolerance ?? 0.05),
          toleranceFraction: options.deliveryTolerance ?? 0.05,
        }
      : undefined;
    let limitingFactor: "contrast" | "dispersion" | "framing" | null = null;
    if (rendered.targetProjectedCoverage < 0.05) {
      limitingFactor = "framing";
    } else if (
      rasterStats.sampleCoverageFraction < 0.08 &&
      luminanceSeparation < 0.04
    ) {
      limitingFactor = "contrast";
    } else if (rasterStats.sampleCoverageFraction < 0.05) {
      limitingFactor = "dispersion";
    }
    const quality = {
      ...(deliveryScale ? { deliveryScale } : {}),
      explanation:
        rendered.camera.framing === "source"
          ? "The target was located for diagnostics, but the literal fixture camera was preserved; use --framing fit or --view when target framing is intended."
          : "The selected target was located and used to frame the resolved camera.",
      judgeable: limitingFactor === null,
      limitingFactor,
      surfaceJudgeable,
      surfaceLuminanceSpread,
      surfaceLuminanceThreshold: SURFACE_LUMINANCE_SPREAD_THRESHOLD,
      targetProjectedCoverage: rendered.targetProjectedCoverage,
      targetProjectedPixelSize: {
        height: rendered.targetScreenBounds.height,
        width: rendered.targetScreenBounds.width,
      },
      targetSignalCoverage: rasterStats.sampleCoverageFraction,
    };
    const warnings = [
      ...(limitingFactor === "framing"
        ? [
            `Target projection occupies only ${(rendered.targetProjectedCoverage * 100).toFixed(1)}% of the frame; framing, not scale, is limiting.`,
          ]
        : []),
      ...(limitingFactor === "contrast"
        ? [
            "The target is framed but has insufficient luminance separation from the background; inspect material and light state before changing the camera.",
          ]
        : []),
      ...(limitingFactor === "dispersion"
        ? [
            "The target bounds are framed, but visible signal occupies too little of that extent; sparse or dispersed geometry makes fit framing uninformative.",
          ]
        : []),
      ...(surfaceJudgeable
        ? []
        : [
            `Target surface dynamic range is insufficient for a supported surface-quality judgment: p90-p10 ${surfaceLuminanceSpread.toFixed(4)} is below ${SURFACE_LUMINANCE_SPREAD_THRESHOLD.toFixed(4)}.`,
          ]),
      ...(rendered.contextEvidence.empty
        ? [
            "The target was rendered without other renderable scene context or an environment; isolation is useful for identification but insufficient for contextual approval.",
          ]
        : []),
      ...(deliveryScale && !deliveryScale.satisfied
        ? [
            `Target delivery height is ${deliveryScale.actualHeightPx.toFixed(1)}px, outside ${deliveryScale.requestedHeightPx}px ± ${(deliveryScale.toleranceFraction * 100).toFixed(1)}%.`,
          ]
        : []),
      ...(rendered.rendererName.toLowerCase().includes("swiftshader")
        ? [
            "Rendering used SwiftShader CPU rasterization; this artifact is not GPU performance evidence.",
          ]
        : []),
    ];
    const outputNonempty = (await stat(output)).size > 0;
    const requestedScaleAchieved =
      rendered.renderedSize.width ===
        Math.round(options.width * options.scale) &&
      rendered.renderedSize.height ===
        Math.round(options.height * options.scale);
    const checks = {
      boundsValid: rendered.boundsValid,
      exportFound: true,
      moduleLoaded: true,
      outputNonempty,
      requestedScaleAchieved,
      targetFound: true,
    };
    await runtime.page.evaluate(() => {
      const outputRuntime = Reflect.get(
        window,
        "__UISCENE_OUTPUT_RENDERER__"
      ) as
        | {
            ownRenderer: boolean;
            renderer: import("three").WebGLRenderer;
          }
        | undefined;
      if (outputRuntime?.ownRenderer) {
        outputRuntime.renderer.dispose();
      }
      Reflect.deleteProperty(window, "__UISCENE_OUTPUT_RENDERER__");
    });
    if (!options.preserveFixture) {
      await disposeThree(runtime.page);
    }
    const executionSucceeded = Object.values(checks).every(Boolean);
    const status = renderStatus({
      ...(deliveryScale ? { deliveryScale } : {}),
      executionSucceeded,
      quality,
      ...(referenceComparison ? { reference: referenceComparison.report } : {}),
    });
    return {
      ...status,
      artifact: output,
      camera: {
        ...rendered.camera,
        position: rendered.camera.position as [number, number, number],
        target: rendered.camera.target as [number, number, number],
      },
      checks,
      ...(comparison ? { comparison } : {}),
      context: rendered.contextEvidence,
      fixture: options.fixture,
      isolation: rendered.isolation,
      logicalSize: rendered.logicalSize,
      nodeId: options.nodeId,
      quality,
      rasterizer: rasterizerInfo(rendered.rendererName),
      ...(referenceComparison ? { reference: referenceComparison.report } : {}),
      renderedSize: rendered.renderedSize,
      renderer: "three",
      scale: options.scale,
      ...(silhouetteReport ? { silhouette: silhouetteReport } : {}),
      ...(options.stats
        ? {
            stats: {
              background: rasterStats.background,
              coverageFraction: rasterStats.coverageFraction,
              luminance: rasterStats.luminance,
            },
          }
        : {}),
      success: executionSucceeded,
      timingsMs: {
        capture: captureMs,
        render: rendered.renderMs,
        total: performance.now() - totalStartedAt,
      },
      warnings: [
        ...warnings,
        ...(referenceComparison ? referenceComparison.warnings : []),
      ],
    };
  } finally {
    await runtime.browser?.close();
  }
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Frame capture coordinates validation, one live scene transaction, artifact capture, and reporting without recreating state.
export async function renderThreeFrames(
  options: Required<
    Pick<
      ThreeOptions,
      | "entry"
      | "exportName"
      | "height"
      | "nodeId"
      | "out"
      | "props"
      | "scale"
      | "width"
    >
  > &
    Pick<
      ThreeOptions,
      | "action"
      | "actionInput"
      | "background"
      | "fixture"
      | "focus"
      | "framing"
      | "isolate"
      | "margin"
      | "view"
      | "zoom"
    > & { frames: string }
): Promise<FrameRenderReport> {
  const tokens = options.frames.split(",").map((token) => token.trim());
  if (tokens.length === 0 || tokens.some((token) => token.length === 0)) {
    throw new Error(
      "--frames requires before, nonnegative milliseconds, or settled."
    );
  }
  const parsed = tokens.map((token) => {
    if (token === "before" || token === "settled") {
      return { kind: token, label: token, timeMs: null } as const;
    }
    const timeMs = Number(token);
    if (!Number.isFinite(timeMs) || timeMs < 0) {
      throw new Error(
        `Invalid frame token ${token}; expected before, settled, or nonnegative milliseconds.`
      );
    }
    return { kind: "time", label: `${timeMs}ms`, timeMs } as const;
  });
  const numeric = parsed.flatMap((frame) =>
    frame.kind === "time" ? [frame.timeMs] : []
  );
  if (
    numeric.some((time, index) => index > 0 && time < (numeric[index - 1] ?? 0))
  ) {
    throw new Error("--frames millisecond samples must be in ascending order.");
  }
  if (
    parsed.some((frame, index) => frame.kind === "before" && index !== 0) ||
    parsed.some(
      (frame, index) => frame.kind === "settled" && index !== parsed.length - 1
    )
  ) {
    throw new Error(
      "--frames requires before first and settled last when those tokens are used."
    );
  }

  const requestedOutput = resolve(options.out);
  const contactSheetIsFile = extname(requestedOutput).toLowerCase() === ".png";
  const directory = contactSheetIsFile
    ? join(
        dirname(requestedOutput),
        `${basename(requestedOutput, extname(requestedOutput))}-frames`
      )
    : requestedOutput;
  const contactSheet = contactSheetIsFile
    ? requestedOutput
    : join(directory, "contact-sheet.png");
  await mkdir(directory, { recursive: true });
  await mkdir(dirname(contactSheet), { recursive: true });
  const runtime = await prepareThreePage({
    entry: options.entry,
    exportName: options.exportName,
    height: options.height,
    props: options.props,
    scale: options.scale,
    width: options.width,
  });
  try {
    const scene = await extractThreeScene(runtime.page, options);
    options.nodeId = resolveSceneNodeId(scene, options.nodeId);
    const rendered = await runtime.page.evaluate(
      async ({
        action,
        actionInput,
        background,
        focus,
        framing,
        height,
        isolate,
        margin,
        nodeId,
        scale,
        tokens: frameTokens,
        view,
        width,
        zoom,
        // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: The timeline must remain one serialized browser transaction to preserve one fixture lifecycle.
      }) => {
        const browserRuntime = Reflect.get(window, "__UISCENE_THREE__") as {
          THREE: typeof import("three");
          result: {
            actions?: Record<
              string,
              (input?: Record<string, unknown>) => void | Promise<void>
            >;
            camera: import("three").Camera;
            renderer?: import("three").WebGLRenderer;
            scene: import("three").Scene;
            seek?: (timeMs: number) => void | Promise<void>;
            settle?: () => void | Promise<void>;
            targets?: Array<{
              bounds?: import("three").Box3 | (() => import("three").Box3);
              id: string;
              isolate?: () => void;
              members?: Array<{
                instanceId?: number;
                object: import("three").Object3D;
              }>;
            }>;
          };
        };
        const { THREE, result } = browserRuntime;
        const clean = (value: string): string =>
          value
            .normalize("NFKD")
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, "")
            .slice(0, 80);
        const descriptor = result.targets?.find((candidate) => {
          const id = candidate.id.startsWith("three:")
            ? candidate.id.slice("three:".length)
            : candidate.id;
          return `three:${clean(id)}` === nodeId;
        });
        const implicitMembers: Array<{
          instanceId: number;
          object: import("three").Object3D;
        }> = [];
        result.scene.traverse((object) => {
          const instanceIds = object.userData.sceneproofInstanceIds;
          if (
            Reflect.get(object, "isInstancedMesh") !== true ||
            !Array.isArray(instanceIds)
          ) {
            return;
          }
          const count = Math.min(
            Number(Reflect.get(object, "count") ?? 0),
            instanceIds.length
          );
          for (let instanceId = 0; instanceId < count; instanceId += 1) {
            const rawId = instanceIds[instanceId];
            if (
              typeof rawId === "string" &&
              `three:${clean(rawId)}` === nodeId
            ) {
              implicitMembers.push({ instanceId, object });
            }
          }
        });
        const semanticMembers = descriptor?.members ?? implicitMembers;
        let selectedTarget: import("three").Object3D | null = null;
        result.scene.traverse((object) => {
          if (object.userData.__uisceneRuntimeId === nodeId) {
            selectedTarget = object;
          }
        });
        if (!(selectedTarget || descriptor || semanticMembers.length > 0)) {
          throw new Error(`Target node not found: ${nodeId}`);
        }
        // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Target bounds support objects, explicit semantic bounds, and individual InstancedMesh members.
        const targetBox = (): import("three").Box3 => {
          result.scene.updateMatrixWorld(true);
          if (selectedTarget) {
            return new THREE.Box3().setFromObject(selectedTarget);
          }
          const raw =
            typeof descriptor?.bounds === "function"
              ? descriptor.bounds()
              : descriptor?.bounds;
          if (raw?.isBox3) {
            return raw.clone();
          }
          const box = new THREE.Box3();
          for (const member of semanticMembers) {
            if (
              typeof member.instanceId === "number" &&
              Reflect.get(member.object, "isInstancedMesh") === true
            ) {
              const mesh = member.object as import("three").InstancedMesh;
              if (!mesh.geometry.boundingBox) {
                mesh.geometry.computeBoundingBox();
              }
              if (mesh.geometry.boundingBox) {
                const matrix = new THREE.Matrix4();
                mesh.getMatrixAt(member.instanceId, matrix);
                box.union(
                  mesh.geometry.boundingBox
                    .clone()
                    .applyMatrix4(matrix.premultiply(mesh.matrixWorld))
                );
              }
            } else {
              box.union(new THREE.Box3().setFromObject(member.object));
            }
          }
          return box;
        };
        const contains = (
          ancestor: import("three").Object3D,
          object: import("three").Object3D
        ): boolean => {
          let current: import("three").Object3D | null = object;
          while (current) {
            if (current === ancestor) {
              return true;
            }
            current = current.parent;
          }
          return false;
        };
        if (isolate && descriptor?.isolate) {
          descriptor.isolate();
        } else if (isolate) {
          const members = selectedTarget
            ? [selectedTarget]
            : semanticMembers.map((member) => member.object);
          result.scene.traverse((object) => {
            if (object === result.scene) {
              return;
            }
            object.visible =
              Reflect.get(object, "isLight") === true ||
              members.some(
                (member) => contains(object, member) || contains(member, object)
              );
          });
        }
        if (isolate) {
          result.scene.traverse((object) => {
            if (Reflect.get(object, "isLight") !== true) {
              return;
            }
            let current: import("three").Object3D | null = object;
            while (current) {
              current.visible = true;
              current = current.parent;
            }
          });
        }

        const ownRenderer = !result.renderer;
        const renderer =
          result.renderer ??
          new THREE.WebGLRenderer({
            alpha: background === "transparent",
            antialias: true,
            preserveDrawingBuffer: true,
          });
        const renderedWidth = Math.round(width * scale);
        const renderedHeight = Math.round(height * scale);
        renderer.setPixelRatio(1);
        renderer.setSize(renderedWidth, renderedHeight, false);
        const gl = renderer.getContext();
        const debugRenderer = gl.getExtension("WEBGL_debug_renderer_info");
        const rendererName = String(
          debugRenderer
            ? gl.getParameter(debugRenderer.UNMASKED_RENDERER_WEBGL)
            : gl.getParameter(gl.RENDERER)
        );
        if (background && background !== "transparent") {
          renderer.setClearColor(background, 1);
        } else if (background === "transparent") {
          renderer.setClearColor(0x00_00_00, 0);
        }

        const sheet = document.createElement("main");
        sheet.dataset.sceneproofFrames = "true";
        sheet.style.background = "#0b0d14";
        sheet.style.color = "#e5e7eb";
        sheet.style.display = "grid";
        sheet.style.fontFamily =
          "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
        sheet.style.gap = "12px";
        sheet.style.gridTemplateColumns = `repeat(2, ${renderedWidth}px)`;
        sheet.style.padding = "16px";
        sheet.style.width = "max-content";
        let actionApplied = false;
        let actionMutatedObjectCount: number | null = action ? 0 : null;
        const serializableValue = (value: unknown): unknown => {
          if (
            value === null ||
            typeof value === "boolean" ||
            typeof value === "number" ||
            typeof value === "string"
          ) {
            return value;
          }
          if (Array.isArray(value)) {
            return value.map(serializableValue);
          }
          if (typeof value === "object" && value !== null) {
            const record = value as Record<string, unknown>;
            if (
              record.isColor === true &&
              typeof record.getHex === "function"
            ) {
              return (record.getHex as () => number)();
            }
            if (typeof record.toArray === "function") {
              return (record.toArray as () => unknown[])().map(
                serializableValue
              );
            }
          }
          return String(value);
        };
        const sceneObjectState = (): Map<import("three").Object3D, string> => {
          result.scene.updateMatrixWorld(true);
          const state = new Map<import("three").Object3D, string>();
          result.scene.traverse((object) => {
            const rawMaterial = Reflect.get(object, "material") as
              | import("three").Material
              | import("three").Material[]
              | undefined;
            let materials: import("three").Material[] = [];
            if (rawMaterial) {
              materials = Array.isArray(rawMaterial)
                ? rawMaterial
                : [rawMaterial];
            }
            const geometry = Reflect.get(object, "geometry") as
              | import("three").BufferGeometry
              | undefined;
            state.set(
              object,
              JSON.stringify({
                geometry: geometry
                  ? {
                      attributes: Object.fromEntries(
                        Object.entries(geometry.attributes).map(
                          ([name, attribute]) => [
                            name,
                            Number(
                              Reflect.get(attribute, "version") ??
                                Reflect.get(
                                  Reflect.get(attribute, "data") ?? {},
                                  "version"
                                ) ??
                                0
                            ),
                          ]
                        )
                      ),
                      drawRange: geometry.drawRange,
                    }
                  : null,
                material: materials.map((material) => {
                  const uniforms = Reflect.get(material, "uniforms") as
                    | Record<string, { value?: unknown }>
                    | undefined;
                  return {
                    color: serializableValue(Reflect.get(material, "color")),
                    opacity: material.opacity,
                    uniforms: uniforms
                      ? Object.fromEntries(
                          Object.entries(uniforms).map(([name, uniform]) => [
                            name,
                            serializableValue(uniform.value),
                          ])
                        )
                      : null,
                    visible: material.visible,
                  };
                }),
                matrix: object.matrix.toArray(),
                matrixWorld: object.matrixWorld.toArray(),
                visible: object.visible,
              })
            );
          });
          return state;
        };
        const applyAction = async (): Promise<void> => {
          if (actionApplied || !action) {
            return;
          }
          const selectedAction = result.actions?.[action];
          if (typeof selectedAction !== "function") {
            throw new Error(`Scene fixture action ${action} was not found.`);
          }
          const beforeAction = sceneObjectState();
          await selectedAction(actionInput);
          const afterAction = sceneObjectState();
          actionMutatedObjectCount = [...afterAction.entries()].filter(
            ([object, state]) => beforeAction.get(object) !== state
          ).length;
          actionApplied = true;
        };
        const outputs: Array<{
          index: number;
          label: string;
          timeMs: number | null;
        }> = [];
        const comparisons: Array<{
          changedPixelFraction: number;
          classification: "below-perceptual-floor" | "changed" | "identical";
          differenceIndex: number;
          from: string;
          normalizedRasterDelta: number;
          to: string;
        }> = [];
        let previousPixels: Uint8ClampedArray | null = null;
        let previousLabel: string | null = null;
        for (const [index, token] of frameTokens.entries()) {
          if (token.kind === "time") {
            // biome-ignore lint/performance/noAwaitInLoops: Timeline samples are intentionally sequential mutations of one live scene.
            await applyAction();
            if (typeof result.seek !== "function") {
              throw new Error(
                "Scene fixture does not expose seek(timeMs), required by --frames."
              );
            }
            await result.seek(token.timeMs);
          } else if (token.kind === "settled") {
            await applyAction();
            if (typeof result.settle !== "function") {
              throw new Error(
                "Scene fixture does not expose settle(), required by the settled frame."
              );
            }
            await result.settle();
          }
          const box = targetBox();
          const center = focus
            ? new THREE.Vector3(...focus)
            : box.getCenter(new THREE.Vector3());
          const camera = result.camera.clone();
          if (framing !== "source") {
            const radius = Math.max(
              box.getBoundingSphere(new THREE.Sphere()).radius,
              0.1
            );
            if (Reflect.get(camera, "isPerspectiveCamera")) {
              const perspective = camera as import("three").PerspectiveCamera;
              perspective.aspect = width / height;
              const direction = view
                ? (() => {
                    const up = perspective.up.clone().normalize();
                    const horizontalX = new THREE.Vector3(
                      1,
                      0,
                      0
                    ).addScaledVector(up, -up.x);
                    if (horizontalX.lengthSq() < 0.0001) {
                      horizontalX.set(0, 0, 1).addScaledVector(up, -up.z);
                    }
                    horizontalX.normalize();
                    const horizontalY = up
                      .clone()
                      .cross(horizontalX)
                      .normalize();
                    const azimuth = THREE.MathUtils.degToRad(view.azimuth);
                    const elevation = THREE.MathUtils.degToRad(view.elevation);
                    return horizontalX
                      .multiplyScalar(Math.cos(elevation) * Math.cos(azimuth))
                      .addScaledVector(
                        horizontalY,
                        Math.cos(elevation) * Math.sin(azimuth)
                      )
                      .addScaledVector(up, Math.sin(elevation));
                  })()
                : perspective
                    .getWorldDirection(new THREE.Vector3())
                    .multiplyScalar(-1);
              direction.normalize();
              const halfFov = THREE.MathUtils.degToRad(perspective.fov / 2);
              const paddingFactor =
                framing === "fill"
                  ? Math.max(0.25, 1 - margin)
                  : 1 + margin * 2;
              const distance =
                ((radius / Math.sin(halfFov)) * paddingFactor) /
                Math.max(zoom, 0.001);
              perspective.position
                .copy(center)
                .addScaledVector(direction, distance);
              perspective.lookAt(center);
              perspective.updateProjectionMatrix();
            }
          }
          camera.updateMatrixWorld(true);
          renderer.render(result.scene, camera);
          const copy = document.createElement("canvas");
          copy.dataset.sceneproofFrameIndex = String(index);
          copy.height = renderedHeight;
          copy.width = renderedWidth;
          copy.style.display = "block";
          copy.style.height = `${renderedHeight}px`;
          copy.style.width = `${renderedWidth}px`;
          const context = copy.getContext("2d", { willReadFrequently: true });
          if (!context) {
            throw new Error("A 2D canvas is required for frame capture.");
          }
          context.drawImage(renderer.domElement, 0, 0);
          const pixels = context.getImageData(
            0,
            0,
            renderedWidth,
            renderedHeight
          ).data;
          if (previousPixels && previousLabel) {
            let absoluteDelta = 0;
            let changedPixels = 0;
            const difference = document.createElement("canvas");
            difference.dataset.sceneproofFrameDifferenceIndex = String(
              comparisons.length
            );
            difference.height = renderedHeight;
            difference.width = renderedWidth;
            difference.style.display = "block";
            difference.style.height = `${renderedHeight}px`;
            difference.style.width = `${renderedWidth}px`;
            const differenceContext = difference.getContext("2d");
            if (!differenceContext) {
              throw new Error(
                "A 2D canvas is required for amplified frame differences."
              );
            }
            const differenceImage = differenceContext.createImageData(
              renderedWidth,
              renderedHeight
            );
            for (let offset = 0; offset < pixels.length; offset += 4) {
              const redDelta = Math.abs(
                (pixels[offset] ?? 0) - (previousPixels[offset] ?? 0)
              );
              const greenDelta = Math.abs(
                (pixels[offset + 1] ?? 0) - (previousPixels[offset + 1] ?? 0)
              );
              const blueDelta = Math.abs(
                (pixels[offset + 2] ?? 0) - (previousPixels[offset + 2] ?? 0)
              );
              absoluteDelta += redDelta + greenDelta + blueDelta;
              differenceImage.data[offset] = Math.min(255, redDelta * 4);
              differenceImage.data[offset + 1] = Math.min(255, greenDelta * 4);
              differenceImage.data[offset + 2] = Math.min(255, blueDelta * 4);
              differenceImage.data[offset + 3] = 255;
              if (Math.max(redDelta, greenDelta, blueDelta) > 2) {
                changedPixels += 1;
              }
            }
            const pixelCount = Math.max(1, renderedWidth * renderedHeight);
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
            comparisons.push({
              changedPixelFraction,
              classification,
              differenceIndex: comparisons.length,
              from: previousLabel,
              normalizedRasterDelta,
              to: token.label,
            });
            differenceContext.putImageData(differenceImage, 0, 0);
            const differenceCard = document.createElement("section");
            differenceCard.style.background = "#121621";
            differenceCard.style.border = "1px solid #252b3a";
            const differenceLabel = document.createElement("div");
            differenceLabel.style.padding = "8px 10px";
            differenceLabel.textContent = `${previousLabel} → ${token.label} difference (4x)`;
            differenceCard.append(difference, differenceLabel);
            sheet.append(differenceCard);
          }
          previousPixels = new Uint8ClampedArray(pixels);
          previousLabel = token.label;
          const card = document.createElement("section");
          card.style.background = "#121621";
          card.style.border = "1px solid #252b3a";
          const label = document.createElement("div");
          label.style.padding = "8px 10px";
          label.textContent = token.label;
          card.append(copy, label);
          sheet.append(card);
          outputs.push({
            index,
            label: token.label,
            timeMs: token.timeMs,
          });
        }
        document.body.style.margin = "0";
        document.body.replaceChildren(sheet);
        Reflect.set(window, "__UISCENE_FRAMES_RENDERER__", {
          ownRenderer,
          renderer,
        });
        return {
          actionMutatedObjectCount,
          comparisons,
          outputs,
          rendererName,
        };
      },
      {
        action: options.action ?? null,
        actionInput: options.actionInput ?? {},
        background: options.background ?? null,
        focus: options.focus ?? null,
        framing: options.framing ?? "source",
        height: options.height,
        isolate: options.isolate ?? false,
        margin: options.margin ?? 0.12,
        nodeId: options.nodeId,
        scale: options.scale,
        tokens: parsed,
        view: options.view ?? null,
        width: options.width,
        zoom: options.zoom ?? 1,
      }
    );
    const frames: FrameRenderReport["frames"] = [];
    for (const frame of rendered.outputs) {
      const filename =
        frame.label === "before" || frame.label === "settled"
          ? `${frame.label}.png`
          : `${String(frame.timeMs ?? 0).padStart(4, "0")}ms.png`;
      const artifact = join(directory, filename);
      // biome-ignore lint/performance/noAwaitInLoops: Playwright captures labeled canvases sequentially to keep artifact attribution deterministic.
      await runtime.page
        .locator(`canvas[data-sceneproof-frame-index="${frame.index}"]`)
        .screenshot({
          animations: "disabled",
          caret: "hide",
          path: artifact,
          scale: "css",
          timeout: 120_000,
        });
      frames.push({
        artifact,
        label: frame.label,
        timeMs: frame.timeMs,
      });
    }
    const comparisons: FrameRenderReport["comparisons"] = [];
    for (const [index, comparison] of rendered.comparisons.entries()) {
      const artifact = join(
        directory,
        `difference-${String(index + 1).padStart(2, "0")}.png`
      );
      // biome-ignore lint/performance/noAwaitInLoops: Each adjacent pair owns one attributable amplified difference artifact.
      await runtime.page
        .locator(
          `canvas[data-sceneproof-frame-difference-index="${comparison.differenceIndex}"]`
        )
        .screenshot({
          animations: "disabled",
          caret: "hide",
          path: artifact,
          scale: "css",
          timeout: 120_000,
        });
      const { differenceIndex: _differenceIndex, ...metrics } = comparison;
      comparisons.push({
        ...metrics,
        artifacts: { amplifiedDifference: artifact },
      });
    }
    await runtime.page
      .locator("main[data-sceneproof-frames='true']")
      .screenshot({
        animations: "disabled",
        caret: "hide",
        path: contactSheet,
        scale: "css",
        timeout: 120_000,
      });
    const manifest = join(directory, "frames.json");
    const motionDetected = comparisons.some(
      (comparison) => comparison.classification === "changed"
    );
    const warnings = [
      ...(options.action && rendered.actionMutatedObjectCount === 0
        ? [`Action ${options.action} mutated 0 scene objects.`]
        : []),
      ...(options.action && !motionDetected
        ? [
            "The requested action sequence contains no visual transition above the reported perceptual floor.",
          ]
        : []),
      ...comparisons.flatMap((comparison) => {
        if (comparison.classification === "identical") {
          return [
            `Frames ${comparison.from} and ${comparison.to} are pixel-identical.`,
          ];
        }
        if (comparison.classification === "below-perceptual-floor") {
          return [
            `Frames ${comparison.from} and ${comparison.to} differ below the perceptual floor.`,
          ];
        }
        return [];
      }),
    ];
    const report: FrameRenderReport = {
      action: {
        mutatedObjectCount: rendered.actionMutatedObjectCount,
        requested: Boolean(options.action),
      },
      artifacts: { contactSheet, directory, manifest },
      assessment: {
        decisionOwner: "agent",
        reasons: [],
        verdict: "not-requested",
      },
      command: "render-frames",
      comparisons,
      evidence: { claims: {}, reasons: [], status: "not-requested" },
      execution: {
        meaning: "command-execution-only",
        status: "failed",
      },
      frames,
      lifecycle: {
        actions: options.action ? 1 : 0,
        browserLaunches: 1,
        bundles: 1,
        frames: frames.length,
        sceneInstances: 1,
      },
      quality: {
        motionDetected,
        perceptualFloor: {
          changedPixelFraction: 0.005,
          normalizedRasterDelta: 0.001,
        },
      },
      rasterizer: rasterizerInfo(rendered.rendererName),
      success: false,
      warnings,
    };
    // Resolve the asynchronous artifact checks before persisting the report.
    const artifactsComplete =
      frames.length === parsed.length &&
      (
        await Promise.all(
          frames.map(async (frame) => (await stat(frame.artifact)).size > 0)
        )
      ).every(Boolean);
    report.success = artifactsComplete;
    Object.assign(
      report,
      frameStatus({
        executionSucceeded: artifactsComplete,
        motionDetected: report.quality.motionDetected,
        motionRequested: Boolean(options.action),
      })
    );
    await writeFile(manifest, `${JSON.stringify(report, null, 2)}\n`);
    await runtime.page.evaluate(() => {
      const output = Reflect.get(window, "__UISCENE_FRAMES_RENDERER__") as
        | {
            ownRenderer: boolean;
            renderer: import("three").WebGLRenderer;
          }
        | undefined;
      if (output?.ownRenderer) {
        output.renderer.dispose();
      }
      Reflect.deleteProperty(window, "__UISCENE_FRAMES_RENDERER__");
    });
    await disposeThree(runtime.page);
    return report;
  } finally {
    await runtime.browser.close();
  }
}

export async function renderThreeRegion(
  options: Required<
    Pick<
      ThreeOptions,
      "entry" | "exportName" | "width" | "height" | "scale" | "out"
    >
  > & {
    action?: string;
    actionInput?: Record<string, unknown>;
    region: LogicalRegion;
    background?: string;
    fixture?: FixtureProvenance;
    props: Record<string, unknown>;
    stats?: boolean;
    timeMs?: number;
  }
): Promise<RegionRenderReport> {
  const totalStartedAt = performance.now();
  const runtime = await prepareThreePage(options);
  const output = resolve(options.out);
  try {
    await mkdir(dirname(output), { recursive: true });
    const rendered = await runtime.page.evaluate(
      ({ width, height, scale, region, background }) => {
        const renderStartedAt = performance.now();
        const browserRuntime = Reflect.get(window, "__UISCENE_THREE__") as {
          THREE: typeof import("three");
          result: {
            camera: import("three").Camera;
            renderer?: import("three").WebGLRenderer;
            scene: import("three").Scene;
          };
        };
        const { THREE, result } = browserRuntime;
        result.scene.updateMatrixWorld(true);
        const camera = result.camera.clone();
        const setViewOffset = Reflect.get(camera, "setViewOffset") as
          | ((
              fullWidth: number,
              fullHeight: number,
              offsetX: number,
              offsetY: number,
              viewWidth: number,
              viewHeight: number
            ) => void)
          | undefined;
        const updateProjectionMatrix = Reflect.get(
          camera,
          "updateProjectionMatrix"
        ) as (() => void) | undefined;
        if (!(setViewOffset && updateProjectionMatrix)) {
          throw new Error(
            `Camera type ${camera.type} does not support logical region rendering.`
          );
        }
        setViewOffset.call(
          camera,
          width,
          height,
          region.x,
          region.y,
          region.width,
          region.height
        );
        updateProjectionMatrix.call(camera);
        camera.updateMatrixWorld(true);

        const ownRenderer = !result.renderer;
        const renderer =
          result.renderer ??
          new THREE.WebGLRenderer({
            alpha: background === "transparent",
            antialias: true,
            preserveDrawingBuffer: true,
          });
        const renderedWidth = Math.round(region.width * scale);
        const renderedHeight = Math.round(region.height * scale);
        renderer.setPixelRatio(1);
        renderer.setSize(renderedWidth, renderedHeight, false);
        if (background && background !== "transparent") {
          renderer.setClearColor(background, 1);
        } else if (background === "transparent") {
          renderer.setClearColor(0x00_00_00, 0);
        }
        renderer.render(result.scene, camera);
        const gl = renderer.getContext();
        const debugRenderer = gl.getExtension("WEBGL_debug_renderer_info");
        const rendererName = String(
          debugRenderer
            ? gl.getParameter(debugRenderer.UNMASKED_RENDERER_WEBGL)
            : gl.getParameter(gl.RENDERER)
        );
        const canvas = renderer.domElement;
        canvas.dataset.uisceneOutput = "true";
        canvas.style.display = "block";
        canvas.style.height = `${renderedHeight}px`;
        canvas.style.width = `${renderedWidth}px`;
        document.documentElement.style.background = "transparent";
        document.body.style.background = "transparent";
        document.body.style.margin = "0";
        document.body.replaceChildren(canvas);
        Reflect.set(window, "__UISCENE_OUTPUT_RENDERER__", {
          ownRenderer,
          renderer,
        });
        return {
          renderedSize: {
            height: renderedHeight,
            width: renderedWidth,
          },
          rendererName,
          renderMs: performance.now() - renderStartedAt,
        };
      },
      {
        background: options.background ?? null,
        height: options.height,
        region: options.region,
        scale: options.scale,
        width: options.width,
      }
    );

    const captureStartedAt = performance.now();
    await runtime.page
      .locator("canvas[data-uiscene-output='true']")
      .screenshot({
        animations: "disabled",
        caret: "hide",
        path: output,
        scale: "css",
        timeout: 120_000,
      });
    const captureMs = performance.now() - captureStartedAt;
    const rasterStats = options.stats
      ? await analyzeCanvasRaster(
          runtime.page,
          "canvas[data-uiscene-output='true']"
        )
      : null;
    const outputNonempty = (await stat(output)).size > 0;
    const expected = {
      height: Math.round(options.region.height * options.scale),
      width: Math.round(options.region.width * options.scale),
    };
    const checks = {
      exportFound: true,
      moduleLoaded: true,
      outputNonempty,
      regionValid: true,
      requestedScaleAchieved:
        rendered.renderedSize.width === expected.width &&
        rendered.renderedSize.height === expected.height,
    };
    await runtime.page.evaluate(() => {
      const outputRuntime = Reflect.get(
        window,
        "__UISCENE_OUTPUT_RENDERER__"
      ) as
        | {
            ownRenderer: boolean;
            renderer: import("three").WebGLRenderer;
          }
        | undefined;
      if (outputRuntime?.ownRenderer) {
        outputRuntime.renderer.dispose();
      }
      Reflect.deleteProperty(window, "__UISCENE_OUTPUT_RENDERER__");
    });
    await disposeThree(runtime.page);
    const executionSucceeded = Object.values(checks).every(Boolean);
    return {
      ...agentReviewStatus({
        evidenceJudgeable: true,
        executionSucceeded,
        reason:
          "The Three.js region was rerendered from source; the agent must inspect it before making a visual-quality claim.",
      }),
      artifact: output,
      checks,
      ...(options.fixture ? { fixture: options.fixture } : {}),
      logicalSize: {
        height: options.region.height,
        width: options.region.width,
      },
      rasterizer: rasterizerInfo(rendered.rendererName),
      region: options.region,
      renderedSize: rendered.renderedSize,
      renderer: "three",
      scale: options.scale,
      ...(rasterStats
        ? {
            stats: {
              background: rasterStats.background,
              coverageFraction: rasterStats.coverageFraction,
              luminance: rasterStats.luminance,
            },
          }
        : {}),
      success: executionSucceeded,
      timingsMs: {
        capture: captureMs,
        render: rendered.renderMs,
        total: performance.now() - totalStartedAt,
      },
    };
  } finally {
    await runtime.browser.close();
  }
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Scout owns one atomic discovery lifecycle plus the complete intent-specific evidence portfolio.
export async function scoutThree(
  options: ThreeScoutOptions
): Promise<ScoutReport> {
  const totalStartedAt = performance.now();
  const runtime = await prepareThreePage({
    ...(options.action === undefined ? {} : { action: options.action }),
    actionInput: options.actionInput ?? {},
    entry: options.entry,
    exportName: options.exportName,
    ...(options.fixture === undefined ? {} : { fixture: options.fixture }),
    height: options.height,
    props: options.props,
    scale: 1,
    ...(options.timeMs === undefined ? {} : { timeMs: options.timeMs }),
    width: options.width,
  });
  const directory = resolve(options.out);
  const artifacts = {
    contactSheet: join(directory, "contact-sheet.png"),
    report: join(directory, "scout.json"),
    structure: join(directory, "structure.json"),
  };

  try {
    const scene = await extractThreeScene(runtime.page, options);
    options.nodeId = resolveSceneNodeId(scene, options.nodeId);
    const targetNode = scene.nodes.find((node) => node.id === options.nodeId);
    if (!targetNode) {
      throw new Error(`Resolved node is missing: ${options.nodeId}`);
    }
    if (options.focusNodeId) {
      options.focusNodeId = resolveSceneNodeId(scene, options.focusNodeId);
      const focusNode = scene.nodes.find(
        (node) => node.id === options.focusNodeId
      );
      if (!focusNode) {
        throw new Error(`Focus node not found: ${options.focusNodeId}`);
      }
    }
    await mkdir(directory, { recursive: true });
    await writeFile(artifacts.structure, `${JSON.stringify(scene, null, 2)}\n`);

    const candidatePass = await runtime.page.evaluate(
      // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Playwright must serialize this complete single-page transaction so Scout can reuse one source scene and renderer.
      function runScoutPass({
        background,
        focus,
        focusNodeId,
        height,
        isolate,
        nodeId,
        specs,
        targetBounds,
        targetFocus,
        width,
      }) {
        const passStartedAt = performance.now();
        const browserRuntime = Reflect.get(window, "__UISCENE_THREE__") as
          | {
              THREE: typeof import("three");
              result: {
                camera: import("three").Camera;
                renderer?: import("three").WebGLRenderer;
                scene: import("three").Scene;
                targets?: Array<{
                  id: string;
                  isolate?: () => void;
                  members?: Array<{
                    instanceId?: number;
                    object: import("three").Object3D;
                  }>;
                }>;
              };
            }
          | undefined;
        if (!browserRuntime) {
          throw new Error("Three.js runtime was not created.");
        }
        const { THREE, result } = browserRuntime;
        result.scene.updateMatrixWorld(true);

        const findObject = (id: string): import("three").Object3D | null => {
          let found: import("three").Object3D | null = null;
          result.scene.traverse((object) => {
            if (object.userData.__uisceneRuntimeId === id) {
              found = object;
            }
          });
          return found;
        };
        const selectedTarget = findObject(nodeId);
        const targetBox = new THREE.Box3(
          new THREE.Vector3(...targetBounds.min),
          new THREE.Vector3(...targetBounds.max)
        );
        const targetSize = targetBox.getSize(new THREE.Vector3());
        const boundsValid =
          [targetSize.x, targetSize.y, targetSize.z].every(Number.isFinite) &&
          Math.max(targetSize.x, targetSize.y, targetSize.z) > 0;
        if (!boundsValid) {
          throw new Error(`Target node has empty bounds: ${nodeId}`);
        }
        const focusObject = focusNodeId ? findObject(focusNodeId) : null;
        if (focusNodeId && !focusObject) {
          throw new Error(`Focus node not found: ${focusNodeId}`);
        }
        let focusPoint = targetFocus
          ? new THREE.Vector3(...targetFocus)
          : targetBox.getCenter(new THREE.Vector3());
        if (focusObject) {
          focusPoint = new THREE.Box3()
            .setFromObject(focusObject)
            .getCenter(new THREE.Vector3());
        }
        if (focus) {
          focusPoint = new THREE.Vector3(...focus);
        }

        const contains = (
          ancestor: import("three").Object3D,
          object: import("three").Object3D
        ): boolean => {
          let current: import("three").Object3D | null = object;
          while (current) {
            if (current === ancestor) {
              return true;
            }
            current = current.parent;
          }
          return false;
        };
        const clean = (value: string): string =>
          value
            .normalize("NFKD")
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, "")
            .slice(0, 80);
        const descriptor = result.targets?.find((candidate) => {
          const id = candidate.id.startsWith("three:")
            ? candidate.id.slice("three:".length)
            : candidate.id;
          return `three:${clean(id)}` === nodeId;
        });
        const implicitMembers: Array<{
          instanceId: number;
          object: import("three").Object3D;
        }> = [];
        result.scene.traverse((object) => {
          const instanceIds = object.userData.sceneproofInstanceIds;
          if (
            Reflect.get(object, "isInstancedMesh") !== true ||
            !Array.isArray(instanceIds)
          ) {
            return;
          }
          const count = Math.min(
            Number(Reflect.get(object, "count") ?? 0),
            instanceIds.length
          );
          for (let instanceId = 0; instanceId < count; instanceId += 1) {
            const rawId = instanceIds[instanceId];
            if (
              typeof rawId === "string" &&
              `three:${clean(rawId)}` === nodeId
            ) {
              implicitMembers.push({ instanceId, object });
            }
          }
        });
        const semanticMembers = descriptor?.members ?? implicitMembers;
        if (isolate && descriptor?.isolate) {
          descriptor.isolate();
        } else if (isolate && selectedTarget) {
          result.scene.traverse((object) => {
            if (object === result.scene) {
              return;
            }
            object.visible =
              Reflect.get(object, "isLight") === true ||
              contains(object, selectedTarget) ||
              contains(selectedTarget, object);
          });
        } else if (isolate && semanticMembers.length > 0) {
          const memberObjects = semanticMembers.map((member) => member.object);
          result.scene.traverse((object) => {
            if (object === result.scene) {
              return;
            }
            object.visible =
              Reflect.get(object, "isLight") === true ||
              memberObjects.some(
                (member) => contains(object, member) || contains(member, object)
              );
          });
        }

        if (isolate) {
          result.scene.traverse((object) => {
            if (Reflect.get(object, "isLight") !== true) {
              return;
            }
            let current: import("three").Object3D | null = object;
            while (current) {
              current.visible = true;
              current = current.parent;
            }
          });
        }

        const targetRadius = Math.max(
          targetBox.getBoundingSphere(new THREE.Sphere()).radius,
          0.1
        );
        const framePerspectiveCamera = (
          perspective: import("three").PerspectiveCamera,
          view: { azimuth: number; elevation: number } | null,
          zoom: number,
          sceneCamera: boolean
        ): void => {
          perspective.aspect = width / height;
          if (sceneCamera) {
            perspective.updateProjectionMatrix();
            perspective.updateMatrixWorld(true);
            return;
          }
          const direction = view
            ? (() => {
                const up = perspective.up.clone().normalize();
                const horizontalX = new THREE.Vector3(1, 0, 0).addScaledVector(
                  up,
                  -up.x
                );
                if (horizontalX.lengthSq() < 0.0001) {
                  horizontalX.set(0, 0, 1).addScaledVector(up, -up.z);
                }
                horizontalX.normalize();
                const horizontalY = up.clone().cross(horizontalX).normalize();
                const azimuth = THREE.MathUtils.degToRad(view.azimuth);
                const elevation = THREE.MathUtils.degToRad(view.elevation);
                return horizontalX
                  .multiplyScalar(Math.cos(elevation) * Math.cos(azimuth))
                  .addScaledVector(
                    horizontalY,
                    Math.cos(elevation) * Math.sin(azimuth)
                  )
                  .addScaledVector(up, Math.sin(elevation));
              })()
            : perspective.position.clone().sub(focusPoint);
          if (direction.lengthSq() === 0) {
            direction.set(1, -1, 1);
          }
          direction.normalize();
          const halfFov = THREE.MathUtils.degToRad(perspective.fov / 2);
          const distance =
            ((targetRadius / Math.sin(halfFov)) * 1.25) / Math.max(zoom, 0.001);
          perspective.position
            .copy(focusPoint)
            .addScaledVector(direction, distance);
          perspective.near = Math.max(0.01, distance - targetRadius * 4);
          perspective.far = Math.max(
            perspective.near + 1,
            distance + targetRadius * 8
          );
          perspective.lookAt(focusPoint);
          perspective.updateProjectionMatrix();
          perspective.updateMatrixWorld(true);
        };
        const frameOrthographicCamera = (
          orthographic: import("three").OrthographicCamera,
          zoom: number,
          sceneCamera: boolean
        ): void => {
          if (!sceneCamera) {
            const extent = (targetRadius * 1.4) / Math.max(zoom, 0.001);
            orthographic.left = -extent * (width / height);
            orthographic.right = extent * (width / height);
            orthographic.top = extent;
            orthographic.bottom = -extent;
            orthographic.lookAt(focusPoint);
          }
          orthographic.updateProjectionMatrix();
          orthographic.updateMatrixWorld(true);
        };
        const frameCamera = (
          camera: import("three").Camera,
          view: { azimuth: number; elevation: number } | null,
          zoom: number,
          sceneCamera: boolean
        ): void => {
          if (Reflect.get(camera, "isPerspectiveCamera")) {
            framePerspectiveCamera(
              camera as import("three").PerspectiveCamera,
              view,
              zoom,
              sceneCamera
            );
            return;
          }
          if (Reflect.get(camera, "isOrthographicCamera")) {
            frameOrthographicCamera(
              camera as import("three").OrthographicCamera,
              zoom,
              sceneCamera
            );
          }
        };

        const boxCorners = (
          box: import("three").Box3
        ): import("three").Vector3[] => [
          new THREE.Vector3(box.min.x, box.min.y, box.min.z),
          new THREE.Vector3(box.min.x, box.min.y, box.max.z),
          new THREE.Vector3(box.min.x, box.max.y, box.min.z),
          new THREE.Vector3(box.min.x, box.max.y, box.max.z),
          new THREE.Vector3(box.max.x, box.min.y, box.min.z),
          new THREE.Vector3(box.max.x, box.min.y, box.max.z),
          new THREE.Vector3(box.max.x, box.max.y, box.min.z),
          new THREE.Vector3(box.max.x, box.max.y, box.max.z),
        ];
        const projectedMetrics = (camera: import("three").Camera) => {
          const screen = boxCorners(targetBox).map((corner) => {
            const depth = -corner
              .clone()
              .applyMatrix4(camera.matrixWorldInverse).z;
            const projected = corner.clone().project(camera);
            return {
              depth,
              x: ((projected.x + 1) / 2) * width,
              y: ((1 - projected.y) / 2) * height,
            };
          });
          const xs = screen.map((point) => point.x);
          const ys = screen.map((point) => point.y);
          const depths = screen
            .map((point) => point.depth)
            .filter(Number.isFinite);
          const minimumX = Math.min(...xs);
          const maximumX = Math.max(...xs);
          const minimumY = Math.min(...ys);
          const maximumY = Math.max(...ys);
          const intersectionWidth = Math.max(
            0,
            Math.min(width, maximumX) - Math.max(0, minimumX)
          );
          const intersectionHeight = Math.max(
            0,
            Math.min(height, maximumY) - Math.max(0, minimumY)
          );
          const clippedEdges: Array<"bottom" | "left" | "right" | "top"> = [];
          if (minimumX < 0) {
            clippedEdges.push("left");
          }
          if (maximumX > width) {
            clippedEdges.push("right");
          }
          if (minimumY < 0) {
            clippedEdges.push("top");
          }
          if (maximumY > height) {
            clippedEdges.push("bottom");
          }
          return {
            cameraDepthRange: {
              max: depths.length > 0 ? Math.max(...depths) : 0,
              min: depths.length > 0 ? Math.min(...depths) : 0,
            },
            clippedEdges,
            screenBounds: {
              height: Math.max(1, Math.ceil(intersectionHeight)),
              width: Math.max(1, Math.ceil(intersectionWidth)),
              x: Math.max(0, Math.floor(minimumX)),
              y: Math.max(0, Math.floor(minimumY)),
            },
            targetCoverage:
              (intersectionWidth * intersectionHeight) / (width * height),
          };
        };

        const copyCanvas = (source: HTMLCanvasElement): HTMLCanvasElement => {
          const copy = document.createElement("canvas");
          copy.height = height;
          copy.width = width;
          const context = copy.getContext("2d", { willReadFrequently: true });
          if (!context) {
            throw new Error("A 2D canvas is required for Scout analysis.");
          }
          context.drawImage(source, 0, 0, width, height);
          return copy;
        };
        const readPixelEvidence = (canvas: HTMLCanvasElement) => {
          const context = canvas.getContext("2d", {
            willReadFrequently: true,
          });
          if (!context) {
            throw new Error("A 2D canvas is required for Scout analysis.");
          }
          const pixels = context.getImageData(0, 0, width, height).data;
          const colorCounts = new Map<string, number>();
          const luminances = new Float32Array(width * height);
          let maximumLuminance = 0;
          let minimumLuminance = 1;
          let luminanceSum = 0;
          for (let index = 0; index < pixels.length; index += 4) {
            const red = pixels[index] ?? 0;
            const green = pixels[index + 1] ?? 0;
            const blue = pixels[index + 2] ?? 0;
            const alpha = pixels[index + 3] ?? 0;
            const colorKey = `${red},${green},${blue},${alpha}`;
            colorCounts.set(colorKey, (colorCounts.get(colorKey) ?? 0) + 1);
            const luminance =
              (red * 0.2126 + green * 0.7152 + blue * 0.0722) / 255;
            const pixelIndex = index / 4;
            luminances[pixelIndex] = luminance;
            luminanceSum += luminance;
            maximumLuminance = Math.max(maximumLuminance, luminance);
            minimumLuminance = Math.min(minimumLuminance, luminance);
          }
          return {
            colorCounts,
            luminanceSum,
            luminances,
            maximumLuminance,
            minimumLuminance,
            pixels,
          };
        };
        const dominantColorComponents = (
          colorCounts: Map<string, number>
        ): number[] => {
          const [dominant] = [...colorCounts.entries()].sort(
            (left, right) => right[1] - left[1]
          );
          return (dominant?.[0] ?? "0,0,0,0").split(",").map(Number);
        };
        const isEdgePixel = (
          index: number,
          luminances: Float32Array
        ): boolean => {
          const current = luminances[index] ?? 0;
          const x = index % width;
          const y = Math.floor(index / width);
          const right =
            x + 1 < width ? (luminances[index + 1] ?? current) : current;
          const below =
            y + 1 < height ? (luminances[index + width] ?? current) : current;
          return (
            Math.abs(current - right) > 0.025 ||
            Math.abs(current - below) > 0.025
          );
        };
        const measurePixelSignal = (
          evidence: ReturnType<typeof readPixelEvidence>
        ) => {
          const {
            colorCounts,
            luminances,
            luminanceSum,
            maximumLuminance,
            minimumLuminance,
            pixels,
          } = evidence;
          const dominantComponents = dominantColorComponents(colorCounts);
          let backgroundPixels = 0;
          let edgePixels = 0;
          let squaredDifferenceSum = 0;
          const mean = luminanceSum / Math.max(1, luminances.length);
          for (let index = 0; index < luminances.length; index += 1) {
            const current = luminances[index] ?? 0;
            const difference = current - mean;
            squaredDifferenceSum += difference * difference;
            const offset = index * 4;
            const colorDistance = Math.hypot(
              (pixels[offset] ?? 0) - (dominantComponents[0] ?? 0),
              (pixels[offset + 1] ?? 0) - (dominantComponents[1] ?? 0),
              (pixels[offset + 2] ?? 0) - (dominantComponents[2] ?? 0),
              ((pixels[offset + 3] ?? 0) - (dominantComponents[3] ?? 0)) * 0.5
            );
            if (colorDistance <= 4) {
              backgroundPixels += 1;
            }
            if (isEdgePixel(index, luminances)) {
              edgePixels += 1;
            }
          }
          const totalPixels = Math.max(1, luminances.length);
          const backgroundFraction = backgroundPixels / totalPixels;
          return {
            backgroundFraction,
            contrastStdDev: Math.sqrt(squaredDifferenceSum / totalPixels),
            edgeDensity: edgePixels / totalPixels,
            luminanceRange: {
              max: maximumLuminance,
              min: minimumLuminance,
            },
            visiblePixelFraction: 1 - backgroundFraction,
          };
        };
        const pixelMetrics = (canvas: HTMLCanvasElement) =>
          measurePixelSignal(readPixelEvidence(canvas));
        const candidateScore = (metrics: {
          clippedEdges: string[];
          contrastStdDev: number;
          edgeDensity: number;
          targetCoverage: number;
          visiblePixelFraction: number;
        }): number => {
          const coverageUtility = Math.max(
            0,
            1 - Math.abs(Math.min(1, metrics.targetCoverage) - 0.55) / 0.55
          );
          const signal = Math.min(1, metrics.visiblePixelFraction * 8);
          const contrast = Math.min(1, metrics.contrastStdDev * 10);
          const edges = Math.min(1, metrics.edgeDensity * 12);
          const clippingPenalty = metrics.clippedEdges.length * 0.08;
          return Math.max(
            0,
            signal * 0.4 +
              contrast * 0.25 +
              coverageUtility * 0.25 +
              edges * 0.1 -
              clippingPenalty
          );
        };

        const ownRenderer = !result.renderer;
        const renderer =
          result.renderer ??
          new THREE.WebGLRenderer({
            alpha: background === "transparent",
            antialias: true,
            powerPreference: "high-performance",
            preserveDrawingBuffer: true,
          });
        renderer.setPixelRatio(1);
        renderer.setSize(width, height, false);
        const gl = renderer.getContext();
        const debugRenderer = gl.getExtension("WEBGL_debug_renderer_info");
        const rendererName = String(
          debugRenderer
            ? gl.getParameter(debugRenderer.UNMASKED_RENDERER_WEBGL)
            : gl.getParameter(gl.RENDERER)
        );
        if (background && background !== "transparent") {
          renderer.setClearColor(background, 1);
        } else if (background === "transparent") {
          renderer.setClearColor(0x00_00_00, 0);
        }

        const previews: Array<{
          candidate: {
            camera: {
              azimuth?: number;
              elevation?: number;
              position: number[];
              target: number[];
            };
            id: string;
            metrics: ReturnType<typeof pixelMetrics> &
              ReturnType<typeof projectedMetrics>;
            score: number;
            timingsMs: { render: number };
            view: string;
            zoom: number;
          };
          canvas: HTMLCanvasElement;
        }> = [];
        for (const spec of specs) {
          const camera = result.camera.clone();
          frameCamera(camera, spec.view, spec.zoom, spec.sceneCamera);
          const renderStartedAt = performance.now();
          renderer.render(result.scene, camera);
          const renderMs = performance.now() - renderStartedAt;
          const canvas = copyCanvas(renderer.domElement);
          const metrics = {
            ...pixelMetrics(canvas),
            ...projectedMetrics(camera),
          };
          previews.push({
            candidate: {
              camera: {
                ...(spec.view
                  ? {
                      azimuth: spec.view.azimuth,
                      elevation: spec.view.elevation,
                    }
                  : {}),
                position: camera.position.toArray(),
                target: focusPoint.toArray(),
              },
              id: spec.id,
              metrics,
              score: candidateScore(metrics),
              timingsMs: { render: renderMs },
              view: spec.view?.label ?? "original",
              zoom: spec.zoom,
            },
            canvas,
          });
        }

        const sheet = document.createElement("main");
        sheet.dataset.uisceneScout = "true";
        sheet.style.background = "#0b0d14";
        sheet.style.color = "#e5e7eb";
        sheet.style.display = "grid";
        sheet.style.fontFamily =
          "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
        sheet.style.gap = "12px";
        sheet.style.gridTemplateColumns = `repeat(3, ${width}px)`;
        sheet.style.padding = "16px";
        sheet.style.width = "max-content";
        const heading = document.createElement("header");
        heading.style.gridColumn = "1 / -1";
        heading.style.padding = "0 2px 4px";
        const title = document.createElement("strong");
        title.textContent = `SceneProof scout · ${nodeId}`;
        const subtitle = document.createElement("div");
        subtitle.style.color = "#9ca3af";
        subtitle.style.fontSize = "12px";
        subtitle.style.marginTop = "4px";
        subtitle.textContent = `focus ${focusPoint
          .toArray()
          .map((value) => Number(value.toFixed(3)))
          .join(", ")} · ${width}×${height}`;
        heading.append(title, subtitle);
        sheet.append(heading);
        for (const preview of previews) {
          const card = document.createElement("section");
          card.style.background = "#121621";
          card.style.border = "1px solid #252b3a";
          card.style.borderRadius = "8px";
          card.style.overflow = "hidden";
          preview.canvas.style.display = "block";
          preview.canvas.style.height = `${height}px`;
          preview.canvas.style.width = `${width}px`;
          const label = document.createElement("div");
          label.style.fontSize = "11px";
          label.style.lineHeight = "1.45";
          label.style.padding = "8px 10px";
          label.textContent = `${preview.candidate.id} · score ${preview.candidate.score.toFixed(
            3
          )} · coverage ${(
            preview.candidate.metrics.targetCoverage * 100
          ).toFixed(1)}% · visible ${(
            preview.candidate.metrics.visiblePixelFraction * 100
          ).toFixed(1)}%`;
          card.append(preview.canvas, label);
          sheet.append(card);
        }
        document.documentElement.style.background = "#0b0d14";
        document.body.style.background = "#0b0d14";
        document.body.style.margin = "0";
        document.body.replaceChildren(sheet);
        Reflect.set(window, "__UISCENE_SCOUT_RENDERER__", {
          ownRenderer,
          renderer,
        });

        let focusSource: "node" | "point" | "target" = "target";
        if (focus) {
          focusSource = "point";
        }
        if (focusNodeId) {
          focusSource = "node";
        }
        return {
          candidatePassMs: performance.now() - passStartedAt,
          candidates: previews.map((preview) => preview.candidate),
          focus: {
            ...(focusNodeId ? { nodeId: focusNodeId } : {}),
            source: focusSource,
            worldPosition: focusPoint
              .toArray()
              .map((value) => Number(value.toFixed(9))),
          },
          rendererName,
        };
      },
      {
        background: options.background ?? null,
        focus: options.focus ?? null,
        focusNodeId: options.focusNodeId ?? null,
        height: options.height,
        isolate: options.isolate ?? true,
        nodeId: options.nodeId,
        specs: scoutCandidateSpecs(),
        targetBounds: (
          Reflect.get(targetNode, "bounds") as {
            worldBox: {
              max: [number, number, number];
              min: [number, number, number];
            };
          }
        ).worldBox,
        targetFocus:
          (Reflect.get(targetNode, "focus") as
            | [number, number, number]
            | undefined) ?? null,
        width: options.width,
      }
    );

    const captureStartedAt = performance.now();
    await runtime.page.locator("main[data-uiscene-scout='true']").screenshot({
      animations: "disabled",
      caret: "hide",
      path: artifacts.contactSheet,
      scale: "css",
      timeout: 120_000,
    });
    const captureMs = performance.now() - captureStartedAt;
    await runtime.page.evaluate(() => {
      const outputRuntime = Reflect.get(window, "__UISCENE_SCOUT_RENDERER__") as
        | {
            ownRenderer: boolean;
            renderer: import("three").WebGLRenderer;
          }
        | undefined;
      if (outputRuntime?.ownRenderer) {
        outputRuntime.renderer.dispose();
      }
      Reflect.deleteProperty(window, "__UISCENE_SCOUT_RENDERER__");
    });

    const candidates = candidatePass.candidates as ScoutCandidate[];
    const ordered = [...candidates].sort(
      (left, right) => right.score - left.score
    );
    const originalCandidate = candidates.find(
      (candidate) => candidate.id === "original"
    );
    const [detailCandidate] = [...candidates]
      .filter(
        (candidate) =>
          candidate.metrics.visiblePixelFraction > 0.001 &&
          candidate.metrics.clippedEdges.length <= 3
      )
      .sort(
        (left, right) =>
          right.metrics.visiblePixelFraction -
            left.metrics.visiblePixelFraction ||
          right.metrics.edgeDensity - left.metrics.edgeDensity
      );
    const [shapeCandidate] = [...candidates]
      .filter(
        (candidate) =>
          candidate.view !== "original" &&
          candidate.metrics.visiblePixelFraction > 0.001
      )
      .sort((left, right) => {
        const score = (candidate: ScoutCandidate) =>
          candidate.metrics.edgeDensity * 4 +
          candidate.metrics.contrastStdDev * 2 +
          candidate.metrics.visiblePixelFraction * 0.25;
        return score(right) - score(left);
      });
    const structuralWarning = scene.warnings.find(
      (warning) =>
        warning.startsWith(options.nodeId) &&
        warning.toLowerCase().includes("invisible")
    );
    const recommendedCandidate = structuralWarning
      ? undefined
      : (detailCandidate ?? ordered[0]);
    const resolvedFocus = {
      ...candidatePass.focus,
      worldPosition: candidatePass.focus.worldPosition as [
        number,
        number,
        number,
      ],
    } as ScoutReport["focus"];
    const detail = recommendedCandidate
      ? {
          candidateId: recommendedCandidate.id,
          command: detailCommand({
            candidate: recommendedCandidate,
            entry: options.entry,
            exportName: options.exportName,
            ...(options.fixture === undefined
              ? {}
              : { fixture: options.fixture }),
            focus: resolvedFocus.worldPosition,
            height: options.height,
            isolate: options.isolate ?? true,
            nodeId: options.nodeId,
            width: options.width,
          }),
          reason: [
            `Places ${(recommendedCandidate.metrics.visiblePixelFraction * 100).toFixed(1)}% non-background target signal in the discovery frame.`,
            "Uses target framing before requesting additional pixel density.",
          ],
          strategy: "target-camera" as const,
        }
      : {
          candidateId: null,
          command: null,
          reason: ["No viable target-camera detail candidate was produced."],
          strategy: "unavailable" as const,
        };
    const sourceBounds = originalCandidate?.metrics.screenBounds;
    const sourceRegion = sourceBounds
      ? (() => {
          const paddingX = Math.ceil(sourceBounds.width * 0.18);
          const paddingY = Math.ceil(sourceBounds.height * 0.18);
          const x = Math.max(0, sourceBounds.x - paddingX);
          const y = Math.max(0, sourceBounds.y - paddingY);
          const right = Math.min(
            options.width,
            sourceBounds.x + sourceBounds.width + paddingX
          );
          const bottom = Math.min(
            options.height,
            sourceBounds.y + sourceBounds.height + paddingY
          );
          return {
            height: Math.max(1, bottom - y),
            width: Math.max(1, right - x),
            x,
            y,
          };
        })()
      : null;
    const context = originalCandidate
      ? {
          candidateId: originalCandidate.id,
          command: sourceCameraCommand({
            entry: options.entry,
            exportName: options.exportName,
            ...(options.fixture === undefined
              ? {}
              : { fixture: options.fixture }),
            height: options.height,
            nodeId: options.nodeId,
            width: options.width,
          }),
          reason: [
            "Preserves the literal fixture camera for composition and transition evidence.",
          ],
          strategy: "source-camera" as const,
        }
      : {
          candidateId: null,
          command: null,
          reason: ["No source-camera candidate was produced."],
          strategy: "unavailable" as const,
        };
    const sourceDetail =
      originalCandidate && sourceRegion
        ? {
            candidateId: originalCandidate.id,
            command: sourceRegionCommand({
              entry: options.entry,
              exportName: options.exportName,
              ...(options.fixture === undefined
                ? {}
                : { fixture: options.fixture }),
              height: options.height,
              region: sourceRegion,
              width: options.width,
            }),
            reason: [
              "Rerenders the padded projected target region while preserving the source camera.",
            ],
            strategy: "source-region" as const,
          }
        : {
            candidateId: null,
            command: null,
            reason: [
              "The target has no usable source-camera projected region.",
            ],
            strategy: "unavailable" as const,
          };
    const shape = shapeCandidate
      ? {
          candidateId: shapeCandidate.id,
          command: detailCommand({
            candidate: shapeCandidate,
            entry: options.entry,
            exportName: options.exportName,
            ...(options.fixture === undefined
              ? {}
              : { fixture: options.fixture }),
            focus: resolvedFocus.worldPosition,
            height: options.height,
            isolate: options.isolate ?? true,
            nodeId: options.nodeId,
            width: options.width,
          }),
          reason: [
            "Balances edge, contrast, and visible target evidence from a generated structural perspective.",
          ],
          strategy: "target-camera" as const,
        }
      : {
          candidateId: null,
          command: null,
          reason: ["No viable structural perspective was produced."],
          strategy: "unavailable" as const,
        };
    const sourceTargetPixelFraction =
      originalCandidate?.metrics.visiblePixelFraction ?? 0;
    const sourceProjectedCoverage =
      originalCandidate?.metrics.targetCoverage ?? 0;
    const contrastLimited =
      sourceProjectedCoverage >= 0.05 &&
      sourceTargetPixelFraction < 0.08 &&
      (originalCandidate?.metrics.contrastStdDev ?? 0) < 0.02;
    const dispersionLimited =
      sourceProjectedCoverage >= 0.18 && sourceTargetPixelFraction < 0.05;
    let limitingFactor: ScoutReport["diagnosis"]["limitingFactor"] =
      "raster-resolution";
    if (contrastLimited) {
      limitingFactor = "contrast";
    } else if (sourceProjectedCoverage < 0.18) {
      limitingFactor = "framing";
    } else if (dispersionLimited) {
      limitingFactor = "dispersion";
    }
    const diagnosis = {
      higherScaleWouldHelp: limitingFactor === "raster-resolution",
      limitingFactor,
      sourceProjectedCoverage,
      sourceTargetPixelFraction,
    };
    const recommendations = structuralWarning
      ? {
          context,
          detail: {
            candidateId: null,
            command: null,
            reason: [
              `Structural diagnostics must be resolved first: ${structuralWarning}`,
            ],
            strategy: "unavailable" as const,
          },
          shape: {
            candidateId: null,
            command: null,
            reason: [
              `Structural diagnostics must be resolved first: ${structuralWarning}`,
            ],
            strategy: "unavailable" as const,
          },
          sourceDetail,
        }
      : { context, detail, shape, sourceDetail };
    const recommended = structuralWarning
      ? {
          candidateId: null,
          detailCommand: null,
          reason: [
            `Structural diagnostics must be resolved before camera or scale changes: ${structuralWarning}`,
          ],
        }
      : {
          candidateId: detail.candidateId,
          detailCommand: detail.command,
          reason: recommendedCandidate
            ? [...detail.reason]
            : ["No viable candidate was produced."],
        };
    const geometry = Reflect.get(targetNode, "geometry") as
      | { vertexCount?: unknown }
      | undefined;
    const vertexCount =
      typeof geometry?.vertexCount === "number"
        ? geometry.vertexCount
        : undefined;
    let targetGranularity: ScoutReport["target"]["granularity"] = "object";
    if (targetNode.kind === "SemanticTarget") {
      targetGranularity = "semantic";
    } else if (targetNode.children.length > 0) {
      targetGranularity = "draw-owner";
    }
    const executionSucceeded =
      candidates.length > 0 && (await stat(artifacts.contactSheet)).size > 0;
    const status = agentReviewStatus({
      evidenceJudgeable: !structuralWarning && candidates.length > 0,
      executionSucceeded,
      reason: structuralWarning
        ? `Scout evidence is unjudgeable until structural diagnostics are resolved: ${structuralWarning}`
        : "Scout ranked camera evidence; the agent must inspect the contact sheet before choosing a view or approving the target.",
    });
    const report: ScoutReport = {
      ...status,
      artifacts,
      candidates,
      diagnosis,
      focus: resolvedFocus,
      lifecycle: {
        browserLaunches: 1,
        bundles: 1,
        sceneInstances: 1,
      },
      rasterizer: rasterizerInfo(candidatePass.rendererName),
      recommendations,
      recommended,
      success: executionSucceeded,
      target: {
        granularity: targetGranularity,
        id: options.nodeId,
        kind: targetNode.kind,
        ...(vertexCount === undefined ? {} : { vertexCount }),
      },
      timingsMs: {
        candidates: candidatePass.candidatePassMs,
        capture: captureMs,
        total: performance.now() - totalStartedAt,
      },
      warnings: [
        ...scene.warnings,
        ...(contrastLimited
          ? [
              "The source target is framed but has insufficient contrast against the background; inspect material and light state before changing cameras.",
            ]
          : []),
        ...(dispersionLimited
          ? [
              "The source target bounds contain sparse visible signal; bounds-based framing may be uninformative.",
            ]
          : []),
        ...(targetNode.kind !== "SemanticTarget" &&
        targetNode.children.length > 0
          ? [
              `${options.nodeId} is a draw-owner target; its bounds may aggregate multiple logical items. Provide fixture semantic targets or sceneproofInstanceIds for instance-specific framing.`,
            ]
          : []),
      ],
    };
    await writeFile(artifacts.report, `${JSON.stringify(report, null, 2)}\n`);
    await disposeThree(runtime.page);
    return report;
  } finally {
    await runtime.browser.close();
  }
}
