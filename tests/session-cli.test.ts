import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { file, sleep, spawn } from "bun";
import { loadSessionModule } from "../src/session-loader.js";
import { digest } from "../src/session-store.js";
import { loadSourceOverlays } from "../src/source-overlays.js";

const owned: string[] = [];
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "sceneproof-session-cli-"));
  owned.push(path);
  return path;
}
afterEach(async () => {
  await Promise.all(
    owned.splice(0).map((path) => rm(path, { force: true, recursive: true }))
  );
});
async function cli(args: string[]) {
  const child = spawn(
    [process.execPath, "--no-env-file", resolve("src/cli.ts"), ...args],
    { stderr: "pipe", stdout: "pipe" }
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stderr, stdout };
}
test("the external module loader preserves helper origins and pins transitive source changes", async () => {
  const root = await directory();
  const helper = join(root, "helper.ts");
  const entry = join(root, "entry.ts");
  await writeFile(
    helper,
    "export const origin=import.meta.dir; export const value=1;"
  );
  await writeFile(
    entry,
    "export {origin,value} from './helper'; export {defineSession} from 'sceneproof/session'; export {defineReactFixture} from 'sceneproof/react';"
  );
  const first = await loadSessionModule(entry);
  expect(first.module.origin).toBe(root);
  expect(typeof first.module.defineSession).toBe("function");
  expect(typeof first.module.defineReactFixture).toBe("function");
  await writeFile(
    helper,
    "export const origin=import.meta.dir; export const value=2;"
  );
  const second = await loadSessionModule(entry);
  expect(second.module.value).toBe(2);
  expect(second.bundleDigest).not.toBe(first.bundleDigest);
});
test("session command executes the public module and records gate adapter/ICD provenance", async () => {
  const out = join(await directory(), "run");
  const result = await cli([
    "session",
    "tests/fixtures/session-source.session.ts",
    "--out",
    out,
  ]);
  expect(result.code).toBe(0);
  const report = JSON.parse(result.stdout);
  expect(report.provenance.VK_DRIVER_FILES).toBe(
    process.env.VK_DRIVER_FILES ?? null
  );
  expect(report.provenance.adapter.isFallbackAdapter).toBe(false);
  expect(
    JSON.parse(await readFile(join(out, "frames/source-rows/2.json"), "utf8"))
      .row.index
  ).toBe(2);
});
test("external checkout imports the installed public session API without a local dependency or symlink", async () => {
  const root = await directory();
  const entry = join(root, "external.session.ts");
  const fixture = resolve("tests/fixtures/session-react.tsx");
  await writeFile(
    entry,
    `import {defineSession,frameClock} from 'sceneproof/session';
    export default defineSession({source:{entry:${JSON.stringify(fixture)}}, viewport:{width:240,height:160},
      async run(s){await s.frames({id:'external',rows:[{index:0,clock:frameClock(0)}]});}});`
  );
  const result = await cli(["session", entry, "--out", join(root, "run")]);
  expect(result.stderr).toBe("");
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout).provenance.adapter.isFallbackAdapter).toBe(
    false
  );
});
test("SIGINT closes the session browser and its owned loopback server", async () => {
  const root = await directory();
  const entry = join(root, "interrupt.session.ts");
  const marker = join(root, "running.json");
  const html = resolve("tests/fixtures/session-page.html");
  await writeFile(
    entry,
    `import {defineSession} from 'sceneproof/session';
    import {serve,file} from 'bun'; import {writeFile} from 'node:fs/promises';
    export default defineSession({page:{async start(){const server=serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response(file(${JSON.stringify(html)}))});
      return {url:server.url.href,sourcePins:{},dispose(){server.stop(true)}};}},
      ready:s=>s.ready(()=>globalThis.__pageReady===true),
      async run(s){await writeFile(${JSON.stringify(marker)},JSON.stringify({url:s.page.url(),signals:process.listenerCount('SIGINT')}));await s.ready(()=>false);}});`
  );
  const out = join(root, "run");
  const child = spawn(
    [
      process.execPath,
      "--no-env-file",
      resolve("src/cli.ts"),
      "session",
      entry,
      "--out",
      out,
    ],
    { stderr: "pipe", stdout: "pipe" }
  );
  const output = Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  try {
    // biome-ignore lint/performance/noAwaitInLoops: Wait for the owned lifecycle boundary, not a fixed timeout.
    while (!(await file(marker).exists())) {
      await Promise.race([
        sleep(10),
        child.exited.then(() => {
          throw new Error("Session exited before its interrupt boundary");
        }),
      ]);
    }
    const { url, signals } = JSON.parse(await readFile(marker, "utf8"));
    expect(signals).toBeGreaterThan(0);
    child.kill("SIGINT");
    expect(await child.exited).not.toBe(0);
    const logs = await output;
    const attempts = await readdir(join(out, "attempts"));
    const [attempt] = attempts;
    if (!attempt) {
      throw new Error("No session cleanup attempt was recorded");
    }
    if (
      !(await file(join(out, "attempts", attempt, "cleanup.json")).exists())
    ) {
      throw new Error(
        `No interrupt cleanup receipt; CLI output ${JSON.stringify(logs)}`
      );
    }
    const cleanup = JSON.parse(
      await readFile(join(out, "attempts", attempt, "cleanup.json"), "utf8")
    );
    expect(cleanup.browserClosed).toBe(true);
    expect(cleanup.ownedServerDisposed).toBe(true);
    await expect(fetch(url)).rejects.toThrow();
  } finally {
    child.kill("SIGTERM");
    await child.exited;
    await output;
  }
});
test("render-region exposes guarded overlays, preserves the source file, and rejects digest drift", async () => {
  const root = await directory();
  const entry = resolve("tests/fixtures/session-react.tsx");
  const original = await readFile(entry);
  const manifest = join(root, "overlays.json");
  const overlay = {
    expectedDigest: digest(original),
    file: entry,
    replacements: [{ from: "React source row", to: "Overlaid source row" }],
  };
  await writeFile(manifest, JSON.stringify([overlay]));
  expect((await loadSourceOverlays(manifest))[0]?.file).toBe(entry);
  const args = [
    "render-region",
    entry,
    "--renderer",
    "react",
    "--width",
    "240",
    "--height",
    "160",
    "--region",
    "0,0,160,100",
    "--source-overlays",
    manifest,
    "--out",
    join(root, "detail.png"),
  ];
  expect((await cli(args)).code).toBe(0);
  expect(digest(await readFile(entry))).toBe(digest(original));
  await writeFile(
    manifest,
    JSON.stringify([{ ...overlay, expectedDigest: `sha256:${"0".repeat(64)}` }])
  );
  const rejected = await cli(args);
  expect(rejected.code).not.toBe(0);
  expect(rejected.stderr).toContain("digest");
});
