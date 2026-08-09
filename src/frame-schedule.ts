export type FrameSample =
  | { kind: "before"; label: "before"; timeMs: null }
  | { kind: "settled"; label: "settled"; timeMs: null }
  | { kind: "time"; label: string; timeMs: number };

export type FrameSchedule = {
  frames: FrameSample[];
  kind: "checkpoint" | "continuous";
  stepMs: number | null;
};

const CONTINUOUS = /^(\d+)\.\.(\d+)@(\d+)ms$/;
const MAX_CONTINUOUS_FRAMES = 180;

function parseContinuous(value: string): FrameSchedule | null {
  const match = CONTINUOUS.exec(value);
  if (!match) {
    return null;
  }
  const start = Number(match[1]);
  const end = Number(match[2]);
  const step = Number(match[3]);
  if (end <= start) {
    throw new Error("Continuous --frames end must be greater than start.");
  }
  if (step <= 0) {
    throw new Error("Continuous --frames step must be greater than zero.");
  }
  const times: number[] = [];
  for (let time = start; time <= end; time += step) {
    times.push(time);
  }
  if (times.at(-1) !== end) {
    times.push(end);
  }
  if (times.length > MAX_CONTINUOUS_FRAMES) {
    throw new Error(
      `Continuous --frames accepts at most ${MAX_CONTINUOUS_FRAMES} frames; this range produces ${times.length}.`
    );
  }
  return {
    frames: times.map((timeMs) => ({
      kind: "time" as const,
      label: `${timeMs}ms`,
      timeMs,
    })),
    kind: "continuous",
    stepMs: step,
  };
}

export function parseFrameSchedule(value: string): FrameSchedule {
  const continuous = parseContinuous(value.trim());
  if (continuous) {
    return continuous;
  }
  const tokens = value.split(",").map((token) => token.trim());
  if (tokens.length === 0 || tokens.some((token) => token.length === 0)) {
    throw new Error(
      "--frames requires before, nonnegative milliseconds, settled, or start..end@stepms."
    );
  }
  const frames = tokens.map((token): FrameSample => {
    if (token === "before") {
      return { kind: "before", label: "before", timeMs: null };
    }
    if (token === "settled") {
      return { kind: "settled", label: "settled", timeMs: null };
    }
    const timeMs = Number(token);
    if (!Number.isFinite(timeMs) || timeMs < 0) {
      throw new Error(
        `Invalid frame token ${token}; expected before, settled, or nonnegative milliseconds.`
      );
    }
    return { kind: "time", label: `${timeMs}ms`, timeMs };
  });
  const numeric = frames.flatMap((frame) =>
    frame.kind === "time" ? [frame.timeMs] : []
  );
  if (
    numeric.some((time, index) => index > 0 && time < (numeric[index - 1] ?? 0))
  ) {
    throw new Error("--frames millisecond samples must be in ascending order.");
  }
  if (
    frames.some((frame, index) => frame.kind === "before" && index !== 0) ||
    frames.some(
      (frame, index) => frame.kind === "settled" && index !== frames.length - 1
    )
  ) {
    throw new Error(
      "--frames requires before first and settled last when those tokens are used."
    );
  }
  return { frames, kind: "checkpoint", stepMs: null };
}

export function representativeFrameIndices(
  frameCount: number,
  maximum = 12
): number[] {
  if (frameCount <= maximum) {
    return Array.from({ length: frameCount }, (_, index) => index);
  }
  return Array.from({ length: maximum }, (_, index) =>
    Math.round((index * (frameCount - 1)) / (maximum - 1))
  );
}
