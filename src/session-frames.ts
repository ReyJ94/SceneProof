import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { relative } from "node:path";
import type {
  FrameSequence,
  SessionArtifact,
  SessionContext,
  SessionFrame,
} from "./session.js";
import {
  artifactPath,
  canonical,
  digest,
  readReceipt,
} from "./session-store.js";

const SEQUENCE_ID = /^[a-zA-Z0-9_-]+$/;
/** The committed receipt is the checkpoint; a PNG without one is an orphan, not a completed frame. */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Ordered streaming, immutable checkpoints, and restore-before-seek are one resume transaction.
export async function streamFrames(input: {
  sequence: FrameSequence;
  session: Pick<SessionContext, "invoke" | "capture" | "evidence">;
  directory: string;
  identity: string;
  resume: boolean;
  attempt: string;
  beforeFrame?: (row: SessionFrame) => void | Promise<void>;
}) {
  const { sequence, session, directory, identity, resume, attempt } = input;
  if (!SEQUENCE_ID.test(sequence.id)) {
    throw new Error("Frame sequence id must be a safe artifact segment.");
  }
  let committed = 0,
    reused = 0,
    previousIndex = -1;
  let lastSaved: SessionFrame | undefined;
  let restored = false;
  let sawMissing = false;
  for await (const row of sequence.rows) {
    if (
      !Number.isSafeInteger(row.index) ||
      row.index <= previousIndex ||
      !Number.isSafeInteger(row.clock.numerator) ||
      row.clock.numerator < 0 ||
      !Number.isSafeInteger(row.clock.denominator) ||
      row.clock.denominator <= 0
    ) {
      throw new Error(
        "Frames require increasing safe indices and a nonnegative rational clock."
      );
    }
    previousIndex = row.index;
    const name = `frames/${sequence.id}/${row.index}.json`;
    const rowDigest = digest(canonical(row));
    const saved = (await readReceipt(directory, name)) as {
      identity: string;
      rowDigest: string;
      image: SessionArtifact;
    } | null;
    if (saved) {
      if (
        !resume ||
        sawMissing ||
        saved.identity !== identity ||
        saved.rowDigest !== rowDigest
      ) {
        throw new Error(
          "Resume frame identity mismatch or non-prefix checkpoint."
        );
      }
      const imagePath = artifactPath(
        directory,
        relative(directory, saved.image.path)
      );
      if (digest(await readFile(imagePath)) !== saved.image.sha256) {
        throw new Error("Resume frame artifact is corrupt.");
      }
      if (!sequence.restore) {
        throw new Error(
          "Resume requires an explicit fixture restore callback."
        );
      }
      lastSaved = row;
      reused += 1;
      continue;
    }
    sawMissing = true;
    if (lastSaved && !restored) {
      await sequence.restore?.(lastSaved);
      restored = true;
    }
    await input.beforeFrame?.(row);
    if (sequence.seek) {
      await sequence.seek(row);
    } else {
      await session.invoke("seek", row);
    }
    if (sequence.fence) {
      await sequence.fence(row);
    } else {
      await session.invoke("fence");
    }
    const image = await session.capture({
      name: `frames/${sequence.id}/${row.index}-${randomUUID()}.png`,
      ...(sequence.region ? { region: sequence.region } : {}),
    });
    await session.evidence(name, { identity, image, row, rowDigest });
    committed += 1;
  }
  if (lastSaved && !restored) {
    await sequence.restore?.(lastSaved);
  }
  await session.evidence(`attempts/${attempt}/${sequence.id}-complete.json`, {
    committed,
    reused,
  });
  return { committed, reused };
}
