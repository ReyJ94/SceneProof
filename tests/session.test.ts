import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { file, serve } from "bun";
import {
  defineSession,
  frameClock,
  loopbackUrl,
  runSession,
} from "../src/session.js";
import { digest } from "../src/session-store.js";

const owned: string[] = [];
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "sceneproof-session-"));
  owned.push(path);
  return path;
}
afterEach(async () => {
  await Promise.all(
    owned.splice(0).map((path) => rm(path, { force: true, recursive: true }))
  );
});
function* rows(count: number) {
  for (let index = 0; index < count; index += 1) {
    yield { clock: frameClock(index), index };
  }
}
const source = { entry: resolve("tests/fixtures/session-react.tsx") };
test("page admission accepts only credential-free loopback origins", () => {
  expect(loopbackUrl("http://127.0.0.1:1234/source").hostname).toBe(
    "127.0.0.1"
  );
  for (const value of [
    "https://provider.example/",
    "file:///etc/passwd",
    "http://user:password@localhost/",
  ]) {
    expect(() => loopbackUrl(value)).toThrow();
  }
});
test("source routes serve dedicated worker entry, module imports and worker fetches at the context boundary", async () => {
  const root = await directory();
  const entry = join(root, "worker-source.tsx");
  await writeFile(
    entry,
    `const worker=new Worker('/worker-entry.js',{type:'module'});
    worker.onmessage=event=>{globalThis.__workerResult=event.data;};
    worker.onerror=()=>{globalThis.__workerFailure='Source worker could not load';};
    export default function WorkerSource(){return <div>Real source worker owner</div>;}`
  );
  const requested: string[] = [];
  await runSession(
    defineSession({
      ready: (s) =>
        s.ready(() => {
          const error = Reflect.get(globalThis, "__workerFailure");
          if (error) {
            throw new Error(error);
          }
          return !!Reflect.get(globalThis, "__workerResult");
        }),
      routes: [
        {
          async handle(route) {
            const path = new URL(route.request().url()).pathname;
            if (path === "/worker-entry.js") {
              requested.push(path);
              await route.fulfill({
                body: "import {answer} from './worker-helper.js'; const data=await(await fetch('/worker-evidence.json')).json(); postMessage({answer,data});",
                contentType: "text/javascript",
              });
            } else if (path === "/worker-helper.js") {
              requested.push(path);
              await route.fulfill({
                body: "export const answer=42;",
                contentType: "text/javascript",
              });
            } else if (path === "/worker-evidence.json") {
              requested.push(path);
              await route.fulfill({ json: { source: "actual worker fetch" } });
            } else {
              await route.fallback();
            }
          },
          identity: { worker: "pinned fixture" },
          pattern: "**/*",
        },
      ],
      async run(s) {
        expect(
          await s.page.evaluate(() => Reflect.get(globalThis, "__workerResult"))
        ).toEqual({ answer: 42, data: { source: "actual worker fetch" } });
      },
      source: { entry },
      viewport: { height: 160, width: 240 },
    }),
    { out: join(root, "run") }
  );
  expect(requested).toEqual([
    "/worker-entry.js",
    "/worker-helper.js",
    "/worker-evidence.json",
  ]);
});
test("a real React source sequence awaits seek/fence and persists each row before requesting the next", async () => {
  const out = join(await directory(), "run");
  let saved = 0;
  const definition = defineSession({
    identity: () => ({ camera: "literal", seed: 12 }),
    async run(session) {
      async function* lazy() {
        for (const row of rows(3)) {
          if (row.index) {
            expect(
              JSON.parse(
                // biome-ignore lint/performance/noAwaitInLoops: The oracle asserts persistence before the next row is requested.
                await readFile(
                  join(out, `frames/rows/${row.index - 1}.json`),
                  "utf8"
                )
              ).row.index
            ).toBe(row.index - 1);
          }
          yield row;
        }
      }
      const result = await session.frames({ id: "rows", rows: lazy() });
      saved = result.committed;
      expect(await session.invoke("read")).toEqual({
        committed: true,
        frame: 2,
      });
    },
    source,
    viewport: { height: 160, width: 240 },
  });
  const report = await runSession(definition, { out });
  expect(saved).toBe(3);
  expect(report.provenance.adapter?.isFallbackAdapter).toBe(false);
  const receipt = JSON.parse(
    await readFile(join(out, "frames/rows/2.json"), "utf8")
  );
  expect(receipt.row.clock).toEqual({ denominator: 30, numerator: 2 });
  expect(digest(await readFile(receipt.image.path))).toBe(receipt.image.sha256);
});
test("interruption restores the last committed domain state; changed identity and corrupt PNGs refuse resume", async () => {
  const out = join(await directory(), "run");
  const state = { interrupt: true };
  let restored = -1,
    seed = 8;
  const definition = defineSession({
    identity: () => ({ camera: "literal", seed }),
    async run(session) {
      await session.frames({
        id: "rows",
        restore: async (row) => {
          restored = row.index;
          await session.invoke("seek", row);
        },
        rows: rows(3),
        seek: async (row) => {
          // biome-ignore lint/suspicious/noUnnecessaryConditions: The test mutates this shared closure between interrupted and resumed runs.
          if (state.interrupt && row.index === 1) {
            throw new Error("interrupted");
          }
          await session.invoke("seek", row);
        },
      });
    },
    source,
    viewport: { height: 160, width: 240 },
  });
  await expect(runSession(definition, { out })).rejects.toThrow("interrupted");
  state.interrupt = false;
  await runSession(definition, { out, resume: true });
  expect(restored).toBe(0);
  seed = 9;
  await expect(runSession(definition, { out, resume: true })).rejects.toThrow(
    "identity mismatch"
  );
  seed = 8;
  const receipt = JSON.parse(
    await readFile(join(out, "frames/rows/0.json"), "utf8")
  );
  await writeFile(receipt.image.path, "corrupt");
  await expect(runSession(definition, { out, resume: true })).rejects.toThrow(
    "corrupt"
  );
});
test("loopback page session installs init modules and routes before load, uses controls and closes its owned server", async () => {
  const root = await directory();
  const out = join(root, "run");
  const init = join(root, "init.ts");
  await writeFile(init, "globalThis.__passiveInit = true;");
  const html = join(root, "source.html");
  await writeFile(
    html,
    `<!doctype html><button id="replay">Replay</button><script>
    window.__ready = window.__passiveInit === true;
    window.__SCENEPROOF_CONTROLS__ = {actions:{read:()=>({init:window.__passiveInit,clicked:window.__clicked===true})}};
    document.querySelector('button').onclick=()=>{window.__clicked=true};
  </script>`
  );
  let stopped = false;
  const definition = defineSession({
    init: [init],
    page: {
      async start() {
        const server = serve({
          fetch: () => new Response(file(html)),
          hostname: "127.0.0.1",
          port: 0,
        });
        return {
          dispose() {
            server.stop(true);
            stopped = true;
          },
          sourcePins: { [html]: digest(await readFile(html)) },
          url: server.url.href,
        };
      },
    },
    ready: (session) =>
      session.ready(() => Reflect.get(globalThis, "__ready") === true),
    routes: [
      {
        handle: (route) => route.fulfill({ json: { value: 7 } }),
        identity: { value: 7 },
        pattern: "**/value.json",
      },
    ],
    async run(session) {
      await session.click("#replay");
      expect(await session.invoke("read")).toEqual({
        clicked: true,
        init: true,
      });
      expect(
        await session.page.evaluate(async () =>
          (await fetch("/value.json")).json()
        )
      ).toEqual({ value: 7 });
      await session.capture({ name: "full.png" });
      await session.evidence("readback.json", { value: 7 });
      await session.binary("bytes.bin", new Uint8Array([5, 6]));
    },
    viewport: { height: 160, width: 240 },
  });
  await runSession(definition, { out });
  expect(stopped).toBe(true);
  expect(
    JSON.parse(await readFile(join(out, "readback.json"), "utf8"))
  ).toEqual({ value: 7 });
  expect([...(await readFile(join(out, "bytes.bin")))]).toEqual([5, 6]);
});
test("source fence/action rejection never publishes a frame or appropriates an existing output directory", async () => {
  const out = join(await directory(), "run");
  const definition = defineSession({
    async run(session) {
      await session.frames({
        fence: () => {
          throw new Error("fence rejected");
        },
        id: "rows",
        rows: rows(1),
      });
    },
    source,
  });
  await expect(runSession(definition, { out })).rejects.toThrow(
    "fence rejected"
  );
  await expect(readFile(join(out, "frames/rows/0.json"))).rejects.toThrow();
  await expect(runSession(definition, { out })).rejects.toThrow();
});
test("GPU timestamp passes stream real source timings separately from CPU windows", async () => {
  const out = join(await directory(), "run");
  const definition = defineSession({
    gpuTimings: true,
    async run(session) {
      await session.measure({
        name: "cpu.json",
        run: async (s) => {
          await expect(s.capture({ name: "forbidden.png" })).rejects.toThrow(
            "CPU measurement"
          );
          expect(() => s.frames({ id: "forbidden", rows: rows(1) })).toThrow(
            "CPU measurement"
          );
          await s.invoke("seek", { clock: frameClock(0), index: 0 });
          await s.invoke("draw");
          return { boundary: "owner draw call" };
        },
      });
      await session.gpuTimings({
        name: "passes",
        run: (s) => s.frames({ id: "native", rows: rows(3) }),
      });
      const receipt = JSON.parse(
        await readFile(join(out, "frames/native/2.json"), "utf8")
      );
      const data = `data:image/png;base64,${(await readFile(receipt.image.path)).toString("base64")}`;
      const pixel = await session.page.evaluate(async (url) => {
        const image = new Image();
        image.src = url;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext("2d");
        if (!context) {
          throw new Error("pixel decoder missing");
        }
        context.drawImage(image, 0, 0);
        return [...context.getImageData(20, 20, 1, 1).data];
      }, data);
      expect(pixel).toEqual([128, 64, 128, 255]);
      const metadata = JSON.parse(
        await readFile(`${receipt.image.path}.artifact.json`, "utf8")
      );
      expect(metadata.method).toBe("native-framebuffer-readback-composite");
    },
    source: { entry: resolve("tests/fixtures/session-gpu-react.tsx") },
    viewport: { height: 160, width: 240 },
  });
  const report = await runSession(definition, { out });
  const cpu = JSON.parse(await readFile(join(out, "cpu.json"), "utf8"));
  expect(cpu.gpuTimestamps).toBe(false);
  const gpu = JSON.parse(await readFile(join(out, "passes.json"), "utf8"));
  expect(gpu.queueFenceIsGpuTime).toBe(false);
  const devices = report.provenance.deviceAdmissions as Array<{
    features: string[];
  }>;
  if (devices.some((device) => device.features.includes("timestamp-query"))) {
    expect(gpu.status).toBe("collected");
    expect(gpu.samples).toBe(3);
    const sample = JSON.parse(
      await readFile(join(out, gpu.rawDirectory, "0.json"), "utf8")
    );
    expect(sample.pass).toBe("source-clear");
    expect(sample.sampleCount).toBe(1);
    expect(sample.frame.clock.denominator).toBe(30);
    expect(sample.adapter.vendor).toBe(
      (report.provenance.adapter as { vendor: string }).vendor
    );
    expect(sample.milliseconds).toBeGreaterThanOrEqual(0);
  } else {
    expect(gpu.status).toBe("unsupported-or-incomplete");
  }
});
