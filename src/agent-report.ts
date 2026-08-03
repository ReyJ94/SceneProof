export const AGENT_REVIEW_MESSAGE =
  "Open the artifact before making a visual claim.";

type UnknownRecord = Record<string, unknown>;

const LEGACY_EPISTEMIC_KEYS = new Set([
  "assessment",
  "evidence",
  "nextActions",
  "success",
]);
const LEGACY_WARNING =
  /supported surface-quality judgment|visual-quality verdict requires/i;
const RECORD_FACT_KEYS = [
  "camera",
  "candidates",
  "checks",
  "context",
  "diagnosis",
  "focus",
  "graphics",
  "isolation",
  "logicalSize",
  "rasterizer",
  "renderedSize",
  "timingsMs",
] as const;
const VALUE_FACT_KEYS = [
  "comparison",
  "comparisons",
  "items",
  "lifecycle",
  "variants",
] as const;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertionFrom(report: UnknownRecord): UnknownRecord[] {
  const assessment = isRecord(report.assessment) ? report.assessment : null;
  if (assessment?.decisionOwner !== "sceneproof-assertion") {
    return [];
  }
  const { verdict } = assessment;
  return [
    {
      ...(typeof assessment.objective === "string"
        ? { objective: assessment.objective }
        : {}),
      passed: verdict === "passed",
      reasons: Array.isArray(assessment.reasons) ? assessment.reasons : [],
    },
  ];
}

function factualWarnings(report: UnknownRecord): string[] {
  if (!Array.isArray(report.warnings)) {
    return [];
  }
  return report.warnings.filter(
    (warning): warning is string =>
      typeof warning === "string" && !LEGACY_WARNING.test(warning)
  );
}

function sanitizeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sanitizeValue);
  }
  if (!isRecord(value)) {
    return value;
  }
  const result: UnknownRecord = {};
  for (const [key, nested] of Object.entries(value)) {
    if (
      LEGACY_EPISTEMIC_KEYS.has(key) ||
      key === "judgeable" ||
      key === "surfaceJudgeable" ||
      key === "surfaceLuminanceThreshold"
    ) {
      continue;
    }
    if (key === "review") {
      continue;
    }
    result[key] = sanitizeValue(nested);
  }
  return result;
}

function primaryArtifact(
  command: string,
  report: UnknownRecord
): UnknownRecord | null {
  if (typeof report.artifact === "string") {
    return {
      kind: command === "render-region" ? "region-render" : "render",
      path: report.artifact,
    };
  }
  if (!isRecord(report.artifacts)) {
    return null;
  }
  const preferred = ["contactSheet", "sideBySide", "current", "output"];
  for (const key of preferred) {
    const path = report.artifacts[key];
    if (typeof path === "string") {
      return {
        kind: key === "contactSheet" ? "contact-sheet" : key,
        path,
      };
    }
  }
  return null;
}

function rasterFacts(report: UnknownRecord): UnknownRecord | null {
  const quality = isRecord(report.quality) ? report.quality : null;
  const stats = isRecord(report.stats) ? report.stats : null;
  if (!(quality || stats)) {
    return null;
  }
  const raster: UnknownRecord = {};
  for (const key of [
    "surfaceLuminanceSpread",
    "targetProjectedCoverage",
    "targetSignalCoverage",
  ] as const) {
    if (quality && typeof quality[key] === "number") {
      raster[key] = quality[key];
    }
  }
  if (stats) {
    raster.stats = sanitizeValue(stats);
  }
  return raster;
}

function artifactFacts(report: UnknownRecord): UnknownRecord {
  let target: unknown;
  if (isRecord(report.target)) {
    target = sanitizeValue(report.target);
  } else if (typeof report.nodeId === "string") {
    target = { id: report.nodeId };
  }
  const facts: UnknownRecord = {};
  if (target) {
    facts.target = target;
  }
  for (const key of RECORD_FACT_KEYS) {
    if (isRecord(report[key])) {
      facts[key] = sanitizeValue(report[key]);
    }
  }
  if (typeof report.scale === "number") {
    facts.scale = report.scale;
  }
  const raster = rasterFacts(report);
  if (raster) {
    facts.raster = raster;
  }
  for (const key of VALUE_FACT_KEYS) {
    if (report[key] !== undefined) {
      facts[key] = sanitizeValue(report[key]);
    }
  }
  return facts;
}

export function createAgentBriefing(
  command: string,
  value: unknown
): UnknownRecord {
  if (!isRecord(value)) {
    throw new Error("A visual report must be an object.");
  }
  const primary = primaryArtifact(command, value);
  const evidence = isRecord(value.evidence) ? value.evidence : null;
  const fullEvidence =
    evidence && isRecord(evidence.full) ? evidence.full : null;
  const relatedArtifacts = {
    ...(isRecord(value.artifacts)
      ? (sanitizeValue(value.artifacts) as UnknownRecord)
      : {}),
    ...(fullEvidence ? { report: sanitizeValue(fullEvidence) } : {}),
  };
  const suggestions = isRecord(value.recommendations)
    ? Object.entries(value.recommendations).flatMap(
        ([kind, recommendation]) => {
          if (
            !isRecord(recommendation) ||
            typeof recommendation.command !== "string"
          ) {
            return [];
          }
          return [
            {
              basis: Array.isArray(recommendation.reason)
                ? recommendation.reason
                : [],
              command: recommendation.command,
              kind,
            },
          ];
        }
      )
    : [];
  return {
    artifacts: {
      ...(primary ? { primary } : {}),
      ...(Object.keys(relatedArtifacts).length > 0
        ? { related: relatedArtifacts }
        : {}),
    },
    command,
    execution: isRecord(value.execution)
      ? sanitizeValue(value.execution)
      : { status: "succeeded" },
    ...(isRecord(value.provenance)
      ? { provenance: sanitizeValue(value.provenance) }
      : {}),
    assertions: assertionFrom(value),
    facts: artifactFacts(value),
    warnings: factualWarnings(value),
    ...(suggestions.length > 0 ? { suggestions } : {}),
    review: {
      decisionOwner: "agent",
      message: AGENT_REVIEW_MESSAGE,
      required: true,
    },
  };
}

export function createFullAgentReport(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }
  const sanitized = sanitizeValue(value) as UnknownRecord;
  return {
    ...sanitized,
    assertions: assertionFrom(value),
    review: {
      decisionOwner: "agent",
      message: AGENT_REVIEW_MESSAGE,
      required: true,
    },
    warnings: factualWarnings(value),
  };
}
