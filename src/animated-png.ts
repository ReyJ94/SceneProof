/* biome-ignore-all lint/suspicious/noBitwiseOperators: PNG CRC-32 is defined by bitwise polynomial arithmetic. */
import { readFile, writeFile } from "node:fs/promises";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

type PngChunk = { data: Buffer; type: string };

function parsePng(bytes: Buffer): PngChunk[] {
  if (!bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error("Animated PNG input is not a PNG file.");
  }
  const chunks: PngChunk[] = [];
  let offset = PNG_SIGNATURE.length;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.subarray(offset + 4, offset + 8).toString("ascii");
    const end = offset + 12 + length;
    if (end > bytes.length) {
      throw new Error(`PNG chunk ${type} exceeds the input length.`);
    }
    chunks.push({
      data: bytes.subarray(offset + 8, offset + 8 + length),
      type,
    });
    offset = end;
    if (type === "IEND") {
      break;
    }
  }
  if (chunks[0]?.type !== "IHDR" || chunks.at(-1)?.type !== "IEND") {
    throw new Error("Animated PNG input has an invalid chunk sequence.");
  }
  return chunks;
}

let crcTable: Uint32Array | undefined;

function crc32(bytes: Buffer): number {
  crcTable ??= Uint32Array.from({ length: 256 }, (_, value) => {
    let current = value;
    for (let bit = 0; bit < 8; bit += 1) {
      current =
        (current & 1) === 1 ? 0xed_b8_83_20 ^ (current >>> 1) : current >>> 1;
    }
    return current >>> 0;
  });
  let crc = 0xff_ff_ff_ff;
  for (const byte of bytes) {
    crc = (crcTable[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xff_ff_ff_ff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const name = Buffer.from(type, "ascii");
  const output = Buffer.allocUnsafe(data.length + 12);
  output.writeUInt32BE(data.length, 0);
  name.copy(output, 4);
  data.copy(output, 8);
  output.writeUInt32BE(crc32(Buffer.concat([name, data])), data.length + 8);
  return output;
}

function greatestCommonDivisor(left: number, right: number): number {
  let a = left;
  let b = right;
  while (b !== 0) {
    [a, b] = [b, a % b];
  }
  return a;
}

function frameControl(input: {
  delayMs: number;
  height: number;
  sequence: number;
  width: number;
}): Buffer {
  const divisor = greatestCommonDivisor(input.delayMs, 1000);
  const numerator = input.delayMs / divisor;
  const denominator = 1000 / divisor;
  if (numerator > 65_535 || denominator > 65_535) {
    throw new Error(`APNG frame delay ${input.delayMs}ms is out of range.`);
  }
  const data = Buffer.alloc(26);
  data.writeUInt32BE(input.sequence, 0);
  data.writeUInt32BE(input.width, 4);
  data.writeUInt32BE(input.height, 8);
  data.writeUInt32BE(0, 12);
  data.writeUInt32BE(0, 16);
  data.writeUInt16BE(numerator, 20);
  data.writeUInt16BE(denominator, 22);
  data[24] = 0; // APNG_DISPOSE_OP_NONE
  data[25] = 0; // APNG_BLEND_OP_SOURCE
  return data;
}

export async function writeAnimatedPng(input: {
  delayMs: number;
  framePaths: string[];
  out: string;
}): Promise<void> {
  if (input.framePaths.length < 2) {
    throw new Error("An animated PNG requires at least two frames.");
  }
  if (!Number.isInteger(input.delayMs) || input.delayMs <= 0) {
    throw new Error(
      "Animated PNG delay must be a positive integer in milliseconds."
    );
  }
  const images = await Promise.all(
    input.framePaths.map(async (path) => parsePng(await readFile(path)))
  );
  const firstHeader = images[0]?.[0]?.data;
  if (!firstHeader) {
    throw new Error("Animated PNG first frame has no IHDR chunk.");
  }
  const width = firstHeader.readUInt32BE(0);
  const height = firstHeader.readUInt32BE(4);
  const format = firstHeader.subarray(8).toString("hex");
  for (const chunks of images) {
    const header = chunks[0]?.data;
    if (
      !header ||
      header.readUInt32BE(0) !== width ||
      header.readUInt32BE(4) !== height ||
      header.subarray(8).toString("hex") !== format
    ) {
      throw new Error(
        "Animated PNG frames must have identical dimensions and pixel format."
      );
    }
  }

  const output: Buffer[] = [PNG_SIGNATURE, chunk("IHDR", firstHeader)];
  const sharedChunks = images[0]
    ?.slice(1)
    .filter(
      (entry) => !["IDAT", "IEND", "acTL", "fcTL", "fdAT"].includes(entry.type)
    );
  for (const entry of sharedChunks ?? []) {
    output.push(chunk(entry.type, entry.data));
  }
  const animationControl = Buffer.alloc(8);
  animationControl.writeUInt32BE(images.length, 0);
  animationControl.writeUInt32BE(0, 4);
  output.push(chunk("acTL", animationControl));

  let sequence = 0;
  for (const [index, chunks] of images.entries()) {
    output.push(
      chunk(
        "fcTL",
        frameControl({
          delayMs: input.delayMs,
          height,
          sequence,
          width,
        })
      )
    );
    sequence += 1;
    for (const entry of chunks.filter(
      (candidate) => candidate.type === "IDAT"
    )) {
      if (index === 0) {
        output.push(chunk("IDAT", entry.data));
      } else {
        const data = Buffer.allocUnsafe(entry.data.length + 4);
        data.writeUInt32BE(sequence, 0);
        entry.data.copy(data, 4);
        output.push(chunk("fdAT", data));
        sequence += 1;
      }
    }
  }
  output.push(chunk("IEND", Buffer.alloc(0)));
  await writeFile(input.out, Buffer.concat(output));
}
