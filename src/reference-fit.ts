import type {
  ReferenceComparisonReport,
  SweepRenderReport,
} from "./scene-schema.js";

export type ReferenceObjective =
  | "appearance"
  | "balanced"
  | "composition"
  | "geometry";

export type ReferenceFit = NonNullable<
  SweepRenderReport["variants"][number]["referenceFit"]
>;

export function scoreReferenceFit(
  reference: ReferenceComparisonReport,
  objective: ReferenceObjective
): ReferenceFit | undefined {
  const { analysisAvailable, histograms, silhouette } = reference;
  if (!(analysisAvailable && silhouette && histograms)) {
    return;
  }
  const currentLuminance = histograms.current.luminance;
  const referenceLuminance = histograms.reference.luminance;
  const luminanceMeanAbsoluteDelta =
    (Math.abs(currentLuminance.p10 - referenceLuminance.p10) +
      Math.abs(currentLuminance.p50 - referenceLuminance.p50) +
      Math.abs(currentLuminance.p90 - referenceLuminance.p90)) /
    3;
  const components = {
    aspectRatio:
      1 -
      Math.min(
        1,
        Math.abs(silhouette.aspectRatio.delta) /
          Math.max(0.01, Math.abs(silhouette.aspectRatio.reference))
      ),
    composition: reference.composition
      ? 1 -
        Math.min(
          1,
          (Math.abs(reference.composition.delta.center[0]) +
            Math.abs(reference.composition.delta.center[1]) +
            Math.abs(reference.composition.delta.size[0]) +
            Math.abs(reference.composition.delta.size[1])) /
            4
        )
      : 0,
    luminance: 1 - Math.min(1, luminanceMeanAbsoluteDelta),
    profile: reference.profile
      ? 1 - Math.min(1, reference.profile.summary.widthRmseFraction / 0.25)
      : 0,
    silhouetteIoU: silhouette.areaIoU,
    tipConvergence:
      1 - Math.min(1, Math.abs(silhouette.tipConvergenceAngle.delta) / 90),
    widestPoint:
      1 - Math.min(1, Math.abs(silhouette.widestPointHeightFraction.delta)),
  };
  const weights = {
    appearance: {
      aspectRatio: 0,
      composition: 0,
      luminance: 1,
      profile: 0,
      silhouetteIoU: 0,
      tipConvergence: 0,
      widestPoint: 0,
    },
    balanced: {
      aspectRatio: 0.1,
      composition: 0.1,
      luminance: 0.2,
      profile: 0.15,
      silhouetteIoU: 0.3,
      tipConvergence: 0.05,
      widestPoint: 0.1,
    },
    composition: {
      aspectRatio: 0,
      composition: 1,
      luminance: 0,
      profile: 0,
      silhouetteIoU: 0,
      tipConvergence: 0,
      widestPoint: 0,
    },
    geometry: {
      aspectRatio: 0.15,
      composition: 0,
      luminance: 0,
      profile: 0.25,
      silhouetteIoU: 0.4,
      tipConvergence: 0.1,
      widestPoint: 0.1,
    },
  }[objective];
  return {
    components,
    luminanceMeanAbsoluteDelta,
    objective,
    score: Object.entries(weights).reduce(
      (score, [key, weight]) =>
        score + components[key as keyof typeof components] * weight,
      0
    ),
  };
}
