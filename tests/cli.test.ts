import { test } from "bun:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const packageVersion = (
  JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
    version: string;
  }
).version;
const entry = resolve(root, "tests/fixtures/DemoCard.tsx");
const threeEntry = resolve(root, "tests/fixtures/KnowledgeGraphScene.ts");
const invisiblePointsEntry = resolve(root, "tests/fixtures/InvisiblePoints.ts");
const advancedSceneEntry = resolve(root, "tests/fixtures/AdvancedScene.ts");
const litIsolateEntry = resolve(root, "tests/fixtures/LitIsolateScene.ts");
const nestedPropsEntry = resolve(root, "tests/fixtures/NestedPropsCard.tsx");
const typedPropsEntry = resolve(root, "tests/fixtures/TypedPropsPanel.tsx");
const staticActionEntry = resolve(root, "tests/fixtures/StaticActionScene.ts");
const darkContrastEntry = resolve(root, "tests/fixtures/DarkContrastScene.ts");
const silhouetteEntry = resolve(root, "tests/fixtures/SilhouetteScene.ts");
const projectedFitEntry = resolve(root, "tests/fixtures/ProjectedFitScene.ts");
const webgpuStandardEntry = resolve(
  root,
  "tests/fixtures/WebGpuStandardScene.ts"
);
const webgpuIncompatibleEntry = resolve(
  root,
  "tests/fixtures/WebGpuIncompatibleScene.ts"
);
const webgpuAddonIncompatibleEntry = resolve(
  root,
  "tests/fixtures/WebGpuAddonIncompatibleScene.ts"
);
const ambiguousReferenceEntry = resolve(
  root,
  "tests/fixtures/AmbiguousReferenceScene.ts"
);
const advancedProps = resolve(root, "tests/fixtures/advanced-props.json");
const actionInput = resolve(root, "tests/fixtures/action-input.json");
const props = resolve(root, "tests/fixtures/props.json");
const INVISIBLE_ATTRIBUTE_WARNING = /aOpacity.*maximum is 0/i;
const INTERNAL_COMMAND =
  /\b(?:hydrate|query-report|browser-start|browser-stop)\b/;
const MUTUALLY_EXCLUSIVE_FOCUS_ERROR =
  /focus-node.*look-at.*mutually exclusive/i;
const MISSING_EXPORT_ERROR = /export.*Missing.*not found/i;
const REGION_EXCEEDS_VIEWPORT_ERROR = /region.*exceeds viewport.*800x600/i;
const SCOUT_DETAIL_COMMAND = /sceneproof render/;
const SCOUT_FOCUS_COMMAND = /--look-at -2\.4,0\.2,0/;
const SHA_256_DIGEST = /^sha256:/;
const MISSING_PROPS_ERROR = /props.*not found|ENOENT/i;
const SOURCE_FRAMING_COMMAND = /--framing source/;
const SOURCE_REGION_COMMAND = /render-region.*--region/;
const TARGET_FRAMING_COMMAND = /--framing (?:fit|fill)/;
const SCALE_FOUR_COMMAND = /--scale 4/;
const DIRECT_COMMAND_GUIDANCE = /direct command/i;
const LOCAL_RENDER_GUIDANCE = /local-render|unsandboxed/i;
const CHROMIUM_PERMISSION_ERROR =
  /Chromium could not start.*unsandboxed\/local-render permission/is;
const STRUCTURAL_REASON = /structural/i;
const SCENEPROOF_USAGE = /Usage: sceneproof/;
const DID_YOU_MEAN_SEMANTIC_FOCUS = /Did you mean three:semantic-focus/i;
const TYPED_PROPS_PANEL_TEXT = /Real title ready 0\s*disabled/;
const REFERENCE_AGENT_REVIEW_REASON = /reference.*current.*agent/i;
const NESTED_PROPS_COMPONENT = /NestedPropsCard/;
const MENU_STAGE_ACCESS = /menuStage/;
const PROPS_FLAG = /--props/;
const TARGET_WAS_LOCATED = /target was located/i;
const LITERAL_FIXTURE_CAMERA = /literal fixture camera/i;
const NO_VISUAL_TRANSITION = /no visual transition/i;
const ZERO_SCENE_OBJECT_MUTATIONS = /mutated 0 scene objects/i;
const EMPTY_CONTEXT_WARNING = /without other renderable scene context/i;
const SURFACE_RANGE_WARNING = /surface.*dynamic range/i;
const MEASUREMENT_NOT_TASTE = /measurement.*not.*taste/i;
const REFERENCE_CONFIDENCE_WARNING = /reference subject.*confidence/i;
const REFERENCE_OPTION_DEPENDENCY = /reference-mask.*require.*reference/i;
const REFERENCE_MASK_DIMENSIONS = /mask dimensions differ.*reference/i;
const COMPETING_REFERENCE_COMPONENTS = /competing.*components/i;
const SWEEP_NO_VISUAL_CHANGE = /sweep.*no adjacent visual change/i;
const SWEEP_FIXTURE_PROP_GUIDANCE = /context\.props|fixture prop/i;
const NOT_A_TASTE_VERDICT = /not a taste verdict/i;
const WEBGPU_COMPATIBILITY_ERROR = /WebGPU compatibility/i;
const GLSL_SUBJECT = /glsl-subject/i;
const SHADER_MATERIAL = /ShaderMaterial/i;
const GLSL_TO_TSL_GUIDANCE = /GLSL.*TSL|TSL.*GLSL/i;
const WEBGL_ONLY_EXPORTS = /WebGL-only Three\.js exports/i;
const WEBGPU_TSL_EQUIVALENT = /WebGPU\/TSL equivalent/i;
const EXPLICIT_WEBGL_BACKEND = /--three-backend webgl/i;
const VISUAL_QUALITY_VERDICT = /visual-quality verdict/i;
const CYAN_MASK_REVIEW = /cyan mask/i;

type CliResult = {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
};

function runCli(
  args: readonly string[],
  environment: Readonly<Record<string, string>> = {}
): CliResult {
  const result = spawnSync(
    process.execPath,
    [resolve(root, "src/cli.ts"), ...args],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        SCENEPROOF_INTERNAL_RAW_REPORT: "1",
        UISCENE_CHROME_PATH:
          process.env.UISCENE_CHROME_PATH ?? "/usr/bin/google-chrome",
        ...environment,
      },
    }
  );

  return {
    status: result.status,
    stderr: result.stderr,
    stdout: result.stdout,
  };
}

function pngSize(path: string): { width: number; height: number } {
  const bytes = readFileSync(path);
  assert.equal(bytes.subarray(1, 4).toString("ascii"), "PNG");
  return {
    height: bytes.readUInt32BE(20),
    width: bytes.readUInt32BE(16),
  };
}

function readFullEvidence(briefing: {
  evidence: { full: { bytes: number; path: string } };
}) {
  assert.ok(existsSync(briefing.evidence.full.path));
  assert.equal(
    statSync(briefing.evidence.full.path).size,
    briefing.evidence.full.bytes
  );
  return JSON.parse(readFileSync(briefing.evidence.full.path, "utf8"));
}

test("presents SceneProof through stable agent-facing commands and diagnostics", () => {
  const result = runCli(["--help"]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, SCENEPROOF_USAGE);
  for (const command of [
    "inspect",
    "tree",
    "node",
    "matrix",
    "sheet",
    "render",
    "render-region",
    "scout",
    "doctor",
  ]) {
    assert.match(result.stdout, new RegExp(`\\b${command}\\b`));
  }
  assert.doesNotMatch(result.stdout, INTERNAL_COMMAND);
});

test("reports the package version through the CLI", () => {
  const result = runCli(["--version"]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), packageVersion);
});

test("routes a selected Three.js factory by contract rather than export name", () => {
  const automatic = runCli([
    "tree",
    advancedSceneEntry,
    "--export",
    "createConfiguredScene",
    "--props",
    advancedProps,
    "--renderer",
    "auto",
    "--width",
    "320",
    "--height",
    "240",
  ]);

  assert.equal(automatic.status, 0, automatic.stderr);
  const tree = JSON.parse(automatic.stdout);
  assert.equal(tree.renderer, "three");
  assert.equal(tree.fixture.props.path, advancedProps);
  assert.match(tree.fixture.props.digest, SHA_256_DIGEST);
  assert.equal(tree.roots[0].id, "three:advanced-fixture");
});

test("loads a reusable inspector from repository-root scripts without an app adapter", () => {
  const repository = mkdtempSync(join(tmpdir(), "sceneproof-repository-"));
  const sourceDirectory = join(repository, "src");
  const inspectorDirectory = join(repository, "scripts/sceneproof");
  const fixtureDirectory = join(inspectorDirectory, "fixtures");
  const productionEntry = join(sourceDirectory, "production-scene.ts");
  const inspectorEntry = join(inspectorDirectory, "gallery.scene.ts");
  const fixture = join(fixtureDirectory, "selected.json");

  try {
    mkdirSync(sourceDirectory, { recursive: true });
    mkdirSync(fixtureDirectory, { recursive: true });
    writeFileSync(
      productionEntry,
      `export { createConfiguredScene } from ${JSON.stringify(advancedSceneEntry)};\n`
    );
    writeFileSync(
      inspectorEntry,
      [
        'import { createConfiguredScene } from "../../src/production-scene";',
        "export const createGalleryEvidence = createConfiguredScene;",
        "",
      ].join("\n")
    );
    writeFileSync(fixture, readFileSync(advancedProps));

    const result = runCli([
      "tree",
      inspectorEntry,
      "--export",
      "createGalleryEvidence",
      "--props",
      fixture,
      "--renderer",
      "auto",
      "--width",
      "640",
      "--height",
      "480",
    ]);

    assert.equal(result.status, 0, result.stderr);
    const tree = JSON.parse(result.stdout);
    assert.equal(tree.renderer, "three");
    assert.equal(tree.fixture.props.path, fixture);
    assert.equal(tree.roots[0].id, "three:advanced-fixture");
  } finally {
    rmSync(repository, { force: true, recursive: true });
  }
});

test("rejects missing Three.js props instead of silently ignoring them", () => {
  const missing = resolve(tmpdir(), "sceneproof-missing-props.json");
  const result = runCli([
    "tree",
    advancedSceneEntry,
    "--export",
    "createScene",
    "--renderer",
    "three",
    "--props",
    missing,
  ]);

  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, MISSING_PROPS_ERROR);
});

test("passes props, fixture actions, and deterministic time to Three.js", () => {
  const result = runCli([
    "node",
    advancedSceneEntry,
    "three:semantic-focus",
    "--export",
    "createConfiguredScene",
    "--renderer",
    "three",
    "--props",
    advancedProps,
    "--action",
    "select",
    "--action-input",
    actionInput,
    "--time",
    "125",
    "--width",
    "320",
    "--height",
    "240",
  ]);

  assert.equal(result.status, 0, result.stderr);
  const detail = JSON.parse(result.stdout);
  assert.equal(detail.renderer, "three");
  assert.deepEqual(detail.fixture.action, {
    inputPath: actionInput,
    name: "select",
  });
  assert.equal(detail.fixture.timeMs, 125);
  assert.equal(detail.node.kind, "SemanticTarget");
  assert.deepEqual(detail.node.focus, [4, 0, 3]);
  assert.equal(detail.node.bounds.worldBox.min[2], 2);
  assert.equal(detail.node.bounds.worldBox.max[2], 4);
  assert.ok(detail.node.bounds.worldBox.min[0] < 3);
  assert.ok(detail.node.bounds.worldBox.max[0] > 5);
  assert.equal(detail.node.selection.memberCount, 1);
  assert.equal(detail.node.drawOwner.id, "three:focus-object");
  assert.equal(detail.node.drawOwner.kind, "Mesh");
  assert.equal(detail.node.drawOwner.geometry.type, "BoxGeometry");
  assert.equal(detail.node.drawOwner.material.type, "MeshBasicMaterial");
  assert.equal(detail.node.drawOwner.material.color, "#f2a65a");
});

test("accepts the bare target ID printed by tree and suggests the canonical ID on misses", () => {
  const accepted = runCli([
    "node",
    advancedSceneEntry,
    "semantic-focus",
    "--export",
    "createConfiguredScene",
    "--renderer",
    "three",
    "--width",
    "320",
    "--height",
    "240",
  ]);

  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(JSON.parse(accepted.stdout).node.id, "three:semantic-focus");

  const missed = runCli([
    "node",
    advancedSceneEntry,
    "semantic-focu",
    "--export",
    "createConfiguredScene",
    "--renderer",
    "three",
    "--width",
    "320",
    "--height",
    "240",
  ]);

  assert.notEqual(missed.status, 0);
  assert.match(missed.stderr, DID_YOU_MEAN_SEMANTIC_FOCUS);
});

test("reports light physics and keeps lights visible after fixture-owned isolation", () => {
  const directory = mkdtempSync(join(tmpdir(), "sceneproof-lit-isolate-"));
  const output = join(directory, "isolated.png");

  try {
    const detail = runCli([
      "node",
      litIsolateEntry,
      "key-light",
      "--export",
      "createScene",
      "--renderer",
      "three",
      "--width",
      "160",
      "--height",
      "120",
    ]);
    assert.equal(detail.status, 0, detail.stderr);
    const light = JSON.parse(detail.stdout).node;
    assert.equal(light.light.type, "DirectionalLight");
    assert.equal(light.light.color, "#ffffff");
    assert.equal(light.light.intensity, 3);
    assert.deepEqual(light.light.position, [2, -3, 4]);
    assert.deepEqual(light.light.target, [0, 0, 0]);

    const rendered = runCli([
      "render",
      litIsolateEntry,
      "subject",
      "--export",
      "createScene",
      "--renderer",
      "three",
      "--isolate",
      "--framing",
      "fit",
      "--stats",
      "--width",
      "160",
      "--height",
      "120",
      "--out",
      output,
    ]);
    assert.equal(rendered.status, 0, rendered.stderr);
    const report = JSON.parse(rendered.stdout);
    assert.ok(report.stats.luminance.max > 0.2);
    assert.equal(report.isolation.lightsPreserved, 1);
    assert.equal(report.context.contextRenderableCount, 0);
    assert.equal(report.context.environmentPresent, false);
    assert.equal(report.context.empty, true);
    assert.ok(report.quality.targetProjectedPixelSize.height > 0);
    assert.ok(report.quality.targetProjectedPixelSize.width > 0);
    assert.match(report.warnings.join("\n"), EMPTY_CONTEXT_WARNING);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("captures declared context and isolation as one attributable scene lifecycle", () => {
  const directory = mkdtempSync(join(tmpdir(), "sceneproof-context-pair-"));
  const output = join(directory, "pair.png");
  try {
    const result = runCli([
      "render",
      litIsolateEntry,
      "subject",
      "--export",
      "createScene",
      "--renderer",
      "three",
      "--framing",
      "fit",
      "--context-pair",
      "--width",
      "160",
      "--height",
      "120",
      "--out",
      output,
    ]);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.command, "render-context-pair");
    assert.deepEqual(report.lifecycle, {
      browserLaunches: 1,
      bundles: 1,
      sceneInstances: 1,
      views: 2,
    });
    assert.equal(report.variants.inContext.context.source, "declared");
    assert.equal(report.variants.inContext.context.contextRenderableCount, 1);
    assert.equal(report.variants.isolated.context.source, "isolated");
    assert.equal(report.variants.isolated.context.contextRenderableCount, 0);
    assert.equal(report.assessment.verdict, "review-required");
    assert.equal(report.assessment.decisionOwner, "agent");
    assert.ok(existsSync(report.artifacts.contactSheet));
    assert.ok(existsSync(report.artifacts.inContext));
    assert.ok(existsSync(report.artifacts.isolated));
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("separates a failed delivery-scale assertion from successful execution", () => {
  const directory = mkdtempSync(join(tmpdir(), "sceneproof-delivery-scale-"));
  const output = join(directory, "delivery.png");
  try {
    const result = runCli([
      "render",
      litIsolateEntry,
      "subject",
      "--export",
      "createScene",
      "--renderer",
      "three",
      "--framing",
      "fit",
      "--delivery-scale",
      "1",
      "--delivery-tolerance",
      "0.05",
      "--width",
      "160",
      "--height",
      "120",
      "--out",
      output,
    ]);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.success, true);
    assert.equal(report.execution.status, "succeeded");
    assert.equal(report.quality.deliveryScale.requestedHeightPx, 1);
    assert.equal(report.quality.deliveryScale.satisfied, false);
    assert.ok(report.quality.deliveryScale.actualHeightPx > 1);
    assert.equal(report.assessment.decisionOwner, "sceneproof-assertion");
    assert.equal(report.assessment.objective, "delivery-scale");
    assert.equal(report.assessment.verdict, "failed");
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("accepts --isolate as a composable no-op alias on scout", () => {
  const directory = mkdtempSync(join(tmpdir(), "sceneproof-scout-isolate-"));
  try {
    const result = runCli([
      "scout",
      advancedSceneEntry,
      "semantic-focus",
      "--export",
      "createConfiguredScene",
      "--renderer",
      "three",
      "--isolate",
      "--width",
      "160",
      "--height",
      "120",
      "--out",
      directory,
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).success, true);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("adds component and props guidance when a React render throws", () => {
  const result = runCli([
    "inspect",
    nestedPropsEntry,
    "--export",
    "NestedPropsCard",
    "--renderer",
    "react",
  ]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, NESTED_PROPS_COMPONENT);
  assert.match(result.stderr, MENU_STAGE_ACCESS);
  assert.match(result.stderr, PROPS_FLAG);
});

test("emits a typed React props skeleton with attributable placeholders", () => {
  const directory = mkdtempSync(join(tmpdir(), "sceneproof-props-template-"));
  const output = join(directory, "typed-props.json");
  try {
    const result = runCli([
      "props",
      typedPropsEntry,
      "--export",
      "TypedPropsPanel",
      "--out",
      output,
    ]);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.command, "props");
    assert.equal(report.component, "TypedPropsPanel");
    assert.equal(report.artifact, output);
    assert.deepEqual(JSON.parse(readFileSync(output, "utf8")), {
      enabled: false,
      labels: [],
      model: {
        menuStage: "[missing: model.menuStage]",
        nested: { count: 0 },
      },
      title: "[missing: title]",
    });
    assert.ok(
      report.placeholders.some(
        (placeholder: { path: string }) =>
          placeholder.path === "model.menuStage"
      )
    );
    assert.ok(
      report.placeholders.some(
        (placeholder: { path: string }) => placeholder.path === "title"
      )
    );
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("completes partial React props without hiding synthesized values", () => {
  const directory = mkdtempSync(join(tmpdir(), "sceneproof-partial-props-"));
  const partial = join(directory, "partial.json");
  writeFileSync(
    partial,
    JSON.stringify({ model: { menuStage: "ready" }, title: "Real title" })
  );
  try {
    const result = runCli([
      "inspect",
      typedPropsEntry,
      "--export",
      "TypedPropsPanel",
      "--renderer",
      "react",
      "--props",
      partial,
      "--partial-props",
    ]);
    assert.equal(result.status, 0, result.stderr);
    const briefing = JSON.parse(result.stdout);
    const scene = readFullEvidence(briefing);
    const panel = scene.nodes.find(
      (node: { id: string }) => node.id === "dom:typed-props-panel"
    );
    assert.match(panel.text, TYPED_PROPS_PANEL_TEXT);
    assert.equal(scene.fixture.propsCompletion.mode, "typed-placeholders");
    assert.deepEqual(scene.fixture.propsCompletion.synthesizedPaths.sort(), [
      "enabled",
      "labels",
      "model.nested.count",
    ]);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("exposes stable instance IDs as frameable semantic targets", () => {
  const result = runCli([
    "node",
    advancedSceneEntry,
    "three:instance-beta",
    "--export",
    "createConfiguredScene",
    "--renderer",
    "three",
    "--width",
    "320",
    "--height",
    "240",
  ]);

  assert.equal(result.status, 0, result.stderr);
  const detail = JSON.parse(result.stdout);
  assert.equal(detail.node.kind, "SemanticTarget");
  assert.equal(detail.node.selection.source, "instances");
  assert.deepEqual(detail.node.bounds.worldBox.min, [13.5, -0.5, -0.5]);
  assert.deepEqual(detail.node.bounds.worldBox.max, [14.5, 0.5, 0.5]);
});

test("preserves the complete source camera when original framing is requested", () => {
  const directory = mkdtempSync(join(tmpdir(), "sceneproof-camera-test-"));
  const before = join(directory, "before.png");
  const during = join(directory, "during.png");

  try {
    const base = [
      "render",
      advancedSceneEntry,
      "three:semantic-focus",
      "--export",
      "createConfiguredScene",
      "--renderer",
      "three",
      "--props",
      advancedProps,
      "--action",
      "select",
      "--action-input",
      actionInput,
      "--view",
      "original",
      "--framing",
      "source",
      "--width",
      "320",
      "--height",
      "240",
    ];
    const first = runCli([...base, "--time", "0", "--out", before]);
    const second = runCli([...base, "--time", "125", "--out", during]);

    assert.equal(first.status, 0, first.stderr);
    assert.equal(second.status, 0, second.stderr);
    const report = JSON.parse(first.stdout);
    assert.equal(report.camera.modified, false);
    assert.match(report.quality.explanation, TARGET_WAS_LOCATED);
    assert.match(report.quality.explanation, LITERAL_FIXTURE_CAMERA);
    assert.deepEqual(report.camera.source.position, [7, -11, 9]);
    assert.deepEqual(report.camera.resolved.position, [7, -11, 9]);
    assert.deepEqual(
      report.camera.resolved.quaternion,
      report.camera.source.quaternion
    );
    assert.notDeepEqual(readFileSync(before), readFileSync(during));
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("compares a current render with an arbitrary prior PNG and localizes the change", () => {
  const directory = mkdtempSync(join(tmpdir(), "sceneproof-compare-"));
  const previous = join(directory, "previous.png");
  const current = join(directory, "current.png");
  const base = [
    "render",
    advancedSceneEntry,
    "semantic-focus",
    "--export",
    "createConfiguredScene",
    "--renderer",
    "three",
    "--props",
    advancedProps,
    "--action",
    "select",
    "--action-input",
    actionInput,
    "--framing",
    "source",
    "--width",
    "320",
    "--height",
    "240",
  ];

  try {
    const before = runCli([...base, "--time", "0", "--out", previous]);
    assert.equal(before.status, 0, before.stderr);
    const after = runCli([
      ...base,
      "--time",
      "125",
      "--compare",
      previous,
      "--out",
      current,
    ]);
    assert.equal(after.status, 0, after.stderr);
    const report = JSON.parse(after.stdout);
    assert.equal(report.comparison.previous, previous);
    assert.equal(report.comparison.classification, "changed");
    assert.ok(report.comparison.changedPixelFraction > 0);
    assert.ok(report.comparison.normalizedRasterDelta > 0);
    assert.ok(report.comparison.changedBounds.width > 0);
    assert.ok(report.comparison.changedBounds.height > 0);
    assert.ok(existsSync(report.comparison.artifacts.sideBySide));
    assert.ok(existsSync(report.comparison.artifacts.difference));
    assert.deepEqual(pngSize(report.comparison.artifacts.difference), {
      height: 240,
      width: 320,
    });
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("extracts target-mask silhouette evidence that distinguishes jagged from smooth contours", () => {
  const directory = mkdtempSync(join(tmpdir(), "sceneproof-silhouette-"));
  const smoothProps = join(directory, "smooth.json");
  const jaggedProps = join(directory, "jagged.json");
  writeFileSync(smoothProps, JSON.stringify({ jagged: false }));
  writeFileSync(jaggedProps, JSON.stringify({ jagged: true }));
  const render = (fixtureProps: string, name: string) =>
    runCli([
      "render",
      silhouetteEntry,
      "subject",
      "--export",
      "createScene",
      "--renderer",
      "three",
      "--props",
      fixtureProps,
      "--framing",
      "fit",
      "--silhouette",
      "--width",
      "240",
      "--height",
      "240",
      "--out",
      join(directory, `${name}.png`),
    ]);

  try {
    const smoothResult = render(smoothProps, "smooth");
    const jaggedResult = render(jaggedProps, "jagged");
    assert.equal(smoothResult.status, 0, smoothResult.stderr);
    assert.equal(jaggedResult.status, 0, jaggedResult.stderr);
    const smooth = JSON.parse(smoothResult.stdout).silhouette;
    const jagged = JSON.parse(jaggedResult.stdout).silhouette;
    assert.equal(smooth.available, true);
    assert.equal(jagged.available, true);
    assert.ok(existsSync(smooth.artifact));
    assert.ok(existsSync(jagged.artifact));
    assert.ok(smooth.areaPixels > 0);
    assert.ok(jagged.areaPixels > 0);
    assert.ok(
      jagged.profile.highFrequencyDirectionReversals >
        smooth.profile.highFrequencyDirectionReversals
    );
    assert.ok(jagged.compactness < smooth.compactness);
    assert.ok(
      jagged.profile.maximumDeviationFromLocalTrendPx >
        smooth.profile.maximumDeviationFromLocalTrendPx
    );
    assert.equal(smooth.profile.splineAlgorithm, "reduced-knot-catmull-rom");
    assert.equal(jagged.profile.splineAlgorithm, "reduced-knot-catmull-rom");
    assert.equal(
      Number.isFinite(smooth.profile.maximumDeviationFromFittedSplinePx),
      true
    );
    assert.ok(
      jagged.profile.maximumDeviationFromFittedSplinePx >
        smooth.profile.maximumDeviationFromFittedSplinePx
    );
    assert.match(jagged.caveat, MEASUREMENT_NOT_TASTE);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("can replace a perspective fixture camera with an orthographic evidence camera", () => {
  const directory = mkdtempSync(join(tmpdir(), "sceneproof-orthographic-"));
  const fixtureProps = join(directory, "smooth.json");
  writeFileSync(fixtureProps, JSON.stringify({ jagged: false }));

  try {
    const result = runCli([
      "render",
      silhouetteEntry,
      "subject",
      "--export",
      "createScene",
      "--renderer",
      "three",
      "--props",
      fixtureProps,
      "--projection",
      "orthographic",
      "--view",
      "front",
      "--framing",
      "fit",
      "--width",
      "240",
      "--height",
      "240",
      "--out",
      join(directory, "orthographic.png"),
    ]);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.camera.source.type, "PerspectiveCamera");
    assert.equal(report.camera.resolved.type, "OrthographicCamera");
    assert.equal(report.camera.projection.requested, "orthographic");
    assert.equal(report.camera.projection.actual, "orthographic");
    assert.equal(report.camera.projection.converted, true);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("fits an orthographic top view to projected target extent", () => {
  const directory = mkdtempSync(join(tmpdir(), "sceneproof-projected-fit-"));

  try {
    const result = runCli([
      "render",
      projectedFitEntry,
      "subject",
      "--export",
      "createScene",
      "--renderer",
      "three",
      "--projection",
      "orthographic",
      "--view",
      "top",
      "--framing",
      "fit",
      "--width",
      "320",
      "--height",
      "320",
      "--out",
      join(directory, "top.png"),
    ]);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.camera.resolved.type, "OrthographicCamera");
    assert.ok(report.quality.targetProjectedCoverage > 0.2);
    assert.ok(report.quality.targetProjectedPixelSize.height > 180);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("puts a copy-ready reference comparison next action on an unassessed render", () => {
  const directory = mkdtempSync(join(tmpdir(), "sceneproof-next-action-"));
  const fixtureProps = join(directory, "smooth.json");
  writeFileSync(fixtureProps, JSON.stringify({ jagged: false }));

  try {
    const result = runCli([
      "render",
      silhouetteEntry,
      "subject",
      "--export",
      "createScene",
      "--renderer",
      "three",
      "--props",
      fixtureProps,
      "--framing",
      "fit",
      "--out",
      join(directory, "current.png"),
    ]);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.assessment.verdict, "not-requested");
    assert.ok(
      report.nextActions.some(
        (action: { command: string; reason: string }) =>
          action.command.includes("--reference <image>") &&
          VISUAL_QUALITY_VERDICT.test(action.reason)
      )
    );
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("normalizes an automatic reference mask and reports paired subject evidence", () => {
  const directory = mkdtempSync(join(tmpdir(), "sceneproof-reference-auto-"));
  const fixtureProps = join(directory, "smooth.json");
  const reference = join(directory, "reference.png");
  const current = join(directory, "current.png");
  writeFileSync(fixtureProps, JSON.stringify({ jagged: false }));
  const base = [
    "render",
    silhouetteEntry,
    "subject",
    "--export",
    "createScene",
    "--renderer",
    "three",
    "--props",
    fixtureProps,
    "--framing",
    "fit",
    "--width",
    "240",
    "--height",
    "240",
  ];

  try {
    const referenceResult = runCli([...base, "--out", reference]);
    assert.equal(referenceResult.status, 0, referenceResult.stderr);
    const currentResult = runCli([
      ...base,
      "--reference",
      reference,
      "--probe",
      "0.5,0.5",
      "--out",
      current,
    ]);
    assert.equal(currentResult.status, 0, currentResult.stderr);
    const report = JSON.parse(currentResult.stdout).reference;
    assert.equal(report.analysisAvailable, true);
    assert.equal(report.mask.method, "automatic");
    assert.ok(report.mask.confidence >= report.mask.minimumConfidence);
    assert.equal(report.alignment.mode, "center-height-preserving-aspect");
    assert.ok(report.alignment.scale > 0);
    assert.deepEqual(Object.keys(report.composition).sort(), [
      "current",
      "delta",
      "reference",
    ]);
    assert.ok(Math.abs(report.composition.delta.center[0]) < 0.01);
    assert.ok(Math.abs(report.composition.delta.center[1]) < 0.01);
    assert.ok(Math.abs(report.composition.delta.size[0]) < 0.01);
    assert.ok(Math.abs(report.composition.delta.size[1]) < 0.01);
    assert.ok(existsSync(report.artifacts.contactSheet));
    assert.ok(existsSync(report.artifacts.difference));
    assert.ok(existsSync(report.artifacts.silhouetteOverlay));
    assert.ok(existsSync(report.artifacts.referenceMask));
    assert.ok(existsSync(report.artifacts.referenceMaskOverlay));
    assert.deepEqual(pngSize(report.artifacts.contactSheet), {
      height: 240,
      width: 720,
    });
    assert.ok(report.silhouette.areaIoU > 0.9);
    assert.equal(report.profile.samples.length, 101);
    assert.ok(report.profile.summary.widthRmseFraction < 0.06);
    assert.ok(report.profile.summary.maximumAbsoluteWidthDeltaFraction < 0.12);
    assert.ok(
      Math.abs(
        report.histograms.current.luminance.p50 -
          report.histograms.reference.luminance.p50
      ) < 0.02
    );
    assert.deepEqual(report.probes[0].normalized, [0.5, 0.5]);
    assert.equal(report.probes[0].current.rgba.length, 4);
    assert.equal(report.probes[0].reference.rgba.length, 4);

    const renderReport = JSON.parse(currentResult.stdout);
    assert.deepEqual(renderReport.execution, {
      meaning: "command-execution-only",
      status: "succeeded",
    });
    assert.equal(renderReport.evidence.status, "judgeable");
    assert.equal(renderReport.assessment.decisionOwner, "agent");
    assert.equal(renderReport.assessment.verdict, "review-required");
    assert.equal(renderReport.assessment.objective, "balanced");
    assert.equal(renderReport.assessment.score > 0, true);
    assert.equal(renderReport.review.required, true);
    assert.ok(
      renderReport.review.artifacts.includes(
        report.artifacts.referenceMaskOverlay
      )
    );
    assert.match(renderReport.review.questions.join("\n"), CYAN_MASK_REVIEW);
    assert.match(
      renderReport.assessment.reasons.join("\n"),
      REFERENCE_AGENT_REVIEW_REASON
    );
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("uses an explicit reference mask for auditable sculptural deltas", () => {
  const directory = mkdtempSync(join(tmpdir(), "sceneproof-reference-mask-"));
  const smoothProps = join(directory, "smooth.json");
  const jaggedProps = join(directory, "jagged.json");
  const reference = join(directory, "reference.png");
  const current = join(directory, "current.png");
  writeFileSync(smoothProps, JSON.stringify({ jagged: false }));
  writeFileSync(jaggedProps, JSON.stringify({ jagged: true }));
  const base = [
    "render",
    silhouetteEntry,
    "subject",
    "--export",
    "createScene",
    "--renderer",
    "three",
    "--framing",
    "fit",
    "--width",
    "240",
    "--height",
    "240",
  ];

  try {
    const referenceResult = runCli([
      ...base,
      "--props",
      smoothProps,
      "--silhouette",
      "--out",
      reference,
    ]);
    assert.equal(referenceResult.status, 0, referenceResult.stderr);
    const referenceReport = JSON.parse(referenceResult.stdout);
    const currentResult = runCli([
      ...base,
      "--props",
      jaggedProps,
      "--reference",
      reference,
      "--reference-mask",
      referenceReport.silhouette.artifact,
      "--probe",
      "0.5,0.5",
      "--out",
      current,
    ]);
    assert.equal(currentResult.status, 0, currentResult.stderr);
    const report = JSON.parse(currentResult.stdout).reference;
    assert.equal(report.analysisAvailable, true);
    assert.equal(report.mask.method, "explicit-mask");
    assert.equal(report.mask.verification, "explicit-needs-review");
    assert.equal(report.mask.audit.componentCount, 1);
    assert.equal(typeof report.mask.audit.borderContactFraction, "number");
    assert.ok(existsSync(report.artifacts.referenceMask));
    assert.ok(existsSync(report.artifacts.referenceMaskOverlay));
    assert.ok(report.silhouette.areaIoU < 0.9);
    assert.equal(report.profile.samples.length, 101);
    assert.ok(report.profile.summary.maximumAbsoluteWidthDeltaFraction > 0);
    assert.ok(report.profile.summary.errorIntervals.length > 0);
    assert.equal(Number.isFinite(report.silhouette.aspectRatio.current), true);
    assert.equal(
      Number.isFinite(report.silhouette.aspectRatio.reference),
      true
    );
    assert.ok(
      Math.abs(
        report.silhouette.aspectRatio.delta -
          (report.silhouette.aspectRatio.current -
            report.silhouette.aspectRatio.reference)
      ) < Number.EPSILON
    );
    assert.equal(
      report.silhouette.tipConvergenceAngle.algorithm,
      "outer-envelope-upper-third-linear-fit"
    );
    assert.equal(
      Number.isFinite(report.silhouette.widestPointHeightFraction.current),
      true
    );
    assert.equal(
      Number.isFinite(report.silhouette.widestPointHeightFraction.reference),
      true
    );
    assert.ok(
      Math.abs(
        report.silhouette.widestPointHeightFraction.delta -
          (report.silhouette.widestPointHeightFraction.current -
            report.silhouette.widestPointHeightFraction.reference)
      ) < Number.EPSILON
    );
    assert.ok(report.probes[0].current.similarColorRun.horizontalPx > 0);
    assert.ok(report.probes[0].reference.similarColorRun.horizontalPx > 0);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("evaluates a labeled multi-view reference set without conflating perspectives", () => {
  const directory = mkdtempSync(join(tmpdir(), "sceneproof-reference-set-"));
  const fixtureProps = join(directory, "smooth.json");
  const hero = join(directory, "hero.png");
  const manifest = join(directory, "references.json");
  writeFileSync(fixtureProps, JSON.stringify({ jagged: false }));
  const base = [
    "render",
    silhouetteEntry,
    "subject",
    "--export",
    "createScene",
    "--renderer",
    "three",
    "--props",
    fixtureProps,
    "--framing",
    "fit",
    "--silhouette",
    "--width",
    "240",
    "--height",
    "240",
  ];

  try {
    const heroResult = runCli([...base, "--out", hero]);
    assert.equal(heroResult.status, 0, heroResult.stderr);
    const heroReport = JSON.parse(heroResult.stdout);
    writeFileSync(
      manifest,
      JSON.stringify({
        references: [
          {
            label: "hero",
            maskPath: heroReport.silhouette.artifact,
            path: hero,
            view: "original",
          },
          {
            label: "front",
            maskPath: heroReport.silhouette.artifact,
            path: hero,
            projection: "orthographic",
            view: "front",
          },
        ],
      })
    );
    const result = runCli([
      "render",
      silhouetteEntry,
      "subject",
      "--export",
      "createScene",
      "--renderer",
      "three",
      "--props",
      fixtureProps,
      "--reference-set",
      manifest,
      "--width",
      "240",
      "--height",
      "240",
      "--out",
      join(directory, "evidence"),
    ]);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.command, "render-reference-set");
    assert.deepEqual(
      report.views.map((view: { label: string }) => view.label),
      ["hero", "front"]
    );
    assert.ok(
      report.views.every(
        (view: { reference: { analysisAvailable: boolean } }) =>
          view.reference.analysisAvailable
      )
    );
    assert.ok(
      report.views.every(
        (view: { reference: { silhouette: { areaIoU: number } } }) =>
          view.reference.silhouette.areaIoU > 0.9
      )
    );
    assert.equal(report.lifecycle.sceneInstances, 2);
    assert.equal(report.lifecycle.browserLaunches, 1);
    assert.equal(report.lifecycle.bundles, 1);
    assert.equal(report.aggregate.analyzedViews, 2);
    assert.equal(report.aggregate.worstView.label, "front");
    assert.ok(existsSync(report.artifacts.contactSheet));
    assert.deepEqual(pngSize(report.artifacts.contactSheet), {
      height: 480,
      width: 960,
    });
    assert.equal(report.views[1].camera.resolved.type, "OrthographicCamera");
    assert.equal(report.success, true);
    assert.equal(report.execution.status, "succeeded");
    assert.equal(report.evidence.status, "judgeable");
    assert.equal(report.assessment.decisionOwner, "agent");
    assert.equal(report.assessment.verdict, "review-required");
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}, 60_000);

test("refuses numeric reference claims when automatic subject confidence is low", () => {
  const directory = mkdtempSync(join(tmpdir(), "sceneproof-reference-low-"));
  const fixtureProps = join(directory, "smooth.json");
  const reference = join(directory, "uniform.png");
  const current = join(directory, "current.png");
  writeFileSync(fixtureProps, JSON.stringify({ jagged: false }));
  writeFileSync(
    reference,
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64"
    )
  );

  try {
    const result = runCli([
      "render",
      silhouetteEntry,
      "subject",
      "--export",
      "createScene",
      "--renderer",
      "three",
      "--props",
      fixtureProps,
      "--framing",
      "fit",
      "--reference",
      reference,
      "--width",
      "240",
      "--height",
      "240",
      "--out",
      current,
    ]);
    assert.equal(result.status, 0, result.stderr);
    const fullReport = JSON.parse(result.stdout);
    assert.equal(fullReport.reference.analysisAvailable, false);
    assert.ok(
      fullReport.reference.mask.confidence <
        fullReport.reference.mask.minimumConfidence
    );
    assert.equal(fullReport.reference.histograms, undefined);
    assert.equal(fullReport.reference.silhouette, undefined);
    assert.ok(existsSync(fullReport.reference.artifacts.contactSheet));
    assert.ok(existsSync(fullReport.reference.artifacts.referenceMask));
    assert.ok(existsSync(fullReport.reference.artifacts.referenceMaskOverlay));
    assert.ok(
      fullReport.nextActions.some((action: { command: string }) =>
        action.command.includes("--reference-mask")
      )
    );
    assert.match(fullReport.warnings.join("\n"), REFERENCE_CONFIDENCE_WARNING);
    assert.deepEqual(fullReport.execution, {
      meaning: "command-execution-only",
      status: "succeeded",
    });
    assert.equal(fullReport.success, true);
    assert.equal(fullReport.evidence.status, "unjudgeable");
    assert.equal(fullReport.assessment.decisionOwner, "agent");
    assert.equal(fullReport.assessment.verdict, "unjudgeable");
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("withholds automatic reference metrics when disconnected subjects compete", () => {
  const directory = mkdtempSync(
    join(tmpdir(), "sceneproof-reference-ambiguous-")
  );
  const reference = join(directory, "reference.png");
  const current = join(directory, "current.png");
  const base = [
    "render",
    ambiguousReferenceEntry,
    "subject",
    "--export",
    "createScene",
    "--renderer",
    "three",
    "--framing",
    "fit",
    "--width",
    "240",
    "--height",
    "240",
  ];

  try {
    const referenceResult = runCli([...base, "--out", reference]);
    assert.equal(referenceResult.status, 0, referenceResult.stderr);
    const result = runCli([
      ...base,
      "--reference",
      reference,
      "--out",
      current,
    ]);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout).reference;
    assert.equal(report.analysisAvailable, false);
    assert.ok(report.mask.confidence < report.mask.minimumConfidence);
    assert.match(report.mask.reason, COMPETING_REFERENCE_COMPONENTS);
    assert.equal(report.mask.verification, "automatic-needs-review");
    const assistedResult = runCli([
      ...base,
      "--reference",
      reference,
      "--reference-foreground-seed",
      "0.28,0.5",
      "--out",
      join(directory, "assisted-current.png"),
    ]);
    assert.equal(assistedResult.status, 0, assistedResult.stderr);
    const assistedReport = JSON.parse(assistedResult.stdout).reference;
    assert.equal(assistedReport.analysisAvailable, true);
    assert.equal(assistedReport.mask.method, "assisted-seeds");
    assert.equal(assistedReport.mask.verification, "assisted-needs-review");
    assert.deepEqual(assistedReport.mask.seeds.foreground, [[0.28, 0.5]]);
    assert.ok(existsSync(assistedReport.artifacts.referenceMaskOverlay));
    const regionResult = runCli([
      ...base,
      "--reference",
      reference,
      "--reference-region",
      "10,10,220,220",
      "--out",
      join(directory, "region-current.png"),
    ]);
    assert.equal(regionResult.status, 0, regionResult.stderr);
    const regionReport = JSON.parse(regionResult.stdout).reference;
    assert.equal(regionReport.analysisAvailable, true);
    assert.equal(regionReport.mask.method, "automatic-region");
    assert.ok(
      regionReport.mask.confidence >= regionReport.mask.minimumConfidence
    );
    assert.ok(regionReport.silhouette.areaIoU > 0.9);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("rejects dependent reference options instead of silently ignoring them", () => {
  const directory = mkdtempSync(join(tmpdir(), "sceneproof-reference-input-"));
  const fixtureProps = join(directory, "smooth.json");
  writeFileSync(fixtureProps, JSON.stringify({ jagged: false }));

  try {
    const result = runCli([
      "render",
      silhouetteEntry,
      "subject",
      "--export",
      "createScene",
      "--renderer",
      "three",
      "--props",
      fixtureProps,
      "--reference-mask",
      join(directory, "mask.png"),
      "--out",
      join(directory, "current.png"),
    ]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, REFERENCE_OPTION_DEPENDENCY);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("rejects a reference mask whose dimensions do not match its image", () => {
  const directory = mkdtempSync(join(tmpdir(), "sceneproof-reference-size-"));
  const fixtureProps = join(directory, "smooth.json");
  const reference = join(directory, "reference.png");
  const wrongMask = join(directory, "wrong-mask.png");
  writeFileSync(fixtureProps, JSON.stringify({ jagged: false }));
  writeFileSync(
    wrongMask,
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64"
    )
  );
  const base = [
    "render",
    silhouetteEntry,
    "subject",
    "--export",
    "createScene",
    "--renderer",
    "three",
    "--props",
    fixtureProps,
    "--framing",
    "fit",
    "--width",
    "240",
    "--height",
    "240",
  ];

  try {
    const referenceResult = runCli([...base, "--out", reference]);
    assert.equal(referenceResult.status, 0, referenceResult.stderr);
    const result = runCli([
      ...base,
      "--reference",
      reference,
      "--reference-mask",
      wrongMask,
      "--out",
      join(directory, "current.png"),
    ]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, REFERENCE_MASK_DIMENSIONS);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("renders a one-variable prop sweep as labeled attributable evidence", () => {
  const directory = mkdtempSync(join(tmpdir(), "sceneproof-sweep-"));
  const fixtureProps = join(directory, "base.json");
  const contactSheet = join(directory, "sweep.png");
  writeFileSync(fixtureProps, JSON.stringify({ jagged: false }));

  try {
    const result = runCli([
      "render",
      silhouetteEntry,
      "subject",
      "--export",
      "createScene",
      "--renderer",
      "three",
      "--props",
      fixtureProps,
      "--framing",
      "fit",
      "--sweep",
      "jagged=false,true",
      "--width",
      "240",
      "--height",
      "240",
      "--out",
      contactSheet,
    ]);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.command, "render-sweep");
    assert.equal(report.sweep.path, "jagged");
    assert.deepEqual(report.sweep.values, [false, true]);
    assert.equal(report.variants.length, 2);
    assert.deepEqual(
      report.variants.map((variant: { label: string }) => variant.label),
      ["jagged=false", "jagged=true"]
    );
    assert.ok(
      report.variants.every((variant: { artifact: string }) =>
        existsSync(variant.artifact)
      )
    );
    assert.equal(report.comparisons[0].classification, "changed");
    assert.ok(report.comparisons[0].changedPixelFraction > 0);
    assert.deepEqual(pngSize(report.artifacts.contactSheet), {
      height: 268,
      width: 480,
    });
    assert.equal(report.lifecycle.sceneInstances, 2);
    assert.equal(report.lifecycle.browserLaunches, 1);
    assert.equal(report.lifecycle.bundles, 1);
    assert.equal(report.success, true);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("ranks reference-aware sweep variants from paired silhouette and luminance evidence", () => {
  const directory = mkdtempSync(join(tmpdir(), "sceneproof-reference-sweep-"));
  const fixtureProps = join(directory, "base.json");
  const reference = join(directory, "reference.png");
  writeFileSync(fixtureProps, JSON.stringify({ jagged: false }));

  try {
    const referenceResult = runCli([
      "render",
      silhouetteEntry,
      "subject",
      "--export",
      "createScene",
      "--renderer",
      "three",
      "--props",
      fixtureProps,
      "--framing",
      "fit",
      "--silhouette",
      "--width",
      "240",
      "--height",
      "240",
      "--out",
      reference,
    ]);
    assert.equal(referenceResult.status, 0, referenceResult.stderr);
    const referenceReport = JSON.parse(referenceResult.stdout);

    const result = runCli([
      "render",
      silhouetteEntry,
      "subject",
      "--export",
      "createScene",
      "--renderer",
      "three",
      "--props",
      fixtureProps,
      "--framing",
      "fit",
      "--sweep",
      "jagged=false,true",
      "--reference",
      reference,
      "--reference-mask",
      referenceReport.silhouette.artifact,
      "--width",
      "240",
      "--height",
      "240",
      "--out",
      join(directory, "sweep.png"),
    ]);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.variants.length, 2);
    assert.ok(
      report.variants.every(
        (variant: { reference?: { analysisAvailable: boolean } }) =>
          variant.reference?.analysisAvailable === true
      )
    );
    assert.ok(
      report.variants[0].referenceFit.score >
        report.variants[1].referenceFit.score
    );
    assert.equal(report.recommendation.index, 0);
    assert.equal(report.recommendation.label, "jagged=false");
    assert.equal(report.recommendation.basis, "highest-reference-fit");
    assert.match(report.recommendation.caveat, NOT_A_TASTE_VERDICT);
    assert.equal(report.lifecycle.sceneInstances, 2);
    assert.equal(report.lifecycle.browserLaunches, 1);
    assert.equal(report.lifecycle.bundles, 1);
    assert.equal(report.success, true);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("scores reference-aware sweeps against an explicit evidence objective", () => {
  const directory = mkdtempSync(join(tmpdir(), "sceneproof-sweep-objective-"));
  const referenceProps = join(directory, "reference.json");
  const baseProps = join(directory, "base.json");
  const reference = join(directory, "reference.png");
  writeFileSync(
    referenceProps,
    JSON.stringify({ brightness: 1, jagged: false })
  );
  writeFileSync(baseProps, JSON.stringify({ brightness: 0.3, jagged: false }));

  try {
    const base = [
      "render",
      silhouetteEntry,
      "subject",
      "--export",
      "createScene",
      "--renderer",
      "three",
      "--framing",
      "fit",
      "--width",
      "240",
      "--height",
      "240",
    ];
    const referenceResult = runCli([
      ...base,
      "--props",
      referenceProps,
      "--silhouette",
      "--out",
      reference,
    ]);
    assert.equal(referenceResult.status, 0, referenceResult.stderr);
    const referenceReport = JSON.parse(referenceResult.stdout);
    const result = runCli([
      ...base,
      "--props",
      baseProps,
      "--reference",
      reference,
      "--reference-mask",
      referenceReport.silhouette.artifact,
      "--sweep",
      "brightness=0.3,1",
      "--sweep-objective",
      "appearance",
      "--out",
      join(directory, "sweep.png"),
    ]);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.sweep.objective, "appearance");
    assert.equal(report.recommendation.value, 1);
    assert.equal(report.variants[1].referenceFit.objective, "appearance");
    assert.ok(
      report.variants[1].referenceFit.score >
        report.variants[0].referenceFit.score
    );
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("marks an ignored sweep prop as a no-op instead of useful evidence", () => {
  const directory = mkdtempSync(join(tmpdir(), "sceneproof-sweep-noop-"));
  const fixtureProps = join(directory, "base.json");
  writeFileSync(fixtureProps, JSON.stringify({ jagged: false }));

  try {
    const result = runCli([
      "render",
      silhouetteEntry,
      "subject",
      "--export",
      "createScene",
      "--renderer",
      "three",
      "--props",
      fixtureProps,
      "--framing",
      "fit",
      "--sweep",
      "unused=1,2",
      "--width",
      "240",
      "--height",
      "240",
      "--out",
      join(directory, "sweep.png"),
    ]);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.comparisons[0].classification, "identical");
    assert.equal(report.sweepability.pathReachability, "no-visual-effect");
    assert.match(report.sweepability.guidance, SWEEP_FIXTURE_PROP_GUIDANCE);
    assert.equal(report.success, true);
    assert.equal(report.execution.status, "succeeded");
    assert.equal(report.evidence.status, "judgeable");
    assert.equal(report.assessment.decisionOwner, "sceneproof-assertion");
    assert.equal(report.assessment.verdict, "failed");
    assert.match(report.warnings.join("\n"), SWEEP_NO_VISUAL_CHANGE);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("Scout recommends source-derived context and bounded detail before higher scale", () => {
  const directory = mkdtempSync(join(tmpdir(), "sceneproof-intent-test-"));

  try {
    const result = runCli([
      "scout",
      advancedSceneEntry,
      "three:semantic-focus",
      "--export",
      "createConfiguredScene",
      "--props",
      advancedProps,
      "--width",
      "320",
      "--height",
      "240",
      "--out",
      directory,
    ]);

    assert.equal(result.status, 0, result.stderr);
    const briefing = JSON.parse(result.stdout);
    assert.equal(briefing.target.granularity, "semantic");
    assert.equal(briefing.diagnosis.limitingFactor, "framing");
    assert.equal(briefing.diagnosis.higherScaleWouldHelp, false);
    assert.match(
      briefing.recommendations.context.command,
      SOURCE_FRAMING_COMMAND
    );
    assert.match(
      briefing.recommendations.sourceDetail.command,
      SOURCE_REGION_COMMAND
    );
    assert.match(
      briefing.recommendations.detail.command,
      TARGET_FRAMING_COMMAND
    );
    assert.doesNotMatch(
      briefing.recommendations.detail.command,
      SCALE_FOUR_COMMAND
    );
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("captures deterministic transition frames in one scene lifecycle", () => {
  const directory = mkdtempSync(join(tmpdir(), "sceneproof-frames-test-"));

  try {
    const result = runCli([
      "render",
      advancedSceneEntry,
      "three:semantic-focus",
      "--export",
      "createConfiguredScene",
      "--renderer",
      "three",
      "--props",
      advancedProps,
      "--action",
      "select",
      "--action-input",
      actionInput,
      "--frames",
      "before,0,125,settled",
      "--view",
      "original",
      "--framing",
      "source",
      "--width",
      "320",
      "--height",
      "240",
      "--out",
      directory,
    ]);

    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.command, "render-frames");
    assert.deepEqual(report.lifecycle, {
      actions: 1,
      browserLaunches: 1,
      bundles: 1,
      frames: 4,
      sceneInstances: 1,
    });
    assert.equal(report.frames.length, 4);
    assert.equal(report.comparisons.length, 3);
    assert.equal(report.quality.motionDetected, true);
    assert.ok(report.action.mutatedObjectCount >= 1);
    assert.ok(
      report.comparisons.some(
        (comparison: { classification: string }) =>
          comparison.classification === "changed"
      )
    );
    for (const comparison of report.comparisons) {
      assert.ok(existsSync(comparison.artifacts.amplifiedDifference));
      assert.ok(statSync(comparison.artifacts.amplifiedDifference).size > 100);
    }
    for (const frame of report.frames) {
      assert.ok(existsSync(frame.artifact));
      assert.ok(statSync(frame.artifact).size > 100);
    }
    assert.ok(existsSync(report.artifacts.contactSheet));
    assert.ok(existsSync(report.artifacts.manifest));
    assert.equal(report.rasterizer.kind, "swiftshader-cpu");
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("fails an action sequence that contains no transition and explains the null result", () => {
  const directory = mkdtempSync(join(tmpdir(), "sceneproof-static-frames-"));
  const contactSheet = join(directory, "transition.png");

  try {
    const result = runCli([
      "render",
      staticActionEntry,
      "subject",
      "--export",
      "createScene",
      "--renderer",
      "three",
      "--action",
      "select",
      "--frames",
      "before,0,settled",
      "--framing",
      "fit",
      "--width",
      "160",
      "--height",
      "120",
      "--out",
      contactSheet,
    ]);

    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.success, true);
    assert.deepEqual(report.execution, {
      meaning: "command-execution-only",
      status: "succeeded",
    });
    assert.equal(report.evidence.status, "judgeable");
    assert.equal(report.assessment.decisionOwner, "sceneproof-assertion");
    assert.equal(report.assessment.verdict, "failed");
    assert.equal(report.quality.motionDetected, false);
    assert.equal(report.action.mutatedObjectCount, 0);
    assert.ok(
      report.comparisons.every(
        (comparison: {
          changedPixelFraction: number;
          classification: string;
          normalizedRasterDelta: number;
        }) =>
          comparison.classification === "identical" &&
          comparison.changedPixelFraction === 0 &&
          comparison.normalizedRasterDelta === 0
      )
    );
    assert.ok(
      report.comparisons.every(
        (comparison: { artifacts: { amplifiedDifference: string } }) =>
          existsSync(comparison.artifacts.amplifiedDifference)
      )
    );
    assert.match(report.warnings.join("\n"), NO_VISUAL_TRANSITION);
    assert.match(report.warnings.join("\n"), ZERO_SCENE_OBJECT_MUTATIONS);
    assert.equal(report.artifacts.contactSheet, contactSheet);
    assert.notEqual(report.artifacts.directory, contactSheet);
    assert.ok(report.artifacts.directory.endsWith("transition-frames"));
    assert.ok(existsSync(contactSheet));
    assert.ok(existsSync(report.artifacts.manifest));
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("marks a flat target surface unjudgeable while preserving its silhouette evidence", () => {
  const directory = mkdtempSync(join(tmpdir(), "sceneproof-flat-surface-"));
  const output = join(directory, "flat.png");
  try {
    const result = runCli([
      "render",
      staticActionEntry,
      "subject",
      "--export",
      "createScene",
      "--renderer",
      "three",
      "--framing",
      "fit",
      "--stats",
      "--width",
      "160",
      "--height",
      "120",
      "--out",
      output,
    ]);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.quality.judgeable, true);
    assert.equal(report.quality.surfaceJudgeable, false);
    assert.deepEqual(report.execution, {
      meaning: "command-execution-only",
      status: "succeeded",
    });
    assert.equal(report.evidence.status, "partially-judgeable");
    assert.equal(report.evidence.claims.framing, "judgeable");
    assert.equal(report.evidence.claims.surface, "unjudgeable");
    assert.equal(report.assessment.verdict, "not-requested");
    assert.ok(
      report.quality.surfaceLuminanceSpread <
        report.quality.surfaceLuminanceThreshold
    );
    assert.equal(
      report.stats.luminance.p10 <= report.stats.luminance.p50,
      true
    );
    assert.match(report.warnings.join("\n"), SURFACE_RANGE_WARNING);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("doctor reports Chromium and WebGL readiness with actionable execution guidance", () => {
  const result = runCli(["doctor"]);

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.success, true);
  assert.equal(report.checks.chromiumFound, true);
  assert.equal(report.checks.browserLaunched, true);
  assert.equal(report.checks.webglAvailable, true);
  assert.equal(report.checks.webgpuAvailable, true);
  assert.equal(report.webgpu.adapter.available, true);
  assert.equal(report.webgpu.rendered, true);
  assert.equal(report.webgpu.renderError, null);
  assert.equal(typeof report.webgpu.adapter.isFallbackAdapter, "boolean");
  assert.ok(
    ["software-cpu", "swiftshader-cpu"].includes(report.rasterizer.kind)
  );
  assert.match(report.executionGuidance, DIRECT_COMMAND_GUIDANCE);
  assert.match(report.executionGuidance, LOCAL_RENDER_GUIDANCE);
});

test("doctor can require both graphics backends explicitly", () => {
  const result = runCli(["doctor", "--require-backend", "both"]);

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.requiredBackend, "both");
  assert.equal(report.requirementMet, true);
  assert.equal(report.checks.webglAvailable, true);
  assert.equal(report.checks.webgpuAvailable, true);
});

test("renders a built-in Three.js material on actual WebGPU with explicit backend provenance", () => {
  const directory = mkdtempSync(join(tmpdir(), "sceneproof-webgpu-standard-"));
  const output = join(directory, "webgpu.png");

  try {
    const result = runCli([
      "render",
      webgpuStandardEntry,
      "webgpu-subject",
      "--export",
      "createScene",
      "--renderer",
      "three",
      "--three-backend",
      "webgpu",
      "--framing",
      "source",
      "--stats",
      "--width",
      "640",
      "--height",
      "480",
      "--out",
      output,
    ]);

    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.graphics.requested, "webgpu");
    assert.equal(report.graphics.renderer, "WebGPURenderer");
    assert.equal(report.graphics.actual, "webgpu");
    assert.equal(report.graphics.fallback, false);
    assert.equal(report.graphics.adapter.available, true);
    assert.equal(report.quality.judgeable, true);
    assert.ok(report.stats.coverageFraction > 0);
    assert.ok(statSync(output).size > 0);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("captures WebGPU timeline frames through direct GPU readback", () => {
  const directory = mkdtempSync(join(tmpdir(), "sceneproof-webgpu-frames-"));
  const output = join(directory, "frames");

  try {
    const result = runCli([
      "render",
      staticActionEntry,
      "subject",
      "--export",
      "createScene",
      "--renderer",
      "three",
      "--three-backend",
      "webgpu",
      "--action",
      "select",
      "--frames",
      "before,0,settled",
      "--width",
      "128",
      "--height",
      "96",
      "--out",
      output,
    ]);

    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.graphics.actual, "webgpu");
    assert.equal(report.graphics.fallback, false);
    assert.equal(report.frames.length, 3);
    assert.equal(report.comparisons.length, 2);
    assert.equal(report.comparisons[0].classification, "identical");
    for (const frame of report.frames) {
      assert.ok(statSync(frame.artifact).size > 0);
    }
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("captures WebGPU regions through direct GPU readback", () => {
  const directory = mkdtempSync(join(tmpdir(), "sceneproof-webgpu-region-"));
  const output = join(directory, "region.png");

  try {
    const result = runCli([
      "render-region",
      webgpuStandardEntry,
      "--export",
      "createScene",
      "--renderer",
      "three",
      "--three-backend",
      "webgpu",
      "--region",
      "0,0,160,120",
      "--width",
      "320",
      "--height",
      "240",
      "--stats",
      "--out",
      output,
    ]);

    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.graphics.actual, "webgpu");
    assert.equal(report.graphics.fallback, false);
    assert.ok(report.stats.coverageFraction > 0);
    assert.ok(statSync(output).size > 0);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("uses WebGPU readback for Scout candidates", () => {
  const directory = mkdtempSync(join(tmpdir(), "sceneproof-webgpu-scout-"));

  try {
    const result = runCli([
      "scout",
      webgpuStandardEntry,
      "webgpu-subject",
      "--export",
      "createScene",
      "--renderer",
      "three",
      "--three-backend",
      "webgpu",
      "--width",
      "120",
      "--height",
      "90",
      "--out",
      directory,
    ]);

    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.graphics.actual, "webgpu");
    assert.equal(report.graphics.fallback, false);
    assert.equal(report.evidence.claims.framing, "judgeable");
    assert.ok(statSync(report.artifacts.contactSheet).size > 0);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("keeps WebGL as the default Three.js backend", () => {
  const directory = mkdtempSync(join(tmpdir(), "sceneproof-webgl-default-"));
  const output = join(directory, "webgl.png");

  try {
    const result = runCli([
      "render",
      webgpuStandardEntry,
      "webgpu-subject",
      "--export",
      "createScene",
      "--renderer",
      "three",
      "--framing",
      "fit",
      "--width",
      "160",
      "--height",
      "120",
      "--out",
      output,
    ]);

    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.graphics.requested, "webgl");
    assert.equal(report.graphics.renderer, "WebGLRenderer");
    assert.equal(report.graphics.actual, "webgl");
    assert.equal(report.graphics.fallback, false);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("refuses GLSL-only materials on WebGPU instead of emitting partial evidence", () => {
  const directory = mkdtempSync(
    join(tmpdir(), "sceneproof-webgpu-incompatible-")
  );
  const output = join(directory, "must-not-exist.png");

  try {
    const result = runCli([
      "render",
      webgpuIncompatibleEntry,
      "glsl-subject",
      "--export",
      "createScene",
      "--renderer",
      "three",
      "--three-backend",
      "webgpu",
      "--framing",
      "fit",
      "--width",
      "160",
      "--height",
      "120",
      "--out",
      output,
    ]);

    assert.notEqual(result.status, 0);
    assert.equal(existsSync(output), false);
    assert.match(result.stderr, WEBGPU_COMPATIBILITY_ERROR);
    assert.match(result.stderr, GLSL_SUBJECT);
    assert.match(result.stderr, SHADER_MATERIAL);
    assert.match(result.stderr, GLSL_TO_TSL_GUIDANCE);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("explains WebGL-only addon imports that cannot bundle for WebGPU", () => {
  const directory = mkdtempSync(
    join(tmpdir(), "sceneproof-webgpu-addon-incompatible-")
  );
  const output = join(directory, "must-not-exist.png");

  try {
    const result = runCli([
      "render",
      webgpuAddonIncompatibleEntry,
      "scene",
      "--export",
      "createScene",
      "--renderer",
      "three",
      "--three-backend",
      "webgpu",
      "--out",
      output,
    ]);

    assert.notEqual(result.status, 0);
    assert.equal(existsSync(output), false);
    assert.match(result.stderr, WEBGPU_COMPATIBILITY_ERROR);
    assert.match(result.stderr, WEBGL_ONLY_EXPORTS);
    assert.match(result.stderr, WEBGPU_TSL_EQUIVALENT);
    assert.match(result.stderr, EXPLICIT_WEBGL_BACKEND);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("browser launch failure exits non-zero with local-render permission guidance", () => {
  const result = runCli(["doctor"], {
    SCENEPROOF_CHROME_PATH: "/bin/false",
  });

  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, CHROMIUM_PERMISSION_ERROR);
});

test("inspect rebuilds source into a deterministic structural scene", () => {
  const command = [
    "inspect",
    entry,
    "--export",
    "DemoCard",
    "--props",
    props,
    "--width",
    "800",
    "--height",
    "600",
  ];

  const first = runCli(command);
  assert.equal(first.status, 0, first.stderr);
  const second = runCli(command);
  assert.equal(second.status, 0, second.stderr);

  const firstBriefing = JSON.parse(first.stdout);
  const secondBriefing = JSON.parse(second.stdout);
  assert.equal(firstBriefing.command, "inspect");
  assert.equal(firstBriefing.presentation, "brief");
  assert.equal(firstBriefing.nodeCount, 4);
  assert.deepEqual(firstBriefing.rootIds, ["dom:demo-card"]);
  assert.deepEqual(firstBriefing.warnings, []);
  assert.equal("nodes" in firstBriefing, false);
  assert.ok(Buffer.byteLength(first.stdout) < 2500);
  assert.ok(
    firstBriefing.evidence.full.bytes > Buffer.byteLength(first.stdout)
  );

  const firstScene = readFullEvidence(firstBriefing);
  const secondScene = readFullEvidence(secondBriefing);
  assert.deepEqual(firstScene.rootIds, ["dom:demo-card"]);
  assert.deepEqual(secondScene.rootIds, firstScene.rootIds);
  assert.deepEqual(
    secondScene.nodes.map((node: { id: string }) => node.id),
    firstScene.nodes.map((node: { id: string }) => node.id)
  );

  const card = firstScene.nodes.find(
    (node: { id: string }) => node.id === "dom:demo-card"
  );
  assert.ok(card);
  assert.equal(card.kind, "element");
  assert.equal(card.tag, "section");
  assert.equal(card.bounds.width, 320);
  assert.ok(card.bounds.height > 0);
  assert.equal(card.styles.display, "flex");
  assert.equal(card.styles.flexDirection, "column");
  assert.equal(card.styles.padding, "20px");
  assert.equal(card.styles.borderRadius, "16px");
  assert.equal(card.text, "Structural UI Continue");
});

test("inspect rejects a missing export without producing a scene", () => {
  const result = runCli(["inspect", entry, "--export", "Missing"]);

  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, MISSING_EXPORT_ERROR);
});

test("inspect exposes exact Three.js attribute ranges and warns about zero-opacity geometry", () => {
  const result = runCli([
    "inspect",
    invisiblePointsEntry,
    "--export",
    "createScene",
  ]);

  assert.equal(result.status, 0, result.stderr);
  const briefing = JSON.parse(result.stdout);
  assert.match(briefing.warnings.join("\n"), INVISIBLE_ATTRIBUTE_WARNING);
  const scene = readFullEvidence(briefing);
  const points = scene.nodes.find(
    (node: { id: string }) => node.id === "three:invisible-point-cloud"
  );
  assert.ok(points);
  assert.deepEqual(points.geometry.attributes.aOpacity.range, {
    max: 0,
    min: 0,
  });
  assert.deepEqual(points.geometry.attributes.position.range, {
    max: 1,
    min: -1,
  });
  assert.equal(points.material.uniforms.uOpacity, 0.5);
  assert.equal(points.material.uniforms.uTint, "#8d82ac");
  assert.equal(points.material.depthWrite, true);
  assert.match(scene.warnings.join("\n"), INVISIBLE_ATTRIBUTE_WARNING);
});

test("render reruns source at the requested device scale", () => {
  const directory = mkdtempSync(join(tmpdir(), "uiscene-test-"));
  const output = join(directory, "card.png");

  try {
    const result = runCli([
      "render",
      entry,
      "dom:demo-card",
      "--export",
      "DemoCard",
      "--props",
      props,
      "--width",
      "800",
      "--height",
      "600",
      "--scale",
      "3",
      "--out",
      output,
    ]);

    assert.equal(result.status, 0, result.stderr);
    assert.ok(existsSync(output));
    assert.ok(statSync(output).size > 100);

    const report = JSON.parse(result.stdout);
    assert.equal(report.success, true);
    assert.equal(report.nodeId, "dom:demo-card");
    assert.equal(report.scale, 3);
    assert.equal(
      report.renderedSize.width,
      report.logicalSize.width * report.scale
    );
    assert.equal(
      report.renderedSize.height,
      report.logicalSize.height * report.scale
    );
    assert.deepEqual(pngSize(output), report.renderedSize);
    assert.deepEqual(report.checks, {
      boundsValid: true,
      exportFound: true,
      moduleLoaded: true,
      outputNonempty: true,
      requestedScaleAchieved: true,
      targetFound: true,
    });
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("render accepts a model-chosen scale above an arbitrary preset ceiling", () => {
  const directory = mkdtempSync(join(tmpdir(), "uiscene-scale-test-"));
  const output = join(directory, "tiny-mark.png");

  try {
    const result = runCli([
      "render",
      resolve(root, "tests/fixtures/TinyMark.tsx"),
      "dom:tiny-mark",
      "--export",
      "TinyMark",
      "--width",
      "64",
      "--height",
      "64",
      "--scale",
      "24",
      "--out",
      output,
    ]);

    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.success, true);
    assert.equal(report.scale, 24);
    assert.deepEqual(report.logicalSize, { height: 8, width: 8 });
    assert.deepEqual(report.renderedSize, { height: 192, width: 192 });
    assert.deepEqual(pngSize(output), report.renderedSize);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("render-region rebuilds a selected React patch from source at the requested scale", () => {
  const directory = mkdtempSync(join(tmpdir(), "uiscene-region-test-"));
  const output = join(directory, "react-region.png");

  try {
    const result = runCli([
      "render-region",
      entry,
      "--export",
      "DemoCard",
      "--props",
      props,
      "--width",
      "800",
      "--height",
      "600",
      "--region",
      "8,8,40,30",
      "--scale",
      "6",
      "--out",
      output,
    ]);

    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.success, true);
    assert.deepEqual(report.region, {
      height: 30,
      width: 40,
      x: 8,
      y: 8,
    });
    assert.deepEqual(report.renderedSize, { height: 180, width: 240 });
    assert.deepEqual(pngSize(output), report.renderedSize);
    assert.equal(report.checks.regionValid, true);
    assert.equal(report.checks.requestedScaleAchieved, true);
    assert.equal(report.execution.status, "succeeded");
    assert.equal(report.evidence.status, "judgeable");
    assert.equal(report.assessment.decisionOwner, "agent");
    assert.equal(report.assessment.verdict, "review-required");
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("render-region rebuilds a Three.js camera patch instead of cropping an old canvas", () => {
  const directory = mkdtempSync(join(tmpdir(), "uiscene-three-region-test-"));
  const output = join(directory, "three-region.png");

  try {
    const result = runCli([
      "render-region",
      threeEntry,
      "--export",
      "createScene",
      "--width",
      "320",
      "--height",
      "240",
      "--region",
      "80,60,160,120",
      "--scale",
      "4",
      "--stats",
      "--out",
      output,
    ]);

    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.success, true);
    assert.deepEqual(report.region, {
      height: 120,
      width: 160,
      x: 80,
      y: 60,
    });
    assert.deepEqual(report.renderedSize, { height: 480, width: 640 });
    assert.deepEqual(pngSize(output), report.renderedSize);
    assert.equal(report.checks.regionValid, true);
    assert.equal(report.checks.requestedScaleAchieved, true);
    assert.equal(report.rasterizer.kind, "swiftshader-cpu");
    assert.ok(report.stats.coverageFraction > 0);
    assert.ok(report.stats.luminance.p99 >= report.stats.luminance.p90);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("render gives an agent explicit target perspective and camera zoom controls", () => {
  const directory = mkdtempSync(join(tmpdir(), "uiscene-three-view-test-"));
  const output = join(directory, "three-view.png");

  try {
    const result = runCli([
      "render",
      threeEntry,
      "three:collection",
      "--export",
      "createScene",
      "--width",
      "320",
      "--height",
      "240",
      "--view",
      "front",
      "--zoom",
      "3",
      "--scale",
      "2",
      "--stats",
      "--out",
      output,
    ]);

    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.success, true);
    assert.equal(report.camera.view, "front");
    assert.equal(report.camera.zoom, 3);
    assert.equal(report.camera.elevation, 0);
    assert.equal(report.camera.azimuth, -90);
    assert.equal(report.renderedSize.width, 640);
    assert.equal(report.rasterizer.kind, "swiftshader-cpu");
    assert.equal(report.quality.judgeable, true);
    assert.equal(report.quality.limitingFactor, null);
    assert.ok(report.stats.coverageFraction > 0);
    assert.ok(report.stats.luminance.max > report.stats.background.luminance);
    assert.deepEqual(pngSize(output), report.renderedSize);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("scout builds one ranked multi-view evidence set around a semantic focus node", () => {
  const directory = mkdtempSync(join(tmpdir(), "uiscene-scout-test-"));

  try {
    const result = runCli([
      "scout",
      threeEntry,
      "three:collection",
      "--export",
      "createScene",
      "--width",
      "240",
      "--height",
      "180",
      "--focus-node",
      "three:featured-model",
      "--out",
      directory,
    ]);

    assert.equal(result.status, 0, result.stderr);
    const briefing = JSON.parse(result.stdout);
    assert.equal(briefing.command, "scout");
    assert.equal(briefing.presentation, "brief");
    assert.equal(briefing.success, true);
    assert.equal(briefing.execution.status, "succeeded");
    assert.equal(briefing.evidence.status, "judgeable");
    assert.equal(briefing.assessment.decisionOwner, "agent");
    assert.equal(briefing.assessment.verdict, "review-required");
    assert.deepEqual(briefing.lifecycle, {
      browserLaunches: 1,
      bundles: 1,
      sceneInstances: 1,
    });
    assert.deepEqual(briefing.focus, {
      nodeId: "three:featured-model",
      source: "node",
      worldPosition: [-2.4, 0.2, 0],
    });
    assert.equal(briefing.target.id, "three:collection");
    assert.equal(briefing.candidates.total, 13);
    assert.equal(briefing.candidates.shown.length, 3);
    assert.equal(briefing.candidates.omitted, 10);
    assert.ok(Buffer.byteLength(result.stdout) < 4000);
    for (const candidate of briefing.candidates.shown) {
      assert.deepEqual(
        Object.keys(candidate).sort(),
        [
          "clippedEdges",
          "id",
          "score",
          "targetCoverage",
          "view",
          "visiblePixelFraction",
          "zoom",
        ].sort()
      );
    }
    const report = readFullEvidence(briefing);
    assert.ok(report.candidates.length >= 13);
    assert.deepEqual(
      [
        ...new Set(
          report.candidates.map((candidate: { view: string }) => candidate.view)
        ),
      ].sort(),
      ["front", "isometric", "original", "side", "top"]
    );
    assert.ok(
      report.candidates.some(
        (candidate: { view: string; zoom: number }) =>
          candidate.view === "front" && candidate.zoom === 8
      )
    );
    for (const candidate of report.candidates) {
      assert.ok(candidate.metrics.backgroundFraction >= 0);
      assert.ok(candidate.metrics.backgroundFraction <= 1);
      assert.ok(candidate.metrics.targetCoverage >= 0);
      assert.ok(candidate.metrics.targetCoverage <= 1);
      assert.ok(candidate.metrics.visiblePixelFraction >= 0);
      assert.ok(candidate.metrics.visiblePixelFraction <= 1);
      assert.ok(candidate.timingsMs.render >= 0);
    }
    assert.ok(
      report.candidates.some(
        (candidate: { metrics: { clippedEdges: string[] } }) =>
          candidate.metrics.clippedEdges.length > 0
      )
    );
    assert.ok(
      report.candidates.some(
        (candidate: { metrics: { targetCoverage: number } }) =>
          candidate.metrics.targetCoverage > 0.1
      )
    );
    assert.ok(briefing.recommended.candidateId);
    assert.match(briefing.recommended.detailCommand, SCOUT_DETAIL_COMMAND);
    assert.match(briefing.recommended.detailCommand, SCOUT_FOCUS_COMMAND);
    assert.ok(existsSync(report.artifacts.contactSheet));
    assert.ok(existsSync(report.artifacts.report));
    assert.ok(existsSync(report.artifacts.structure));
    assert.ok(pngSize(report.artifacts.contactSheet).width > 240);
    const persisted = JSON.parse(readFileSync(report.artifacts.report, "utf8"));
    assert.equal(
      persisted.recommended.candidateId,
      briefing.recommended.candidateId
    );
    const structure = JSON.parse(
      readFileSync(report.artifacts.structure, "utf8")
    );
    assert.ok(
      structure.nodes.some(
        (node: { id: string }) => node.id === "three:collection"
      )
    );
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("scout keeps structural invisibility visible instead of recommending brute-force scale", () => {
  const directory = mkdtempSync(
    join(tmpdir(), "uiscene-invisible-scout-test-")
  );

  try {
    const result = runCli([
      "scout",
      invisiblePointsEntry,
      "three:invisible-point-cloud",
      "--export",
      "createScene",
      "--width",
      "160",
      "--height",
      "120",
      "--out",
      directory,
    ]);

    assert.equal(result.status, 0, result.stderr);
    const briefing = JSON.parse(result.stdout);
    assert.match(briefing.warnings.join("\n"), INVISIBLE_ATTRIBUTE_WARNING);
    assert.equal(briefing.recommended.detailCommand, null);
    const report = readFullEvidence(briefing);
    assert.ok(
      report.candidates.every(
        (candidate: { metrics: { visiblePixelFraction: number } }) =>
          candidate.metrics.visiblePixelFraction < 0.02
      )
    );
    assert.match(report.recommended.reason.join("\n"), STRUCTURAL_REASON);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("scout identifies a framed dark target as contrast-limited instead of framing-limited", () => {
  const directory = mkdtempSync(join(tmpdir(), "sceneproof-dark-scout-"));
  try {
    const result = runCli([
      "scout",
      darkContrastEntry,
      "subject",
      "--export",
      "createScene",
      "--renderer",
      "three",
      "--width",
      "160",
      "--height",
      "120",
      "--out",
      directory,
    ]);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.diagnosis.limitingFactor, "contrast");
    assert.equal(report.diagnosis.higherScaleWouldHelp, false);
    assert.equal(report.rasterizer.kind, "swiftshader-cpu");
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("scout rejects competing semantic and coordinate focus sources", () => {
  const result = runCli([
    "scout",
    threeEntry,
    "three:collection",
    "--export",
    "createScene",
    "--focus-node",
    "three:featured-model",
    "--look-at",
    "0,0,0",
  ]);

  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, MUTUALLY_EXCLUSIVE_FOCUS_ERROR);
});

test("render-region rejects a patch that exceeds the logical viewport", () => {
  const result = runCli([
    "render-region",
    entry,
    "--export",
    "DemoCard",
    "--props",
    props,
    "--width",
    "800",
    "--height",
    "600",
    "--region",
    "790,590,20,20",
    "--scale",
    "8",
  ]);

  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, REGION_EXCEEDS_VIEWPORT_ERROR);
});
