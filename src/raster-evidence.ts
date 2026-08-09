import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";

import type { Page } from "playwright-core";

import type {
  LogicalRegion,
  RasterStats,
  RenderReport,
} from "./scene-schema.js";

export type PersistedRasterStats = RasterStats & {
  sampleCoverageFraction: number;
  sampleLuminance: { p10: number; p90: number };
  source: { digest: string; path: string };
};

async function pngSource(path: string): Promise<{
  dataUrl: string;
  digest: string;
  path: string;
}> {
  const absolute = resolve(path);
  const bytes = await readFile(absolute);
  return {
    dataUrl: `data:image/png;base64,${bytes.toString("base64")}`,
    digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    path: absolute,
  };
}

export async function analyzePngRaster(
  page: Page,
  path: string,
  sampleRect?: LogicalRegion
): Promise<PersistedRasterStats> {
  const source = await pngSource(path);
  const measured = await page.evaluate(
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: This isolated decoder measures the persisted PNG, including its dominant background, signal coverage, and requested sample.
    async ({ dataUrl, rect }) => {
      const image = new Image();
      image.src = dataUrl;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.height = image.naturalHeight;
      canvas.width = image.naturalWidth;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) {
        throw new Error(
          "A 2D canvas is required for persisted raster analysis."
        );
      }
      context.drawImage(image, 0, 0);
      const pixels = context.getImageData(
        0,
        0,
        canvas.width,
        canvas.height
      ).data;
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
        canvas.width,
        Math.ceil((rect?.x ?? 0) + (rect?.width ?? canvas.width))
      );
      const sampleBottom = Math.min(
        canvas.height,
        Math.ceil((rect?.y ?? 0) + (rect?.height ?? canvas.height))
      );
      for (let offset = 0; offset < pixels.length; offset += 4) {
        const red = pixels[offset] ?? 0;
        const green = pixels[offset + 1] ?? 0;
        const blue = pixels[offset + 2] ?? 0;
        const alpha = pixels[offset + 3] ?? 0;
        const signal =
          Math.hypot(
            red - background[0],
            green - background[1],
            blue - background[2],
            (alpha - background[3]) * 0.5
          ) > 4;
        if (signal) {
          signalLuminances.push(luminance(red, green, blue));
        }
        const pixel = offset / 4;
        const x = pixel % canvas.width;
        const y = Math.floor(pixel / canvas.width);
        if (
          x >= sampleLeft &&
          x < sampleRight &&
          y >= sampleTop &&
          y < sampleBottom
        ) {
          samplePixels += 1;
          if (signal) {
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
        return (
          values[
            Math.min(
              values.length - 1,
              Math.floor((values.length - 1) * fraction)
            )
          ] ?? 0
        );
      };
      return {
        background: {
          color: background,
          luminance: luminance(background[0], background[1], background[2]),
        },
        coverageFraction:
          signalLuminances.length / Math.max(1, canvas.width * canvas.height),
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
    { dataUrl: source.dataUrl, rect: sampleRect ?? null }
  );
  return {
    ...measured,
    source: { digest: source.digest, path: source.path },
  };
}

export async function comparePngRasters(input: {
  currentPath: string;
  page: Page;
  previousPath: string;
}): Promise<NonNullable<RenderReport["comparison"]>> {
  const [current, previous] = await Promise.all([
    pngSource(input.currentPath),
    pngSource(input.previousPath),
  ]);
  const compared = await input.page.evaluate(
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: One persisted-raster transaction owns decode, exact pixel comparison, localization, and both evidence panels.
    async ({ currentSource, previousSource }) => {
      const load = async (source: string): Promise<HTMLImageElement> => {
        const image = new Image();
        image.src = source;
        await image.decode();
        return image;
      };
      const [currentImage, previousImage] = await Promise.all([
        load(currentSource),
        load(previousSource),
      ]);
      if (
        currentImage.naturalWidth !== previousImage.naturalWidth ||
        currentImage.naturalHeight !== previousImage.naturalHeight
      ) {
        throw new Error(
          `Comparison dimensions differ: previous ${previousImage.naturalWidth}x${previousImage.naturalHeight}, current ${currentImage.naturalWidth}x${currentImage.naturalHeight}.`
        );
      }
      const width = currentImage.naturalWidth;
      const height = currentImage.naturalHeight;
      const read = (image: HTMLImageElement): Uint8ClampedArray => {
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) {
          throw new Error(
            "A 2D canvas is required for persisted raster comparison."
          );
        }
        context.drawImage(image, 0, 0);
        return context.getImageData(0, 0, width, height).data;
      };
      const currentPixels = read(currentImage);
      const previousPixels = read(previousImage);
      const difference = document.createElement("canvas");
      difference.width = width;
      difference.height = height;
      const differenceContext = difference.getContext("2d");
      if (!differenceContext) {
        throw new Error("A 2D canvas is required for difference evidence.");
      }
      const differenceImage = differenceContext.createImageData(width, height);
      let absoluteDelta = 0;
      let changedPixels = 0;
      let maximumX = -1;
      let maximumY = -1;
      let minimumX = width;
      let minimumY = height;
      for (let offset = 0; offset < currentPixels.length; offset += 4) {
        const red = Math.abs(
          (currentPixels[offset] ?? 0) - (previousPixels[offset] ?? 0)
        );
        const green = Math.abs(
          (currentPixels[offset + 1] ?? 0) - (previousPixels[offset + 1] ?? 0)
        );
        const blue = Math.abs(
          (currentPixels[offset + 2] ?? 0) - (previousPixels[offset + 2] ?? 0)
        );
        absoluteDelta += red + green + blue;
        differenceImage.data[offset] = Math.min(255, red * 4);
        differenceImage.data[offset + 1] = Math.min(255, green * 4);
        differenceImage.data[offset + 2] = Math.min(255, blue * 4);
        differenceImage.data[offset + 3] = 255;
        if (Math.max(red, green, blue) > 2) {
          changedPixels += 1;
          const pixel = offset / 4;
          const x = pixel % width;
          const y = Math.floor(pixel / width);
          minimumX = Math.min(minimumX, x);
          minimumY = Math.min(minimumY, y);
          maximumX = Math.max(maximumX, x);
          maximumY = Math.max(maximumY, y);
        }
      }
      differenceContext.putImageData(differenceImage, 0, 0);
      const sideBySide = document.createElement("canvas");
      sideBySide.width = width * 2;
      sideBySide.height = height;
      const sideContext = sideBySide.getContext("2d");
      if (!sideContext) {
        throw new Error("A 2D canvas is required for comparison evidence.");
      }
      sideContext.drawImage(previousImage, 0, 0);
      sideContext.drawImage(currentImage, width, 0);
      const pixelCount = Math.max(1, width * height);
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
    { currentSource: current.dataUrl, previousSource: previous.dataUrl }
  );
  const extension = extname(current.path);
  const stem = extension
    ? current.path.slice(0, -extension.length)
    : current.path;
  const difference = `${stem}-difference.png`;
  const sideBySide = `${stem}-compare.png`;
  const decode = (value: string): Buffer =>
    Buffer.from(value.slice(value.indexOf(",") + 1), "base64");
  await Promise.all([
    writeFile(difference, decode(compared.differenceDataUrl)),
    writeFile(sideBySide, decode(compared.sideBySideDataUrl)),
  ]);
  return {
    artifacts: { difference, sideBySide },
    changedBounds: compared.changedBounds,
    changedPixelFraction: compared.changedPixelFraction,
    classification: compared.classification,
    normalizedRasterDelta: compared.normalizedRasterDelta,
    previous: previous.path,
  };
}

export async function comparePngSequence(input: {
  frames: Array<{ label: string; path: string }>;
  page: Page;
}): Promise<{
  comparisons: Array<{
    changedPixelFraction: number;
    classification: "below-perceptual-floor" | "changed" | "identical";
    differenceDataUrl: string;
    from: string;
    normalizedRasterDelta: number;
    sources: {
      from: { digest: string; path: string };
      to: { digest: string; path: string };
    };
    to: string;
  }>;
  motionMapDataUrl: string;
}> {
  if (input.frames.length < 2) {
    throw new Error(
      "A raster sequence comparison requires at least two frames."
    );
  }
  const sources = await Promise.all(
    input.frames.map(async (frame) => ({
      ...frame,
      ...(await pngSource(frame.path)),
    }))
  );
  const measured = await input.page.evaluate(
    async (entries) => {
      const images: HTMLImageElement[] = [];
      for (const entry of entries) {
        const image = new Image();
        image.src = entry.dataUrl;
        // biome-ignore lint/performance/noAwaitInLoops: Decode order preserves frame attribution.
        await image.decode();
        images.push(image);
      }
      const [first] = images;
      if (!first) {
        throw new Error("The persisted sequence has no first frame.");
      }
      const width = first.naturalWidth;
      const height = first.naturalHeight;
      if (
        images.some(
          (image) =>
            image.naturalWidth !== width || image.naturalHeight !== height
        )
      ) {
        throw new Error("Persisted sequence frame dimensions differ.");
      }
      const read = (image: HTMLImageElement): Uint8ClampedArray => {
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) {
          throw new Error(
            "A 2D canvas is required for persisted sequence evidence."
          );
        }
        context.drawImage(image, 0, 0);
        return context.getImageData(0, 0, width, height).data;
      };
      const pixels = images.map(read);
      const motion = document.createElement("canvas");
      motion.width = width;
      motion.height = height;
      const motionContext = motion.getContext("2d");
      if (!motionContext) {
        throw new Error(
          "A 2D canvas is required for persisted motion-map evidence."
        );
      }
      const motionImage = motionContext.createImageData(width, height);
      // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Each adjacent saved-frame pair owns exact pixel deltas, classification, an amplified map, and aggregate motion-map accumulation.
      const comparisons = pixels.slice(1).map((current, index) => {
        const previous = pixels[index] as Uint8ClampedArray;
        const difference = document.createElement("canvas");
        difference.width = width;
        difference.height = height;
        const differenceContext = difference.getContext("2d");
        if (!differenceContext) {
          throw new Error(
            "A 2D canvas is required for persisted difference evidence."
          );
        }
        const differenceImage = differenceContext.createImageData(
          width,
          height
        );
        let absoluteDelta = 0;
        let changedPixels = 0;
        for (let offset = 0; offset < current.length; offset += 4) {
          const red = Math.abs(
            (current[offset] ?? 0) - (previous[offset] ?? 0)
          );
          const green = Math.abs(
            (current[offset + 1] ?? 0) - (previous[offset + 1] ?? 0)
          );
          const blue = Math.abs(
            (current[offset + 2] ?? 0) - (previous[offset + 2] ?? 0)
          );
          absoluteDelta += red + green + blue;
          const deltas = [red, green, blue];
          for (let channel = 0; channel < 3; channel += 1) {
            const amplified = Math.min(255, (deltas[channel] ?? 0) * 4);
            differenceImage.data[offset + channel] = amplified;
            motionImage.data[offset + channel] = Math.max(
              motionImage.data[offset + channel] ?? 0,
              amplified
            );
          }
          differenceImage.data[offset + 3] = 255;
          motionImage.data[offset + 3] = 255;
          if (Math.max(red, green, blue) > 2) {
            changedPixels += 1;
          }
        }
        differenceContext.putImageData(differenceImage, 0, 0);
        const pixelCount = Math.max(1, width * height);
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
          changedPixelFraction,
          classification,
          differenceDataUrl: difference.toDataURL("image/png"),
          from: entries[index]?.label ?? "",
          normalizedRasterDelta,
          to: entries[index + 1]?.label ?? "",
        };
      });
      motionContext.putImageData(motionImage, 0, 0);
      return { comparisons, motionMapDataUrl: motion.toDataURL("image/png") };
    },
    sources.map(({ dataUrl, label }) => ({ dataUrl, label }))
  );
  return {
    comparisons: measured.comparisons.map((comparison, index) => ({
      ...comparison,
      sources: {
        from: {
          digest: sources[index]?.digest ?? "",
          path: sources[index]?.path ?? "",
        },
        to: {
          digest: sources[index + 1]?.digest ?? "",
          path: sources[index + 1]?.path ?? "",
        },
      },
    })),
    motionMapDataUrl: measured.motionMapDataUrl,
  };
}
