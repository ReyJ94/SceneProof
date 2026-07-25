#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Command } from "commander";
import { z } from "zod";

import packageMetadata from "../package.json" with { type: "json" };
import { diagnoseBrowser } from "./browser-runtime.js";
import {
  persistJsonEvidence,
  referenceJsonEvidence,
} from "./evidence-store.js";
import {
  inspectReact,
  renderReact,
  renderReactRegion,
} from "./react-renderer.js";
import {
  detectRenderer,
  probeRenderer,
  type RendererKind,
  rendererProbeInputFromEnvironment,
} from "./renderer-detection.js";
import type {
  LogicalRegion,
  SceneArtifact,
  ScoutReport,
} from "./scene-schema.js";
import {
  type FixtureProvenance,
  inspectThree,
  renderThree,
  renderThreeFrames,
  renderThreeRegion,
  scoutThree,
  type ThreeFraming,
  type ThreeTargetView,
} from "./three-renderer.js";

const rendererProbeInput = rendererProbeInputFromEnvironment();
if (rendererProbeInput) {
  process.stdout.write(await probeRenderer(rendererProbeInput));
  process.exit(0);
}

const PositiveInteger = z.coerce.number().int().positive();
const PositiveScale = z.coerce.number().positive();
const NonnegativeNumber = z.coerce.number().nonnegative();
const RendererKindSchema = z.enum(["auto", "react", "three"]);
const FramingSchema = z.enum(["source", "fit", "fill"]);
const PropsSchema = z.record(z.string(), z.unknown());
const RegionTuple = z.tuple([
  z.coerce.number().nonnegative(),
  z.coerce.number().nonnegative(),
  z.coerce.number().positive(),
  z.coerce.number().positive(),
]);
const ViewTuple = z.tuple([z.coerce.number(), z.coerce.number()]);
const Vector3Tuple = z.tuple([
  z.coerce.number(),
  z.coerce.number(),
  z.coerce.number(),
]);
const VIEW_PRESETS = {
  front: { azimuth: -90, elevation: 18 },
  isometric: { azimuth: -45, elevation: 35 },
  side: { azimuth: 0, elevation: 18 },
  top: { azimuth: -90, elevation: 89 },
} as const;

type CommonOptions = {
  action?: string;
  actionInput?: string;
  export: string;
  props?: string;
  css?: string[];
  width: string;
  height: string;
  renderer: string;
  time?: string;
};

type RenderOptions = CommonOptions & {
  frames?: string;
  framing?: string;
  margin: string;
  scale: string;
  out?: string;
};

function fixtureOptions(command: Command, defaultExport: string): Command {
  return command
    .option("--export <name>", "named module export", defaultExport)
    .option(
      "--renderer <auto|react|three>",
      "renderer selection; auto probes the selected export contract",
      "auto"
    )
    .option("--props <file>", "JSON fixture state passed to React or Three.js")
    .option("--action <name>", "fixture-owned Three.js action")
    .option("--action-input <file>", "JSON object passed to the fixture action")
    .option("--time <milliseconds>", "deterministic fixture seek time")
    .option("--width <pixels>", "logical viewport width", "1280")
    .option("--height <pixels>", "logical viewport height", "720");
}

function sourceOptions(command: Command): Command {
  return fixtureOptions(command, "default").option(
    "--css <files...>",
    "source CSS files to compile and load"
  );
}

function renderOptions(command: Command): Command {
  return sourceOptions(command)
    .option(
      "--scale <number>",
      "source pixel density; use --zoom to move a Three.js camera",
      "1"
    )
    .option(
      "--framing <source|fit|fill>",
      "Three.js framing: literal source camera, contained target, or close target"
    )
    .option("--margin <fraction>", "target framing margin", "0.12")
    .option(
      "--frames <before,ms...,settled>",
      "capture a deterministic Three.js sequence in one scene lifecycle"
    )
    .option("--out <path>", "artifact output path");
}

function scoutOptions(command: Command): Command {
  return fixtureOptions(command, "createScene")
    .option("--focus-node <node-id>", "center cameras on another scene node")
    .option("--look-at <x,y,z>", "center cameras on a world-space point")
    .option("--no-isolate", "include unrelated objects in discovery views")
    .option("--background <color>", "background color or transparent")
    .option(
      "--out <directory>",
      "Scout artifact directory",
      "sceneproof-scout"
    );
}

type LoadedJson = {
  reference: { digest: string; path: string } | null;
  value: Record<string, unknown>;
};

async function loadJsonInput(
  path: string | undefined,
  label: string
): Promise<LoadedJson> {
  if (!path) {
    return { reference: null, value: {} };
  }
  const absolute = resolve(path);
  let source: string;
  try {
    source = await readFile(absolute, "utf8");
  } catch (error) {
    throw new Error(`${label} file not found: ${absolute}`, { cause: error });
  }
  const parsed: unknown = JSON.parse(source);
  return {
    reference: {
      digest: `sha256:${createHash("sha256").update(source).digest("hex")}`,
      path: absolute,
    },
    value: PropsSchema.parse(parsed),
  };
}

function output(value: unknown): void {
  const indentation = process.stdout.isTTY ? 2 : undefined;
  process.stdout.write(`${JSON.stringify(value, null, indentation)}\n`);
}

function roundMetric(value: number): number {
  return Number(value.toFixed(4));
}

async function inspectBriefing(scene: SceneArtifact) {
  const nodes = new Map(scene.nodes.map((node) => [node.id, node]));
  return {
    command: "inspect",
    entry: scene.entry,
    evidence: {
      full: await persistJsonEvidence("inspect", scene),
    },
    export: scene.export,
    fixture: scene.fixture,
    nodeCount: scene.nodes.length,
    presentation: "brief",
    relationshipCount: scene.relationships.length,
    renderer: scene.renderer,
    rootIds: scene.rootIds,
    roots: scene.rootIds.map((id) => {
      const node = nodes.get(id);
      return {
        childCount: node?.children.length ?? 0,
        id,
        ...(node?.kind ? { kind: node.kind } : {}),
        ...(node?.name ? { name: node.name } : {}),
        ...(node?.tag ? { tag: node.tag } : {}),
      };
    }),
    viewport: scene.viewport,
    warnings: scene.warnings,
  };
}

async function scoutBriefing(report: ScoutReport) {
  const shown = [...report.candidates]
    .sort((left, right) => right.score - left.score)
    .slice(0, 3)
    .map((candidate) => ({
      clippedEdges: candidate.metrics.clippedEdges,
      id: candidate.id,
      score: roundMetric(candidate.score),
      targetCoverage: roundMetric(candidate.metrics.targetCoverage),
      view: candidate.view,
      visiblePixelFraction: roundMetric(candidate.metrics.visiblePixelFraction),
      zoom: candidate.zoom,
    }));
  return {
    artifacts: {
      contactSheet: report.artifacts.contactSheet,
      structure: report.artifacts.structure,
    },
    candidates: {
      omitted: report.candidates.length - shown.length,
      shown,
      total: report.candidates.length,
    },
    command: "scout",
    diagnosis: report.diagnosis,
    evidence: {
      full: await referenceJsonEvidence(report.artifacts.report),
    },
    focus: report.focus,
    lifecycle: report.lifecycle,
    presentation: "brief",
    recommendations: report.recommendations,
    recommended: report.recommended,
    success: report.success,
    target: report.target,
    timingsMs: {
      candidates: Math.round(report.timingsMs.candidates),
      capture: Math.round(report.timingsMs.capture),
      total: Math.round(report.timingsMs.total),
    },
    warnings: report.warnings,
  };
}

type PreparedSource = {
  absoluteEntry: string;
  actionInput: Record<string, unknown>;
  fixture: FixtureProvenance;
  height: number;
  props: Record<string, unknown>;
  renderer: RendererKind;
  timeMs?: number;
  width: number;
};

async function prepareSource(
  entry: string,
  raw: CommonOptions
): Promise<PreparedSource> {
  const height = PositiveInteger.parse(raw.height);
  const width = PositiveInteger.parse(raw.width);
  const absoluteEntry = resolve(entry);
  const props = await loadJsonInput(raw.props, "Props");
  const actionInput = await loadJsonInput(raw.actionInput, "Action input");
  if (raw.actionInput && !raw.action) {
    throw new Error("--action-input requires --action.");
  }
  const requestedRenderer = RendererKindSchema.parse(raw.renderer);
  const renderer =
    requestedRenderer === "auto"
      ? await detectRenderer({
          entry: absoluteEntry,
          exportName: raw.export,
          height,
          props: props.value,
          width,
        })
      : requestedRenderer;
  const timeMs =
    raw.time === undefined ? undefined : NonnegativeNumber.parse(raw.time);
  if (renderer === "react" && (raw.action || raw.actionInput || raw.time)) {
    throw new Error(
      "--action, --action-input, and --time require a Three.js fixture."
    );
  }
  return {
    absoluteEntry,
    actionInput: actionInput.value,
    fixture: {
      action: raw.action
        ? {
            ...(actionInput.reference
              ? { inputPath: actionInput.reference.path }
              : {}),
            name: raw.action,
          }
        : null,
      props: props.reference,
      timeMs: timeMs ?? null,
    },
    height,
    props: props.value,
    renderer,
    ...(timeMs === undefined ? {} : { timeMs }),
    width,
  };
}

function parseRegion(
  value: string,
  viewport: { width: number; height: number }
): LogicalRegion {
  const values = RegionTuple.parse(value.split(","));
  const [x, y, width, height] = values;
  if (x + width > viewport.width || y + height > viewport.height) {
    throw new Error(
      `Region ${value} exceeds viewport ${viewport.width}x${viewport.height}.`
    );
  }
  return { height, width, x, y };
}

function parseThreeView(
  value: string | undefined
): ThreeTargetView | undefined {
  if (!value || value === "original") {
    return;
  }
  const preset = VIEW_PRESETS[value as keyof typeof VIEW_PRESETS];
  if (preset) {
    return { ...preset, label: value };
  }
  const [azimuth, elevation] = ViewTuple.parse(value.split(","));
  if (elevation < -89 || elevation > 89) {
    throw new Error("Three.js view elevation must be between -89 and 89.");
  }
  return { azimuth, elevation, label: value };
}

function parseVector3(value: string): [number, number, number] {
  return Vector3Tuple.parse(value.split(","));
}

async function inspectEntry(
  entry: string,
  raw: CommonOptions
): Promise<SceneArtifact> {
  const prepared = await prepareSource(entry, raw);
  if (prepared.renderer === "three") {
    const scene = await inspectThree({
      ...(raw.action === undefined ? {} : { action: raw.action }),
      actionInput: prepared.actionInput,
      entry: prepared.absoluteEntry,
      exportName: raw.export,
      fixture: prepared.fixture,
      height: prepared.height,
      props: prepared.props,
      ...(prepared.timeMs === undefined ? {} : { timeMs: prepared.timeMs }),
      width: prepared.width,
    });
    return {
      ...scene,
      fixture: prepared.fixture,
      renderer: "three",
    };
  }
  const scene = await inspectReact({
    css: (raw.css ?? []).map((path) => resolve(path)),
    entry: prepared.absoluteEntry,
    exportName: raw.export,
    height: prepared.height,
    props: prepared.props,
    width: prepared.width,
  });
  return {
    ...scene,
    fixture: prepared.fixture,
    renderer: "react",
  };
}

function compactTree(scene: SceneArtifact) {
  const nodes = new Map(scene.nodes.map((node) => [node.id, node]));
  let prunedNodes = 0;

  const compactBounds = (value: unknown) => {
    if (
      typeof value !== "object" ||
      value === null ||
      !("height" in value) ||
      !("width" in value) ||
      !("x" in value) ||
      !("y" in value)
    ) {
      return;
    }
    const bounds = value as Record<"height" | "width" | "x" | "y", unknown>;
    if (
      typeof bounds.height !== "number" ||
      typeof bounds.width !== "number" ||
      typeof bounds.x !== "number" ||
      typeof bounds.y !== "number"
    ) {
      return;
    }
    const round = (number: number) => Math.round(number * 100) / 100;
    return {
      height: round(bounds.height),
      width: round(bounds.width),
      x: round(bounds.x),
      y: round(bounds.y),
    };
  };

  const build = (id: string): Record<string, unknown> | null => {
    const node = nodes.get(id);
    if (!node) {
      return { id, missing: true };
    }
    const children = node.children
      .map(build)
      .filter((child): child is Record<string, unknown> => child !== null);
    const bounds = compactBounds(node.bounds);
    const hasVisibleBounds =
      bounds !== undefined && bounds.width > 0 && bounds.height > 0;
    const isDomNode = node.id.startsWith("dom:");
    if (isDomNode && !hasVisibleBounds && children.length === 0) {
      prunedNodes += 1;
      return null;
    }
    const text =
      typeof node.text === "string" && node.text.length > 120
        ? `${node.text.slice(0, 117)}...`
        : node.text;
    return {
      ...(children.length > 0 ? { children } : {}),
      id: node.id,
      kind: node.kind,
      ...(node.name ? { name: node.name } : {}),
      ...(node.tag ? { tag: node.tag } : {}),
      ...(bounds ? { bounds } : {}),
      ...(children.length === 0 && text ? { text } : {}),
    };
  };
  const rootIds = scene.root ? [scene.root] : scene.rootIds;
  const roots = rootIds
    .map(build)
    .filter((root): root is Record<string, unknown> => root !== null);
  return {
    entry: scene.entry,
    export: scene.export,
    fixture: scene.fixture,
    ...(prunedNodes > 0 ? { prunedHiddenNodes: prunedNodes } : {}),
    renderer: scene.renderer,
    roots,
    viewport: scene.viewport,
    warnings: scene.warnings,
  };
}

function nodeDetail(scene: SceneArtifact, nodeId: string) {
  const node = scene.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) {
    throw new Error(`Target node not found: ${nodeId}`);
  }
  const summary = (id: string) => {
    const related = scene.nodes.find((candidate) => candidate.id === id);
    if (!related) {
      return { id, missing: true };
    }
    return {
      id: related.id,
      kind: related.kind,
      ...(related.name ? { name: related.name } : {}),
      ...(related.tag ? { tag: related.tag } : {}),
      ...(related.text ? { text: related.text.slice(0, 160) } : {}),
    };
  };
  const parentId =
    typeof node.parent === "string"
      ? node.parent
      : scene.relationships.find((relationship) => relationship.to === nodeId)
          ?.from;
  return {
    children: node.children.map(summary),
    entry: scene.entry,
    export: scene.export,
    fixture: scene.fixture,
    node,
    renderer: scene.renderer,
    ...(parentId ? { parent: summary(parentId) } : {}),
  };
}

const program = new Command()
  .name("sceneproof")
  .description("Source-grounded visual perception for coding agents")
  .version(packageMetadata.version);

sourceOptions(
  program
    .command("inspect")
    .description("inspect a React component or Three.js scene")
    .argument("<entry>", "TypeScript or JavaScript source entry")
).action(async (entry: string, raw: CommonOptions) => {
  output(await inspectBriefing(await inspectEntry(entry, raw)));
});

sourceOptions(
  program
    .command("tree")
    .description("print a compact structural tree for agent navigation")
    .argument("<entry>", "TypeScript or JavaScript source entry")
).action(async (entry: string, raw: CommonOptions) => {
  output(compactTree(await inspectEntry(entry, raw)));
});

sourceOptions(
  program
    .command("node")
    .description("inspect one node with its immediate relationships")
    .argument("<entry>", "TypeScript or JavaScript source entry")
    .argument("<node-id>", "deterministic scene node ID")
).action(async (entry: string, nodeId: string, raw: CommonOptions) => {
  output(nodeDetail(await inspectEntry(entry, raw), nodeId));
});

renderOptions(
  program
    .command("render")
    .description("rerender a selected node from its source")
    .argument("<entry>", "TypeScript or JavaScript source entry")
    .argument("<node-id>", "deterministic scene node ID")
    .option("--isolate", "hide unrelated Three.js objects")
    .option("--background <color>", "Three.js background color or transparent")
    .option(
      "--view <preset|azimuth,elevation>",
      "Three.js target perspective: original, front, side, top, isometric, or degrees",
      "original"
    )
    .option(
      "--zoom <factor>",
      "Three.js camera framing zoom; values above 1 move closer",
      "1"
    )
    .option(
      "--look-at <x,y,z>",
      "Three.js world-space patch to center in the camera"
    )
).action(
  async (
    entry: string,
    nodeId: string,
    raw: RenderOptions & {
      isolate?: boolean;
      background?: string;
      view: string;
      zoom: string;
      lookAt?: string;
    }
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: This command boundary validates mutually exclusive React and Three.js render surfaces before dispatch.
  ) => {
    const prepared = await prepareSource(entry, raw);
    const scale = PositiveScale.parse(raw.scale);
    const framing = FramingSchema.parse(
      raw.framing ?? (raw.view === "original" ? "source" : "fit")
    ) as ThreeFraming;
    const margin = NonnegativeNumber.parse(raw.margin);
    const out = resolve(
      raw.out ?? (raw.frames ? "sceneproof-frames" : "sceneproof-render.png")
    );
    if (prepared.renderer === "three") {
      const view = parseThreeView(raw.view);
      if (
        framing === "source" &&
        (view !== undefined || raw.zoom !== "1" || raw.lookAt)
      ) {
        throw new Error(
          "Source framing preserves the literal camera and cannot be combined with a generated view, --zoom, or --look-at. Use --framing fit or --framing fill."
        );
      }
      const common = {
        ...(raw.action === undefined ? {} : { action: raw.action }),
        actionInput: prepared.actionInput,
        entry: prepared.absoluteEntry,
        exportName: raw.export,
        fixture: prepared.fixture,
        framing,
        height: prepared.height,
        margin,
        nodeId,
        props: prepared.props,
        scale,
        width: prepared.width,
        ...(prepared.timeMs === undefined ? {} : { timeMs: prepared.timeMs }),
        ...(raw.lookAt === undefined
          ? {}
          : { focus: parseVector3(raw.lookAt) }),
        ...(raw.isolate === undefined ? {} : { isolate: raw.isolate }),
        ...(raw.background === undefined ? {} : { background: raw.background }),
        ...(view === undefined ? {} : { view }),
        zoom: PositiveScale.parse(raw.zoom),
      };
      if (raw.frames) {
        output(
          await renderThreeFrames({
            ...common,
            frames: raw.frames,
            out,
          })
        );
        return;
      }
      output(
        await renderThree({
          ...common,
          out,
        })
      );
      return;
    }
    if (
      raw.view !== "original" ||
      raw.zoom !== "1" ||
      raw.lookAt ||
      raw.frames ||
      raw.framing
    ) {
      throw new Error(
        "--view, --zoom, --look-at, --framing, and --frames are Three.js render options."
      );
    }
    output(
      await renderReact({
        css: (raw.css ?? []).map((path) => resolve(path)),
        entry: prepared.absoluteEntry,
        exportName: raw.export,
        height: prepared.height,
        nodeId,
        out,
        props: prepared.props,
        scale,
        width: prepared.width,
      })
    );
  }
);

renderOptions(
  program
    .command("render-region")
    .description("rerender a logical viewport patch from source")
    .argument("<entry>", "TypeScript or JavaScript source entry")
    .requiredOption(
      "--region <x,y,width,height>",
      "logical viewport region to rerender"
    )
    .option("--background <color>", "Three.js background color or transparent")
).action(
  async (
    entry: string,
    raw: RenderOptions & { region: string; background?: string }
  ) => {
    const prepared = await prepareSource(entry, raw);
    const scale = PositiveScale.parse(raw.scale);
    const region = parseRegion(raw.region, {
      height: prepared.height,
      width: prepared.width,
    });
    const out = resolve(raw.out ?? "sceneproof-region.png");
    if (prepared.renderer === "three") {
      output(
        await renderThreeRegion({
          ...(raw.action === undefined ? {} : { action: raw.action }),
          actionInput: prepared.actionInput,
          entry: prepared.absoluteEntry,
          exportName: raw.export,
          fixture: prepared.fixture,
          height: prepared.height,
          out,
          props: prepared.props,
          region,
          scale,
          ...(prepared.timeMs === undefined ? {} : { timeMs: prepared.timeMs }),
          width: prepared.width,
          ...(raw.background === undefined
            ? {}
            : { background: raw.background }),
        })
      );
      return;
    }
    output(
      await renderReactRegion({
        css: (raw.css ?? []).map((path) => resolve(path)),
        entry: prepared.absoluteEntry,
        exportName: raw.export,
        height: prepared.height,
        out,
        props: prepared.props,
        region,
        scale,
        width: prepared.width,
      })
    );
  }
);

scoutOptions(
  program
    .command("scout")
    .description(
      "rank useful Three.js target cameras and create one visual contact sheet"
    )
    .argument("<entry>", "TypeScript or JavaScript source entry")
    .argument("<node-id>", "deterministic Three.js target node ID")
).action(
  async (
    entry: string,
    nodeId: string,
    raw: {
      background?: string;
      action?: string;
      actionInput?: string;
      export: string;
      focusNode?: string;
      height: string;
      isolate: boolean;
      lookAt?: string;
      out: string;
      props?: string;
      renderer: string;
      time?: string;
      width: string;
    }
  ) => {
    if (raw.focusNode && raw.lookAt) {
      throw new Error(
        "--focus-node and --look-at are mutually exclusive focus sources."
      );
    }
    const prepared = await prepareSource(entry, raw);
    if (prepared.renderer !== "three") {
      throw new Error("Scout requires a Three.js fixture export.");
    }
    output(
      await scoutBriefing(
        await scoutThree({
          ...(raw.action === undefined ? {} : { action: raw.action }),
          actionInput: prepared.actionInput,
          entry: prepared.absoluteEntry,
          exportName: raw.export,
          fixture: prepared.fixture,
          height: prepared.height,
          isolate: raw.isolate,
          nodeId,
          out: resolve(raw.out),
          props: prepared.props,
          ...(prepared.timeMs === undefined ? {} : { timeMs: prepared.timeMs }),
          width: prepared.width,
          ...(raw.background === undefined
            ? {}
            : { background: raw.background }),
          ...(raw.focusNode === undefined
            ? {}
            : { focusNodeId: raw.focusNode }),
          ...(raw.lookAt === undefined
            ? {}
            : { focus: parseVector3(raw.lookAt) }),
        })
      )
    );
  }
);

program
  .command("doctor")
  .description("diagnose Chromium, WebGL, and local-render execution readiness")
  .action(async () => {
    const report = await diagnoseBrowser();
    output(report);
    if (!report.success) {
      process.exitCode = 1;
    }
  });

program.parseAsync().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`sceneproof: ${message}\n`);
  process.exitCode = 1;
});
