import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

export function digest(value: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

/** Canonical JSON makes provenance independent of object insertion order. */
export function canonical(value: unknown): string {
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error("Evidence numbers must be finite JSON values.");
  }
  if (Array.isArray(value)) {
    return `[${Array.from(value, (item) => (item === undefined ? "null" : canonical(item))).join(",")}]`;
  }
  if (value instanceof Date) {
    return canonical(value.toJSON());
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new Error("Evidence must be JSON serializable, not undefined.");
  }
  return encoded;
}

export function artifactPath(directory: string, name: string): string {
  const path = resolve(directory, name);
  const rel = relative(resolve(directory), path);
  if (
    !rel ||
    rel.startsWith(`..${sep}`) ||
    rel === ".." ||
    resolve(name) === name ||
    name.includes("\\") ||
    rel.split(sep).some((part) => part.startsWith(".env"))
  ) {
    throw new Error(`Artifact name escapes the session directory: ${name}`);
  }
  return path;
}

/** Publish an immutable artifact only after its bytes reach disk. */
export async function atomicArtifact(
  directory: string,
  name: string,
  bytes: Uint8Array | string
) {
  const path = artifactPath(directory, name);
  let parentPath = resolve(directory);
  for (const segment of relative(parentPath, dirname(path))
    .split(sep)
    .filter(Boolean)) {
    parentPath = resolve(parentPath, segment);
    // biome-ignore lint/performance/noAwaitInLoops: Validate each parent before descending into it.
    await mkdir(parentPath).catch((error) => {
      if (error.code !== "EEXIST") {
        throw error;
      }
    });
    const parentInfo = await lstat(parentPath);
    if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) {
      throw new Error(
        "Artifact parent must be an owned directory, not a symlink."
      );
    }
  }
  const temporary = `${path}.${randomUUID()}.pending`;
  const file = await open(temporary, "wx");
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    // link is an atomic no-clobber publication, unlike rename's replacement.
    await link(temporary, path);
    const parent = await open(dirname(path), "r");
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  } finally {
    await unlink(temporary);
  }
  return {
    bytes: Buffer.byteLength(bytes),
    path,
    sha256: digest(bytes),
  };
}

export async function readReceipt(
  directory: string,
  name: string
): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(artifactPath(directory, name), "utf8"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export type RationalClock = { numerator: number; denominator: number };
export function frameClock(
  index: number,
  fps: RationalClock = { denominator: 1, numerator: 30 }
): RationalClock {
  if (
    !Number.isSafeInteger(index) ||
    index < 0 ||
    !Number.isSafeInteger(fps.numerator) ||
    fps.numerator <= 0 ||
    !Number.isSafeInteger(fps.denominator) ||
    fps.denominator <= 0 ||
    !Number.isSafeInteger(index * fps.denominator)
  ) {
    throw new Error(
      "Frame index and rational frame rate must be safe nonnegative/positive integers."
    );
  }
  return { denominator: fps.numerator, numerator: index * fps.denominator };
}
