import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import type { Loader, Plugin } from "esbuild";

import {
  loadRuntimeDependency,
  resolveRuntimeDependency,
} from "./runtime-dependency.js";

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
const SOURCE_FILE_FILTER = /\.(?:[cm]?[jt]s|tsx|jsx)$/;
const SHARED_RUNTIME_IMPORT = /^(?:react(?:-dom)?|three)(?:\/.*)?$/;
const WEB_ALIAS_IMPORT = /^@\//;
const NEXT_LINK_IMPORT = /^next\/link$/;
const ANY_IMPORT = /.*/;
const COMPONENT_STYLES = [
  "src/styles/globals.css",
  "src/styles/workspace.css",
  "src/index.css",
  "src/globals.css",
];
const APP_STYLE_FALLBACK = "src/app/globals.css";

export type BrowserBundle = {
  javascript: string;
  css: string;
  inputs: string[];
};

export type SourceOverlay = {
  expectedDigest?: string;
  file: string;
  replacements: Array<{ from: string; to: string }>;
};

function loaderForSource(path: string): Loader {
  const extension = extname(path);
  if (extension === ".tsx") {
    return "tsx";
  }
  if (extension === ".jsx") {
    return "jsx";
  }
  if ([".cts", ".mts", ".ts"].includes(extension)) {
    return "ts";
  }
  return "js";
}

async function applySourceOverlay(path: string, overlay: SourceOverlay) {
  const original = await readFile(path, "utf8");
  const digest = `sha256:${createHash("sha256").update(original).digest("hex")}`;
  if (overlay.expectedDigest && overlay.expectedDigest !== digest) {
    throw new Error(
      `Source overlay digest mismatch for ${path}: expected ${overlay.expectedDigest}, received ${digest}.`
    );
  }
  let contents = original;
  for (const replacement of overlay.replacements) {
    if (!replacement.from) {
      throw new Error(
        `Source overlay for ${path} contains an empty replacement source.`
      );
    }
    const occurrences = contents.split(replacement.from).length - 1;
    if (occurrences !== 1) {
      throw new Error(
        `Source overlay replacement for ${path} matched ${occurrences} locations; exactly one is required.`
      );
    }
    contents = contents.replace(replacement.from, replacement.to);
  }
  return {
    contents,
    loader: loaderForSource(path),
    resolveDir: dirname(path),
  };
}

export function shouldDiscoverSourceCss(
  discoverCss: boolean | undefined
): boolean {
  return discoverCss !== false;
}

const TRANSIENT_ESBUILD_SERVICE_ERROR =
  /(?:The service was stopped|service is no longer running).*(?:EPERM|operation not permitted|send)/is;
const WEBGPU_MISSING_THREE_EXPORT =
  /three\.webgpu\.js.*No matching export|No matching export.*three\.webgpu\.js/is;

export async function retryTransientEsbuildService<T>(
  operation: () => Promise<T>
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!TRANSIENT_ESBUILD_SERVICE_ERROR.test(message)) {
      throw error;
    }
    return operation();
  }
}

function resolveSourcePath(base: string): string | null {
  if (existsSync(base)) {
    return base;
  }
  for (const extension of SOURCE_EXTENSIONS) {
    if (existsSync(`${base}${extension}`)) {
      return `${base}${extension}`;
    }
  }
  for (const extension of SOURCE_EXTENSIONS) {
    const index = resolve(base, `index${extension}`);
    if (existsSync(index)) {
      return index;
    }
  }
  return null;
}

function findWebSource(importer: string): string | null {
  let current = dirname(importer);
  while (current !== dirname(current)) {
    const tsconfig = resolve(current, "tsconfig.json");
    const source = resolve(current, "src");
    if (existsSync(tsconfig) && existsSync(source)) {
      return source;
    }
    current = dirname(current);
  }
  return null;
}

function findAncestorContaining(
  start: string,
  filename: string
): string | null {
  let current = start;
  while (current !== dirname(current)) {
    if (existsSync(resolve(current, filename))) {
      return current;
    }
    current = dirname(current);
  }
  return null;
}

function nearestPackageRoot(path: string): string | null {
  return findAncestorContaining(dirname(path), "package.json");
}

async function workspacePackageStyles(workspace: string): Promise<string[]> {
  const packages = resolve(workspace, "packages");
  if (!existsSync(packages)) {
    return [];
  }
  const entries = await readdir(packages, { withFileTypes: true });
  const styles = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const packageRoot = resolve(packages, entry.name);
        const manifestPath = resolve(packageRoot, "package.json");
        if (!existsSync(manifestPath)) {
          return null;
        }
        const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
          style?: unknown;
        };
        if (typeof manifest.style !== "string") {
          return null;
        }
        const style = resolve(packageRoot, manifest.style);
        return existsSync(style) ? style : null;
      })
  );
  return styles.filter((style): style is string => style !== null);
}

async function discoverSourceCss(inputs: readonly string[]): Promise<string[]> {
  const ownedInputs = inputs.filter((path) => !path.includes("/node_modules/"));
  const packageRoots = new Set<string>();
  const workspaceRoots = new Set<string>();
  for (const path of ownedInputs) {
    const packageRoot = nearestPackageRoot(path);
    if (packageRoot) {
      packageRoots.add(packageRoot);
    }
    const workspace = findAncestorContaining(
      dirname(path),
      "pnpm-workspace.yaml"
    );
    if (workspace) {
      workspaceRoots.add(workspace);
    }
  }

  const sharedStyles = (
    await Promise.all(
      [...workspaceRoots].map((workspace) => workspacePackageStyles(workspace))
    )
  ).flat();
  const appStyles = [...packageRoots].flatMap((packageRoot) => {
    const componentStyles = COMPONENT_STYLES.map((path) =>
      resolve(packageRoot, path)
    ).filter(existsSync);
    if (componentStyles.length > 0) {
      return componentStyles;
    }
    const fallback = resolve(packageRoot, APP_STYLE_FALLBACK);
    return existsSync(fallback) ? [fallback] : [];
  });
  return [...new Set([...sharedStyles, ...appStyles])];
}

function sourceResolutionPlugin(
  threeBackend: "webgl" | "webgpu" = "webgl",
  aliases: Readonly<Record<string, string>> = {},
  sourceOverlays: readonly SourceOverlay[] = []
): Plugin {
  const overlays = new Map(
    sourceOverlays.map((overlay) => [resolve(overlay.file), overlay])
  );
  return {
    name: "uiscene-source-resolution",
    setup(context) {
      context.onLoad({ filter: SOURCE_FILE_FILTER }, async (args) => {
        const overlay = overlays.get(resolve(args.path));
        if (!overlay) {
          return null;
        }
        return await applySourceOverlay(args.path, overlay);
      });
      context.onResolve({ filter: ANY_IMPORT }, (args) => {
        const replacement = aliases[args.path];
        return replacement ? { path: replacement } : null;
      });
      context.onResolve({ filter: NEXT_LINK_IMPORT }, () => ({
        namespace: "uiscene-next-shim",
        path: "next-link",
      }));
      context.onLoad(
        { filter: ANY_IMPORT, namespace: "uiscene-next-shim" },
        () => ({
          contents: `
            import React from "react";
            export default function Link({ href, children, ...props }) {
              const value =
                typeof href === "string" ? href : (href?.pathname ?? "#");
              return React.createElement("a", { ...props, href: value }, children);
            }
          `,
          loader: "jsx",
        })
      );
      context.onResolve({ filter: SHARED_RUNTIME_IMPORT }, (args) => {
        try {
          const dependency =
            threeBackend === "webgpu" && args.path === "three"
              ? "three/webgpu"
              : args.path;
          return { path: resolveRuntimeDependency(dependency) };
        } catch {
          return null;
        }
      });

      context.onResolve({ filter: WEB_ALIAS_IMPORT }, (args) => {
        const source = findWebSource(args.importer);
        if (!source) {
          return null;
        }
        const path = resolveSourcePath(resolve(source, args.path.slice(2)));
        return path ? { path } : null;
      });
    },
  };
}

export async function bundleBrowserDriver(input: {
  aliases?: Readonly<Record<string, string>>;
  discoverCss?: boolean;
  entry: string;
  source: string;
  sourceOverlays?: readonly SourceOverlay[];
  extraCss: readonly string[];
  threeBackend?: "webgl" | "webgpu";
}): Promise<BrowserBundle> {
  const { build } =
    await loadRuntimeDependency<typeof import("esbuild")>("esbuild");
  let result: Awaited<ReturnType<typeof build>>;
  try {
    result = await retryTransientEsbuildService(() =>
      build({
        absWorkingDir: dirname(input.entry),
        banner: {
          js: `globalThis.process ??= { env: { NODE_ENV: "production" } };`,
        },
        bundle: true,
        define: {
          "process.env.NODE_ENV": '"production"',
        },
        format: "iife",
        jsx: "automatic",
        logLevel: "silent",
        metafile: true,
        outdir: "out",
        platform: "browser",
        plugins: [
          sourceResolutionPlugin(
            input.threeBackend,
            input.aliases ?? {},
            input.sourceOverlays ?? []
          ),
        ],
        sourcemap: "inline",
        stdin: {
          contents: input.source,
          loader: "tsx",
          resolveDir: dirname(input.entry),
          sourcefile: "uiscene-browser-driver.tsx",
        },
        target: ["chrome120"],
        write: false,
      })
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      input.threeBackend === "webgpu" &&
      WEBGPU_MISSING_THREE_EXPORT.test(message)
    ) {
      throw new Error(
        `WebGPU compatibility check failed during bundling: a source dependency requires WebGL-only Three.js exports. Migrate that dependency to its WebGPU/TSL equivalent or request --three-backend webgl. ${message}`,
        { cause: error }
      );
    }
    throw error;
  }

  if (!(result.outputFiles && result.metafile)) {
    throw new Error("Source bundle did not return in-memory outputs.");
  }
  const javascript = result.outputFiles.find((file) =>
    file.path.endsWith(".js")
  );
  if (!javascript) {
    throw new Error("Source bundle did not produce browser JavaScript.");
  }

  const bundledCss = result.outputFiles
    .filter((file) => file.path.endsWith(".css"))
    .map((file) => file.text)
    .join("\n");
  const inputs = Object.keys(result.metafile.inputs).map((path) =>
    resolve(dirname(input.entry), path)
  );
  for (const overlay of input.sourceOverlays ?? []) {
    const file = resolve(overlay.file);
    if (!inputs.includes(file)) {
      throw new Error(
        `Source overlay file did not participate in the browser bundle: ${file}`
      );
    }
  }
  const discoveredCss = shouldDiscoverSourceCss(input.discoverCss)
    ? await discoverSourceCss(inputs)
    : [];
  const cssSources = [
    ...new Set([
      ...discoveredCss,
      ...input.extraCss.map((path) => resolve(path)),
    ]),
  ];
  const extraCss = await compileSourceCss(cssSources, inputs);

  return {
    css: [extraCss, bundledCss].filter(Boolean).join("\n"),
    inputs,
    javascript: javascript.text,
  };
}

async function compileSourceCss(
  paths: readonly string[],
  sourceInputs: readonly string[]
): Promise<string> {
  if (paths.length === 0) {
    return "";
  }

  const absolutePaths = paths.map((path) => resolve(path));
  for (const path of absolutePaths) {
    if (!existsSync(path)) {
      throw new Error(`CSS source not found: ${path}`);
    }
  }

  const sources = [
    ...new Set(
      sourceInputs.filter((path) =>
        [".ts", ".tsx", ".js", ".jsx"].includes(extname(path))
      )
    ),
  ];
  const directives = sources
    .map((path) => `@source ${JSON.stringify(path)};`)
    .join("\n");
  const [{ default: tailwindcss }, { default: postcss }] = await Promise.all([
    loadRuntimeDependency<typeof import("@tailwindcss/postcss")>(
      "@tailwindcss/postcss"
    ),
    loadRuntimeDependency<typeof import("postcss")>("postcss"),
  ]);
  const outputs = await Promise.all(
    absolutePaths.map(async (path) => {
      const raw = await readFile(path, "utf8");
      return await postcss([tailwindcss()]).process(`${raw}\n${directives}`, {
        from: path,
      });
    })
  );
  return outputs.map((output) => output.css).join("\n");
}
