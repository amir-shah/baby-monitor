/**
 * HomeKit Secure Video recording delegate.
 *
 * The contract HAP-NodeJS enforces, and which this file exists to satisfy:
 *
 * * The first packet yielded MUST be the initialization segment; every packet
 *   after it is one fMP4 fragment beginning with a keyframe.
 * * No fragment may be longer than the negotiated
 *   `mediaContainerConfiguration.fragmentLength`.
 * * `Characteristic.RecordingAudioActive` MUST be honoured — when it is off,
 *   the fragments must contain no audio track at all.
 * * Exactly one packet is yielded with `isLast: true`, and the generator then
 *   returns. After close is signalled we have 10 seconds to return before
 *   HAP-NodeJS logs a resource leak.
 * * Only one recording stream is ever open at a time.
 */

import type { Readable } from "node:stream";

import {
  AudioRecordingCodecType,
  AudioRecordingSamplerate,
  type CameraController,
  type CameraRecordingConfiguration,
  type CameraRecordingDelegate,
  Characteristic,
  H264Level,
  H264Profile,
  type HDSProtocolSpecificErrorReason,
  type RecordingPacket,
} from "@homebridge/hap-nodejs";

import type { Logger } from "../log.js";
import type { FfmpegCapabilities } from "./ffmpeg.js";
import { FfmpegProcess, LocalSocketSink, LocalSocketSource } from "./ffmpeg.js";
import { Mp4ParseError, parseUnits } from "./mp4.js";
import type { Prebuffer } from "./prebuffer.js";

export interface RecordingDelegateOptions {
  ffmpeg: FfmpegCapabilities;
  prebuffer: Prebuffer;
  log: Logger;
  /** Microphone for the recording's audio track, e.g. an ALSA device name. */
  audioDevice: string | undefined;
  /** Include audio at all. HomeKit can still turn it off per-camera. */
  audioEnabled: boolean;
  /** Re-mux instead of re-encoding when the source already matches. */
  allowCopy: boolean;
  /** Native resolution of the source, used to decide whether copy is legal. */
  sourceWidth: number;
  sourceHeight: number;
  /** Stop the recording once the local motion/sound trigger clears. */
  stopWhenTriggerClears: boolean;
  /** Hard ceiling on a single recording, so a stuck trigger cannot run forever. */
  maxDurationMs: number;
  debug?: boolean;
  /** Told when a recording starts and stops, so it can be logged on the timeline. */
  onRecordingStateChange?: (state: "started" | "stopped", detail: Record<string, unknown>) => void;
}

/** ffmpeg profile names, indexed by the H264Profile TLV value. */
const PROFILE_NAMES = ["baseline", "main", "high"] as const;
/** ffmpeg level strings, indexed by the H264Level TLV value. */
const LEVEL_NAMES = ["3.1", "3.2", "4.0"] as const;

/**
 * `AudioRecordingSamplerate` is an *index*, not a rate. `KHZ_32` is the number
 * 3. Passing it straight to ffmpeg yields `-ar 3`, which is the single easiest
 * mistake to make in this API — the live-streaming sample-rate enum next door
 * really does hold kHz values.
 */
function samplerateHz(value: AudioRecordingSamplerate): number {
  switch (value) {
    case AudioRecordingSamplerate.KHZ_8:
      return 8000;
    case AudioRecordingSamplerate.KHZ_16:
      return 16000;
    case AudioRecordingSamplerate.KHZ_24:
      return 24000;
    case AudioRecordingSamplerate.KHZ_32:
      return 32000;
    case AudioRecordingSamplerate.KHZ_44_1:
      return 44100;
    case AudioRecordingSamplerate.KHZ_48:
      return 48000;
    default:
      throw new Error(`unsupported HKSV audio samplerate index ${value}`);
  }
}

interface ActiveSession {
  streamId: number;
  closed: boolean;
  closeReason?: HDSProtocolSpecificErrorReason;
  source?: LocalSocketSource;
  sink?: LocalSocketSink;
  process?: FfmpegProcess;
  detach?: () => void;
}

export class BabymonRecordingDelegate implements CameraRecordingDelegate {
  private readonly options: RecordingDelegateOptions;
  private readonly log: Logger;

  private configuration: CameraRecordingConfiguration | undefined;
  private recordingActive = false;
  private session: ActiveSession | undefined;

  /** Set by the accessory when local motion/sound detection changes. */
  private triggerActive = false;

  /** Wired up by the accessory so we can read RecordingAudioActive. */
  controller: CameraController | undefined;

  constructor(options: RecordingDelegateOptions) {
    this.options = options;
    this.log = options.log.child("hksv");
  }

  // -- state from HomeKit ---------------------------------------------------

  updateRecordingActive(active: boolean): void {
    if (this.recordingActive === active) {
      return;
    }
    this.recordingActive = active;
    this.log.info(`HomeKit ${active ? "enabled" : "disabled"} secure video recording`);
    // The pre-roll only exists if we are buffering before the trigger fires,
    // so the buffer's lifetime is tied to this flag and nothing else.
    if (active) {
      this.options.prebuffer.start();
    } else {
      this.options.prebuffer.stop();
    }
  }

  updateRecordingConfiguration(configuration: CameraRecordingConfiguration | undefined): void {
    this.configuration = configuration;
    if (!configuration) {
      this.log.info("HomeKit cleared the recording configuration");
      return;
    }
    const [width, height, fps] = configuration.videoCodec.resolution;
    this.log.info(
      `HomeKit selected ${width}x${height}@${fps} ` +
        `${PROFILE_NAMES[configuration.videoCodec.parameters.profile] ?? "?"} ` +
        `L${LEVEL_NAMES[configuration.videoCodec.parameters.level] ?? "?"} ` +
        `${configuration.videoCodec.parameters.bitRate} kbit/s, ` +
        `${configuration.mediaContainerConfiguration.fragmentLength} ms fragments, ` +
        `${configuration.prebufferLength} ms pre-roll`,
    );
    // A configuration change mid-recording must not disturb the running
    // stream; the running session captured its own configuration up front.
  }

  /** Local detection state, forwarded by the accessory. */
  setTriggerActive(active: boolean): void {
    this.triggerActive = active;
  }

  get audioAllowedByHomeKit(): boolean {
    const service = this.controller?.recordingManagement?.recordingManagementService;
    if (!service) {
      return false;
    }
    // getCharacteristic() returns an object, which is always truthy — reading
    // `.value` is the whole point. The official example gets this wrong and
    // therefore always includes audio, in violation of the spec.
    return service.getCharacteristic(Characteristic.RecordingAudioActive).value === 1;
  }

  // -- the recording stream -------------------------------------------------

  async *handleRecordingStreamRequest(
    streamId: number,
    signal?: AbortSignal,
  ): AsyncGenerator<RecordingPacket> {
    const configuration = this.configuration;
    if (!configuration) {
      // HAP-NodeJS guarantees this cannot happen, but a wrong guarantee here
      // would mean spawning ffmpeg with undefined arguments.
      this.log.error("recording requested with no negotiated configuration");
      return;
    }

    const session: ActiveSession = { streamId, closed: false };
    this.session = session;
    const startedAt = Date.now();
    let fragmentsSent = 0;
    let bytesSent = 0;

    this.log.info(`recording stream ${streamId} requested`);
    this.options.onRecordingStateChange?.("started", { stream_id: streamId });

    try {
      if (!this.options.prebuffer.active) {
        this.options.prebuffer.start();
      }
      const ready = await this.options.prebuffer.waitUntilReady(8000);
      if (!ready) {
        this.log.warn("rolling buffer is not ready; recording will have no pre-roll");
      }

      const includeAudio = this.options.audioEnabled && this.audioAllowedByHomeKit;
      this.log.debug(`audio ${includeAudio ? "included" : "omitted"} for stream ${streamId}`);

      const source = await LocalSocketSource.create();
      const sink = await LocalSocketSink.create();
      session.source = source;
      session.sink = sink;

      const args = this.buildArgs(configuration, source.url, sink.url, includeAudio);
      const process = new FfmpegProcess(this.options.ffmpeg.path, {
        args,
        log: this.log,
        label: `rec-${streamId}`,
        debug: this.options.debug,
      });
      session.process = process;

      // Feed the replay: init segment, buffered pre-roll, then live fragments.
      void this.pump(session, configuration.prebufferLength);

      const output = (await sink.socket()) as unknown as Readable;

      for await (const unit of parseUnits(output, signal)) {
        if (unit.kind === "initialization") {
          bytesSent += unit.data.length;
          this.log.debug(`stream ${streamId}: initialization segment, ${unit.data.length} bytes`);
          yield { data: unit.data, isLast: false };
          continue;
        }

        fragmentsSent += 1;
        bytesSent += unit.data.length;
        const elapsed = Date.now() - startedAt;
        const isLast = this.shouldFinish(session, signal, elapsed);
        yield { data: unit.data, isLast };
        if (isLast) {
          this.log.info(
            `recording stream ${streamId} finished: ${fragmentsSent} fragments, ` +
              `${(bytesSent / 1024).toFixed(0)} KiB, ${(elapsed / 1000).toFixed(1)}s`,
          );
          return;
        }
      }

      // The stream ended without us marking a last packet — HAP-NodeJS cannot
      // signal end-of-stream to the hub, so say so rather than fail silently.
      this.log.warn(
        `recording stream ${streamId} ended after ${fragmentsSent} fragments ` +
          "without a final packet; the recording may be truncated",
      );
    } catch (err) {
      if (signal?.aborted || session.closed) {
        this.log.debug(`recording stream ${streamId} aborted`);
      } else if (err instanceof Mp4ParseError) {
        this.log.error(`recording stream ${streamId}: ${err.message}`);
      } else {
        this.log.error(`recording stream ${streamId} failed`, err);
      }
    } finally {
      this.teardown(session);
      if (this.session === session) {
        this.session = undefined;
      }
      this.options.onRecordingStateChange?.("stopped", {
        stream_id: streamId,
        fragments: fragmentsSent,
        bytes: bytesSent,
        duration_s: (Date.now() - startedAt) / 1000,
      });
    }
  }

  /**
   * Decide whether the fragment about to be yielded should be the last one.
   *
   * We stop when HomeKit closes the stream, when the abort signal fires, when
   * the local trigger has cleared (if configured), or when the hard duration
   * ceiling is reached. Anything else and HomeKit decides how long to record.
   */
  private shouldFinish(
    session: ActiveSession,
    signal: AbortSignal | undefined,
    elapsedMs: number,
  ): boolean {
    if (session.closed || signal?.aborted) {
      return true;
    }
    if (elapsedMs >= this.options.maxDurationMs) {
      this.log.info(
        `stopping recording at the ${Math.round(this.options.maxDurationMs / 1000)}s ceiling`,
      );
      return true;
    }
    if (this.options.stopWhenTriggerClears && !this.triggerActive) {
      return true;
    }
    return false;
  }

  /** Write the pre-roll and then live fragments into the replay socket. */
  private async pump(session: ActiveSession, prebufferMs: number): Promise<void> {
    const { prebuffer } = this.options;
    try {
      const source = session.source;
      if (!source) {
        return;
      }
      await source.connected();

      const init = prebuffer.initializationSegment();
      if (init) {
        await source.write(init);
      }

      // Snapshot the ring, then subscribe. Subscribing first would let a
      // fragment arrive between the snapshot and the subscription and be sent
      // twice; this order can only ever drop the boundary fragment, which the
      // demuxer handles.
      const replay = prebuffer.replay(prebufferMs);
      for (const fragment of replay) {
        if (session.closed) {
          return;
        }
        await source.write(fragment);
      }
      this.log.debug(
        `stream ${session.streamId}: replayed ${replay.length} buffered fragments ` +
          `(${Math.round(prebufferMs)} ms of pre-roll)`,
      );

      const queue: Buffer[] = [];
      let draining = false;
      const onFragment = (fragment: Buffer) => {
        queue.push(fragment);
        if (draining) {
          return;
        }
        draining = true;
        void (async () => {
          while (queue.length > 0 && !session.closed) {
            const next = queue.shift();
            if (next) {
              await source.write(next);
            }
          }
          draining = false;
        })();
      };
      prebuffer.on("fragment", onFragment);
      session.detach = () => prebuffer.removeListener("fragment", onFragment);
    } catch (err) {
      if (!session.closed) {
        this.log.warn(`replay pump for stream ${session.streamId} failed: ${(err as Error).message}`);
      }
    }
  }

  private buildArgs(
    configuration: CameraRecordingConfiguration,
    inputUrl: string,
    outputUrl: string,
    includeAudio: boolean,
  ): string[] {
    const [width, height, fps] = configuration.videoCodec.resolution;
    const { bitRate, iFrameInterval, profile, level } = configuration.videoCodec.parameters;
    const fragmentMs = configuration.mediaContainerConfiguration.fragmentLength;

    // With `-movflags frag_keyframe` ffmpeg cuts a fragment at every keyframe,
    // so the keyframe interval *is* the fragment length. HKSV accepts shorter
    // fragments but never longer ones, hence the min().
    const gopSeconds = Math.max(0.5, Math.min(fragmentMs, iFrameInterval) / 1000);
    const gopFrames = Math.max(1, Math.round(gopSeconds * fps));

    const canCopy =
      this.options.allowCopy &&
      width === this.options.sourceWidth &&
      height === this.options.sourceHeight;

    const args: string[] = [
      "-hide_banner",
      "-loglevel", this.options.debug ? "info" : "error",
      "-f", "mp4",
      "-i", inputUrl,
    ];

    if (includeAudio && this.options.audioDevice) {
      args.push("-f", "alsa", "-ar", "16000", "-ac", "1", "-i", this.options.audioDevice);
    }

    args.push("-map", "0:v:0");
    if (includeAudio && this.options.audioDevice) {
      args.push("-map", "1:a:0");
    }

    if (canCopy) {
      // The source already carries the negotiated geometry, so re-encoding
      // would burn a Pi core to produce an identical picture. Fragment
      // boundaries then follow the camera's own IDR period.
      args.push("-c:v", "copy");
    } else {
      args.push(
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-tune", "zerolatency",
        "-pix_fmt", "yuv420p",
        "-profile:v", PROFILE_NAMES[profile] ?? "high",
        "-level:v", LEVEL_NAMES[level] ?? "4.0",
        "-b:v", `${bitRate}k`,
        "-maxrate", `${bitRate}k`,
        "-bufsize", `${bitRate * 2}k`,
        "-r", String(fps),
        "-vf", `scale=${width}:${height}`,
        // gte, not eq: an equality test against a float timestamp can miss and
        // silently drop a keyframe, producing an over-long fragment.
        "-force_key_frames", `expr:gte(t,n_forced*${gopSeconds})`,
        "-g", String(gopFrames),
        "-keyint_min", String(gopFrames),
        // Without this, scene-change keyframes create extra short fragments at
        // unpredictable times.
        "-sc_threshold", "0",
      );
    }

    if (includeAudio && this.options.audioDevice) {
      const codec = configuration.audioCodec;
      const rate = samplerateHz(codec.samplerate);
      const wantsEld = codec.type === AudioRecordingCodecType.AAC_ELD;
      if (wantsEld && this.options.ffmpeg.libfdkAac) {
        args.push("-c:a", "libfdk_aac", "-profile:a", "aac_eld");
      } else if (this.options.ffmpeg.libfdkAac) {
        args.push("-c:a", "libfdk_aac", "-profile:a", "aac_low");
      } else {
        // Native ffmpeg AAC cannot produce AAC-ELD, which is why we only ever
        // advertise AAC-LC on a build without libfdk_aac.
        args.push("-c:a", "aac");
      }
      args.push(
        "-ar", String(rate),
        "-b:a", `${codec.bitrate}k`,
        "-ac", String(codec.audioChannels ?? 1),
      );
    } else {
      args.push("-an");
    }

    args.push(
      "-sn", "-dn",
      "-fflags", "+genpts",
      "-reset_timestamps", "1",
      "-f", "mp4",
      "-movflags", "frag_keyframe+empty_moov+default_base_moof",
      "-min_frag_duration", String(Math.round(gopSeconds * 1_000_000)),
      outputUrl,
    );
    return args;
  }

  closeRecordingStream(streamId: number, reason: HDSProtocolSpecificErrorReason | undefined): void {
    const session = this.session;
    this.log.info(
      `HomeKit closed recording stream ${streamId}` +
        (reason === undefined ? "" : ` (reason ${reason})`),
    );
    if (!session || session.streamId !== streamId) {
      return;
    }
    session.closed = true;
    session.closeReason = reason;
    // Tear the pipeline down now so the generator's `for await` ends promptly;
    // HAP-NodeJS complains loudly if we take more than ten seconds.
    this.teardown(session);
  }

  acknowledgeStream(streamId: number): void {
    this.log.debug(`HomeKit acknowledged recording stream ${streamId}`);
  }

  private teardown(session: ActiveSession): void {
    session.detach?.();
    session.detach = undefined;
    session.source?.close();
    session.source = undefined;
    session.process?.stop();
    session.process = undefined;
    session.sink?.close();
    session.sink = undefined;
  }

  /** Called on service shutdown. */
  shutdown(): void {
    if (this.session) {
      this.session.closed = true;
      this.teardown(this.session);
      this.session = undefined;
    }
    this.options.prebuffer.stop();
  }

  get status(): Record<string, unknown> {
    return {
      recording_active: this.recordingActive,
      configured: this.configuration !== undefined,
      streaming: this.session !== undefined,
      audio_allowed: this.audioAllowedByHomeKit,
      prebuffer: this.options.prebuffer.stats,
    };
  }
}

export { PROFILE_NAMES, LEVEL_NAMES, samplerateHz };
export { H264Level, H264Profile };
