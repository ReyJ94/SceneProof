import { existsSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";

type PackageManifest = { name?: string; version?: string };

async function readManifest(path: string): Promise<PackageManifest | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as PackageManifest;
  } catch {
    return null;
  }
}

async function nearestPackage(start: string): Promise<{
  path: string;
  version: string | null;
} | null> {
  const candidates: string[] = [];
  let directory = dirname(start);
  candidates.push(join(directory, "package.json"));
  let parent = dirname(directory);
  while (parent !== directory) {
    directory = parent;
    candidates.push(join(directory, "package.json"));
    parent = dirname(directory);
  }
  const manifests = await Promise.all(
    candidates.map(async (path) => ({
      manifest: await readManifest(path),
      path,
    }))
  );
  for (const { manifest, path } of manifests) {
    if (manifest?.name === "sceneproof") {
      return {
        path,
        version: typeof manifest.version === "string" ? manifest.version : null,
      };
    }
  }
  return null;
}

async function resolved(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

export async function diagnoseInstallation(input: {
  effectiveVersion: string;
  home?: string;
  invokedPath?: string;
  modulePath: string;
  pathEnvironment?: string;
}) {
  const home = input.home ?? homedir();
  const invokedPath = resolve(
    input.invokedPath ?? process.argv[1] ?? input.modulePath
  );
  const resolvedEntry = await resolved(invokedPath);
  const globalManifestPath = join(
    home,
    ".bun/install/global/node_modules/sceneproof/package.json"
  );
  const globalManifest = await readManifest(globalManifestPath);
  const globalPackage = {
    path: globalManifestPath,
    present: globalManifest !== null,
    version:
      typeof globalManifest?.version === "string"
        ? globalManifest.version
        : null,
  };
  const pathCandidates = await Promise.all(
    (input.pathEnvironment ?? process.env.PATH ?? "")
      .split(delimiter)
      .filter(Boolean)
      .map((directory) => join(directory, "sceneproof"))
      .filter(existsSync)
      .map(async (path) => ({ path, resolved: await resolved(path) }))
  );
  const entryPackage = await nearestPackage(resolvedEntry);
  const installedMode =
    invokedPath.includes(`${join(".bun", "bin")}`) ||
    resolvedEntry.includes(`${join("node_modules", "sceneproof")}`);
  const mode = installedMode
    ? ("installed-bin" as const)
    : ("source-checkout" as const);
  const versionMismatch = Boolean(
    entryPackage?.version && entryPackage.version !== input.effectiveVersion
  );
  const globalMismatch = Boolean(
    globalPackage.version && globalPackage.version !== input.effectiveVersion
  );
  const consistent = installedMode
    ? !(versionMismatch || globalMismatch || !globalPackage.present)
    : !versionMismatch;
  const warnings = [
    ...(pathCandidates.length > 1
      ? [
          `Multiple SceneProof PATH candidates were found: ${pathCandidates
            .map((candidate) => candidate.path)
            .join(", ")}.`,
        ]
      : []),
    ...(globalPackage.present
      ? []
      : ["The Bun global SceneProof package manifest is missing."]),
    ...(globalMismatch
      ? [
          `The Bun global package is ${globalPackage.version}, while this CLI reports ${input.effectiveVersion}.`,
        ]
      : []),
    ...(versionMismatch
      ? [
          `The resolved entry package is ${entryPackage?.version}, while this CLI reports ${input.effectiveVersion}.`,
        ]
      : []),
  ];
  return {
    bunGlobalPackage: globalPackage,
    consistent,
    effectiveVersion: input.effectiveVersion,
    entryPackage,
    invokedPath,
    mode,
    pathCandidates,
    ready: installedMode ? consistent : true,
    reinstallCommand: consistent
      ? null
      : `bun add --global sceneproof@${input.effectiveVersion}`,
    resolvedEntry,
    warnings,
  };
}
