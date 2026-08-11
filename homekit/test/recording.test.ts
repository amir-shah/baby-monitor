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

import { LEVEL_NAMES, PROFILE_NAMES, samplerateHz } from "../src/camera/recordingDelegate.js";

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
