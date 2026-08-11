/**
 * Fragmented-MP4 box parsing for HomeKit Secure Video.
 *
 * HAP-NodeJS does no MP4 inspection whatsoever: it labels the *first* packet
 * the recording generator yields as `MEDIA_INITIALIZATION` and every packet
 * after it as `MEDIA_FRAGMENT`, purely positionally. Splitting ffmpeg's byte
 * stream into those units is entirely our job, and getting it wrong produces
 * the classic HKSV failure mode — a camera that looks connected, records
 * nothing, and reports no error.
 *
 * The stream ffmpeg produces with
 * `-movflags frag_keyframe+empty_moov+default_base_moof` looks like:
 *
 *     ftyp moov | moof mdat | moof mdat | ...
 *     \_________/ \_________/
 *      init seg    one fragment, starting on a keyframe
 *
 * So: accumulate boxes, flush on `moov` (yielding `ftyp+moov`) and on `mdat`
 * (yielding `moof+mdat`). Two flush triggers, exactly the two packet types.
 */

import type { Readable } from "node:stream";

/** A single top-level MP4 box, header and payload kept separate. */
export interface Mp4Box {
  /** The 8-byte box header: 4-byte big-endian size, then 4-byte ASCII type. */
  header: Buffer;
  /** Four-character box type, e.g. `ftyp`, `moov`, `moof`, `mdat`. */
  type: string;
  /** Payload, excluding the header. */
  data: Buffer;
  /** Total on-the-wire size, header included. */
  totalLength: number;
}

/** A complete unit to hand to HomeKit: either the init segment or a fragment. */
export interface Mp4Unit {
  kind: "initialization" | "fragment";
  data: Buffer;
  /** Boxes that went into it, for logging and diagnostics. */
  types: string[];
}

/**
 * Largest box we are willing to buffer. A four-second 1080p fragment is a few
 * hundred kilobytes; anything past this means we have lost sync with the
 * stream and are about to allocate a garbage-sized buffer from a corrupt
 * length field. Better to fail loudly and let the recording restart.
 */
const MAX_BOX_BYTES = 64 * 1024 * 1024;

export class Mp4ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Mp4ParseError";
  }
}

/**
 * Read exactly `length` bytes from a stream.
 *
 * `readable.read(n)` returns null until `n` bytes are buffered, so a naive
 * call drops data — which is why both reference implementations grow a helper
 * like this one. Two cases they get wrong and this does not:
 *
 * * At end of stream, `read(n)` returns whatever is left even if that is fewer
 *   than `n` bytes. Treating that short read as a complete one silently
 *   truncates the final box.
 * * An object-mode stream ignores `n` entirely and hands back one chunk.
 *
 * Both are handled by accumulating until the requested length is reached
 * rather than trusting a single call.
 */
export function readExactly(
  stream: Readable,
  length: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  if (length === 0) {
    return Promise.resolve(Buffer.alloc(0));
  }
  return new Promise<Buffer>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Mp4ParseError("aborted before read"));
      return;
    }

    const collected: Buffer[] = [];
    let have = 0;

    const cleanup = () => {
      stream.removeListener("readable", onReadable);
      stream.removeListener("end", onEnd);
      stream.removeListener("error", onError);
      signal?.removeEventListener("abort", onAbort);
    };

    const attempt = (): boolean => {
      for (;;) {
        const want = length - have;
        const chunk = (stream.read(want) ?? stream.read()) as Buffer | null;
        if (chunk === null || chunk.length === 0) {
          return false;
        }
        if (chunk.length > want) {
          // Only possible in object mode, or from a bare read(). Keep what we
          // need and push the rest back for the next caller.
          collected.push(chunk.subarray(0, want));
          stream.unshift(chunk.subarray(want));
          have = length;
        } else {
          collected.push(chunk);
          have += chunk.length;
        }
        if (have >= length) {
          cleanup();
          resolve(collected.length === 1 ? collected[0]! : Buffer.concat(collected, length));
          return true;
        }
      }
    };

    const onReadable = () => {
      attempt();
    };
    const onEnd = () => {
      cleanup();
      if (have === 0) {
        // A clean boundary: the previous box ended exactly at end of stream.
        reject(new StreamEndedError());
      } else {
        reject(new Mp4ParseError(`stream ended mid-box: wanted ${length}, had ${have}`));
      }
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const onAbort = () => {
      cleanup();
      reject(new Mp4ParseError("aborted during read"));
    };

    stream.on("readable", onReadable);
    stream.on("end", onEnd);
    stream.on("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });

    attempt();
  });
}

/** Thrown by {@link readExactly} when the stream ends cleanly on a boundary. */
export class StreamEndedError extends Error {
  constructor() {
    super("stream ended");
    this.name = "StreamEndedError";
  }
}

/**
 * Yield top-level MP4 boxes from a stream until it ends or is aborted.
 *
 * Rejects the degenerate size encodings rather than mis-parsing them: `size`
 * of 1 means a 64-bit length follows the type field, and 0 means "to end of
 * file". Neither can occur in a four-second fragment, and treating either as a
 * literal length would desynchronise the parser silently.
 */
export async function* parseBoxes(
  stream: Readable,
  signal?: AbortSignal,
): AsyncGenerator<Mp4Box> {
  while (!signal?.aborted) {
    let header: Buffer;
    try {
      header = await readExactly(stream, 8, signal);
    } catch (err) {
      if (err instanceof StreamEndedError) {
        return;
      }
      throw err;
    }

    const size = header.readUInt32BE(0);
    const type = header.subarray(4, 8).toString("ascii");

    if (!/^[\x20-\x7e]{4}$/.test(type)) {
      throw new Mp4ParseError(`lost stream sync: box type is not printable (${JSON.stringify(type)})`);
    }
    if (size === 1) {
      throw new Mp4ParseError(`64-bit box size is not supported (box '${type}')`);
    }
    if (size === 0) {
      throw new Mp4ParseError(`open-ended box is not supported (box '${type}')`);
    }
    if (size < 8) {
      throw new Mp4ParseError(`invalid box size ${size} for box '${type}'`);
    }
    if (size > MAX_BOX_BYTES) {
      throw new Mp4ParseError(`implausible box '${type}' of ${size} bytes; stream is corrupt`);
    }

    const data = await readExactly(stream, size - 8, signal);
    yield { header, type, data, totalLength: size };
  }
}

/**
 * Group a box stream into the units HomeKit expects.
 *
 * The first yielded unit is the initialization segment (`ftyp` + `moov`); every
 * unit after it is one fragment (`moof` + `mdat`). Anything appearing before
 * the first `moov` that is not `ftyp` is dropped, which is how a mid-stream
 * attach recovers.
 */
export async function* parseUnits(
  stream: Readable,
  signal?: AbortSignal,
): AsyncGenerator<Mp4Unit> {
  let pending: Buffer[] = [];
  let pendingTypes: string[] = [];
  let sawInit = false;

  for await (const box of parseBoxes(stream, signal)) {
    pending.push(box.header, box.data);
    pendingTypes.push(box.type);

    if (box.type === "moov") {
      yield { kind: "initialization", data: Buffer.concat(pending), types: pendingTypes };
      pending = [];
      pendingTypes = [];
      sawInit = true;
    } else if (box.type === "mdat") {
      if (!sawInit) {
        // Fragments arriving before we have an init segment cannot be decoded
        // by anything downstream. Drop them rather than emit an unplayable
        // first packet.
        pending = [];
        pendingTypes = [];
        continue;
      }
      yield { kind: "fragment", data: Buffer.concat(pending), types: pendingTypes };
      pending = [];
      pendingTypes = [];
    }
  }
}

/**
 * Split a complete in-memory fMP4 buffer into boxes.
 *
 * Used by the tests and by the prebuffer, which already holds whole boxes in
 * memory and does not need the streaming path.
 */
export function splitBoxes(buffer: Buffer): Mp4Box[] {
  const boxes: Mp4Box[] = [];
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    const size = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString("ascii");
    if (size < 8 || offset + size > buffer.length) {
      throw new Mp4ParseError(
        `truncated box '${type}': size ${size} at offset ${offset} of ${buffer.length}`,
      );
    }
    boxes.push({
      header: buffer.subarray(offset, offset + 8),
      type,
      data: buffer.subarray(offset + 8, offset + size),
      totalLength: size,
    });
    offset += size;
  }
  if (offset !== buffer.length) {
    throw new Mp4ParseError(`trailing ${buffer.length - offset} bytes after last box`);
  }
  return boxes;
}

/** Whether a buffer starts with a well-formed box of the given type. */
export function startsWithBox(buffer: Buffer, type: string): boolean {
  if (buffer.length < 8) {
    return false;
  }
  return buffer.subarray(4, 8).toString("ascii") === type;
}
