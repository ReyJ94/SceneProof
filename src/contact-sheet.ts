import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";

import { launchBrowser } from "./browser-runtime.js";

export type ContactSheetItem = {
  label: string;
  path: string;
};

export type ContactSheetItemReport = ContactSheetItem & {
  bytes: number;
  digest: string;
  height: number;
  width: number;
};

export type RasterComparison = {
  changedPixelFraction: number;
  classification: "below-perceptual-floor" | "changed" | "identical";
  from: string;
  normalizedRasterDelta: number;
  to: string;
};

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function pngSize(bytes: Buffer): { height: number; width: number } {
  if (
    bytes.length < 24 ||
    !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
  ) {
    throw new Error("Contact-sheet input is not a PNG.");
  }
  return {
    height: bytes.readUInt32BE(20),
    width: bytes.readUInt32BE(16),
  };
}

export async function createContactSheet(input: {
  compare?: boolean;
  items: ContactSheetItem[];
  out: string;
}): Promise<{
  comparisons: RasterComparison[];
  items: ContactSheetItemReport[];
}> {
  if (input.items.length < 2) {
    throw new Error("A contact sheet requires at least two labeled images.");
  }
  if (input.items.length > 12) {
    throw new Error("A contact sheet accepts at most twelve labeled images.");
  }
  const loaded = await Promise.all(
    input.items.map(async (item) => {
      const path = resolve(item.path);
      const bytes = await readFile(path);
      return {
        ...item,
        bytes: bytes.length,
        dataUrl: `data:image/png;base64,${bytes.toString("base64")}`,
        digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
        ...pngSize(bytes),
        path,
      };
    })
  );
  const output = resolve(input.out);
  if (loaded.some((item) => item.path === output)) {
    throw new Error("Contact-sheet output must not overwrite an input image.");
  }
  const tileWidth = Math.max(...loaded.map((item) => item.width));
  const tileHeight = Math.max(...loaded.map((item) => item.height));
  const labelHeight = 32;
  const columns = Math.min(4, loaded.length);
  const rows = Math.ceil(loaded.length / columns);
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({
      viewport: {
        height: rows * (tileHeight + labelHeight),
        width: columns * tileWidth,
      },
    });
    const comparisons = await page.evaluate(
      async ({ columns: columnCount, compare, entries, height, width }) => {
        const main = document.createElement("main");
        main.dataset.sceneproofContactSheet = "true";
        main.style.background = "#11111b";
        main.style.display = "grid";
        main.style.gridTemplateColumns = `repeat(${columnCount}, ${width}px)`;
        main.style.margin = "0";
        const images: HTMLImageElement[] = [];
        for (const entry of entries) {
          const tile = document.createElement("section");
          tile.style.background = "#11111b";
          tile.style.color = "#f4f4f5";
          tile.style.font =
            "12px ui-monospace, SFMono-Regular, Menlo, monospace";
          tile.style.height = `${height + 32}px`;
          tile.style.overflow = "hidden";
          tile.style.width = `${width}px`;
          const label = document.createElement("div");
          label.style.boxSizing = "border-box";
          label.style.height = "32px";
          label.style.overflow = "hidden";
          label.style.padding = "8px";
          label.style.textOverflow = "ellipsis";
          label.style.whiteSpace = "nowrap";
          label.textContent = entry.label;
          const frame = document.createElement("div");
          frame.style.alignItems = "center";
          frame.style.display = "flex";
          frame.style.height = `${height}px`;
          frame.style.justifyContent = "center";
          frame.style.width = `${width}px`;
          const image = new Image();
          image.src = entry.dataUrl;
          // biome-ignore lint/performance/noAwaitInLoops: Decode order preserves exact label-to-image attribution.
          await image.decode();
          images.push(image);
          frame.append(image);
          tile.append(label, frame);
          main.append(tile);
        }
        document.documentElement.style.background = "transparent";
        document.body.style.background = "transparent";
        document.body.style.margin = "0";
        document.body.replaceChildren(main);

        if (!compare) {
          return [];
        }

        const readPixels = (image: HTMLImageElement): Uint8ClampedArray => {
          const canvas = document.createElement("canvas");
          canvas.height = height;
          canvas.width = width;
          const context = canvas.getContext("2d", { willReadFrequently: true });
          if (!context) {
            throw new Error(
              "A 2D canvas is required for contact-sheet comparison."
            );
          }
          const x = Math.floor((width - image.naturalWidth) / 2);
          const y = Math.floor((height - image.naturalHeight) / 2);
          context.drawImage(image, x, y);
          return context.getImageData(0, 0, width, height).data;
        };
        const classifyComparison = (
          absoluteDelta: number,
          normalizedRasterDelta: number,
          changedPixelFraction: number
        ): RasterComparison["classification"] => {
          if (absoluteDelta === 0) {
            return "identical";
          }
          if (normalizedRasterDelta < 0.001 && changedPixelFraction < 0.005) {
            return "below-perceptual-floor";
          }
          return "changed";
        };
        return images.slice(1).map((image, index) => {
          const previous = readPixels(images[index] as HTMLImageElement);
          const current = readPixels(image);
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
            if (Math.max(red, green, blue) > 2) {
              changedPixels += 1;
            }
          }
          const pixels = Math.max(1, width * height);
          const normalizedRasterDelta = absoluteDelta / (pixels * 3 * 255);
          const changedPixelFraction = changedPixels / pixels;
          return {
            changedPixelFraction,
            classification: classifyComparison(
              absoluteDelta,
              normalizedRasterDelta,
              changedPixelFraction
            ),
            from: entries[index]?.label ?? "",
            normalizedRasterDelta,
            to: entries[index + 1]?.label ?? "",
          };
        });
      },
      {
        columns,
        compare: input.compare ?? false,
        entries: loaded.map(({ dataUrl, label }) => ({ dataUrl, label })),
        height: tileHeight,
        width: tileWidth,
      }
    );
    await page
      .locator("main[data-sceneproof-contact-sheet='true']")
      .screenshot({
        animations: "disabled",
        caret: "hide",
        path: output,
        scale: "css",
        timeout: 120_000,
      });
    return {
      comparisons,
      items: loaded.map(
        ({ bytes, dataUrl: _dataUrl, digest, height, label, path, width }) => ({
          bytes,
          digest,
          height,
          label,
          path,
          width,
        })
      ),
    };
  } finally {
    await browser.close();
  }
}

function evidenceSheetLocations(out: string): {
  contactSheet: string;
  directory: string;
  manifest: string;
} {
  const absolute = resolve(out);
  if (extname(absolute).toLowerCase() === ".png") {
    const stem = basename(absolute, extname(absolute));
    const directory = join(dirname(absolute), `${stem}-sheet`);
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

export async function renderEvidenceSheet(input: {
  compare: boolean;
  items: ContactSheetItem[];
  out: string;
}) {
  const labels = new Set<string>();
  for (const item of input.items) {
    if (!item.label.trim()) {
      throw new Error("Every contact-sheet item requires a non-empty label.");
    }
    if (labels.has(item.label)) {
      throw new Error(`Duplicate contact-sheet label: ${item.label}`);
    }
    labels.add(item.label);
  }

  const artifacts = evidenceSheetLocations(input.out);
  await mkdir(artifacts.directory, { recursive: true });
  await mkdir(dirname(artifacts.contactSheet), { recursive: true });
  const composed = await createContactSheet({
    compare: input.compare,
    items: input.items,
    out: artifacts.contactSheet,
  });
  const executionSucceeded = (await stat(artifacts.contactSheet)).size > 0;
  const report = {
    artifacts,
    command: "sheet" as const,
    ...(input.compare ? { comparisons: composed.comparisons } : {}),
    execution: {
      meaning: "command-execution-only",
      status: executionSucceeded ? ("succeeded" as const) : ("failed" as const),
    },
    items: composed.items,
    provenance: {
      assembly: "supplied-png-artifacts",
      freshness: "input-byte-fingerprints",
    },
    warnings: [
      "This sheet preserves labels and input-byte fingerprints; source and state provenance remain in the reports that produced each image.",
    ],
  };
  await writeFile(artifacts.manifest, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}
