import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import type { SourceOverlay } from "./source-bundle.js";

export const SourceOverlaySchema = z.object({
  expectedDigest: z
    .string()
    .regex(/^sha256:[a-f0-9]{64}$/)
    .optional(),
  file: z.string().min(1),
  replacements: z
    .array(z.object({ from: z.string().min(1), to: z.string() }))
    .min(1),
});
const PATH_PART = /[\\/]/;
export async function loadSourceOverlays(
  path: string | undefined
): Promise<SourceOverlay[]> {
  if (!path) {
    return [];
  }
  const absolute = resolve(path);
  if (absolute.split(PATH_PART).some((part) => part.startsWith(".env"))) {
    throw new Error("Private configuration is not an overlay manifest.");
  }
  const overlays = z
    .array(SourceOverlaySchema)
    .parse(JSON.parse(await readFile(absolute, "utf8")));
  return overlays.map((overlay) => {
    const file = resolve(dirname(absolute), overlay.file);
    if (file.split(PATH_PART).some((part) => part.startsWith(".env"))) {
      throw new Error("Private configuration is not an overlay source.");
    }
    return {
      file,
      replacements: overlay.replacements,
      ...(overlay.expectedDigest
        ? { expectedDigest: overlay.expectedDigest }
        : {}),
    };
  });
}
