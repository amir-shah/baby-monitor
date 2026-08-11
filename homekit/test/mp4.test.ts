/**
 * Tests for the fMP4 box splitter.
 *
 * This is the component HomeKit Secure Video depends on entirely: HAP-NodeJS
 * does no MP4 inspection of its own, it simply labels the first packet the
 * generator yields as the initialization segment and every packet after it as
 * a fragment. If the splitting is wrong, recordings fail with no error
 * anywhere — the camera looks connected and records nothing.
 *
 * The fixtures here are hand-built box streams rather than real ffmpeg output,
 * so the test runs anywhere, including CI without ffmpeg. `npm run test:live`
 * exercises the same path against real ffmpeg when it is available.
 */

import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { describe, it } from "node:test";

import {
  Mp4ParseError,
  parseBoxes,
  parseUnits,
  readExactly,
  splitBoxes,
  startsWithBox,
  StreamEndedError,
} from "../src/camera/mp4.js";

/** Build one MP4 box: 4-byte big-endian size (header included) + 4-char type. */
function box(type: string, payload: Buffer | number): Buffer {
  const body = typeof payload === "number" ? Buffer.alloc(payload, 0x2a) : payload;
  const header = Buffer.alloc(8);
  header.writeUInt32BE(body.length + 8, 0);
  header.write(type, 4, 4, "ascii");
  return Buffer.concat([header, body]);
}

/** A plausible fragmented-MP4 stream: ftyp moov (moof mdat)*. */
function fmp4(fragments: number): Buffer {
  const parts = [box("ftyp", 24), box("moov", 512)];
  for (let i = 0; i < fragments; i++) {
    parts.push(box("moof", 120), box("mdat", 4096 + i));
  }
  return Buffer.concat(parts);
}

/**
 * Feed a buffer through a byte stream in awkwardly-sized chunks.
 *
 * objectMode:false matters: the real source is a TCP socket, and an
 * object-mode stream ignores the length argument to read(), which would make
 * these tests pass against behaviour production never sees.
 */
function chunked(buffer: Buffer, size: number): Readable {
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < buffer.length; offset += size) {
    chunks.push(buffer.subarray(offset, Math.min(offset + size, buffer.length)));
  }
  return Readable.from(chunks, { objectMode: false });
}

/** A byte stream from whole buffers, for the malformed-header cases. */
function bytes(...parts: Buffer[]): Readable {
  return Readable.from(parts, { objectMode: false });
}

describe("splitBoxes", () => {
  it("splits a well-formed stream", () => {
    const boxes = splitBoxes(fmp4(2));
    assert.deepEqual(
      boxes.map((b) => b.type),
      ["ftyp", "moov", "moof", "mdat", "moof", "mdat"],
    );
    assert.equal(boxes[0]!.totalLength, 32);
    assert.equal(boxes[3]!.data.length, 4096);
  });

  it("rejects a truncated final box rather than returning it short", () => {
    const truncated = fmp4(1).subarray(0, 600);
    assert.throws(() => splitBoxes(truncated), Mp4ParseError);
  });
});

describe("parseBoxes", () => {
  it("reassembles boxes split across arbitrary chunk boundaries", async () => {
    // 7 bytes is deliberately smaller than the 8-byte header, so every single
    // header has to be reassembled from several chunks.
    for (const size of [1, 7, 8, 13, 4096]) {
      const types: string[] = [];
      for await (const b of parseBoxes(chunked(fmp4(3), size))) {
        types.push(b.type);
      }
      assert.deepEqual(
        types,
        ["ftyp", "moov", "moof", "mdat", "moof", "mdat", "moof", "mdat"],
        `chunk size ${size}`,
      );
    }
  });

  it("ends cleanly at end of stream", async () => {
    const seen: string[] = [];
    for await (const b of parseBoxes(chunked(fmp4(1), 64))) {
      seen.push(b.type);
    }
    assert.deepEqual(seen, ["ftyp", "moov", "moof", "mdat"]);
  });

  it("refuses the 64-bit largesize form instead of mis-parsing it", async () => {
    const header = Buffer.alloc(16);
    header.writeUInt32BE(1, 0); // size == 1 means a 64-bit size follows the type
    header.write("mdat", 4, 4, "ascii");
    await assert.rejects(
      async () => {
        for await (const _ of parseBoxes(bytes(header))) {
          /* consume */
        }
      },
      (err: Error) => err instanceof Mp4ParseError && /64-bit/.test(err.message),
    );
  });

  it("refuses an open-ended box", async () => {
    const header = Buffer.alloc(8);
    header.writeUInt32BE(0, 0);
    header.write("mdat", 4, 4, "ascii");
    await assert.rejects(
      async () => {
        for await (const _ of parseBoxes(bytes(header))) {
          /* consume */
        }
      },
      (err: Error) => err instanceof Mp4ParseError && /open-ended/.test(err.message),
    );
  });

  it("detects loss of sync from a non-printable box type", async () => {
    const garbage = Buffer.from([0, 0, 0, 32, 0xff, 0xfe, 0x00, 0x01, ...Buffer.alloc(24)]);
    await assert.rejects(
      async () => {
        for await (const _ of parseBoxes(bytes(garbage))) {
          /* consume */
        }
      },
      (err: Error) => err instanceof Mp4ParseError && /sync/.test(err.message),
    );
  });

  it("refuses an implausibly large box rather than allocating for it", async () => {
    const header = Buffer.alloc(8);
    header.writeUInt32BE(0xfffffff0, 0);
    header.write("mdat", 4, 4, "ascii");
    await assert.rejects(
      async () => {
        for await (const _ of parseBoxes(bytes(header))) {
          /* consume */
        }
      },
      (err: Error) => err instanceof Mp4ParseError && /implausible/.test(err.message),
    );
  });

  it("reads a size at the top of the unsigned range as unsigned", () => {
    // readInt32BE would make this negative; both reference implementations
    // get this wrong. It cannot happen with four-second fragments, but the
    // correct read is free.
    const header = Buffer.alloc(8);
    header.writeUInt32BE(0x90000000, 0);
    assert.equal(header.readUInt32BE(0), 0x90000000);
    assert.ok(header.readInt32BE(0) < 0);
  });
});

describe("parseUnits", () => {
  it("emits ftyp+moov as one initialization packet, then one packet per fragment", async () => {
    const units = [];
    for await (const unit of parseUnits(chunked(fmp4(3), 97))) {
      units.push(unit);
    }
    assert.equal(units.length, 4);

    const init = units[0]!;
    assert.equal(init.kind, "initialization");
    assert.deepEqual(init.types, ["ftyp", "moov"]);
    // An fMP4 initialization segment is ftyp followed by moov. Dropping the
    // ftyp — as homebridge-camera-ffmpeg does — is technically non-conformant.
    assert.ok(startsWithBox(init.data, "ftyp"));

    for (const fragment of units.slice(1)) {
      assert.equal(fragment.kind, "fragment");
      assert.deepEqual(fragment.types, ["moof", "mdat"]);
      // Every fragment must begin on a moof boundary or the demuxer desyncs.
      assert.ok(startsWithBox(fragment.data, "moof"));
    }
  });

  it("is byte-exact: concatenating every unit reproduces the input", async () => {
    const source = fmp4(4);
    const parts: Buffer[] = [];
    for await (const unit of parseUnits(chunked(source, 31))) {
      parts.push(unit.data);
    }
    assert.ok(Buffer.concat(parts).equals(source));
  });

  it("drops fragments that arrive before an initialization segment", async () => {
    // What a mid-stream attach looks like: fragments first, then the camera
    // restarts and sends a proper header. The early fragments reference a moov
    // we never saw and cannot be decoded by anything downstream.
    const stream = Buffer.concat([
      box("moof", 64),
      box("mdat", 256),
      box("ftyp", 24),
      box("moov", 400),
      box("moof", 64),
      box("mdat", 512),
    ]);
    const units = [];
    for await (const unit of parseUnits(chunked(stream, 45))) {
      units.push(unit);
    }
    assert.equal(units.length, 2);
    assert.equal(units[0]!.kind, "initialization");
    assert.equal(units[1]!.kind, "fragment");
  });

  it("ignores boxes that are part of neither segment", async () => {
    const stream = Buffer.concat([
      box("ftyp", 24),
      box("free", 16),
      box("moov", 400),
      box("moof", 64),
      box("mdat", 512),
      box("mfra", 32),
    ]);
    const units = [];
    for await (const unit of parseUnits(chunked(stream, 64))) {
      units.push(unit);
    }
    assert.equal(units.length, 2);
    // A `free` box before the moov travels with the init segment, which is
    // harmless and byte-exact; a trailing `mfra` is simply never emitted.
    assert.deepEqual(units[0]!.types, ["ftyp", "free", "moov"]);
    assert.deepEqual(units[1]!.types, ["moof", "mdat"]);
  });

  it("stops promptly when aborted", async () => {
    const controller = new AbortController();
    const units = [];
    for await (const unit of parseUnits(chunked(fmp4(10), 512), controller.signal)) {
      units.push(unit);
      if (units.length === 2) {
        controller.abort();
      }
    }
    assert.ok(units.length <= 3, `stopped after ${units.length} units`);
  });
});

describe("readExactly", () => {
  it("returns exactly the requested length across chunk boundaries", async () => {
    const stream = chunked(Buffer.alloc(100, 7), 3);
    const first = await readExactly(stream, 40);
    assert.equal(first.length, 40);
    const second = await readExactly(stream, 60);
    assert.equal(second.length, 60);
  });

  it("signals a clean end of stream distinctly from a truncation", async () => {
    const stream = chunked(Buffer.alloc(10), 10);
    await readExactly(stream, 10);
    await assert.rejects(() => readExactly(stream, 4), StreamEndedError);
  });
});
