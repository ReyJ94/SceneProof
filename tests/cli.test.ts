import { test } from "bun:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const entry = resolve(root, "tests/fixtures/DemoCard.tsx");
const threeEntry = resolve(root, "examples/three/object-gallery.ts");
const invisiblePointsEntry = resolve(root, "tests/fixtures/InvisiblePoints.ts");
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
const STRUCTURAL_REASON = /structural/i;
const SCENEPROOF_USAGE = /Usage: sceneproof/;

type CliResult = {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
};

function runCli(args: readonly string[]): CliResult {
  const result = spawnSync(
    process.execPath,
    [resolve(root, "src/cli.ts"), ...args],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        UISCENE_CHROME_PATH:
          process.env.UISCENE_CHROME_PATH ?? "/usr/bin/google-chrome",
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

test("presents SceneProof through six stable agent-facing commands", () => {
  const result = runCli(["--help"]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, SCENEPROOF_USAGE);
  for (const command of [
    "inspect",
    "tree",
    "node",
    "render",
    "render-region",
    "scout",
  ]) {
    assert.match(result.stdout, new RegExp(`\\b${command}\\b`));
  }
  assert.doesNotMatch(result.stdout, INTERNAL_COMMAND);
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
      "--out",
      output,
    ]);

    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.success, true);
    assert.equal(report.camera.view, "front");
    assert.equal(report.camera.zoom, 3);
    assert.equal(report.camera.elevation, 18);
    assert.equal(report.camera.azimuth, -90);
    assert.equal(report.renderedSize.width, 640);
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
