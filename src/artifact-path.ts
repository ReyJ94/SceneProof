import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";

function slug(value: string): string {
  return (
    value
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 48) || "scene"
  );
}

export async function allocateArtifactPath(input: {
  command: string;
  entry?: string;
  filename?: string;
  target?: string;
}): Promise<string> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const entry = input.entry
    ? basename(input.entry, extname(input.entry))
    : "evidence";
  const directory = resolve(
    "artifacts",
    "sceneproof",
    [
      timestamp,
      slug(input.command),
      slug(entry),
      ...(input.target ? [slug(input.target)] : []),
      randomBytes(4).toString("hex"),
    ].join("-")
  );
  await mkdir(directory, { recursive: true });
  return input.filename ? join(directory, input.filename) : directory;
}
