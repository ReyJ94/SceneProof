import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { streamFrames } from "../src/session-frames.js";
import {
  artifactPath,
  atomicArtifact,
  canonical,
  digest,
  frameClock,
  readReceipt,
} from "../src/session-store.js";

const owned: string[] = [];
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "sceneproof-store-"));
  owned.push(path);
  return path;
}
afterEach(async () => {
  await Promise.all(
    owned.splice(0).map((path) => rm(path, { force: true, recursive: true }))
  );
});
test("artifact publication rejects a symlinked parent before writing outside its owner", async () => {
  const root = await directory();
  const foreign = await directory();
  await symlink(foreign, join(root, "linked"));
  await expect(
    atomicArtifact(root, "linked/frame.png", "bytes")
  ).rejects.toThrow("symlink");
  await expect(readFile(join(foreign, "frame.png"))).rejects.toThrow();
});
test("rational clocks retain exact 30 Hz without a frame count cap", () => {
  expect(frameClock(3966)).toEqual({ denominator: 30, numerator: 3966 });
  expect(frameClock(120_000, { denominator: 1001, numerator: 30_000 })).toEqual(
    { denominator: 30_000, numerator: 120_120_000 }
  );
  expect(() => frameClock(-1)).toThrow();
  expect(() => frameClock(1, { denominator: 1, numerator: 0 })).toThrow();
});
test("immutable evidence publishes bytes and a digest; a duplicate never overwrites", async () => {
  const root = await directory();
  const artifact = await atomicArtifact(
    root,
    "frames/0.png",
    new Uint8Array([1, 2, 3])
  );
  expect(artifact.sha256).toBe(digest(new Uint8Array([1, 2, 3])));
  await expect(
    atomicArtifact(root, "frames/0.png", "replacement")
  ).rejects.toThrow();
  expect([...(await readFile(artifact.path))]).toEqual([1, 2, 3]);
});
test("artifact boundaries reject traversal and private configuration names", () => {
  for (const name of [
    "../foreign.png",
    "/tmp/foreign",
    ".env",
    "sub/.env.local",
    "sub\\foreign",
  ]) {
    expect(() => artifactPath("/tmp/owned", name)).toThrow();
  }
});
test("canonical identity survives key reordering but not changed state", () => {
  expect(canonical({ a: 1, b: { c: 2, d: 3 } })).toBe(
    canonical({ a: 1, b: { c: 2, d: 3 } })
  );
  expect(digest(canonical({ seed: 1 }))).not.toBe(
    digest(canonical({ seed: 2 }))
  );
  expect(() => canonical(undefined)).toThrow();
  expect(() => canonical({ time: Number.NaN })).toThrow("finite");
  expect(canonical({ rows: [undefined, 1], unavailable: undefined })).toBe(
    '{"rows":[null,1]}'
  );
  expect(canonical(new Array(2))).toBe("[null,null]");
  expect(canonical(new Date("2026-10-12T10:00:00Z"))).toBe(
    '"2026-10-12T10:00:00.000Z"'
  );
});
test("only missing receipts are absent; corruption fails closed", async () => {
  const root = await directory();
  expect(await readReceipt(root, "missing.json")).toBeNull();
  await atomicArtifact(root, "broken.json", "not JSON");
  await expect(readReceipt(root, "broken.json")).rejects.toThrow();
});
test("streaming accepts a full 3967-row trajectory and commits before pulling the next row", async () => {
  const root = await directory();
  let committed = 0;
  let fenced = -1;
  function* rows() {
    for (let index = 0; index < 3967; index += 1) {
      expect(committed).toBe(index);
      yield { clock: frameClock(index), index };
    }
  }
  const result = await streamFrames({
    attempt: "unit",
    directory: root,
    identity: "test",
    resume: false,
    sequence: { id: "long", rows: rows() },
    session: {
      capture({ name }) {
        expect(fenced).toBe(committed);
        return atomicArtifact(root, name, new Uint8Array([fenced % 256]));
      },
      async evidence(name, value) {
        const artifact = await atomicArtifact(root, name, canonical(value));
        if (name.startsWith("frames/")) {
          committed += 1;
        }
        return artifact;
      },
      invoke(name, input) {
        if (name === "seek") {
          fenced = (input as { index: number }).index;
        }
        return Promise.resolve();
      },
    },
  });
  expect(result).toEqual({ committed: 3967, reused: 0 });
  const last = (await readReceipt(root, "frames/long/3966.json")) as {
    row: { clock: unknown };
  };
  expect(last.row.clock).toEqual({ denominator: 30, numerator: 3966 });
});
