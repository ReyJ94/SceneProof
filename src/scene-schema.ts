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

export type RenderChecks = {
  moduleLoaded: boolean;
  exportFound: boolean;
  targetFound: boolean;
  boundsValid: boolean;
  requestedScaleAchieved: boolean;
  outputNonempty: boolean;
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
  renderer?: "react" | "three";
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
  renderer?: "react" | "three";
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
    limitingFactor: "framing" | "raster-resolution";
    sourceTargetPixelFraction: number;
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
  success: boolean;
};
