/**
 * ffmpeg process management and capability probing.
 *
 * Everything that spawns ffmpeg goes through here so that a) there is one
 * place that knows how to kill a wedged process, and b) the codecs we advertise
 * to HomeKit are the ones this ffmpeg build can actually produce. Advertising
 * AAC-ELD on a build without libfdk_aac gives a camera that pairs, streams
 * video, and silently fails the moment audio is negotiated.
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { createServer, type Server, type Socket } from "node:net";
import { promisify } from "node:util";

import type { Logger } from "../log.js";

const execFileAsync = promisify(execFile);

export interface FfmpegCapabilities {
  path: string;
  version: string;
  /** Non-free AAC encoder; the only way to produce AAC-ELD. */
  libfdkAac: boolean;
  /** Opus encoder, the other codec HomeKit will accept for live audio. */
  libopus: boolean;
  /** Software H.264. Present in essentially every build. */
  libx264: boolean;
  /** Hardware H.264 via V4L2 M2M — present on Pi 4 and earlier, gone on Pi 5. */
  h264V4l2m2m: boolean;
  /** Native AAC-LC encoder; adequate for HKSV recordings. */
  aac: boolean;
}

export async function probeFfmpeg(path = "ffmpeg"): Promise<FfmpegCapabilities> {
  let version = "unknown";
  let encoders = "";
  try {
    const { stdout } = await execFileAsync(path, ["-hide_banner", "-version"], {
      maxBuffer: 4 * 1024 * 1024,
    });
    version = stdout.split("\n", 1)[0] ?? "unknown";
  } catch (err) {
    throw new Error(
      `could not run ffmpeg at ${JSON.stringify(path)}: ${(err as Error).message}. ` +
        "Install it with `sudo apt install ffmpeg`, or set homekit.ffmpeg_path.",
    );
  }
  try {
    const { stdout } = await execFileAsync(path, ["-hide_banner", "-encoders"], {
      maxBuffer: 8 * 1024 * 1024,
    });
    encoders = stdout;
  } catch {
    // A build that refuses -encoders is unusual; assume the common set.
    encoders = "libx264 aac";
  }
  const has = (name: string) => new RegExp(`^\\s*\\S+\\s+${name}\\s`, "m").test(encoders);
  return {
    path,
    version,
    libfdkAac: has("libfdk_aac"),
    libopus: has("libopus"),
    libx264: has("libx264"),
    h264V4l2m2m: has("h264_v4l2m2m"),
    aac: has("aac"),
  };
}

export interface FfmpegOptions {
  args: string[];
  log: Logger;
  label: string;
  /** Log every line of ffmpeg's stderr rather than only errors. */
  debug?: boolean;
  /** Called once the first frame has been produced (first stderr output). */
  onStart?: () => void;
  /** Called when the process exits for any reason. */
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
}

/**
 * A supervised ffmpeg process.
 *
 * `stop()` is safe to call repeatedly and from any state, and escalates to
 * SIGKILL if ffmpeg ignores SIGTERM — which it does when a muxer is blocked
 * writing to a socket nobody is reading.
 */
export class FfmpegProcess {
  readonly label: string;
  private readonly log: Logger;
  private readonly process: ChildProcessWithoutNullStreams;
  private killTimer: NodeJS.Timeout | undefined;
  private stopped = false;
  private started = false;
  private stderrTail: string[] = [];

  constructor(binary: string, options: FfmpegOptions) {
    this.label = options.label;
    this.log = options.log.child(options.label);
    this.log.debug(`ffmpeg ${options.args.join(" ")}`);

    this.process = spawn(binary, options.args, { env: process.env, stdio: "pipe" });

    this.process.stderr.setEncoding("utf8");
    this.process.stderr.on("data", (chunk: string) => {
      if (!this.started) {
        this.started = true;
        options.onStart?.();
      }
      for (const line of chunk.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        // Keep a tail so a non-zero exit can be explained without logging
        // ffmpeg's entire banner on every start.
        this.stderrTail.push(trimmed);
        if (this.stderrTail.length > 20) {
          this.stderrTail.shift();
        }
        if (options.debug) {
          this.log.debug(trimmed);
        } else if (/\b(error|failed|invalid|unable|no such)\b/i.test(trimmed)) {
          this.log.warn(trimmed);
        }
      }
    });

    this.process.on("error", (err) => {
      this.log.error(`failed to start: ${err.message}`);
      options.onExit?.(null, null);
    });

    this.process.on("exit", (code, signal) => {
      if (this.killTimer) {
        clearTimeout(this.killTimer);
        this.killTimer = undefined;
      }
      if (!this.stopped && code !== 0 && code !== null) {
        this.log.warn(`exited with code ${code}`);
        for (const line of this.stderrTail) {
          this.log.warn(`  ${line}`);
        }
      } else {
        this.log.debug(`exited (code=${code} signal=${signal})`);
      }
      options.onExit?.(code, signal);
    });
  }

  get stdin(): NodeJS.WritableStream {
    return this.process.stdin;
  }

  get stdout(): NodeJS.ReadableStream {
    return this.process.stdout;
  }

  get pid(): number | undefined {
    return this.process.pid;
  }

  get running(): boolean {
    return this.process.exitCode === null && !this.process.killed;
  }

  stop(): void {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    if (this.process.exitCode !== null) {
      return;
    }
    try {
      this.process.stdin.destroy();
    } catch {
      /* already gone */
    }
    this.process.kill("SIGTERM");
    // ffmpeg blocked on a socket write ignores SIGTERM entirely.
    this.killTimer = setTimeout(() => {
      if (this.process.exitCode === null) {
        this.log.warn("did not exit on SIGTERM; sending SIGKILL");
        this.process.kill("SIGKILL");
      }
    }, 3000);
    this.killTimer.unref();
  }
}

/**
 * A one-shot local TCP server for an ffmpeg output.
 *
 * ffmpeg writes its fMP4 to `tcp://127.0.0.1:<port>` and we read the accepted
 * socket. This is preferred over `pipe:1`: a `readable.read(n)` consumer against
 * a stdout pipe deadlocks under backpressure, and the socket gives an
 * unambiguous `close` for end-of-stream.
 */
export class LocalSocketSink {
  private readonly server: Server;
  private readonly socketPromise: Promise<Socket>;
  private resolveSocket!: (socket: Socket) => void;
  private rejectSocket!: (err: Error) => void;
  private settled = false;
  private timer: NodeJS.Timeout | undefined;
  private accepted: Socket | undefined;

  private constructor(server: Server, timeoutMs: number) {
    this.server = server;
    this.socketPromise = new Promise<Socket>((resolve, reject) => {
      this.resolveSocket = resolve;
      this.rejectSocket = reject;
    });
    this.timer = setTimeout(() => {
      if (!this.settled) {
        this.settled = true;
        this.rejectSocket(new Error("ffmpeg did not connect to the local sink in time"));
        this.close();
      }
    }, timeoutMs);
    this.timer.unref();

    server.on("connection", (socket) => {
      // Exactly one producer is expected; refuse extras so a stale ffmpeg
      // cannot interleave its output into a live recording.
      if (this.settled) {
        socket.destroy();
        return;
      }
      this.settled = true;
      this.accepted = socket;
      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = undefined;
      }
      socket.on("error", () => {
        /* handled by the consumer */
      });
      this.resolveSocket(socket);
    });
    server.on("error", (err) => {
      if (!this.settled) {
        this.settled = true;
        this.rejectSocket(err);
      }
    });
  }

  static async create(timeoutMs = 15000): Promise<LocalSocketSink> {
    const server = createServer();
    const sink = new LocalSocketSink(server, timeoutMs);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    return sink;
  }

  get port(): number {
    const address = this.server.address();
    if (address === null || typeof address === "string") {
      throw new Error("local sink is not listening on a TCP port");
    }
    return address.port;
  }

  get url(): string {
    return `tcp://127.0.0.1:${this.port}`;
  }

  socket(): Promise<Socket> {
    return this.socketPromise;
  }

  close(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.accepted?.destroy();
    this.server.close();
    if (!this.settled) {
      this.settled = true;
      this.rejectSocket(new Error("local sink closed before ffmpeg connected"));
    }
  }
}

/**
 * A one-shot local TCP server that *feeds* an ffmpeg input.
 *
 * ffmpeg reads `-i tcp://127.0.0.1:<port>`, connecting as a client; we accept
 * and write the replayed fMP4 into the socket. This is how buffered pre-roll
 * gets in front of the live stream without ever touching the filesystem.
 */
export class LocalSocketSource {
  private readonly server: Server;
  private socket: Socket | undefined;
  private readonly ready: Promise<Socket>;
  private resolveReady!: (socket: Socket) => void;
  private rejectReady!: (err: Error) => void;
  private settled = false;
  private closed = false;
  private timer: NodeJS.Timeout | undefined;

  private constructor(server: Server, timeoutMs: number) {
    this.server = server;
    this.ready = new Promise<Socket>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.timer = setTimeout(() => {
      if (!this.settled) {
        this.settled = true;
        this.rejectReady(new Error("ffmpeg did not connect to the replay source in time"));
      }
    }, timeoutMs);
    this.timer.unref();

    server.on("connection", (socket) => {
      if (this.settled) {
        socket.destroy();
        return;
      }
      this.settled = true;
      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = undefined;
      }
      this.socket = socket;
      // ffmpeg closing its input mid-recording is expected on teardown.
      socket.on("error", () => undefined);
      this.resolveReady(socket);
    });
    server.on("error", (err) => {
      if (!this.settled) {
        this.settled = true;
        this.rejectReady(err);
      }
    });
  }

  static async create(timeoutMs = 15000): Promise<LocalSocketSource> {
    const server = createServer();
    const source = new LocalSocketSource(server, timeoutMs);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    return source;
  }

  get port(): number {
    const address = this.server.address();
    if (address === null || typeof address === "string") {
      throw new Error("replay source is not listening on a TCP port");
    }
    return address.port;
  }

  get url(): string {
    return `tcp://127.0.0.1:${this.port}`;
  }

  connected(): Promise<Socket> {
    return this.ready;
  }

  /**
   * Write a buffer, respecting backpressure.
   *
   * Returning a promise matters: a recording that replays six seconds of
   * pre-roll in one go can outrun ffmpeg's reader, and ignoring the drain
   * signal balloons the socket's internal buffer.
   */
  async write(chunk: Buffer): Promise<void> {
    const socket = this.socket;
    if (!socket || socket.destroyed || this.closed) {
      return;
    }
    if (!socket.write(chunk)) {
      await new Promise<void>((resolve) => {
        const done = () => {
          socket.removeListener("drain", done);
          socket.removeListener("close", done);
          resolve();
        };
        socket.once("drain", done);
        socket.once("close", done);
      });
    }
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    // end() rather than destroy() so ffmpeg sees a clean EOF and flushes its
    // final fragment instead of reporting a truncated stream.
    this.socket?.end();
    this.server.close();
    if (!this.settled) {
      this.settled = true;
      this.rejectReady(new Error("replay source closed before ffmpeg connected"));
    }
  }
}

/** Reserve a free UDP port by binding and immediately releasing it. */
export async function reserveUdpPort(): Promise<number> {
  const { createSocket } = await import("node:dgram");
  return new Promise<number>((resolve, reject) => {
    const socket = createSocket("udp4");
    socket.once("error", reject);
    socket.bind(0, "0.0.0.0", () => {
      const port = socket.address().port;
      socket.close(() => resolve(port));
    });
  });
}
