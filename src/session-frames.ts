import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
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
const RECEIPT_NAME = /^(\d+)\.json$/;

type FrameReceipt = {
  identity: string;
  rowDigest: string;
  region?: FrameSequence["region"] | null;
  image: SessionArtifact;
};

/** Indices of committed frame receipts, ascending. Images without a receipt are orphans and are not listed. */
async function committedIndices(directory: string, id: string) {
  try {
    const names = await readdir(artifactPath(directory, `frames/${id}`));
    return names
      .map((name) => RECEIPT_NAME.exec(name)?.[1])
      .filter((index): index is string => index !== undefined)
      .map(Number)
      .sort((a, b) => a - b);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function checkRow(row: SessionFrame, previousIndex: number) {
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
}

/**
 * Streams rows lazily: seek, fence, capture, then publish the frame receipt before pulling the next row.
 * The committed receipt is the checkpoint. On resume, every saved receipt must be matched, in order, by
 * the first incoming rows (same row, identity, crop and image bytes) before any source action;
 * restore runs once, after that whole prefix.
 */
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
  const region = sequence.region ?? null;
  const saved = await committedIndices(directory, sequence.id);
  if (saved.length && !resume) {
    throw new Error(
      `Frame sequence ${sequence.id} already has committed frames; resume or use a new output directory.`
    );
  }
  if (saved.length && !sequence.restore) {
    throw new Error("Resume requires an explicit fixture restore callback.");
  }
  let committed = 0,
    reused = 0,
    previousIndex = -1;
  let lastSaved: SessionFrame | undefined;
  let restored = false;
  for await (const row of sequence.rows) {
    checkRow(row, previousIndex);
    previousIndex = row.index;
    const name = `frames/${sequence.id}/${row.index}.json`;
    const rowDigest = digest(canonical(row));
    if (reused < saved.length) {
      const receipt = (await readReceipt(
        directory,
        name
      )) as FrameReceipt | null;
      if (
        row.index !== saved[reused] ||
        !receipt ||
        receipt.identity !== identity ||
        receipt.rowDigest !== rowDigest ||
        canonical(receipt.region ?? null) !== canonical(region)
      ) {
        throw new Error(
          `Resume frame ${row.index} does not match committed frame ${saved[reused]} (row, identity or crop changed, or the checkpoint is not a prefix).`
        );
      }
      const imagePath = artifactPath(
        directory,
        relative(directory, receipt.image.path)
      );
      if (digest(await readFile(imagePath)) !== receipt.image.sha256) {
        throw new Error("Resume frame artifact is corrupt.");
      }
      lastSaved = row;
      reused += 1;
      continue;
    }
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
    await session.evidence(name, { identity, image, region, row, rowDigest });
    committed += 1;
  }
  if (reused < saved.length) {
    throw new Error(
      `Resume rows ended after ${reused} of ${saved.length} committed frames of ${sequence.id}.`
    );
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
