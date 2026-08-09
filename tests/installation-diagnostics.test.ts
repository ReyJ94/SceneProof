import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { diagnoseInstallation } from "../src/installation-diagnostics.js";

test("installed-bin drift fails readiness with one exact reinstall command", async () => {
  const home = mkdtempSync(join(tmpdir(), "sceneproof-install-drift-"));
  try {
    const staleRoot = join(home, "node_modules/sceneproof");
    const staleEntry = join(staleRoot, "src/cli.ts");
    const binDirectory = join(home, ".bun/bin");
    const bin = join(binDirectory, "sceneproof");
    const globalRoot = join(
      home,
      ".bun/install/global/node_modules/sceneproof"
    );
    mkdirSync(join(staleRoot, "src"), { recursive: true });
    mkdirSync(binDirectory, { recursive: true });
    mkdirSync(globalRoot, { recursive: true });
    writeFileSync(staleEntry, "#!/usr/bin/env bun\n");
    writeFileSync(
      join(staleRoot, "package.json"),
      JSON.stringify({ name: "sceneproof", version: "0.4.0" })
    );
    writeFileSync(
      join(globalRoot, "package.json"),
      JSON.stringify({ name: "sceneproof", version: "0.7.0" })
    );
    symlinkSync(staleEntry, bin);

    const report = await diagnoseInstallation({
      effectiveVersion: "0.8.0",
      home,
      invokedPath: bin,
      modulePath: staleEntry,
      pathEnvironment: binDirectory,
    });

    assert.equal(report.mode, "installed-bin");
    assert.equal(report.ready, false);
    assert.equal(report.consistent, false);
    assert.equal(report.entryPackage?.version, "0.4.0");
    assert.equal(report.bunGlobalPackage.version, "0.7.0");
    assert.equal(report.reinstallCommand, "bun add --global sceneproof@0.8.0");
  } finally {
    rmSync(home, { force: true, recursive: true });
  }
});

test("source checkout drift warns without failing readiness and lists PATH duplicates", async () => {
  const home = mkdtempSync(join(tmpdir(), "sceneproof-source-drift-"));
  try {
    const sourceRoot = join(home, "work/sceneproof");
    const sourceEntry = join(sourceRoot, "src/cli.ts");
    const firstBin = join(home, "first-bin");
    const secondBin = join(home, "second-bin");
    mkdirSync(join(sourceRoot, "src"), { recursive: true });
    mkdirSync(firstBin, { recursive: true });
    mkdirSync(secondBin, { recursive: true });
    writeFileSync(sourceEntry, "#!/usr/bin/env bun\n");
    writeFileSync(
      join(sourceRoot, "package.json"),
      JSON.stringify({ name: "sceneproof", version: "0.7.0" })
    );
    writeFileSync(join(firstBin, "sceneproof"), "first");
    writeFileSync(join(secondBin, "sceneproof"), "second");

    const report = await diagnoseInstallation({
      effectiveVersion: "0.8.0",
      home,
      invokedPath: sourceEntry,
      modulePath: sourceEntry,
      pathEnvironment: [firstBin, secondBin].join(delimiter),
    });

    assert.equal(report.mode, "source-checkout");
    assert.equal(report.ready, true);
    assert.equal(report.consistent, false);
    assert.equal(report.pathCandidates.length, 2);
    assert.ok(report.warnings.some((warning) => warning.includes("Multiple")));
  } finally {
    rmSync(home, { force: true, recursive: true });
  }
});
