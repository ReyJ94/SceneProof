import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export type FullEvidenceReference = {
  bytes: number;
  path: string;
};

export async function persistJsonEvidence(
  label: string,
  value: unknown
): Promise<FullEvidenceReference> {
  const directory = await mkdtemp(join(tmpdir(), `sceneproof-${label}-`));
  const path = join(directory, "full.json");
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
  return referenceJsonEvidence(path);
}

export async function referenceJsonEvidence(
  path: string
): Promise<FullEvidenceReference> {
  const absolutePath = resolve(path);
  return {
    bytes: (await stat(absolutePath)).size,
    path: absolutePath,
  };
}
