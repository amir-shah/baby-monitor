/**
 * The HKSV pre-roll ring buffer.
 *
 * HomeKit requires at least four seconds of video from *before* the trigger
 * fired, so a recording of a baby waking up starts with the child still
 * asleep. That is only possible if we are continuously buffering while nothing
 * is happening.
 *
 * The design, which follows what scrypted and homebridge-camera-ffmpeg
 * converged on:
 *
 *   1. One long-lived ffmpeg with `-c:v copy` reads the camera's RTSP feed and
 *      muxes it to fragmented MP4 on a local TCP socket. Because it copies
 *      rather than re-encodes, this costs almost no CPU — which matters on a
 *      Pi that may already be software-encoding the source.
 *   2. We parse the box stream, keep `ftyp`/`moov` aside as the init segment,
 *      and push `moof`/`mdat` pairs into a time- and byte-bounded ring.
 *   3. When HomeKit asks for a recording, we replay the init segment, then the
 *      buffered fragments from the requested pre-roll onward, then stay
 *      subscribed to live ones.
 *
 * Two details that are easy to get wrong and produce silent corruption:
 *
 * * Replay **must** begin on a `moof` boundary. Starting mid-fragment
 *   desynchronises the downstream demuxer, which then produces an unplayable
 *   recording rather than an error.
 * * The buffer must be running *before* the trigger. HAP-NodeJS calls
 *   `updateRecordingActive(true)` precisely so the camera can start buffering;
 *   starting it lazily inside `handleRecordingStreamRequest` means the pre-roll
 *   does not exist at the moment it is needed.
 */

import { EventEmitter } from "node:events";
import type { Readable } from "node:stream";

import type { Logger } from "../log.js";
import { FfmpegProcess, LocalSocketSink } from "./ffmpeg.js";
import { type Mp4Box, Mp4ParseError, parseBoxes } from "./mp4.js";

/** One buffered fragment: a `moof`+`mdat` pair with the time it arrived. */
interface BufferedFragment {
  data: Buffer;
  atMs: number;
}

export interface PrebufferOptions {
  ffmpegPath: string;
  /** RTSP (or any ffmpeg-readable) URL of the camera's H.264 feed. */
  sourceUrl: string;
  /** How much history to keep, in milliseconds. */
  durationMs: number;
  /** Hard cap on buffered bytes, so a bitrate spike cannot exhaust RAM. */
  maxBytes: number;
  /** Extra input args, e.g. `-rtsp_transport tcp`. */
  inputArgs?: string[];
  log: Logger;
  debug?: boolean;
}

/**
 * Continuously maintained rolling buffer of fMP4 fragments.
 *
 * Emits `fragment` (Buffer) for every live fragment once running, and `reset`
 * when the upstream restarts and the init segment changes.
 */
export class Prebuffer extends EventEmitter {
  private readonly options: PrebufferOptions;
  private readonly log: Logger;

  private ftyp: Buffer | undefined;
  private moov: Buffer | undefined;
  private fragments: BufferedFragment[] = [];
  private bufferedBytes = 0;

  private process: FfmpegProcess | undefined;
  private sink: LocalSocketSink | undefined;
  private running = false;
  private stopping = false;
  private restartTimer: NodeJS.Timeout | undefined;
  private restartDelayMs = 1000;
  private pending: Buffer[] = [];
  private sawMoof = false;

  /** Rolling estimate of the gap between fragments; drives health reporting. */
  private lastFragmentMs = 0;
  private fragmentIntervalMs = 0;
  private fragmentCount = 0;

  constructor(options: PrebufferOptions) {
    super();
    this.options = options;
    this.log = options.log.child("prebuffer");
    // Several recording sessions may subscribe at once during a handover.
    this.setMaxListeners(24);
  }

  get active(): boolean {
    return this.running;
  }

  /** True once an init segment has been captured and fragments are flowing. */
  get ready(): boolean {
    return this.moov !== undefined && this.fragments.length > 0;
  }

  get stats(): {
    running: boolean;
    ready: boolean;
    fragments: number;
    bytes: number;
    spanMs: number;
    fragmentIntervalMs: number;
  } {
    const first = this.fragments[0];
    const last = this.fragments[this.fragments.length - 1];
    return {
      running: this.running,
      ready: this.ready,
      fragments: this.fragments.length,
      bytes: this.bufferedBytes,
      spanMs: first && last ? last.atMs - first.atMs : 0,
      fragmentIntervalMs: this.fragmentIntervalMs,
    };
  }

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.stopping = false;
    this.log.info(
      `starting rolling buffer (${(this.options.durationMs / 1000).toFixed(1)}s, ` +
        `max ${(this.options.maxBytes / 1024 / 1024).toFixed(0)} MiB)`,
    );
    void this.spawn();
  }

  stop(): void {
    if (!this.running) {
      return;
    }
    this.log.info("stopping rolling buffer");
    this.running = false;
    this.stopping = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
    }
    this.teardown();
    this.clear();
  }

  private clear(): void {
    this.fragments = [];
    this.bufferedBytes = 0;
    this.pending = [];
    this.sawMoof = false;
    this.ftyp = undefined;
    this.moov = undefined;
    this.fragmentCount = 0;
  }

  private teardown(): void {
    this.process?.stop();
    this.process = undefined;
    this.sink?.close();
    this.sink = undefined;
  }

  private async spawn(): Promise<void> {
    if (!this.running) {
      return;
    }
    try {
      const sink = await LocalSocketSink.create();
      this.sink = sink;

      const args = [
        "-hide_banner",
        "-loglevel", this.options.debug ? "info" : "error",
        "-fflags", "+genpts+discardcorrupt",
        ...(this.options.inputArgs ?? []),
        "-i", this.options.sourceUrl,
        "-an",
        "-c:v", "copy",
        "-f", "mp4",
        "-movflags", "frag_keyframe+empty_moov+default_base_moof",
        "-reset_timestamps", "1",
        sink.url,
      ];

      this.process = new FfmpegProcess(this.options.ffmpegPath, {
        args,
        log: this.log,
        label: "ring",
        debug: this.options.debug,
        onExit: () => this.scheduleRestart("ffmpeg exited"),
      });

      const socket = await sink.socket();
      await this.consume(socket);
    } catch (err) {
      if (this.running) {
        this.log.warn(`rolling buffer failed: ${(err as Error).message}`);
      }
      this.scheduleRestart((err as Error).message);
    }
  }

  private async consume(stream: Readable): Promise<void> {
    try {
      for await (const box of parseBoxes(stream)) {
        this.ingest(box);
      }
      this.scheduleRestart("source stream ended");
    } catch (err) {
      if (!this.stopping) {
        const message = err instanceof Mp4ParseError ? err.message : String(err);
        this.scheduleRestart(`parse error: ${message}`);
      }
    }
  }

  private ingest(box: Mp4Box): void {
    const now = Date.now();

    if (box.type === "ftyp") {
      // A fresh ftyp means ffmpeg restarted: the old fragments reference an
      // init segment that no longer describes them, so they must go.
      if (this.moov !== undefined) {
        this.log.debug("source restarted; discarding buffered fragments");
        this.clear();
        this.emit("reset");
      }
      this.ftyp = Buffer.concat([box.header, box.data]);
      return;
    }

    if (box.type === "moov") {
      // Media is genuinely flowing, so the backoff has done its job.
      //
      // It used to reset as soon as ffmpeg connected to our own local socket,
      // which says nothing about the camera: ffmpeg connects, finds the RTSP
      // source down, exits, and the restart is scheduled at the reset delay
      // again — a permanent respawn every second, for as long as the camera
      // stays away. A moov means the source answered.
      this.restartDelayMs = 1000;
      this.moov = Buffer.concat([box.header, box.data]);
      this.log.debug(`captured initialization segment (${this.initializationSegment()?.length} bytes)`);
      return;
    }

    if (box.type === "moof") {
      this.pending = [box.header, box.data];
      this.sawMoof = true;
      return;
    }

    if (box.type === "mdat") {
      if (!this.sawMoof || this.moov === undefined) {
        // An mdat with no preceding moof (or before we have the moov) cannot
        // be replayed; drop it rather than corrupt the ring.
        this.pending = [];
        return;
      }
      this.pending.push(box.header, box.data);
      const fragment = Buffer.concat(this.pending);
      this.pending = [];
      this.sawMoof = false;
      this.push({ data: fragment, atMs: now });
      return;
    }

    // Anything else (`free`, `mfra`, ...) is not part of a fragment.
    this.pending = [];
    this.sawMoof = false;
  }

  private push(fragment: BufferedFragment): void {
    if (this.lastFragmentMs > 0) {
      const gap = fragment.atMs - this.lastFragmentMs;
      // Exponential moving average; the first few samples settle it quickly.
      this.fragmentIntervalMs =
        this.fragmentIntervalMs === 0 ? gap : this.fragmentIntervalMs * 0.8 + gap * 0.2;
    }
    this.lastFragmentMs = fragment.atMs;

    this.fragments.push(fragment);
    this.bufferedBytes += fragment.data.length;
    this.fragmentCount += 1;

    // Trim by age first, then by size. Keeping 1.5x the requested window means
    // there is still a full window left after trimming to a moof boundary.
    const cutoff = fragment.atMs - this.options.durationMs * 1.5;
    while (this.fragments.length > 1 && (this.fragments[0] as BufferedFragment).atMs < cutoff) {
      this.bufferedBytes -= (this.fragments.shift() as BufferedFragment).data.length;
    }
    while (this.fragments.length > 1 && this.bufferedBytes > this.options.maxBytes) {
      this.bufferedBytes -= (this.fragments.shift() as BufferedFragment).data.length;
    }

    if (this.fragmentCount === 1) {
      this.log.info("rolling buffer is live");
    }
    this.emit("fragment", fragment.data);
  }

  private scheduleRestart(reason: string): void {
    if (!this.running || this.restartTimer) {
      return;
    }
    this.teardown();
    this.log.warn(`rolling buffer restarting in ${this.restartDelayMs}ms: ${reason}`);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      // Back off up to 30 s so a camera that is genuinely gone does not spin.
      this.restartDelayMs = Math.min(this.restartDelayMs * 2, 30_000);
      void this.spawn();
    }, this.restartDelayMs);
    this.restartTimer.unref();
  }

  /** `ftyp` + `moov`, the HKSV initialization packet. */
  initializationSegment(): Buffer | undefined {
    if (this.moov === undefined) {
      return undefined;
    }
    return this.ftyp === undefined ? this.moov : Buffer.concat([this.ftyp, this.moov]);
  }

  /**
   * Buffered fragments covering the last `windowMs`, oldest first.
   *
   * Every entry is a complete `moof`+`mdat` pair by construction, so the
   * caller cannot accidentally start replay mid-fragment.
   */
  replay(windowMs: number): Buffer[] {
    const cutoff = Date.now() - windowMs;
    const selected = this.fragments.filter((f) => f.atMs >= cutoff).map((f) => f.data);
    if (selected.length === 0 && this.fragments.length > 0) {
      // The window is shorter than one fragment; send the newest so the
      // recording still starts with a keyframe rather than nothing.
      const last = this.fragments[this.fragments.length - 1];
      return last ? [last.data] : [];
    }
    return selected;
  }

  /** Wait until an init segment and at least one fragment exist. */
  async waitUntilReady(timeoutMs: number): Promise<boolean> {
    if (this.ready) {
      return true;
    }
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.removeListener("fragment", onFragment);
        resolve(this.ready);
      }, timeoutMs);
      timer.unref();
      const onFragment = () => {
        if (this.ready) {
          clearTimeout(timer);
          this.removeListener("fragment", onFragment);
          resolve(true);
        }
      };
      this.on("fragment", onFragment);
    });
  }
}
