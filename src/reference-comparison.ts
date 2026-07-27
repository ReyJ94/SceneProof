/* biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: Playwright serializes this deep browser-side reference-analysis transaction; splitting its helpers across module scope would export unavailable closures into the page. */
import { readFile, writeFile } from "node:fs/promises";
import { extname } from "node:path";

import type {
  LogicalRegion,
  ReferenceComparisonReport,
} from "./scene-schema.js";

const MINIMUM_REFERENCE_CONFIDENCE = 0.7;
const REFERENCE_CAVEAT =
  "Silhouette deltas describe the aligned outer raster envelope, not semantic blade identity or a taste verdict.";

type ReferenceComparisonOptions = {
  backgroundSeeds?: [number, number][];
  currentMaskDataUrl: string;
  currentOutput: string;
  foregroundSeeds?: [number, number][];
  maskPath?: string;
  page: import("playwright-core").Page;
  probes: [number, number][];
  referencePath: string;
  referenceRegion?: LogicalRegion;
  selector: string;
};

type ReferenceComparisonResult = {
  report: ReferenceComparisonReport;
  warnings: string[];
};

function decodeDataUrl(value: string): Uint8Array {
  return Buffer.from(value.slice(value.indexOf(",") + 1), "base64");
}

function outputStem(output: string): string {
  const extension = extname(output);
  return extension
    ? output.slice(0, Math.max(0, output.length - extension.length))
    : output;
}

export async function compareRenderToReference(
  options: ReferenceComparisonOptions
): Promise<ReferenceComparisonResult> {
  const referenceBytes = await readFile(options.referencePath);
  const referenceDataUrl = `data:image/png;base64,${referenceBytes.toString("base64")}`;
  const maskDataUrl = options.maskPath
    ? `data:image/png;base64,${(await readFile(options.maskPath)).toString(
        "base64"
      )}`
    : null;
  const analyzed = await options.page.evaluate(
    async ({
      canvasSelector,
      backgroundSeeds,
      currentMaskSource,
      explicitMaskSource,
      foregroundSeeds,
      minimumConfidence,
      normalizedProbes,
      referenceRegion,
      referenceSource,
    }) => {
      const current = document.querySelector(canvasSelector);
      if (!(current instanceof HTMLCanvasElement)) {
        throw new Error(
          `Reference comparison canvas not found: ${canvasSelector}`
        );
      }
      const decodeImage = async (source: string): Promise<HTMLImageElement> => {
        const image = new Image();
        image.src = source;
        await image.decode();
        return image;
      };
      const createCanvas = (
        width: number,
        height: number
      ): HTMLCanvasElement => {
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        return canvas;
      };
      const context2d = (
        canvas: HTMLCanvasElement,
        readFrequently = false
      ): CanvasRenderingContext2D => {
        const context = canvas.getContext("2d", {
          willReadFrequently: readFrequently,
        });
        if (!context) {
          throw new Error("A 2D canvas is required for reference comparison.");
        }
        return context;
      };
      const referenceImage = await decodeImage(referenceSource);
      const currentMaskImage = await decodeImage(currentMaskSource);
      const referenceCanvas = createCanvas(
        referenceImage.naturalWidth,
        referenceImage.naturalHeight
      );
      const referenceContext = context2d(referenceCanvas, true);
      referenceContext.drawImage(referenceImage, 0, 0);
      const referencePixels = referenceContext.getImageData(
        0,
        0,
        referenceCanvas.width,
        referenceCanvas.height
      ).data;
      const seedPixel = (
        seed: [number, number]
      ): { pixel: number; x: number; y: number } => {
        const x = Math.max(
          0,
          Math.min(
            referenceCanvas.width - 1,
            Math.round(seed[0] * (referenceCanvas.width - 1))
          )
        );
        const y = Math.max(
          0,
          Math.min(
            referenceCanvas.height - 1,
            Math.round(seed[1] * (referenceCanvas.height - 1))
          )
        );
        return { pixel: y * referenceCanvas.width + x, x, y };
      };
      const resolvedForegroundSeeds = foregroundSeeds.map(seedPixel);
      const resolvedBackgroundSeeds = backgroundSeeds.map(seedPixel);
      const currentReadCanvas = createCanvas(current.width, current.height);
      const currentReadContext = context2d(currentReadCanvas, true);
      currentReadContext.drawImage(current, 0, 0);
      const currentPixels = currentReadContext.getImageData(
        0,
        0,
        current.width,
        current.height
      ).data;
      const currentMaskCanvas = createCanvas(current.width, current.height);
      const currentMaskContext = context2d(currentMaskCanvas, true);
      if (
        currentMaskImage.naturalWidth !== current.width ||
        currentMaskImage.naturalHeight !== current.height
      ) {
        throw new Error(
          `Current target mask dimensions differ from the render: ${currentMaskImage.naturalWidth}x${currentMaskImage.naturalHeight} versus ${current.width}x${current.height}.`
        );
      }
      currentMaskContext.drawImage(currentMaskImage, 0, 0);
      const currentMaskPixels = currentMaskContext.getImageData(
        0,
        0,
        current.width,
        current.height
      ).data;
      const currentMask = new Uint8Array(current.width * current.height);
      for (let pixel = 0; pixel < currentMask.length; pixel += 1) {
        currentMask[pixel] = (currentMaskPixels[pixel * 4] ?? 0) > 127 ? 1 : 0;
      }

      const requestedRegion = referenceRegion ?? {
        height: referenceCanvas.height,
        width: referenceCanvas.width,
        x: 0,
        y: 0,
      };
      const region = {
        height: Math.min(
          requestedRegion.height,
          referenceCanvas.height - requestedRegion.y
        ),
        width: Math.min(
          requestedRegion.width,
          referenceCanvas.width - requestedRegion.x
        ),
        x: requestedRegion.x,
        y: requestedRegion.y,
      };
      const {
        height: regionHeight,
        width: regionWidth,
        x: regionX,
        y: regionY,
      } = region;
      if (
        regionX < 0 ||
        regionY < 0 ||
        regionWidth <= 0 ||
        regionHeight <= 0 ||
        regionX >= referenceCanvas.width ||
        regionY >= referenceCanvas.height
      ) {
        throw new Error(
          `Reference region is outside ${referenceCanvas.width}x${referenceCanvas.height}.`
        );
      }

      const referenceMask = new Uint8Array(
        referenceCanvas.width * referenceCanvas.height
      );
      let confidence = 0;
      let foregroundCount = 0;
      let maskReason: string | undefined;
      let backgroundColorDistanceP90: number | undefined;
      if (explicitMaskSource) {
        const explicitMaskImage = await decodeImage(explicitMaskSource);
        if (
          explicitMaskImage.naturalWidth !== referenceCanvas.width ||
          explicitMaskImage.naturalHeight !== referenceCanvas.height
        ) {
          throw new Error(
            `Reference mask dimensions differ from the reference: ${explicitMaskImage.naturalWidth}x${explicitMaskImage.naturalHeight} versus ${referenceCanvas.width}x${referenceCanvas.height}.`
          );
        }
        const explicitMaskCanvas = createCanvas(
          referenceCanvas.width,
          referenceCanvas.height
        );
        const explicitMaskContext = context2d(explicitMaskCanvas, true);
        explicitMaskContext.drawImage(explicitMaskImage, 0, 0);
        const explicitPixels = explicitMaskContext.getImageData(
          0,
          0,
          explicitMaskCanvas.width,
          explicitMaskCanvas.height
        ).data;
        for (let y = regionY; y < regionY + regionHeight; y += 1) {
          for (let x = regionX; x < regionX + regionWidth; x += 1) {
            const pixel = y * referenceCanvas.width + x;
            if ((explicitPixels[pixel * 4] ?? 0) > 127) {
              referenceMask[pixel] = 1;
              foregroundCount += 1;
            }
          }
        }
        confidence = foregroundCount > 0 ? 1 : 0;
        if (foregroundCount === 0) {
          maskReason =
            "The explicit reference mask contains no foreground pixels.";
        }
      } else {
        const borderColors: [number, number, number][] = [];
        const addBorder = (x: number, y: number): void => {
          const offset = (y * referenceCanvas.width + x) * 4;
          borderColors.push([
            referencePixels[offset] ?? 0,
            referencePixels[offset + 1] ?? 0,
            referencePixels[offset + 2] ?? 0,
          ]);
        };
        for (let x = regionX; x < regionX + regionWidth; x += 1) {
          addBorder(x, regionY);
          addBorder(x, regionY + regionHeight - 1);
        }
        for (let y = regionY + 1; y < regionY + regionHeight - 1; y += 1) {
          addBorder(regionX, y);
          addBorder(regionX + regionWidth - 1, y);
        }
        const background = borderColors
          .reduce(
            (sum, color) => [
              sum[0] + color[0],
              sum[1] + color[1],
              sum[2] + color[2],
            ],
            [0, 0, 0]
          )
          .map((value) => value / Math.max(1, borderColors.length));
        const colorDistance = (
          red: number,
          green: number,
          blue: number
        ): number =>
          Math.hypot(
            red - (background[0] ?? 0),
            green - (background[1] ?? 0),
            blue - (background[2] ?? 0)
          );
        const borderDistances = borderColors
          .map((color) => colorDistance(color[0], color[1], color[2]))
          .sort((left, right) => left - right);
        const borderP90 =
          borderDistances[
            Math.min(
              borderDistances.length - 1,
              Math.floor(borderDistances.length * 0.9)
            )
          ] ?? 0;
        backgroundColorDistanceP90 = borderP90;
        const threshold = Math.max(30, borderP90 * 2.5);
        const pixelColor = (pixel: number): [number, number, number] => {
          const offset = pixel * 4;
          return [
            referencePixels[offset] ?? 0,
            referencePixels[offset + 1] ?? 0,
            referencePixels[offset + 2] ?? 0,
          ];
        };
        const sampleColors = (
          seeds: Array<{ pixel: number; x: number; y: number }>
        ): [number, number, number][] =>
          seeds.flatMap((seed) => {
            const colors: [number, number, number][] = [];
            for (let offsetY = -2; offsetY <= 2; offsetY += 1) {
              for (let offsetX = -2; offsetX <= 2; offsetX += 1) {
                const x = Math.max(
                  regionX,
                  Math.min(regionX + regionWidth - 1, seed.x + offsetX)
                );
                const y = Math.max(
                  regionY,
                  Math.min(regionY + regionHeight - 1, seed.y + offsetY)
                );
                colors.push(pixelColor(y * referenceCanvas.width + x));
              }
            }
            return colors;
          });
        const foregroundColors = sampleColors(resolvedForegroundSeeds);
        const backgroundSeedColors = [
          ...sampleColors(resolvedBackgroundSeeds),
          ...borderColors.filter((_, index) => index % 12 === 0),
        ];
        const nearestColorDistance = (
          red: number,
          green: number,
          blue: number,
          colors: [number, number, number][]
        ): number =>
          colors.reduce(
            (minimum, color) =>
              Math.min(
                minimum,
                Math.hypot(red - color[0], green - color[1], blue - color[2])
              ),
            Number.POSITIVE_INFINITY
          );
        const foregroundBackgroundDistances = foregroundColors
          .map((color) =>
            nearestColorDistance(
              color[0],
              color[1],
              color[2],
              backgroundSeedColors
            )
          )
          .sort((left, right) => left - right);
        const seedSeparationDistance =
          foregroundBackgroundDistances[
            Math.floor(foregroundBackgroundDistances.length * 0.5)
          ] ?? 0;
        const seedSeparationScore = Math.min(1, seedSeparationDistance / 64);
        const assisted = foregroundColors.length > 0;
        const candidates = new Uint8Array(referenceMask.length);
        let candidateCount = 0;
        for (let y = regionY; y < regionY + regionHeight; y += 1) {
          for (let x = regionX; x < regionX + regionWidth; x += 1) {
            const pixel = y * referenceCanvas.width + x;
            const offset = pixel * 4;
            const red = referencePixels[offset] ?? 0;
            const green = referencePixels[offset + 1] ?? 0;
            const blue = referencePixels[offset + 2] ?? 0;
            const automaticCandidate =
              colorDistance(red, green, blue) > threshold;
            const foregroundDistance = nearestColorDistance(
              red,
              green,
              blue,
              foregroundColors
            );
            const backgroundDistance = nearestColorDistance(
              red,
              green,
              blue,
              backgroundSeedColors
            );
            const assistedCandidate =
              assisted &&
              foregroundDistance <= 96 &&
              foregroundDistance + 4 < backgroundDistance;
            if (
              (referencePixels[offset + 3] ?? 0) > 32 &&
              (assisted ? assistedCandidate : automaticCandidate)
            ) {
              candidates[pixel] = 1;
              candidateCount += 1;
            }
          }
        }
        const labels = new Int32Array(referenceMask.length);
        const queue = new Int32Array(Math.max(1, candidateCount));
        const components: {
          borderPixels: number;
          id: number;
          meanDistance: number;
          size: number;
        }[] = [];
        let nextId = 1;
        for (let y = regionY; y < regionY + regionHeight; y += 1) {
          for (let x = regionX; x < regionX + regionWidth; x += 1) {
            const start = y * referenceCanvas.width + x;
            if (candidates[start] !== 1 || labels[start] !== 0) {
              continue;
            }
            let head = 0;
            let tail = 0;
            let borderPixels = 0;
            let distanceSum = 0;
            queue[tail] = start;
            tail += 1;
            labels[start] = nextId;
            while (head < tail) {
              const pixel = queue[head] ?? 0;
              head += 1;
              const pixelX = pixel % referenceCanvas.width;
              const pixelY = Math.floor(pixel / referenceCanvas.width);
              if (
                pixelX === regionX ||
                pixelX === regionX + regionWidth - 1 ||
                pixelY === regionY ||
                pixelY === regionY + regionHeight - 1
              ) {
                borderPixels += 1;
              }
              const offset = pixel * 4;
              distanceSum += colorDistance(
                referencePixels[offset] ?? 0,
                referencePixels[offset + 1] ?? 0,
                referencePixels[offset + 2] ?? 0
              );
              const neighbors = [
                pixelX > regionX ? pixel - 1 : -1,
                pixelX < regionX + regionWidth - 1 ? pixel + 1 : -1,
                pixelY > regionY ? pixel - referenceCanvas.width : -1,
                pixelY < regionY + regionHeight - 1
                  ? pixel + referenceCanvas.width
                  : -1,
              ];
              for (const neighbor of neighbors) {
                if (
                  neighbor >= 0 &&
                  candidates[neighbor] === 1 &&
                  labels[neighbor] === 0
                ) {
                  labels[neighbor] = nextId;
                  queue[tail] = neighbor;
                  tail += 1;
                }
              }
            }
            components.push({
              borderPixels,
              id: nextId,
              meanDistance: distanceSum / Math.max(1, tail),
              size: tail,
            });
            nextId += 1;
          }
        }
        const [largest, secondLargest] = components.sort(
          (left, right) => right.size - left.size
        );
        if (largest) {
          const seededIds = new Set(
            resolvedForegroundSeeds
              .map((seed) => labels[seed.pixel] ?? 0)
              .filter((id) => id > 0)
          );
          let selectedComponents = [largest];
          if (seededIds.size > 0) {
            selectedComponents = components.filter((component) =>
              seededIds.has(component.id)
            );
          } else if (referenceRegion) {
            selectedComponents = components.filter(
              (component) =>
                component.size >= Math.max(16, largest.size * 0.02) &&
                component.borderPixels / Math.max(1, component.size) < 0.05
            );
          }
          const selectedIds = new Set(
            selectedComponents.map((component) => component.id)
          );
          for (let pixel = 0; pixel < labels.length; pixel += 1) {
            if (selectedIds.has(labels[pixel] ?? 0)) {
              referenceMask[pixel] = 1;
              foregroundCount += 1;
            }
          }
          const selectedSize = selectedComponents.reduce(
            (sum, component) => sum + component.size,
            0
          );
          const selectedBorderPixels = selectedComponents.reduce(
            (sum, component) => sum + component.borderPixels,
            0
          );
          const selectedMeanDistance =
            selectedComponents.reduce(
              (sum, component) => sum + component.meanDistance * component.size,
              0
            ) / Math.max(1, selectedSize);
          let dominance = selectedSize / Math.max(1, candidateCount);
          let competingComponentRatio =
            referenceRegion === null
              ? (secondLargest?.size ?? 0) / Math.max(1, largest.size)
              : 0;
          if (seededIds.size > 0) {
            dominance = 1;
            competingComponentRatio = 0;
          }
          const componentAmbiguityScore =
            1 - Math.min(1, competingComponentRatio);
          const borderScore =
            1 - selectedBorderPixels / Math.max(1, selectedSize);
          const contrastScore = Math.min(
            1,
            selectedMeanDistance / Math.max(1, threshold * 2)
          );
          const backgroundUniformityScore = 1 - Math.min(1, borderP90 / 40);
          const foregroundFraction =
            selectedSize / Math.max(1, regionWidth * regionHeight);
          const sizeScore =
            foregroundFraction >= 0.01 && foregroundFraction <= 0.85
              ? 1
              : Math.max(0, 1 - Math.abs(foregroundFraction - 0.43) * 2);
          const automaticConfidence =
            dominance * 0.15 +
            componentAmbiguityScore * 0.25 +
            borderScore * 0.1 +
            contrastScore * 0.1 +
            sizeScore * 0.05 +
            backgroundUniformityScore * 0.35;
          const assistedConfidence =
            dominance * 0.15 +
            componentAmbiguityScore * 0.15 +
            borderScore * 0.1 +
            contrastScore * 0.15 +
            sizeScore * 0.05 +
            seedSeparationScore * 0.4;
          confidence = Math.max(
            0,
            Math.min(1, assisted ? assistedConfidence : automaticConfidence)
          );
          if (resolvedForegroundSeeds.length > 0 && seededIds.size === 0) {
            maskReason =
              "Foreground seeds did not land on a separable subject component; add seeds on distinct subject materials or constrain the reference region.";
            confidence = Math.min(confidence, 0.4);
          } else if (
            resolvedForegroundSeeds.length === 0 &&
            !referenceRegion &&
            competingComponentRatio >= 0.25
          ) {
            maskReason =
              "Automatic segmentation found competing connected foreground components; supply a region or exact mask to identify the intended subject.";
          } else if (!assisted && backgroundUniformityScore < 0.5) {
            maskReason =
              "Automatic segmentation found a nonuniform reference background; supply an exact mask for numeric evidence.";
          } else if (assisted && confidence < minimumConfidence) {
            maskReason =
              "Seed-assisted segmentation remains uncertain; inspect the mask overlay, add seeds on missing subject materials, or supply an exact mask.";
          }
        } else {
          maskReason =
            "Automatic segmentation found no connected foreground subject.";
        }
      }

      const boundsOf = (
        mask: Uint8Array,
        width: number,
        height: number
      ): { height: number; width: number; x: number; y: number } | null => {
        let minimumX = width;
        let minimumY = height;
        let maximumX = -1;
        let maximumY = -1;
        for (let pixel = 0; pixel < mask.length; pixel += 1) {
          if (mask[pixel] !== 1) {
            continue;
          }
          const x = pixel % width;
          const y = Math.floor(pixel / width);
          minimumX = Math.min(minimumX, x);
          minimumY = Math.min(minimumY, y);
          maximumX = Math.max(maximumX, x);
          maximumY = Math.max(maximumY, y);
        }
        return maximumX < 0
          ? null
          : {
              height: maximumY - minimumY + 1,
              width: maximumX - minimumX + 1,
              x: minimumX,
              y: minimumY,
            };
      };
      const referenceBounds = boundsOf(
        referenceMask,
        referenceCanvas.width,
        referenceCanvas.height
      );
      const currentBounds = boundsOf(
        currentMask,
        current.width,
        current.height
      );
      const foregroundFraction =
        foregroundCount / Math.max(1, regionWidth * regionHeight);
      let method:
        | "assisted-seeds"
        | "automatic"
        | "automatic-region"
        | "explicit-mask" = "automatic";
      if (explicitMaskSource) {
        method = "explicit-mask";
      } else if (resolvedForegroundSeeds.length > 0) {
        method = "assisted-seeds";
      } else if (referenceRegion) {
        method = "automatic-region";
      }
      const auditMask = (mask: Uint8Array) => {
        const visited = new Uint8Array(mask.length);
        const queue = new Int32Array(Math.max(1, mask.length));
        let componentCount = 0;
        let borderPixels = 0;
        for (let pixel = 0; pixel < mask.length; pixel += 1) {
          if (mask[pixel] !== 1) {
            continue;
          }
          const x = pixel % referenceCanvas.width;
          const y = Math.floor(pixel / referenceCanvas.width);
          if (
            x === regionX ||
            x === regionX + regionWidth - 1 ||
            y === regionY ||
            y === regionY + regionHeight - 1
          ) {
            borderPixels += 1;
          }
          if (visited[pixel] === 1) {
            continue;
          }
          componentCount += 1;
          let head = 0;
          let tail = 0;
          queue[tail] = pixel;
          tail += 1;
          visited[pixel] = 1;
          while (head < tail) {
            const active = queue[head] ?? 0;
            head += 1;
            const activeX = active % referenceCanvas.width;
            const activeY = Math.floor(active / referenceCanvas.width);
            const neighbors = [
              activeX > regionX ? active - 1 : -1,
              activeX < regionX + regionWidth - 1 ? active + 1 : -1,
              activeY > regionY ? active - referenceCanvas.width : -1,
              activeY < regionY + regionHeight - 1
                ? active + referenceCanvas.width
                : -1,
            ];
            for (const neighbor of neighbors) {
              if (
                neighbor >= 0 &&
                mask[neighbor] === 1 &&
                visited[neighbor] === 0
              ) {
                visited[neighbor] = 1;
                queue[tail] = neighbor;
                tail += 1;
              }
            }
          }
        }
        return {
          borderContactFraction: borderPixels / Math.max(1, foregroundCount),
          componentCount,
        };
      };
      const maskAudit = auditMask(referenceMask);
      let maskVerification:
        | "assisted-needs-review"
        | "automatic-needs-review"
        | "explicit-needs-review" = "automatic-needs-review";
      if (method === "explicit-mask") {
        maskVerification = "explicit-needs-review";
      } else if (method === "assisted-seeds") {
        maskVerification = "assisted-needs-review";
      }
      const referenceMaskCanvas = createCanvas(
        referenceCanvas.width,
        referenceCanvas.height
      );
      const referenceMaskContext = context2d(referenceMaskCanvas);
      const referenceMaskImageData = referenceMaskContext.createImageData(
        referenceCanvas.width,
        referenceCanvas.height
      );
      for (let pixel = 0; pixel < referenceMask.length; pixel += 1) {
        const value = referenceMask[pixel] === 1 ? 255 : 0;
        referenceMaskImageData.data[pixel * 4] = value;
        referenceMaskImageData.data[pixel * 4 + 1] = value;
        referenceMaskImageData.data[pixel * 4 + 2] = value;
        referenceMaskImageData.data[pixel * 4 + 3] = 255;
      }
      referenceMaskContext.putImageData(referenceMaskImageData, 0, 0);
      const referenceMaskOverlay = createCanvas(
        referenceCanvas.width,
        referenceCanvas.height
      );
      const referenceMaskOverlayContext = context2d(referenceMaskOverlay);
      referenceMaskOverlayContext.drawImage(referenceCanvas, 0, 0);
      const tintCanvas = createCanvas(
        referenceCanvas.width,
        referenceCanvas.height
      );
      const tintContext = context2d(tintCanvas);
      const tint = tintContext.createImageData(
        referenceCanvas.width,
        referenceCanvas.height
      );
      for (let pixel = 0; pixel < referenceMask.length; pixel += 1) {
        if (referenceMask[pixel] !== 1) {
          continue;
        }
        tint.data[pixel * 4] = 0;
        tint.data[pixel * 4 + 1] = 255;
        tint.data[pixel * 4 + 2] = 255;
        tint.data[pixel * 4 + 3] = 118;
      }
      tintContext.putImageData(tint, 0, 0);
      referenceMaskOverlayContext.drawImage(tintCanvas, 0, 0);
      const contactSheet = createCanvas(current.width * 3, current.height);
      const contactContext = context2d(contactSheet);
      contactContext.fillStyle = "#000000";
      contactContext.fillRect(0, 0, contactSheet.width, contactSheet.height);
      const drawContained = (
        source: CanvasImageSource,
        sourceWidth: number,
        sourceHeight: number,
        panelX: number,
        sourceRegion?: {
          height: number;
          width: number;
          x: number;
          y: number;
        }
      ): void => {
        const crop = sourceRegion ?? {
          height: sourceHeight,
          width: sourceWidth,
          x: 0,
          y: 0,
        };
        const scale = Math.min(
          current.width / crop.width,
          current.height / crop.height
        );
        const width = crop.width * scale;
        const height = crop.height * scale;
        contactContext.drawImage(
          source,
          crop.x,
          crop.y,
          crop.width,
          crop.height,
          panelX + (current.width - width) / 2,
          (current.height - height) / 2,
          width,
          height
        );
      };
      if (
        confidence < minimumConfidence ||
        !referenceBounds ||
        !currentBounds
      ) {
        drawContained(
          referenceCanvas,
          referenceCanvas.width,
          referenceCanvas.height,
          0,
          region
        );
        contactContext.drawImage(current, current.width, 0);
        return {
          analysisAvailable: false as const,
          contactSheetDataUrl: contactSheet.toDataURL("image/png"),
          mask: {
            ...(backgroundColorDistanceP90 === undefined
              ? {}
              : { backgroundColorDistanceP90 }),
            ...(referenceBounds ? { bounds: referenceBounds } : {}),
            audit: maskAudit,
            confidence,
            confidenceMeaning:
              "Extraction confidence only; it does not establish that the selected mask is semantically correct.",
            foregroundFraction,
            method,
            minimumConfidence,
            reason:
              maskReason ??
              `Reference subject confidence ${confidence.toFixed(3)} is below ${minimumConfidence.toFixed(3)}.`,
            seeds: {
              background: backgroundSeeds,
              foreground: foregroundSeeds,
            },
            verification: maskVerification,
          },
          referenceMaskDataUrl: referenceMaskCanvas.toDataURL("image/png"),
          referenceMaskOverlayDataUrl:
            referenceMaskOverlay.toDataURL("image/png"),
        };
      }

      const alignmentScale = currentBounds.height / referenceBounds.height;
      const referenceCenterX = referenceBounds.x + referenceBounds.width / 2;
      const referenceCenterY = referenceBounds.y + referenceBounds.height / 2;
      const currentCenterX = currentBounds.x + currentBounds.width / 2;
      const currentCenterY = currentBounds.y + currentBounds.height / 2;
      const translateX = currentCenterX - referenceCenterX * alignmentScale;
      const translateY = currentCenterY - referenceCenterY * alignmentScale;
      const normalizedReference = createCanvas(current.width, current.height);
      const normalizedContext = context2d(normalizedReference, true);
      normalizedContext.drawImage(
        referenceCanvas,
        translateX,
        translateY,
        referenceCanvas.width * alignmentScale,
        referenceCanvas.height * alignmentScale
      );
      const alignedMaskCanvas = createCanvas(current.width, current.height);
      const alignedMaskContext = context2d(alignedMaskCanvas, true);
      alignedMaskContext.imageSmoothingEnabled = false;
      alignedMaskContext.drawImage(
        referenceMaskCanvas,
        translateX,
        translateY,
        referenceCanvas.width * alignmentScale,
        referenceCanvas.height * alignmentScale
      );
      const alignedMaskPixels = alignedMaskContext.getImageData(
        0,
        0,
        current.width,
        current.height
      ).data;
      const alignedMask = new Uint8Array(currentMask.length);
      for (let pixel = 0; pixel < alignedMask.length; pixel += 1) {
        alignedMask[pixel] = (alignedMaskPixels[pixel * 4] ?? 0) > 127 ? 1 : 0;
      }

      const rowEnvelope = (
        mask: Uint8Array,
        y: number
      ): { left: number; right: number; width: number } => {
        let left = current.width;
        let right = -1;
        for (let x = 0; x < current.width; x += 1) {
          if (mask[y * current.width + x] === 1) {
            left = Math.min(left, x);
            right = Math.max(right, x);
          }
        }
        return right < 0
          ? { left: currentCenterX, right: currentCenterX, width: 0 }
          : { left, right, width: right - left + 1 };
      };
      const profileSampleCount = 101;
      const profileSamples = Array.from(
        { length: profileSampleCount },
        (_, index) => {
          const t = index / (profileSampleCount - 1);
          const y = Math.max(
            0,
            Math.min(
              current.height - 1,
              Math.round(currentBounds.y + t * (currentBounds.height - 1))
            )
          );
          const currentEnvelope = rowEnvelope(currentMask, y);
          const referenceEnvelope = rowEnvelope(alignedMask, y);
          const normalizeEnvelope = (envelope: {
            left: number;
            right: number;
            width: number;
          }) => ({
            leftOffsetFraction:
              (envelope.left - currentCenterX) / currentBounds.height,
            rightOffsetFraction:
              (envelope.right - currentCenterX) / currentBounds.height,
            widthFraction: envelope.width / currentBounds.height,
          });
          const currentProfile = normalizeEnvelope(currentEnvelope);
          const referenceProfile = normalizeEnvelope(referenceEnvelope);
          return {
            current: currentProfile,
            delta: {
              leftOffsetFraction:
                currentProfile.leftOffsetFraction -
                referenceProfile.leftOffsetFraction,
              rightOffsetFraction:
                currentProfile.rightOffsetFraction -
                referenceProfile.rightOffsetFraction,
              widthFraction:
                currentProfile.widthFraction - referenceProfile.widthFraction,
            },
            reference: referenceProfile,
            t,
          };
        }
      );
      const widthDeltas = profileSamples.map(
        (profileSample) => profileSample.delta.widthFraction
      );
      const widthRmseFraction = Math.sqrt(
        widthDeltas.reduce((sum, delta) => sum + delta * delta, 0) /
          profileSampleCount
      );
      const maximumWidthIndex = widthDeltas.reduce(
        (maximumIndex, delta, index) =>
          Math.abs(delta) > Math.abs(widthDeltas[maximumIndex] ?? 0)
            ? index
            : maximumIndex,
        0
      );
      const errorThreshold = 0.02;
      const errorIntervals: Array<{
        direction: "too-narrow" | "too-wide";
        meanWidthDeltaFraction: number;
        start: number;
        end: number;
      }> = [];
      let intervalStart = -1;
      let intervalSign = 0;
      const closeInterval = (endIndex: number): void => {
        if (intervalStart < 0) {
          return;
        }
        const intervalDeltas = widthDeltas.slice(intervalStart, endIndex + 1);
        const mean =
          intervalDeltas.reduce((sum, delta) => sum + delta, 0) /
          Math.max(1, intervalDeltas.length);
        errorIntervals.push({
          direction: mean >= 0 ? "too-wide" : "too-narrow",
          end: endIndex / (profileSampleCount - 1),
          meanWidthDeltaFraction: mean,
          start: intervalStart / (profileSampleCount - 1),
        });
        intervalStart = -1;
        intervalSign = 0;
      };
      for (let index = 0; index < widthDeltas.length; index += 1) {
        const delta = widthDeltas[index] ?? 0;
        const sign = Math.abs(delta) >= errorThreshold ? Math.sign(delta) : 0;
        if (sign === 0) {
          closeInterval(index - 1);
        } else if (intervalStart < 0) {
          intervalStart = index;
          intervalSign = sign;
        } else if (sign !== intervalSign) {
          closeInterval(index - 1);
          intervalStart = index;
          intervalSign = sign;
        }
      }
      closeInterval(widthDeltas.length - 1);
      const profile = {
        samples: profileSamples,
        summary: {
          errorIntervals,
          errorThresholdFraction: errorThreshold,
          maximumAbsoluteWidthDeltaAt:
            maximumWidthIndex / (profileSampleCount - 1),
          maximumAbsoluteWidthDeltaFraction: Math.abs(
            widthDeltas[maximumWidthIndex] ?? 0
          ),
          widthRmseFraction,
        },
      };

      const normalizedPixels = normalizedContext.getImageData(
        0,
        0,
        current.width,
        current.height
      ).data;
      const difference = createCanvas(current.width, current.height);
      const differenceContext = context2d(difference);
      const differenceImage = differenceContext.createImageData(
        current.width,
        current.height
      );
      for (let offset = 0; offset < currentPixels.length; offset += 4) {
        differenceImage.data[offset] = Math.min(
          255,
          Math.abs(
            (currentPixels[offset] ?? 0) - (normalizedPixels[offset] ?? 0)
          ) * 4
        );
        differenceImage.data[offset + 1] = Math.min(
          255,
          Math.abs(
            (currentPixels[offset + 1] ?? 0) -
              (normalizedPixels[offset + 1] ?? 0)
          ) * 4
        );
        differenceImage.data[offset + 2] = Math.min(
          255,
          Math.abs(
            (currentPixels[offset + 2] ?? 0) -
              (normalizedPixels[offset + 2] ?? 0)
          ) * 4
        );
        differenceImage.data[offset + 3] = 255;
      }
      differenceContext.putImageData(differenceImage, 0, 0);
      contactContext.drawImage(normalizedReference, 0, 0);
      contactContext.drawImage(current, current.width, 0);
      contactContext.drawImage(difference, current.width * 2, 0);

      const overlay = createCanvas(current.width, current.height);
      const overlayContext = context2d(overlay);
      const overlayImage = overlayContext.createImageData(
        current.width,
        current.height
      );
      let intersection = 0;
      let union = 0;
      for (let pixel = 0; pixel < currentMask.length; pixel += 1) {
        const isCurrent = currentMask[pixel] === 1;
        const isReference = alignedMask[pixel] === 1;
        if (isCurrent && isReference) {
          intersection += 1;
        }
        if (isCurrent || isReference) {
          union += 1;
        }
        const offset = pixel * 4;
        overlayImage.data[offset] = isReference ? 255 : 0;
        overlayImage.data[offset + 1] = isCurrent ? 255 : 0;
        overlayImage.data[offset + 2] = isCurrent ? 255 : 0;
        overlayImage.data[offset + 3] = isCurrent || isReference ? 255 : 0;
      }
      overlayContext.putImageData(overlayImage, 0, 0);

      const luminance = (red: number, green: number, blue: number): number =>
        (red * 0.2126 + green * 0.7152 + blue * 0.0722) / 255;
      const histogram = (
        pixels: Uint8ClampedArray,
        mask: Uint8Array
      ): {
        luminance: { max: number; p10: number; p50: number; p90: number };
        sampleCount: number;
      } => {
        const values: number[] = [];
        for (let pixel = 0; pixel < mask.length; pixel += 1) {
          if (mask[pixel] !== 1) {
            continue;
          }
          const offset = pixel * 4;
          values.push(
            luminance(
              pixels[offset] ?? 0,
              pixels[offset + 1] ?? 0,
              pixels[offset + 2] ?? 0
            )
          );
        }
        values.sort((left, right) => left - right);
        const percentile = (fraction: number): number =>
          values[
            Math.min(values.length - 1, Math.floor(values.length * fraction))
          ] ?? 0;
        return {
          luminance: {
            max: values.at(-1) ?? 0,
            p10: percentile(0.1),
            p50: percentile(0.5),
            p90: percentile(0.9),
          },
          sampleCount: values.length,
        };
      };
      const widestPointFraction = (
        mask: Uint8Array,
        width: number,
        bounds: { height: number; width: number; x: number; y: number }
      ): number => {
        const {
          height: boundsHeight,
          width: boundsWidth,
          x: boundsX,
          y: boundsY,
        } = bounds;
        let widest = 0;
        let widestY = boundsY;
        for (let y = boundsY; y < boundsY + boundsHeight; y += 1) {
          let rowWidth = 0;
          for (let x = boundsX; x < boundsX + boundsWidth; x += 1) {
            rowWidth += mask[y * width + x] ?? 0;
          }
          if (rowWidth > widest) {
            widest = rowWidth;
            widestY = y;
          }
        }
        return (widestY - boundsY) / Math.max(1, boundsHeight - 1);
      };
      const tipConvergenceAngle = (
        mask: Uint8Array,
        width: number,
        bounds: { height: number; width: number; x: number; y: number }
      ): number => {
        const {
          height: boundsHeight,
          width: boundsWidth,
          x: boundsX,
          y: boundsY,
        } = bounds;
        const rows: { left: number; right: number; y: number }[] = [];
        const endY = Math.min(
          boundsY + boundsHeight,
          boundsY + Math.max(3, Math.ceil(boundsHeight / 3))
        );
        for (let y = boundsY; y < endY; y += 1) {
          let left = boundsX + boundsWidth;
          let right = -1;
          for (let x = boundsX; x < boundsX + boundsWidth; x += 1) {
            if (mask[y * width + x] === 1) {
              left = Math.min(left, x);
              right = Math.max(right, x);
            }
          }
          if (right >= 0) {
            rows.push({ left, right, y });
          }
        }
        const slope = (points: { value: number; y: number }[]): number => {
          const meanY =
            points.reduce((sum, point) => sum + point.y, 0) /
            Math.max(1, points.length);
          const meanValue =
            points.reduce((sum, point) => sum + point.value, 0) /
            Math.max(1, points.length);
          let numerator = 0;
          let denominator = 0;
          for (const point of points) {
            numerator += (point.y - meanY) * (point.value - meanValue);
            denominator += (point.y - meanY) ** 2;
          }
          return numerator / Math.max(Number.EPSILON, denominator);
        };
        const leftSlope = slope(
          rows.map((row) => ({ value: row.left, y: row.y }))
        );
        const rightSlope = slope(
          rows.map((row) => ({ value: row.right, y: row.y }))
        );
        return (
          Math.abs(Math.atan(rightSlope) - Math.atan(leftSlope)) *
          (180 / Math.PI)
        );
      };
      const sample = (
        pixels: Uint8ClampedArray,
        width: number,
        height: number,
        bounds: { height: number; width: number; x: number; y: number },
        normalized: [number, number]
      ) => {
        const {
          height: boundsHeight,
          width: boundsWidth,
          x: boundsX,
          y: boundsY,
        } = bounds;
        const x = Math.max(
          0,
          Math.min(
            width - 1,
            Math.round(boundsX + normalized[0] * (boundsWidth - 1))
          )
        );
        const y = Math.max(
          0,
          Math.min(
            height - 1,
            Math.round(boundsY + normalized[1] * (boundsHeight - 1))
          )
        );
        const offset = (y * width + x) * 4;
        const rgba: [number, number, number, number] = [
          pixels[offset] ?? 0,
          pixels[offset + 1] ?? 0,
          pixels[offset + 2] ?? 0,
          pixels[offset + 3] ?? 0,
        ];
        const similar = (candidateX: number, candidateY: number): boolean => {
          const candidateOffset = (candidateY * width + candidateX) * 4;
          return (
            Math.hypot(
              (pixels[candidateOffset] ?? 0) - rgba[0],
              (pixels[candidateOffset + 1] ?? 0) - rgba[1],
              (pixels[candidateOffset + 2] ?? 0) - rgba[2]
            ) <= 24
          );
        };
        const run = (axis: "horizontal" | "vertical"): number => {
          let negative = axis === "horizontal" ? x - 1 : y - 1;
          let positive = axis === "horizontal" ? x + 1 : y + 1;
          let count = 1;
          while (negative >= 0) {
            const candidateX = axis === "horizontal" ? negative : x;
            const candidateY = axis === "vertical" ? negative : y;
            if (!similar(candidateX, candidateY)) {
              break;
            }
            count += 1;
            negative -= 1;
          }
          const limit = axis === "horizontal" ? width : height;
          while (positive < limit) {
            const candidateX = axis === "horizontal" ? positive : x;
            const candidateY = axis === "vertical" ? positive : y;
            if (!similar(candidateX, candidateY)) {
              break;
            }
            count += 1;
            positive += 1;
          }
          return count;
        };
        return {
          luminance: luminance(rgba[0], rgba[1], rgba[2]),
          pixel: [x, y] as [number, number],
          rgba,
          similarColorRun: {
            horizontalPx: run("horizontal"),
            verticalPx: run("vertical"),
          },
        };
      };
      const referenceAspect = referenceBounds.width / referenceBounds.height;
      const currentAspect = currentBounds.width / currentBounds.height;
      const referenceWidest = widestPointFraction(
        referenceMask,
        referenceCanvas.width,
        referenceBounds
      );
      const currentWidest = widestPointFraction(
        currentMask,
        current.width,
        currentBounds
      );
      const referenceTipAngle = tipConvergenceAngle(
        referenceMask,
        referenceCanvas.width,
        referenceBounds
      );
      const currentTipAngle = tipConvergenceAngle(
        currentMask,
        current.width,
        currentBounds
      );
      const normalizedComposition = (
        bounds: { height: number; width: number; x: number; y: number },
        width: number,
        height: number
      ) => ({
        center: [
          (bounds.x + bounds.width / 2) / width,
          (bounds.y + bounds.height / 2) / height,
        ] as [number, number],
        size: [bounds.width / width, bounds.height / height] as [
          number,
          number,
        ],
      });
      const currentComposition = normalizedComposition(
        currentBounds,
        current.width,
        current.height
      );
      const referenceComposition = normalizedComposition(
        referenceBounds,
        referenceCanvas.width,
        referenceCanvas.height
      );
      return {
        alignment: {
          mode: "center-height-preserving-aspect" as const,
          scale: alignmentScale,
          translate: [translateX, translateY] as [number, number],
        },
        analysisAvailable: true as const,
        composition: {
          current: currentComposition,
          delta: {
            center: [
              currentComposition.center[0] - referenceComposition.center[0],
              currentComposition.center[1] - referenceComposition.center[1],
            ] as [number, number],
            size: [
              currentComposition.size[0] - referenceComposition.size[0],
              currentComposition.size[1] - referenceComposition.size[1],
            ] as [number, number],
          },
          reference: referenceComposition,
        },
        contactSheetDataUrl: contactSheet.toDataURL("image/png"),
        differenceDataUrl: difference.toDataURL("image/png"),
        histograms: {
          current: histogram(currentPixels, currentMask),
          reference: histogram(referencePixels, referenceMask),
        },
        mask: {
          ...(backgroundColorDistanceP90 === undefined
            ? {}
            : { backgroundColorDistanceP90 }),
          audit: maskAudit,
          bounds: referenceBounds,
          confidence,
          confidenceMeaning:
            "Extraction confidence only; it does not establish that the selected mask is semantically correct.",
          foregroundFraction,
          method,
          minimumConfidence,
          seeds: {
            background: backgroundSeeds,
            foreground: foregroundSeeds,
          },
          verification: maskVerification,
        },
        overlayDataUrl: overlay.toDataURL("image/png"),
        probes: normalizedProbes.map((normalized) => ({
          current: sample(
            currentPixels,
            current.width,
            current.height,
            currentBounds,
            normalized
          ),
          normalized,
          reference: sample(
            referencePixels,
            referenceCanvas.width,
            referenceCanvas.height,
            referenceBounds,
            normalized
          ),
        })),
        profile,
        referenceMaskDataUrl: referenceMaskCanvas.toDataURL("image/png"),
        referenceMaskOverlayDataUrl:
          referenceMaskOverlay.toDataURL("image/png"),
        silhouette: {
          areaIoU: intersection / Math.max(1, union),
          aspectRatio: {
            current: currentAspect,
            delta: currentAspect - referenceAspect,
            reference: referenceAspect,
          },
          tipConvergenceAngle: {
            algorithm: "outer-envelope-upper-third-linear-fit" as const,
            current: currentTipAngle,
            delta: currentTipAngle - referenceTipAngle,
            reference: referenceTipAngle,
          },
          widestPointHeightFraction: {
            current: currentWidest,
            delta: currentWidest - referenceWidest,
            reference: referenceWidest,
          },
        },
      };
    },
    {
      backgroundSeeds: options.backgroundSeeds ?? [],
      canvasSelector: options.selector,
      currentMaskSource: options.currentMaskDataUrl,
      explicitMaskSource: maskDataUrl,
      foregroundSeeds: options.foregroundSeeds ?? [],
      minimumConfidence: MINIMUM_REFERENCE_CONFIDENCE,
      normalizedProbes: options.probes,
      referenceRegion: options.referenceRegion ?? null,
      referenceSource: referenceDataUrl,
    }
  );
  const stem = outputStem(options.currentOutput);
  const contactSheet = `${stem}-reference-compare.png`;
  const referenceMask = `${stem}-reference-mask.png`;
  const referenceMaskOverlay = `${stem}-reference-mask-overlay.png`;
  await Promise.all([
    writeFile(contactSheet, decodeDataUrl(analyzed.contactSheetDataUrl)),
    writeFile(referenceMask, decodeDataUrl(analyzed.referenceMaskDataUrl)),
    writeFile(
      referenceMaskOverlay,
      decodeDataUrl(analyzed.referenceMaskOverlayDataUrl)
    ),
  ]);
  const provenance = {
    backgroundSeeds: options.backgroundSeeds ?? [],
    foregroundSeeds: options.foregroundSeeds ?? [],
    maskPath: options.maskPath ?? null,
    path: options.referencePath,
    region: options.referenceRegion ?? null,
  };
  if (!analyzed.analysisAvailable) {
    const recovery =
      analyzed.mask.method === "assisted-seeds" ||
      analyzed.mask.method === "automatic-region"
        ? "Inspect the generated mask overlay, add more foreground/background seeds, or supply --reference-mask."
        : "Inspect the generated mask overlay, then supply --reference-region, reference seeds, or --reference-mask.";
    return {
      report: {
        analysisAvailable: false,
        artifacts: { contactSheet, referenceMask, referenceMaskOverlay },
        mask: analyzed.mask,
        probes: [],
        source: provenance,
      },
      warnings: [
        `Reference subject confidence ${analyzed.mask.confidence.toFixed(3)} is below ${MINIMUM_REFERENCE_CONFIDENCE.toFixed(3)}; numeric paired evidence was withheld. ${recovery}`,
      ],
    };
  }
  const difference = `${stem}-reference-difference.png`;
  const silhouetteOverlay = `${stem}-reference-silhouettes.png`;
  await Promise.all([
    writeFile(difference, decodeDataUrl(analyzed.differenceDataUrl)),
    writeFile(silhouetteOverlay, decodeDataUrl(analyzed.overlayDataUrl)),
  ]);
  return {
    report: {
      alignment: analyzed.alignment,
      analysisAvailable: true,
      artifacts: {
        contactSheet,
        difference,
        referenceMask,
        referenceMaskOverlay,
        silhouetteOverlay,
      },
      composition: analyzed.composition,
      histograms: analyzed.histograms,
      mask: analyzed.mask,
      probes: analyzed.probes,
      profile: analyzed.profile,
      silhouette: {
        ...analyzed.silhouette,
        caveat: REFERENCE_CAVEAT,
      },
      source: provenance,
    },
    warnings: [],
  };
}
