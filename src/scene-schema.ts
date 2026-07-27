import { z } from "zod";

export const BoundsSchema = z.object({
  height: z.number().nonnegative(),
  width: z.number().nonnegative(),
  x: z.number(),
  y: z.number(),
});

export const SceneNodeSchema = z
  .object({
    bounds: z.unknown().optional(),
    children: z.array(z.string()),
    id: z.string().min(1),
    kind: z.string().min(1),
    name: z.string().optional(),
    parent: z.string().nullable().optional(),
    source: z
      .object({
        export: z.string().optional(),
        file: z.string(),
      })
      .optional(),
    styles: z.record(z.string(), z.string()).optional(),
    tag: z.string().optional(),
    text: z.string().optional(),
  })
  .passthrough();

export const SceneArtifactSchema = z.object({
  assets: z.array(z.unknown()),
  entry: z.string(),
  export: z.string(),
  fixture: z.unknown().optional(),
  nodes: z.array(SceneNodeSchema),
  relationships: z.array(
    z.object({
      from: z.string(),
      kind: z.literal("parent-child"),
      to: z.string(),
    })
  ),
  renderer: z.enum(["react", "three"]).optional(),
  root: z.string().optional(),
  rootIds: z.array(z.string()),
  version: z.literal(1),
  viewport: z.object({
    height: z.number().positive(),
    width: z.number().positive(),
  }),
  warnings: z.array(z.string()),
});

export type SceneArtifact = z.infer<typeof SceneArtifactSchema>;

function editDistance(left: string, right: string): number {
  const previous = Array.from(
    { length: right.length + 1 },
    (_, index) => index
  );
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        (current[rightIndex - 1] ?? 0) + 1,
        (previous[rightIndex] ?? 0) + 1,
        (previous[rightIndex - 1] ?? 0) +
          (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1)
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length] ?? Math.max(left.length, right.length);
}

export function resolveSceneNodeId(
  scene: SceneArtifact,
  requested: string
): string {
  const exact = scene.nodes.find((node) => node.id === requested);
  if (exact) {
    return exact.id;
  }
  const bareMatches = scene.nodes.filter((node) => {
    const separator = node.id.indexOf(":");
    return separator >= 0 && node.id.slice(separator + 1) === requested;
  });
  const uniqueBareIds = [...new Set(bareMatches.map((node) => node.id))];
  if (uniqueBareIds.length === 1) {
    return uniqueBareIds[0] ?? requested;
  }
  const normalizedRequested = requested.toLowerCase();
  const ranked = scene.nodes
    .map((node) => {
      const separator = node.id.indexOf(":");
      const bare = separator >= 0 ? node.id.slice(separator + 1) : node.id;
      return {
        distance: Math.min(
          editDistance(normalizedRequested, node.id.toLowerCase()),
          editDistance(normalizedRequested, bare.toLowerCase())
        ),
        id: node.id,
      };
    })
    .sort((left, right) => left.distance - right.distance);
  const [suggestion] = ranked;
  const threshold = Math.max(2, Math.ceil(requested.length * 0.35));
  const hint =
    suggestion && suggestion.distance <= threshold
      ? ` Did you mean ${suggestion.id}?`
      : "";
  throw new Error(`Target node not found: ${requested}.${hint}`);
}

export type RenderChecks = {
  moduleLoaded: boolean;
  exportFound: boolean;
  targetFound: boolean;
  boundsValid: boolean;
  requestedScaleAchieved: boolean;
  outputNonempty: boolean;
  evidenceJudgeable?: boolean;
};

export type RasterStats = {
  background: {
    color: [number, number, number, number];
    luminance: number;
  };
  coverageFraction: number;
  luminance: {
    max: number;
    p10: number;
    p50: number;
    p90: number;
    p99: number;
  };
};

export type RasterizerInfo = {
  kind: "hardware-or-unknown" | "swiftshader-cpu";
  renderer: string | null;
};

export type RenderQuality = {
  explanation: string;
  judgeable: boolean;
  limitingFactor: "contrast" | "dispersion" | "framing" | null;
  targetProjectedCoverage: number;
  targetProjectedPixelSize: {
    height: number;
    width: number;
  };
  targetSignalCoverage: number;
  surfaceJudgeable: boolean;
  surfaceLuminanceSpread: number;
  surfaceLuminanceThreshold: number;
};

export type ReferenceComparisonReport = {
  alignment?: {
    mode: "center-height-preserving-aspect";
    scale: number;
    translate: [number, number];
  };
  analysisAvailable: boolean;
  composition?: {
    current: {
      center: [number, number];
      size: [number, number];
    };
    delta: {
      center: [number, number];
      size: [number, number];
    };
    reference: {
      center: [number, number];
      size: [number, number];
    };
  };
  artifacts: {
    contactSheet: string;
    difference?: string;
    silhouetteOverlay?: string;
  };
  histograms?: {
    current: {
      luminance: {
        max: number;
        p10: number;
        p50: number;
        p90: number;
      };
      sampleCount: number;
    };
    reference: {
      luminance: {
        max: number;
        p10: number;
        p50: number;
        p90: number;
      };
      sampleCount: number;
    };
  };
  mask: {
    backgroundColorDistanceP90?: number;
    bounds?: LogicalRegion;
    confidence: number;
    foregroundFraction: number;
    method: "automatic" | "automatic-region" | "explicit-mask";
    minimumConfidence: number;
    reason?: string;
  };
  probes: Array<{
    current: ReferenceProbeSample;
    normalized: [number, number];
    reference: ReferenceProbeSample;
  }>;
  silhouette?: {
    areaIoU: number;
    aspectRatio: ReferenceMetricDelta;
    caveat: string;
    tipConvergenceAngle: ReferenceMetricDelta & {
      algorithm: "outer-envelope-upper-third-linear-fit";
    };
    widestPointHeightFraction: ReferenceMetricDelta;
  };
  source: {
    maskPath: string | null;
    path: string;
    region: LogicalRegion | null;
  };
};

type ReferenceMetricDelta = {
  current: number;
  delta: number;
  reference: number;
};

type ReferenceProbeSample = {
  luminance: number;
  pixel: [number, number];
  rgba: [number, number, number, number];
  similarColorRun: {
    horizontalPx: number;
    verticalPx: number;
  };
};

export type RenderReport = {
  success: boolean;
  nodeId: string;
  logicalSize: {
    width: number;
    height: number;
  };
  renderedSize: {
    width: number;
    height: number;
  };
  scale: number;
  artifact: string;
  checks: RenderChecks;
  comparison?: {
    artifacts: {
      difference: string;
      sideBySide: string;
    };
    changedBounds: LogicalRegion | null;
    changedPixelFraction: number;
    classification: "below-perceptual-floor" | "changed" | "identical";
    normalizedRasterDelta: number;
    previous: string;
  };
  reference?: ReferenceComparisonReport;
  silhouette?:
    | {
        available: true;
        areaPixels: number;
        artifact: string;
        caveat: string;
        compactness: number;
        granularity: "draw-owner" | "target";
        ignoredNonMeshCount: number;
        perimeterPixels: number;
        profile: {
          curvatureSignChanges: number;
          highFrequencyDirectionReversals: number;
          maximumDeviationFromLocalTrendPx: number;
        };
        targetMeshCount: number;
      }
    | {
        available: false;
        caveat: string;
        reason: string;
      };
  camera?: {
    azimuth?: number;
    elevation?: number;
    framing: "fill" | "fit" | "source";
    modified: boolean;
    position: [number, number, number];
    resolved: CameraSnapshot;
    source: CameraSnapshot;
    target: [number, number, number];
    view: string;
    zoom: number;
  };
  timingsMs?: {
    capture: number;
    render: number;
    total: number;
  };
  fixture?: unknown;
  context?: {
    backgroundPresent: boolean;
    contextRenderableCount: number;
    empty: boolean;
    environmentPresent: boolean;
    targetRenderableCount: number;
    totalRenderableCount: number;
  };
  isolation?: {
    lightsPreserved: number;
    requested: boolean;
  };
  quality?: RenderQuality;
  rasterizer?: RasterizerInfo;
  renderer?: "react" | "three";
  stats?: RasterStats;
  warnings?: string[];
};

export type CameraSnapshot = {
  aspect?: number;
  far: number;
  fov?: number;
  near: number;
  position: [number, number, number];
  quaternion: [number, number, number, number];
  type: string;
  up: [number, number, number];
  zoom?: number;
};

export type LogicalRegion = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type RegionRenderReport = {
  success: boolean;
  region: LogicalRegion;
  logicalSize: {
    width: number;
    height: number;
  };
  renderedSize: {
    width: number;
    height: number;
  };
  scale: number;
  artifact: string;
  checks: {
    moduleLoaded: boolean;
    exportFound: boolean;
    regionValid: boolean;
    requestedScaleAchieved: boolean;
    outputNonempty: boolean;
  };
  timingsMs?: {
    capture: number;
    render: number;
    total: number;
  };
  fixture?: unknown;
  rasterizer?: RasterizerInfo;
  renderer?: "react" | "three";
  stats?: RasterStats;
};

export type ScoutCandidateMetrics = {
  backgroundFraction: number;
  cameraDepthRange: {
    max: number;
    min: number;
  };
  clippedEdges: Array<"bottom" | "left" | "right" | "top">;
  contrastStdDev: number;
  edgeDensity: number;
  luminanceRange: {
    max: number;
    min: number;
  };
  targetCoverage: number;
  visiblePixelFraction: number;
  screenBounds: LogicalRegion;
};

export type ScoutCandidate = {
  camera: {
    azimuth?: number;
    elevation?: number;
    position: [number, number, number];
    target: [number, number, number];
  };
  id: string;
  metrics: ScoutCandidateMetrics;
  score: number;
  timingsMs: {
    render: number;
  };
  view: string;
  zoom: number;
};

export type ScoutReport = {
  artifacts: {
    contactSheet: string;
    report: string;
    structure: string;
  };
  candidates: ScoutCandidate[];
  focus: {
    nodeId?: string;
    source: "node" | "point" | "target";
    worldPosition: [number, number, number];
  };
  lifecycle: {
    browserLaunches: 1;
    bundles: 1;
    sceneInstances: 1;
  };
  recommended: {
    candidateId: string | null;
    detailCommand: string | null;
    reason: string[];
  };
  diagnosis: {
    higherScaleWouldHelp: boolean;
    limitingFactor: "contrast" | "dispersion" | "framing" | "raster-resolution";
    sourceTargetPixelFraction: number;
    sourceProjectedCoverage?: number;
  };
  recommendations: {
    context: ScoutRecommendation;
    detail: ScoutRecommendation;
    shape: ScoutRecommendation;
    sourceDetail: ScoutRecommendation;
  };
  success: boolean;
  target: {
    granularity: "draw-owner" | "object" | "semantic";
    id: string;
    kind: string;
    vertexCount?: number;
  };
  timingsMs: {
    capture: number;
    candidates: number;
    total: number;
  };
  rasterizer?: RasterizerInfo;
  warnings: string[];
};

export type ScoutRecommendation = {
  candidateId: string | null;
  command: string | null;
  reason: string[];
  strategy: "source-camera" | "source-region" | "target-camera" | "unavailable";
};

export type FrameRenderReport = {
  artifacts: {
    contactSheet: string;
    directory: string;
    manifest: string;
  };
  command: "render-frames";
  action: {
    mutatedObjectCount: number | null;
    requested: boolean;
  };
  comparisons: Array<{
    changedPixelFraction: number;
    classification: "below-perceptual-floor" | "changed" | "identical";
    from: string;
    normalizedRasterDelta: number;
    to: string;
  }>;
  frames: Array<{
    artifact: string;
    label: string;
    timeMs: number | null;
  }>;
  lifecycle: {
    actions: 0 | 1;
    browserLaunches: 1;
    bundles: 1;
    frames: number;
    sceneInstances: 1;
  };
  quality: {
    motionDetected: boolean;
    perceptualFloor: {
      changedPixelFraction: number;
      normalizedRasterDelta: number;
    };
  };
  rasterizer?: RasterizerInfo;
  success: boolean;
  warnings: string[];
};

export type SweepRenderReport = {
  artifacts: {
    contactSheet: string;
    directory: string;
    manifest: string;
  };
  command: "render-sweep";
  comparisons: {
    changedPixelFraction: number;
    classification: "below-perceptual-floor" | "changed" | "identical";
    from: string;
    normalizedRasterDelta: number;
    to: string;
  }[];
  lifecycle: {
    browserLaunches: number;
    bundles: number;
    sceneInstances: number;
  };
  recommendation?: {
    basis: "highest-reference-fit";
    caveat: string;
    index: number;
    label: string;
    score: number;
    value: unknown;
  };
  success: boolean;
  sweep: {
    objective: "appearance" | "balanced" | "composition" | "geometry";
    path: string;
    values: unknown[];
  };
  variants: {
    artifact: string;
    index: number;
    label: string;
    quality?: RenderQuality;
    reference?: ReferenceComparisonReport;
    referenceFit?: {
      components: {
        aspectRatio: number;
        composition: number;
        luminance: number;
        silhouetteIoU: number;
        tipConvergence: number;
        widestPoint: number;
      };
      luminanceMeanAbsoluteDelta: number;
      objective: "appearance" | "balanced" | "composition" | "geometry";
      score: number;
    };
    success: boolean;
    value: unknown;
  }[];
  warnings: string[];
};
