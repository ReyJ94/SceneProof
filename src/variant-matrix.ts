import { mkdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";

import { createContactSheet } from "./contact-sheet.js";
import type { SourceOverlay } from "./source-bundle.js";

type UnknownRecord = Record<string, unknown>;

export type MatrixVariant = {
  label: string;
  props: UnknownRecord;
  sourceOverlays: SourceOverlay[];
};

type RenderedMatrixVariant = {
  artifact: string;
  execution: unknown;
  index: number;
  label: string;
  props: UnknownRecord;
  sourceOverlays: SourceOverlay[];
};

const PROHIBITED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function mergeVariantProps(
  base: UnknownRecord,
  override: UnknownRecord
): UnknownRecord {
  const result = structuredClone(base);
  for (const [key, value] of Object.entries(override)) {
    if (PROHIBITED_KEYS.has(key)) {
      throw new Error(`Invalid variant prop key: ${key}`);
    }
    const current = result[key];
    result[key] =
      isRecord(current) && isRecord(value)
        ? mergeVariantProps(current, value)
        : structuredClone(value);
  }
  return result;
}

function safeLabel(label: string): string {
  const normalized = label
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  return normalized || "variant";
}

function outputLocations(out: string): {
  contactSheet: string;
  directory: string;
  manifest: string;
} {
  const absolute = resolve(out);
  if (extname(absolute).toLowerCase() === ".png") {
    const stem = basename(absolute, extname(absolute));
    const directory = join(dirname(absolute), `${stem}-variants`);
    return {
      contactSheet: absolute,
      directory,
      manifest: join(directory, "manifest.json"),
    };
  }
  return {
    contactSheet: join(absolute, "contact-sheet.png"),
    directory: absolute,
    manifest: join(absolute, "manifest.json"),
  };
}

export async function renderVariantMatrix(input: {
  baseProps: UnknownRecord;
  out: string;
  provenance: UnknownRecord;
  render: (
    props: UnknownRecord,
    out: string,
    sourceOverlays: readonly SourceOverlay[]
  ) => Promise<{
    artifact: string;
    execution?: { status?: unknown };
    warnings?: unknown;
  }>;
  renderAll?: (
    variants: Array<{
      label: string;
      out: string;
      props: UnknownRecord;
      sourceOverlays: SourceOverlay[];
    }>
  ) => Promise<
    Array<{
      artifact: string;
      execution?: { status?: unknown };
      warnings?: unknown;
    }>
  >;
  variants: MatrixVariant[];
}) {
  const artifacts = outputLocations(input.out);
  await mkdir(artifacts.directory, { recursive: true });
  const planned = input.variants.map((variant, index) => ({
    label: variant.label,
    out: join(
      artifacts.directory,
      `${String(index + 1).padStart(2, "0")}-${safeLabel(variant.label)}.png`
    ),
    props: mergeVariantProps(input.baseProps, variant.props),
    sourceOverlays: variant.sourceOverlays,
  }));
  const reports = input.renderAll ? await input.renderAll(planned) : [];
  if (!input.renderAll) {
    for (const variant of planned) {
      reports.push(
        // biome-ignore lint/performance/noAwaitInLoops: Renderer lifecycles stay sequential to avoid competing GPU/browser ownership.
        await input.render(variant.props, variant.out, variant.sourceOverlays)
      );
    }
  }
  const rendered: RenderedMatrixVariant[] = [];
  const childWarnings: string[] = [];
  for (const [index, variant] of planned.entries()) {
    const report = reports[index];
    if (!report) {
      throw new Error(
        `Variant renderer returned no report for ${variant.label}.`
      );
    }
    if (Array.isArray(report.warnings)) {
      childWarnings.push(
        ...report.warnings.filter(
          (warning): warning is string => typeof warning === "string"
        )
      );
    }
    rendered.push({
      artifact: report.artifact,
      execution: report.execution?.status ?? "succeeded",
      index,
      label: variant.label,
      props: variant.props,
      sourceOverlays: variant.sourceOverlays,
    });
  }
  const sheet = await createContactSheet({
    compare: true,
    items: rendered.map(({ artifact, label }) => ({ label, path: artifact })),
    out: artifacts.contactSheet,
  });
  const { comparisons } = sheet;
  const changed = comparisons.some(
    (comparison) => comparison.classification === "changed"
  );
  const warnings = [
    ...new Set(childWarnings),
    ...(changed
      ? []
      : [
          "The labeled variants produced no adjacent visual change above the measured perceptual floor.",
        ]),
  ];
  const executionSucceeded =
    rendered.every((variant) => variant.execution === "succeeded") &&
    (await stat(artifacts.contactSheet)).size > 0;
  const report = {
    artifacts,
    command: "matrix",
    comparisons,
    execution: {
      meaning: "command-execution-only",
      status: executionSucceeded ? "succeeded" : "failed",
    },
    lifecycle: input.renderAll
      ? { bundles: 1, renderBrowserLaunches: 1, variants: rendered.length }
      : {
          bundles: rendered.length,
          renderBrowserLaunches: rendered.length,
          variants: rendered.length,
        },
    provenance: input.provenance,
    variants: rendered.map(({ execution: _execution, ...variant }) => variant),
    warnings,
  };
  await writeFile(artifacts.manifest, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}
