import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import type {
  Checker,
  Project,
  Type,
  Symbol as TypeScriptSymbol,
} from "typescript/unstable/async";

export type ReactPropsPlaceholder = {
  kind: "array" | "boolean" | "literal" | "number" | "string";
  path: string;
  required: boolean;
  value: boolean | number | string | unknown[];
};

export type ReactPropsTemplate = {
  component: string;
  entry: string;
  placeholders: ReactPropsPlaceholder[];
  props: Record<string, unknown>;
  unsupported: Array<{ path: string; type: string }>;
};

const OMIT = Symbol("sceneproof-omit-prop");
const NOT_PRIMITIVE = Symbol("sceneproof-not-primitive-prop");
const TYPESCRIPT_ASYNC_API = join(
  "typescript",
  "dist",
  "api",
  "async",
  "api.js"
);

type TypeScriptAsyncApi = typeof import("typescript/unstable/async");

let typescriptApi: Promise<TypeScriptAsyncApi> | undefined;
const execFileAsync = promisify(execFile);

function findDependencyFile(
  start: string,
  dependencyPath: string
): string | undefined {
  const current = resolve(start);
  const candidate = join(current, "node_modules", dependencyPath);
  if (existsSync(candidate)) {
    return candidate;
  }
  const parent = dirname(current);
  return parent === current
    ? undefined
    : findDependencyFile(parent, dependencyPath);
}

function resolveTypeScriptApi(): Promise<TypeScriptAsyncApi> {
  const moduleDirectory = import.meta.url.startsWith("file:")
    ? dirname(fileURLToPath(import.meta.url))
    : process.cwd();
  const starts = [
    process.cwd(),
    dirname(process.execPath),
    dirname(process.argv[1] ?? process.execPath),
    moduleDirectory,
  ];
  for (const start of new Set(starts)) {
    const apiPath = findDependencyFile(start, TYPESCRIPT_ASYNC_API);
    if (apiPath) {
      return import(pathToFileURL(apiPath).href) as Promise<TypeScriptAsyncApi>;
    }
  }
  throw new Error(
    "TypeScript 7 runtime dependency was not found beside SceneProof or in the current package tree. Reinstall SceneProof with its dependencies."
  );
}

function loadTypeScriptApi(): Promise<TypeScriptAsyncApi> {
  typescriptApi ??= resolveTypeScriptApi();
  return typescriptApi;
}

function compiledPropsWorker(): string | undefined {
  if (!import.meta.url.includes("/$bunfs/")) {
    return;
  }
  const executableDirectory = dirname(process.execPath);
  const candidates = [
    resolve(executableDirectory, "../src/react-props-worker.ts"),
    resolve(executableDirectory, "src/react-props-worker.ts"),
    resolve(process.cwd(), "src/react-props-worker.ts"),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

async function inferReactPropsInWorker(
  worker: string,
  entry: string,
  component: string
): Promise<ReactPropsTemplate> {
  const { stdout } = await execFileAsync("bun", [worker, entry, component], {
    cwd: process.cwd(),
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  return JSON.parse(String(stdout)) as ReactPropsTemplate;
}

function hasFlag(value: number, flag: number): boolean {
  // TypeScript exposes flags as bit masks; bitwise membership is the API contract.
  // biome-ignore lint/suspicious/noBitwiseOperators: TypeScript compiler flag membership requires a bitwise comparison.
  return (value & flag) !== 0;
}

async function symbolType(
  checker: Checker,
  project: Project,
  symbol: TypeScriptSymbol
): Promise<Type | undefined> {
  const handle = symbol.valueDeclaration ?? symbol.declarations[0];
  const node = handle ? await handle.resolve(project) : undefined;
  return node
    ? checker.getTypeOfSymbolAtLocation(symbol, node)
    : checker.getTypeOfSymbol(symbol);
}

async function placeholderValue(input: {
  checker: Checker;
  depth: number;
  path: string;
  placeholders: ReactPropsPlaceholder[];
  project: Project;
  required: boolean;
  seen: Set<number>;
  type: Type;
  unsupported: ReactPropsTemplate["unsupported"];
}): Promise<unknown | typeof OMIT> {
  const {
    checker,
    depth,
    path,
    placeholders,
    project,
    required,
    seen,
    unsupported,
  } = input;
  let { type } = input;
  const api = await loadTypeScriptApi();
  if (type.isUnionType()) {
    const variants = (await type.getTypes()) ?? [];
    const concrete = variants.filter(
      (variant) =>
        !(
          hasFlag(variant.flags, api.TypeFlags.Null) ||
          hasFlag(variant.flags, api.TypeFlags.Undefined)
        )
    );
    type = concrete[0] ?? type;
  }
  const primitive = await primitivePlaceholder({
    checker,
    path,
    placeholders,
    required,
    type,
    unsupported,
  });
  if (primitive !== NOT_PRIMITIVE) {
    return primitive;
  }
  if (depth >= 8 || seen.has(type.id)) {
    unsupported.push({ path, type: await checker.typeToString(type) });
    return OMIT;
  }
  const properties = await checker.getPropertiesOfType(type);
  if (properties.length === 0) {
    unsupported.push({ path, type: await checker.typeToString(type) });
    return OMIT;
  }
  seen.add(type.id);
  const object: Record<string, unknown> = {};
  for (const property of properties) {
    // Recursive property inference shares cycle state, so this traversal is deliberately sequential.
    // biome-ignore lint/performance/noAwaitInLoops: parallel recursion would corrupt shared cycle detection.
    const propertyType = await symbolType(checker, project, property);
    if (!propertyType) {
      continue;
    }
    const propertyPath = path ? `${path}.${property.name}` : property.name;
    const value = await placeholderValue({
      checker,
      depth: depth + 1,
      path: propertyPath,
      placeholders,
      project,
      required: !hasFlag(property.flags, api.SymbolFlags.Optional),
      seen,
      type: propertyType,
      unsupported,
    });
    if (value !== OMIT) {
      object[property.name] = value;
    }
  }
  seen.delete(type.id);
  return object;
}

async function primitivePlaceholder(input: {
  checker: Checker;
  path: string;
  placeholders: ReactPropsPlaceholder[];
  required: boolean;
  type: Type;
  unsupported: ReactPropsTemplate["unsupported"];
}): Promise<unknown | typeof OMIT | typeof NOT_PRIMITIVE> {
  const { checker, path, placeholders, required, type, unsupported } = input;
  const api = await loadTypeScriptApi();
  if (type.isStringLiteralType() || type.isNumberLiteralType()) {
    const value = type.isStringLiteralType()
      ? String(type.value)
      : Number(type.value);
    placeholders.push({ kind: "literal", path, required, value });
    return value;
  }
  if (type.isBooleanLiteralType()) {
    const value = Boolean(type.value);
    placeholders.push({ kind: "literal", path, required, value });
    return value;
  }
  if (hasFlag(type.flags, api.TypeFlags.StringLike)) {
    const value = `[missing: ${path}]`;
    placeholders.push({ kind: "string", path, required, value });
    return value;
  }
  if (hasFlag(type.flags, api.TypeFlags.NumberLike)) {
    placeholders.push({ kind: "number", path, required, value: 0 });
    return 0;
  }
  if (hasFlag(type.flags, api.TypeFlags.BooleanLike)) {
    placeholders.push({ kind: "boolean", path, required, value: false });
    return false;
  }
  if (await checker.isArrayType(type)) {
    placeholders.push({ kind: "array", path, required, value: [] });
    return [];
  }
  if (
    (await checker.getSignaturesOfType(type, api.SignatureKind.Call)).length > 0
  ) {
    unsupported.push({ path, type: await checker.typeToString(type) });
    return OMIT;
  }
  return NOT_PRIMITIVE;
}

export async function inferReactPropsTemplate(
  entry: string,
  component: string
): Promise<ReactPropsTemplate> {
  const worker = compiledPropsWorker();
  if (worker) {
    return inferReactPropsInWorker(worker, entry, component);
  }
  const absoluteEntry = resolve(entry);
  const { API, SignatureKind } = await loadTypeScriptApi();
  const api = new API({ cwd: dirname(absoluteEntry) });
  try {
    const snapshot = await api.updateSnapshot({ openFiles: [absoluteEntry] });
    try {
      const project = await snapshot.getDefaultProjectForFile(absoluteEntry);
      if (!project) {
        throw new Error(
          `TypeScript could not resolve a project for React entry ${absoluteEntry}.`
        );
      }
      const source = await project.program.getSourceFile(absoluteEntry);
      const moduleSymbol = source
        ? await project.checker.getSymbolAtLocation(source)
        : undefined;
      const exports = moduleSymbol
        ? await project.checker.getExportsOfModule(moduleSymbol)
        : [];
      const componentSymbol = exports.find(
        (symbol) => symbol.name === component
      );
      if (!componentSymbol) {
        throw new Error(
          `React export ${component} was not found while deriving props from ${absoluteEntry}.`
        );
      }
      const componentType = await symbolType(
        project.checker,
        project,
        componentSymbol
      );
      const signatures = componentType
        ? await project.checker.getSignaturesOfType(
            componentType,
            SignatureKind.Call
          )
        : [];
      const parameters = signatures[0]
        ? await signatures[0].getParameters()
        : [];
      const [propsSymbol] = parameters;
      const propsType = propsSymbol
        ? await symbolType(project.checker, project, propsSymbol)
        : undefined;
      if (!propsType) {
        throw new Error(
          `React export ${component} has no resolvable first props parameter.`
        );
      }
      const placeholders: ReactPropsPlaceholder[] = [];
      const unsupported: ReactPropsTemplate["unsupported"] = [];
      const props = await placeholderValue({
        checker: project.checker,
        depth: 0,
        path: "",
        placeholders,
        project,
        required: true,
        seen: new Set(),
        type: propsType,
        unsupported,
      });
      if (props === OMIT || typeof props !== "object" || props === null) {
        throw new Error(
          `React export ${component} props could not be represented as a JSON object.`
        );
      }
      return {
        component,
        entry: absoluteEntry,
        placeholders,
        props: props as Record<string, unknown>,
        unsupported,
      };
    } finally {
      await snapshot.dispose();
    }
  } finally {
    await api.close();
  }
}

function hasPath(source: Record<string, unknown>, path: string): boolean {
  let current: unknown = source;
  for (const segment of path.split(".")) {
    if (
      typeof current !== "object" ||
      current === null ||
      !Object.hasOwn(current, segment)
    ) {
      return false;
    }
    current = Reflect.get(current, segment);
  }
  return true;
}

function mergeProps(
  template: Record<string, unknown>,
  provided: Record<string, unknown>
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...template };
  for (const [key, value] of Object.entries(provided)) {
    const base = template[key];
    merged[key] =
      typeof base === "object" &&
      base !== null &&
      !Array.isArray(base) &&
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value)
        ? mergeProps(
            base as Record<string, unknown>,
            value as Record<string, unknown>
          )
        : value;
  }
  return merged;
}

export async function completeReactProps(input: {
  component: string;
  entry: string;
  provided: Record<string, unknown>;
}): Promise<{
  props: Record<string, unknown>;
  synthesizedPaths: string[];
  template: ReactPropsTemplate;
}> {
  const template = await inferReactPropsTemplate(input.entry, input.component);
  return {
    props: mergeProps(template.props, input.provided),
    synthesizedPaths: template.placeholders
      .map((placeholder) => placeholder.path)
      .filter((path) => !hasPath(input.provided, path)),
    template,
  };
}
