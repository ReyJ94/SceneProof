import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
  const session = join(directory, "external.session.ts");
  const sessionOutput = join(directory, "session");
  writeFileSync(
    session,
    `import {defineSession,frameClock} from 'sceneproof/session';
    export default defineSession({source:{entry:${JSON.stringify(resolve(root, "tests/fixtures/session-react.tsx"))}},
      viewport:{width:240,height:160},async run(s){await s.frames({id:'compiled',rows:[{index:0,clock:frameClock(0)}]});}});`
  );
  const captured = spawnSync(
    executable,
    ["session", session, "--out", sessionOutput],
    {
      cwd: directory,
      encoding: "utf8",
      env: { ...process.env, SCENEPROOF_HOME: root },
    }
  );
  assert.equal(captured.status, 0, captured.stderr);
  const sessionReport = JSON.parse(captured.stdout);
  assert.equal(sessionReport.provenance.adapter.isFallbackAdapter, false);
  assert.equal(
    JSON.parse(
      readFileSync(join(sessionOutput, "frames/compiled/0.json"), "utf8")
    ).row.index,
    0
  );
  process.stdout.write(
    "compiled external-consumer source session smoke passed\n"
  );
} finally {
  rmSync(directory, { force: true, recursive: true });
}
