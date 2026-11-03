import { readFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveSync } from "bun";
import type { Loader, Plugin } from "esbuild";
import metadata from "../package.json" with { type: "json" };
import {
  loadRuntimeDependency,
  resolveRuntimeDependency,
} from "./runtime-dependency.js";
import { digest } from "./session-store.js";

const PUBLIC_API = /^sceneproof(?:\/.*)?$/;
const BARE_IMPORT = /^[^./]/;
const SOURCE_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const SEPARATOR = /[\\/]/;
const BUILTIN = /^(?:node:|bun$)/;

/** Own public API resolution, while preserving every consumer module's original import.meta identity. */
export async function loadSessionModule(
  entry: string
): Promise<{ module: Record<string, unknown>; bundleDigest: string }> {
  const { build, transform } =
    await loadRuntimeDependency<typeof import("esbuild")>("esbuild");
  const publicNames = new Set(
    Object.keys(metadata.exports).map((key) =>
      key === "." ? "sceneproof" : `sceneproof${key.slice(1)}`
    )
  );
  const plugin: Plugin = {
    name: "sceneproof-session-source-loader",
    setup(builder) {
      builder.onResolve({ filter: PUBLIC_API }, (args) => {
        if (!publicNames.has(args.path)) {
          throw new Error(
            `SceneProof does not export the public API ${args.path}.`
          );
        }
        return { external: true, path: resolveRuntimeDependency(args.path) };
      });
      builder.onResolve({ filter: BARE_IMPORT }, (args) => {
        if (BUILTIN.test(args.path)) {
          return { external: true, path: args.path };
        }
        return {
          external: true,
          path: resolveSync(args.path, dirname(args.importer)),
        };
      });
      builder.onLoad({ filter: SOURCE_FILE }, async (args) => {
        const path = resolve(args.path);
        if (path.split(SEPARATOR).some((part) => part.startsWith(".env"))) {
          throw new Error("Private configuration is not a session module.");
        }
        const extension = extname(path);
        let loader: Loader = "js";
        if (extension === ".tsx") {
          loader = "tsx";
        } else if (extension === ".jsx") {
          loader = "jsx";
        } else if (extension.endsWith("ts")) {
          loader = "ts";
        }
        const transformed = await transform(await readFile(path, "utf8"), {
          define: {
            "import.meta.dir": JSON.stringify(dirname(path)),
            "import.meta.path": JSON.stringify(path),
            "import.meta.url": JSON.stringify(pathToFileURL(path).href),
          },
          format: "esm",
          loader,
          sourcefile: path,
          sourcemap: "inline",
          target: "esnext",
        });
        return {
          contents: transformed.code,
          loader: "js",
          resolveDir: dirname(path),
        };
      });
    },
  };
  const bundle = await build({
    bundle: true,
    entryPoints: [entry],
    format: "esm",
    logLevel: "silent",
    platform: "node",
    plugins: [plugin],
    sourcemap: "inline",
    target: "esnext",
    write: false,
  });
  const output = bundle.outputFiles?.[0];
  if (!output) {
    throw new Error("Session loader produced no executable source.");
  }
  const module = (await import(
    `data:text/javascript;base64,${Buffer.from(output.contents).toString("base64")}`
  )) as Record<string, unknown>;
  return { bundleDigest: digest(output.contents), module };
}
