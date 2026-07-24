#!/usr/bin/env bun

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Command } from "commander";
import { z } from "zod";

import {
  persistJsonEvidence,
  referenceJsonEvidence,
} from "./evidence-store.js";
import {
  inspectReact,
  renderReact,
  renderReactRegion,
} from "./react-renderer.js";
import type {
  LogicalRegion,
  SceneArtifact,
  ScoutReport,
} from "./scene-schema.js";
import {
  inspectThree,
  renderThree,
  renderThreeRegion,
  scoutThree,
  type ThreeTargetView,
} from "./three-renderer.js";

const PositiveInteger = z.coerce.number().int().positive();
const PositiveScale = z.coerce.number().positive();
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
  export: string;
  props?: string;
  css?: string[];
  width: string;
  height: string;
};

type RenderOptions = CommonOptions & {
  scale: string;
  out?: string;
};

function sourceOptions(command: Command): Command {
  return command
    .option("--export <name>", "named module export", "default")
    .option("--props <file>", "JSON object passed as React props")
    .option("--css <files...>", "source CSS files to compile and load")
    .option("--width <pixels>", "logical viewport width", "1280")
    .option("--height <pixels>", "logical viewport height", "720");
}

function renderOptions(command: Command): Command {
  return sourceOptions(command)
    .option(
      "--scale <number>",
      "source pixel density; use --zoom to move a Three.js camera",
      "1"
    )
    .option("--out <path>", "artifact output path");
}

function scoutOptions(command: Command): Command {
  return command
    .option("--export <name>", "named Three.js scene factory", "createScene")
    .option("--width <pixels>", "discovery frame width", "320")
    .option("--height <pixels>", "discovery frame height", "240")
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

async function loadProps(path: string | undefined) {
  if (!path) {
    return {};
  }
  const parsed: unknown = JSON.parse(await readFile(resolve(path), "utf8"));
  return PropsSchema.parse(parsed);
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
    nodeCount: scene.nodes.length,
    presentation: "brief",
    relationshipCount: scene.relationships.length,
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
    evidence: {
      full: await referenceJsonEvidence(report.artifacts.report),
    },
    focus: report.focus,
    lifecycle: report.lifecycle,
    presentation: "brief",
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

function isThreeExport(exportName: string): boolean {
  return exportName === "createScene";
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
  const height = PositiveInteger.parse(raw.height);
  const width = PositiveInteger.parse(raw.width);
  const absoluteEntry = resolve(entry);
  if (isThreeExport(raw.export)) {
    return inspectThree({
      entry: absoluteEntry,
      exportName: raw.export,
      height,
      width,
    });
  }
  return inspectReact({
    css: (raw.css ?? []).map((path) => resolve(path)),
    entry: absoluteEntry,
    exportName: raw.export,
    height,
    props: await loadProps(raw.props),
    width,
  });
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
    ...(prunedNodes > 0 ? { prunedHiddenNodes: prunedNodes } : {}),
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
    node,
    ...(parentId ? { parent: summary(parentId) } : {}),
  };
}

const program = new Command()
  .name("sceneproof")
  .description("Source-grounded visual perception for coding agents")
  .version("0.1.0");

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
  ) => {
    const width = PositiveInteger.parse(raw.width);
    const height = PositiveInteger.parse(raw.height);
    const scale = PositiveScale.parse(raw.scale);
    const absoluteEntry = resolve(entry);
    const out = resolve(raw.out ?? "sceneproof-render.png");
    if (isThreeExport(raw.export)) {
      const view = parseThreeView(raw.view);
      output(
        await renderThree({
          entry: absoluteEntry,
          exportName: raw.export,
          height,
          nodeId,
          out,
          scale,
          width,
          zoom: PositiveScale.parse(raw.zoom),
          ...(raw.lookAt === undefined
            ? {}
            : { focus: parseVector3(raw.lookAt) }),
          ...(raw.isolate === undefined ? {} : { isolate: raw.isolate }),
          ...(raw.background === undefined
            ? {}
            : { background: raw.background }),
          ...(view === undefined ? {} : { view }),
        })
      );
      return;
    }
    if (raw.view !== "original" || raw.zoom !== "1" || raw.lookAt) {
      throw new Error(
        "--view, --zoom, and --look-at are Three.js render options."
      );
    }
    output(
      await renderReact({
        css: (raw.css ?? []).map((path) => resolve(path)),
        entry: absoluteEntry,
        exportName: raw.export,
        height,
        nodeId,
        out,
        props: await loadProps(raw.props),
        scale,
        width,
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
    const width = PositiveInteger.parse(raw.width);
    const height = PositiveInteger.parse(raw.height);
    const scale = PositiveScale.parse(raw.scale);
    const region = parseRegion(raw.region, { height, width });
    const absoluteEntry = resolve(entry);
    const out = resolve(raw.out ?? "sceneproof-region.png");
    if (isThreeExport(raw.export)) {
      output(
        await renderThreeRegion({
          entry: absoluteEntry,
          exportName: raw.export,
          height,
          out,
          region,
          scale,
          width,
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
        entry: absoluteEntry,
        exportName: raw.export,
        height,
        out,
        props: await loadProps(raw.props),
        region,
        scale,
        width,
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
      export: string;
      focusNode?: string;
      height: string;
      isolate: boolean;
      lookAt?: string;
      out: string;
      width: string;
    }
  ) => {
    if (raw.focusNode && raw.lookAt) {
      throw new Error(
        "--focus-node and --look-at are mutually exclusive focus sources."
      );
    }
    if (!isThreeExport(raw.export)) {
      throw new Error("Scout requires a Three.js createScene export.");
    }
    output(
      await scoutBriefing(
        await scoutThree({
          entry: resolve(entry),
          exportName: raw.export,
          height: PositiveInteger.parse(raw.height),
          isolate: raw.isolate,
          nodeId,
          out: resolve(raw.out),
          width: PositiveInteger.parse(raw.width),
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

program.parseAsync().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`sceneproof: ${message}\n`);
  process.exitCode = 1;
});
