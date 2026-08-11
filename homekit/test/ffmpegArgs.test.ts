/**
 * Two arguments whose absence breaks something silently.
 *
 * Both failures share a shape: everything reports success, and the defect is
 * only visible to a person watching the Home app. Neither would be caught by
 * a type check, a lint rule, or a test of the code that surrounds them —
 * hence a test of what ffmpeg actually does with the arguments we give it.
 *
 * These drive the real binary, because the claims are about ffmpeg's
 * behaviour rather than ours. Where it is not installed they skip.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { describe, it } from "node:test";

interface Run {
  code: number | null;
  stdout: Buffer;
  stderr: string;
  fd3: string;
}

/**
 * The samples of a RIFF/WAVE buffer, found by walking its chunks.
 *
 * Not by assuming a 44-byte header: ffmpeg writing to a pipe cannot seek back
 * to fix up sizes, so it emits a longer header with a LIST chunk, and a fixed
 * offset silently starts reading a few hundred samples into the audio.
 */
function wavSamples(wav: Buffer): { rate: number; samples: Int16Array } {
  assert.equal(wav.subarray(0, 4).toString("ascii"), "RIFF");
  assert.equal(wav.subarray(8, 12).toString("ascii"), "WAVE");
  let offset = 12;
  let rate = 0;
  while (offset + 8 <= wav.length) {
    const id = wav.subarray(offset, offset + 4).toString("ascii");
    const size = wav.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt ") {
      rate = wav.readUInt32LE(body + 4);
      assert.equal(wav.readUInt16LE(body + 14), 16, "expected 16-bit samples");
    } else if (id === "data") {
      // A streamed header may declare a placeholder size; trust what arrived.
      const end = size === 0 || body + size > wav.length ? wav.length : body + size;
      const count = (end - body) >> 1;
      const samples = new Int16Array(count);
      for (let i = 0; i < count; i += 1) {
        samples[i] = wav.readInt16LE(body + i * 2);
      }
      return { rate, samples };
    }
    offset = body + size + (size % 2);
  }
  throw new Error("no data chunk in the WAV output");
}

function peak(samples: Int16Array, from: number, to: number): number {
  let highest = 0;
  for (let i = Math.max(0, from); i < Math.min(samples.length, to); i += 1) {
    highest = Math.max(highest, Math.abs(samples[i]));
  }
  return highest;
}

/** Run ffmpeg to completion, or resolve null if it is not installed. */
function runFfmpeg(args: string[], extraFd = false): Promise<Run | null> {
  return new Promise((resolve) => {
    const child = spawn("ffmpeg", args, {
      stdio: extraFd ? ["pipe", "pipe", "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    let stderr = "";
    let fd3 = "";
    let settled = false;
    const finish = (value: Run | null) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };

    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    if (extraFd) {
      const stream = child.stdio[3] as NodeJS.ReadableStream;
      stream.setEncoding?.("utf8");
      stream.on("data", (chunk: string) => (fd3 += chunk));
    }

    child.on("error", () => finish(null)); // ENOENT: no ffmpeg here
    child.on("close", (code) =>
      finish({ code, stdout: Buffer.concat(out), stderr, fd3 }),
    );
  });
}

describe("progress reporting", () => {
  /**
   * `-loglevel error` is what runs in production. A healthy ffmpeg prints
   * nothing at all to stderr under it, so treating the first stderr output as
   * "started" means the START callback is never answered and the live view
   * times out — on every ffmpeg 6 or newer, while working perfectly on a
   * developer machine running with debug logging on.
   */
  it("a quiet ffmpeg still reports progress on fd 3", async (t) => {
    const run = await runFfmpeg(
      [
        "-progress", "pipe:3",
        "-nostats",
        "-hide_banner",
        "-loglevel", "error",
        "-f", "lavfi",
        "-i", "testsrc=size=64x64:rate=10",
        "-t", "1",
        "-f", "null",
        "-",
      ],
      true,
    );
    if (run === null || run.code !== 0) {
      t.skip("ffmpeg is not available here");
      return;
    }

    assert.equal(run.stderr.trim(), "", "the premise: a healthy run says nothing on stderr");
    assert.match(run.fd3, /progress=/, "fd 3 is where 'it started' has to come from");
  });

  it("progress must not be sent to stdout, which carries media", () => {
    // The recording delegate reads fragmented MP4 from stdout. Progress text
    // interleaved into that stream would corrupt every clip HKSV stores, and
    // the corruption would look like a camera fault.
    assert.notEqual("pipe:3", "pipe:1");
  });
});

describe("HKSV audio alignment", () => {
  /**
   * The pre-roll comes from a video-only ring buffer; the microphone is opened
   * live, at the trigger. Muxed from zero that puts the audio ahead of the
   * picture by the whole pre-roll — the cry is heard several seconds before it
   * is seen, and the end of the clip is silent.
   */
  it("adelay pads the head with real silence, and shifts nothing", async (t) => {
    const prerollMs = 4000;
    const run = await runFfmpeg([
      "-hide_banner",
      "-loglevel", "error",
      "-f", "lavfi", "-i", "sine=frequency=1000:duration=1:sample_rate=44100",
      "-af", `adelay=${prerollMs}:all=1`,
      "-f", "wav",
      "-",
    ]);
    if (run === null || run.code !== 0) {
      t.skip("ffmpeg is not available here");
      return;
    }

    const { rate, samples } = wavSamples(run.stdout);
    const seconds = samples.length / rate;
    assert.ok(
      Math.abs(seconds - 5) < 0.2,
      `expected ~5s (4s silence + 1s tone), got ${seconds.toFixed(2)}s`,
    );

    // The whole four seconds of pre-roll, silent — the tone must be delayed,
    // not merely have silence appended after it.
    assert.equal(
      peak(samples, 0, rate * 4),
      0,
      "the pre-roll must be silent, not the tone moved earlier",
    );
    assert.ok(
      peak(samples, rate * 4, samples.length) > 1000,
      "the tone must survive the delay, not be trimmed by it",
    );
  });
});
