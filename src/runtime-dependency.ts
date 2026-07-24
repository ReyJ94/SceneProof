import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

type PackageManifest = {
  exports?: unknown;
  main?: unknown;
  module?: unknown;
};

function isToolRoot(path: string): boolean {
  const manifest = resolve(path, "package.json");
  if (!existsSync(manifest)) {
    return false;
  }
  try {
    const parsed = JSON.parse(readFileSync(manifest, "utf8")) as {
      name?: unknown;
    };
    return parsed.name === "sceneproof" || parsed.name === "uiscene";
  } catch {
    return false;
  }
}

function toolRoot(): string {
  const candidates = [
    process.env.SCENEPROOF_HOME,
    process.env.UISCENE_HOME,
    resolve(dirname(process.execPath), ".."),
    resolve(dirname(fileURLToPath(import.meta.url)), ".."),
    process.cwd(),
  ].filter((path): path is string => typeof path === "string");
  const root = candidates.find(isToolRoot);
  if (!root) {
    throw new Error(
      "Could not locate the SceneProof installation. Set SCENEPROOF_HOME to the repository or installed package root."
    );
  }
  return root;
}

function packageRequest(name: string) {
  const parts = name.split("/");
  const packageName = name.startsWith("@")
    ? `${parts[0]}/${parts[1]}`
    : (parts[0] ?? name);
  const consumedParts = packageName.startsWith("@") ? 2 : 1;
  const remainder = parts.slice(consumedParts).join("/");
  return {
    packageName,
    remainder,
    subpath: remainder ? `./${remainder}` : ".",
  };
}

const EXPORT_CONDITIONS = [
  "import",
  "bun",
  "browser",
  "node",
  "default",
  "require",
] as const;

function firstTarget(
  values: readonly unknown[],
  wildcard: string
): string | null {
  for (const value of values) {
    const target = selectTarget(value, wildcard);
    if (target) {
      return target;
    }
  }
  return null;
}

function selectTarget(value: unknown, wildcard = ""): string | null {
  if (typeof value === "string") {
    return value.replaceAll("*", wildcard);
  }
  if (Array.isArray(value)) {
    return firstTarget(value, wildcard);
  }
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const conditions = value as Record<string, unknown>;
  return firstTarget(
    EXPORT_CONDITIONS.filter((condition) => condition in conditions).map(
      (condition) => conditions[condition]
    ),
    wildcard
  );
}

function matchingExport(
  exportMap: Record<string, unknown>,
  subpath: string
): string | null {
  const direct = selectTarget(exportMap[subpath]);
  if (direct) {
    return direct;
  }
  for (const [pattern, value] of Object.entries(exportMap)) {
    const marker = pattern.indexOf("*");
    const prefix = pattern.slice(0, Math.max(marker, 0));
    const suffix = marker === -1 ? "" : pattern.slice(marker + 1);
    const matches =
      marker !== -1 && subpath.startsWith(prefix) && subpath.endsWith(suffix);
    if (matches) {
      const wildcard = subpath.slice(
        prefix.length,
        subpath.length - suffix.length
      );
      const target = selectTarget(value, wildcard);
      if (target) {
        return target;
      }
    }
  }
  return null;
}

function exportedTarget(exports: unknown, subpath: string): string | null {
  if (
    typeof exports !== "object" ||
    exports === null ||
    Array.isArray(exports)
  ) {
    return subpath === "." ? selectTarget(exports) : null;
  }
  const exportMap = exports as Record<string, unknown>;
  const isSubpathMap = Object.keys(exportMap).some((key) =>
    key.startsWith(".")
  );
  if (!isSubpathMap) {
    return subpath === "." ? selectTarget(exportMap) : null;
  }
  return matchingExport(exportMap, subpath);
}

function fallbackTarget(
  manifest: PackageManifest,
  remainder: string
): string | null {
  if (remainder) {
    return remainder;
  }
  if (typeof manifest.module === "string") {
    return manifest.module;
  }
  return typeof manifest.main === "string" ? manifest.main : null;
}

export function resolveRuntimeDependency(name: string): string {
  const root = toolRoot();
  const { packageName, remainder, subpath } = packageRequest(name);
  const packageRoot = resolve(root, "node_modules", packageName);
  const manifestPath = resolve(packageRoot, "package.json");
  if (!existsSync(manifestPath)) {
    throw new Error(
      `Runtime dependency ${packageName} is not installed under ${root}. Run bun install in the SceneProof installation.`
    );
  }
  const manifest = JSON.parse(
    readFileSync(manifestPath, "utf8")
  ) as PackageManifest;
  const target =
    exportedTarget(manifest.exports, subpath) ??
    fallbackTarget(manifest, remainder);
  if (!target) {
    throw new Error(`Runtime dependency export ${name} could not be resolved.`);
  }

  const path = resolve(packageRoot, target);
  if (!existsSync(path)) {
    throw new Error(`Runtime dependency export ${name} is missing at ${path}.`);
  }
  return path;
}

export function loadRuntimeDependency<T>(name: string): Promise<T> {
  const resolved = resolveRuntimeDependency(name);
  return import(pathToFileURL(resolved).href) as Promise<T>;
}
