import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const executable = resolve(root, "dist/sceneproof");
const directory = mkdtempSync(join(tmpdir(), "sceneproof-compiled-smoke-"));
const output = join(directory, "typed-props.json");

try {
  const result = spawnSync(
    executable,
    [
      "props",
      resolve(root, "tests/fixtures/TypedPropsPanel.tsx"),
      "--export",
      "TypedPropsPanel",
      "--out",
      output,
    ],
    { encoding: "utf8" }
  );
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(output));
  const report = JSON.parse(result.stdout) as {
    command: string;
    component: string;
  };
  assert.equal(report.command, "props");
  assert.equal(report.component, "TypedPropsPanel");
  const props = JSON.parse(readFileSync(output, "utf8")) as {
    model?: { menuStage?: string };
  };
  assert.equal(props.model?.menuStage, "[missing: model.menuStage]");
  process.stdout.write("compiled typed-props smoke passed\n");
} finally {
  rmSync(directory, { force: true, recursive: true });
}
