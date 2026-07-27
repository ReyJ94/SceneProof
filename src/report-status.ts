import { scoreReferenceFit } from "./reference-fit.js";
import type {
  EvidenceStatus,
  ExecutionStatus,
  ReferenceComparisonReport,
  RenderQuality,
  VisualAssessment,
} from "./scene-schema.js";

type StatusFields = {
  assessment: VisualAssessment;
  evidence: EvidenceStatus;
  execution: ExecutionStatus;
};

type RenderStatusInput = {
  deliveryScale?: NonNullable<RenderQuality["deliveryScale"]>;
  executionSucceeded: boolean;
  quality: RenderQuality;
  reference?: ReferenceComparisonReport;
};

function referenceClaim(
  reference: ReferenceComparisonReport | undefined
): NonNullable<EvidenceStatus["claims"]["reference"]> {
  if (!reference) {
    return "not-requested";
  }
  return reference.analysisAvailable ? "judgeable" : "unjudgeable";
}

function evidenceStatus(input: {
  framing: EvidenceStatus["claims"]["framing"];
  reference: EvidenceStatus["claims"]["reference"];
  referenceRequested: boolean;
  surface: EvidenceStatus["claims"]["surface"];
}): EvidenceStatus["status"] {
  if (input.referenceRequested) {
    return input.reference === "judgeable" ? "judgeable" : "unjudgeable";
  }
  if (input.framing === "judgeable" && input.surface === "judgeable") {
    return "judgeable";
  }
  if (input.framing === "unjudgeable" && input.surface === "unjudgeable") {
    return "unjudgeable";
  }
  return "partially-judgeable";
}

function renderAssessment(input: RenderStatusInput): VisualAssessment {
  if (input.deliveryScale && !input.deliveryScale.satisfied) {
    return {
      decisionOwner: "sceneproof-assertion",
      objective: "delivery-scale",
      reasons: [
        `Target height ${input.deliveryScale.actualHeightPx.toFixed(1)}px is outside the requested ${input.deliveryScale.requestedHeightPx}px delivery scale at ${(input.deliveryScale.toleranceFraction * 100).toFixed(1)}% tolerance.`,
      ],
      verdict: "failed",
    };
  }
  if (!input.reference) {
    return {
      decisionOwner: "agent",
      reasons: [
        "No reference assessment was requested; execution success is not a visual-quality verdict.",
      ],
      verdict: "not-requested",
    };
  }
  const fit = scoreReferenceFit(input.reference, "balanced");
  if (input.reference.analysisAvailable && fit) {
    return {
      decisionOwner: "agent",
      objective: "balanced",
      reasons: [
        `SceneProof measured reference/current differences from a ${input.reference.mask.verification} mask; the agent must inspect the mask overlay and comparison artifacts before deciding whether they satisfy the intended visual claim.`,
      ],
      score: fit.score,
      verdict: "review-required",
    };
  }
  return {
    decisionOwner: "agent",
    objective: "balanced",
    reasons: [
      "Reference/current evidence is unavailable or unjudgeable; the agent must not claim a match.",
    ],
    verdict: "unjudgeable",
  };
}

export function executionStatus(succeeded: boolean): ExecutionStatus {
  return {
    meaning: "command-execution-only",
    status: succeeded ? "succeeded" : "failed",
  };
}

export function renderStatus(input: RenderStatusInput): StatusFields {
  const framing = input.quality.judgeable ? "judgeable" : "unjudgeable";
  const surface = input.quality.surfaceJudgeable ? "judgeable" : "unjudgeable";
  const reference = referenceClaim(input.reference);
  const reasons = [
    ...(framing === "unjudgeable"
      ? [
          `Framing evidence is limited by ${input.quality.limitingFactor ?? "unknown raster conditions"}.`,
        ]
      : []),
    ...(surface === "unjudgeable"
      ? [
          `Surface evidence is unjudgeable because luminance spread ${input.quality.surfaceLuminanceSpread.toFixed(4)} is below ${input.quality.surfaceLuminanceThreshold.toFixed(4)}.`,
        ]
      : []),
    ...(input.reference && reference === "unjudgeable"
      ? [
          "Reference evidence is unjudgeable because the supplied subject could not be extracted with sufficient confidence.",
        ]
      : []),
  ];
  return {
    assessment: renderAssessment(input),
    evidence: {
      claims: { framing, reference, surface },
      reasons,
      status: evidenceStatus({
        framing,
        reference,
        referenceRequested: Boolean(input.reference),
        surface,
      }),
    },
    execution: executionStatus(input.executionSucceeded),
  };
}

export function frameStatus(input: {
  executionSucceeded: boolean;
  motionDetected: boolean;
  motionRequested: boolean;
}): StatusFields {
  const assessment: VisualAssessment = input.motionRequested
    ? {
        decisionOwner: "sceneproof-assertion",
        objective: "motion",
        reasons: [
          input.motionDetected
            ? "The requested action produced visual change above the perceptual floor."
            : "The requested action produced no visual transition above the perceptual floor.",
        ],
        verdict: input.motionDetected ? "passed" : "failed",
      }
    : {
        decisionOwner: "agent",
        reasons: [
          "No action assertion was requested; the frame sequence requires agent review.",
        ],
        verdict: "review-required",
      };
  return {
    assessment,
    evidence: {
      claims: { motion: "judgeable" },
      reasons: [],
      status: "judgeable",
    },
    execution: executionStatus(input.executionSucceeded),
  };
}

export function artifactReviewStatus(
  executionSucceeded: boolean
): StatusFields {
  return {
    assessment: {
      decisionOwner: "agent",
      reasons: [
        "No automated visual objective was requested; the agent must inspect the rendered artifact before making a quality claim.",
      ],
      verdict: "not-requested",
    },
    evidence: {
      claims: { framing: "judgeable" },
      reasons: [],
      status: "judgeable",
    },
    execution: executionStatus(executionSucceeded),
  };
}

export function agentReviewStatus(input: {
  evidenceJudgeable: boolean;
  executionSucceeded: boolean;
  reason: string;
}): StatusFields {
  return {
    assessment: {
      decisionOwner: "agent",
      reasons: [input.reason],
      verdict: input.evidenceJudgeable ? "review-required" : "unjudgeable",
    },
    evidence: {
      claims: {
        framing: input.evidenceJudgeable ? "judgeable" : "unjudgeable",
      },
      reasons: input.evidenceJudgeable ? [] : [input.reason],
      status: input.evidenceJudgeable ? "judgeable" : "unjudgeable",
    },
    execution: executionStatus(input.executionSucceeded),
  };
}

export function assertionStatus(input: {
  executionSucceeded: boolean;
  objective: "motion" | "variation";
  passed: boolean;
  reason: string;
}): StatusFields {
  return {
    assessment: {
      decisionOwner: "sceneproof-assertion",
      objective: input.objective,
      reasons: [input.reason],
      verdict: input.passed ? "passed" : "failed",
    },
    evidence: {
      claims:
        input.objective === "motion"
          ? { motion: "judgeable" }
          : { variation: "judgeable" },
      reasons: [],
      status: "judgeable",
    },
    execution: executionStatus(input.executionSucceeded),
  };
}
