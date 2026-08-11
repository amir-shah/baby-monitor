/**
 * Tests for the HKSV enum translation.
 *
 * HAP-NodeJS has two sample-rate enums that look alike and behave differently:
 *
 *   AudioStreamingSamplerate  KHZ_8 = 8,  KHZ_16 = 16, KHZ_24 = 24    real kHz
 *   AudioRecordingSamplerate  KHZ_8 = 0,  KHZ_16 = 1,  KHZ_24 = 2,
 *                             KHZ_32 = 3, KHZ_44_1 = 4, KHZ_48 = 5    an index
 *
 * Pass the recording one straight to ffmpeg and you get `-ar 3`, which is not
 * an error — ffmpeg accepts it, produces silence, and HKSV stores a clip with
 * no usable audio. Nothing anywhere reports a problem. Hence this file.
 *
 * The same applies to H264Profile and H264Level, whose values are TLV indices
 * (LEVEL4_0 === 2) and not level numbers.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  AudioRecordingSamplerate,
  AudioStreamingSamplerate,
  H264Level,
  H264Profile,
} from "@homebridge/hap-nodejs";

import type { Mp4Unit } from "../src/camera/mp4.js";
import {
  LEVEL_NAMES,
  PROFILE_NAMES,
  samplerateHz,
  toPackets,
} from "../src/camera/recordingDelegate.js";

describe("the two sample-rate enums", () => {
  it("recording rates are indices, not kilohertz", () => {
    // If this ever stops being true the translation below is dead code, and
    // the test should fail loudly rather than quietly keep passing.
    assert.equal(AudioRecordingSamplerate.KHZ_8, 0);
    assert.equal(AudioRecordingSamplerate.KHZ_16, 1);
    assert.equal(AudioRecordingSamplerate.KHZ_24, 2);
    assert.equal(AudioRecordingSamplerate.KHZ_32, 3);
    assert.equal(AudioRecordingSamplerate.KHZ_44_1, 4);
    assert.equal(AudioRecordingSamplerate.KHZ_48, 5);
  });

  it("streaming rates really are kilohertz", () => {
    assert.equal(AudioStreamingSamplerate.KHZ_8, 8);
    assert.equal(AudioStreamingSamplerate.KHZ_16, 16);
    assert.equal(AudioStreamingSamplerate.KHZ_24, 24);
  });

  it("the two are not interchangeable", () => {
    // KHZ_16 is 1 on one side and 16 on the other. Using the wrong constant
    // compiles, runs, and produces silence.
    assert.notEqual(
      Number(AudioRecordingSamplerate.KHZ_16),
      Number(AudioStreamingSamplerate.KHZ_16),
    );
  });
});

describe("samplerateHz", () => {
  it("translates every recording index to a real rate in Hz", () => {
    assert.equal(samplerateHz(AudioRecordingSamplerate.KHZ_8), 8000);
    assert.equal(samplerateHz(AudioRecordingSamplerate.KHZ_16), 16000);
    assert.equal(samplerateHz(AudioRecordingSamplerate.KHZ_24), 24000);
    assert.equal(samplerateHz(AudioRecordingSamplerate.KHZ_32), 32000);
    assert.equal(samplerateHz(AudioRecordingSamplerate.KHZ_44_1), 44100);
    assert.equal(samplerateHz(AudioRecordingSamplerate.KHZ_48), 48000);
  });

  it("never returns the index it was given", () => {
    // The failure mode this whole file exists for: -ar 3 instead of -ar 32000.
    for (const value of [0, 1, 2, 3, 4, 5]) {
      const hz = samplerateHz(value as AudioRecordingSamplerate);
      assert.notEqual(hz, value);
      assert.ok(hz >= 8000, `rate ${hz} for index ${value} is implausibly low`);
    }
  });

  it("refuses an index it does not know rather than guessing", () => {
    assert.throws(() => samplerateHz(99 as AudioRecordingSamplerate), /samplerate/);
  });
});

describe("H.264 profile and level tables", () => {
  it("profile values are TLV indices into the ffmpeg name table", () => {
    assert.equal(H264Profile.BASELINE, 0);
    assert.equal(H264Profile.MAIN, 1);
    assert.equal(H264Profile.HIGH, 2);
    assert.equal(PROFILE_NAMES[H264Profile.BASELINE], "baseline");
    assert.equal(PROFILE_NAMES[H264Profile.MAIN], "main");
    assert.equal(PROFILE_NAMES[H264Profile.HIGH], "high");
  });

  it("level values are indices, not level numbers", () => {
    // LEVEL4_0 is 2. Handing that to `-level:v` would request level 2.0.
    assert.equal(H264Level.LEVEL3_1, 0);
    assert.equal(H264Level.LEVEL3_2, 1);
    assert.equal(H264Level.LEVEL4_0, 2);
    assert.equal(LEVEL_NAMES[H264Level.LEVEL3_1], "3.1");
    assert.equal(LEVEL_NAMES[H264Level.LEVEL3_2], "3.2");
    assert.equal(LEVEL_NAMES[H264Level.LEVEL4_0], "4.0");
  });

  it("the tables cover every enum member", () => {
    const profiles = Object.values(H264Profile).filter((v) => typeof v === "number");
    const levels = Object.values(H264Level).filter((v) => typeof v === "number");
    assert.equal(PROFILE_NAMES.length, profiles.length);
    assert.equal(LEVEL_NAMES.length, levels.length);
  });
});

describe("toPackets", () => {
  const init = (): Mp4Unit => ({
    kind: "initialization",
    data: Buffer.from("init"),
    types: ["ftyp", "moov"],
  });
  const fragment = (n: number): Mp4Unit => ({
    kind: "fragment",
    data: Buffer.from(`frag${n}`),
    types: ["moof", "mdat"],
  });

  async function* stream(...units: Mp4Unit[]): AsyncGenerator<Mp4Unit> {
    for (const unit of units) {
      yield unit;
    }
  }

  const collect = async (source: AsyncIterable<Mp4Unit>, stop: () => boolean = () => false) => {
    const out = [];
    for await (const packet of toPackets(source, stop)) {
      out.push(packet);
    }
    return out;
  };

  it("marks a last packet when the source ends on its own", async () => {
    // The bug: ffmpeg exits, the generator returns having never set isLast,
    // and HAP-NodeJS discards the whole recording. Not a short clip in the
    // Home app — no clip at all, for a moment something happened in the room.
    const packets = await collect(stream(init(), fragment(1), fragment(2), fragment(3)));
    assert.equal(packets.filter((p) => p.isLast).length, 1);
    assert.equal(packets.at(-1)?.isLast, true);
  });

  it("delivers every fragment exactly once and in order", async () => {
    const packets = await collect(stream(init(), fragment(1), fragment(2), fragment(3)));
    const fragments = packets.filter((p) => p.isFragment).map((p) => p.data.toString());
    assert.deepEqual(fragments, ["frag1", "frag2", "frag3"]);
  });

  it("the initialization segment comes first and is never the last packet", async () => {
    const packets = await collect(stream(init(), fragment(1)));
    assert.equal(packets[0]?.isFragment, false);
    assert.equal(packets[0]?.isLast, false);
  });

  it("stops early when told to, without emitting the fragment it was holding", async () => {
    let seen = 0;
    const packets = await collect(stream(init(), fragment(1), fragment(2), fragment(3)), () => {
      seen += 1;
      return seen >= 2;
    });
    const fragments = packets.filter((p) => p.isFragment).map((p) => p.data.toString());
    assert.deepEqual(fragments, ["frag1", "frag2"]);
    assert.equal(packets.at(-1)?.isLast, true);
  });

  it("a single fragment is still closed off", async () => {
    const packets = await collect(stream(init(), fragment(1)));
    assert.equal(packets.length, 2);
    assert.equal(packets[1]?.isLast, true);
  });

  it("an init segment with no fragments has nothing to close", async () => {
    // Marking the init as last would claim a recording that has no media in it.
    const packets = await collect(stream(init()));
    assert.deepEqual(packets.map((p) => p.isLast), [false]);
  });

  it("an empty source yields nothing at all", async () => {
    assert.deepEqual(await collect(stream()), []);
  });
});
