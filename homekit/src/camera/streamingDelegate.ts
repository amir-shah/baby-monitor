/**
 * Live camera streaming for the Home app.
 *
 * HomeKit negotiates an SRTP session and then expects RTP on the ports it
 * nominated. We hand the SRTP parameters to ffmpeg, which does the encryption
 * itself. Two details that are quietly load-bearing:
 *
 * * `-srtp_out_params` takes base64 of the **concatenated key and salt**, not
 *   the key alone.
 * * The response echoes HomeKit's own key and salt back unchanged; they are
 *   not ours to generate.
 *
 * There is also an RTCP watchdog: if the Home app goes away without sending a
 * stop (backgrounded, phone off Wi-Fi), nothing else tells us to kill ffmpeg,
 * and an orphaned encoder on a Pi is expensive.
 */

import { createSocket, type Socket as UdpSocket } from "node:dgram";

import {
  AudioStreamingCodecType,
  type CameraController,
  type CameraStreamingDelegate,
  type PrepareStreamCallback,
  type PrepareStreamRequest,
  type PrepareStreamResponse,
  type SnapshotRequest,
  type SnapshotRequestCallback,
  SRTPCryptoSuites,
  type StartStreamRequest,
  type StreamingRequest,
  type StreamRequestCallback,
  StreamRequestTypes,
} from "@homebridge/hap-nodejs";

import type { BabymonApiClient } from "../apiClient.js";
import type { Logger } from "../log.js";
import type { FfmpegCapabilities } from "./ffmpeg.js";
import { FfmpegProcess, reserveUdpPort } from "./ffmpeg.js";

interface SessionInfo {
  address: string;
  ipv6: boolean;
  videoPort: number;
  videoReturnPort: number;
  videoCryptoSuite: SRTPCryptoSuites;
  videoSRTP: Buffer;
  videoSSRC: number;
  audioPort: number;
  audioReturnPort: number;
  audioCryptoSuite: SRTPCryptoSuites;
  audioSRTP: Buffer;
  audioSSRC: number;
}

interface ActiveSession {
  video?: FfmpegProcess;
  returnAudio?: FfmpegProcess;
  watchdog?: UdpSocket;
  timeout?: NodeJS.Timeout;
}

export interface StreamingDelegateOptions {
  ffmpeg: FfmpegCapabilities;
  api: BabymonApiClient;
  log: Logger;
  sourceUrl: string;
  inputArgs: string[];
  copyVideo: boolean;
  maxBitrateKbps: number;
  audioEnabled: boolean;
  audioDevice: string;
  audioBitrateKbps: number;
  twoWayAudio: boolean;
  playbackDevice: string;
  extraArgs: string[];
  debug: boolean;
}

/**
 * How long ffmpeg has to start producing before the stream request fails.
 *
 * Comfortably inside the Home app's own patience, so the user gets a clear
 * failure rather than a spinner that resolves into nothing.
 */
const START_TIMEOUT_MS = 8_000;

/**
 * How long a prepared-but-unstarted session is kept.
 *
 * HomeKit prepares a session and then usually starts it, but not always — the
 * user backs out of the camera tile, the phone leaves the network, the
 * negotiation is abandoned. Nothing ever tells us, and each abandoned session
 * holds two reserved UDP ports and its SRTP keys in a map that only ever
 * grows. On a bridge that runs for months, that is a leak with the shape of a
 * slow memory exhaustion.
 */
const PREPARED_TTL_MS = 60_000;

/** Fallback image when the camera is not producing frames yet. */
const PLACEHOLDER_JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a" +
    "HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA" +
    "AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==",
  "base64",
);

export class BabymonStreamingDelegate implements CameraStreamingDelegate {
  private readonly options: StreamingDelegateOptions;
  private readonly log: Logger;
  private readonly pending = new Map<string, SessionInfo>();
  private readonly pendingTimers = new Map<string, NodeJS.Timeout>();
  private readonly active = new Map<string, ActiveSession>();

  controller: CameraController | undefined;

  constructor(options: StreamingDelegateOptions) {
    this.options = options;
    this.log = options.log.child("stream");
  }

  // -- snapshots ------------------------------------------------------------

  handleSnapshotRequest(request: SnapshotRequest, callback: SnapshotRequestCallback): void {
    // HAP-NodeJS warns after 5 s and gives up at 15 s, so the client has its
    // own tighter deadline and falls back to a placeholder rather than letting
    // the Home app show a spinner.
    this.options.api
      .snapshot(request.width, request.height)
      .then((jpeg) => callback(undefined, jpeg))
      .catch((err) => {
        this.log.warn(`snapshot failed: ${(err as Error).message}`);
        callback(undefined, PLACEHOLDER_JPEG);
      });
  }

  // -- session setup --------------------------------------------------------

  async prepareStream(
    request: PrepareStreamRequest,
    callback: PrepareStreamCallback,
  ): Promise<void> {
    try {
      const videoReturnPort = await reserveUdpPort();
      const audioReturnPort = await reserveUdpPort();
      const videoSSRC = (
        this.controller?.constructor as unknown as { generateSynchronisationSource(): number }
      ).generateSynchronisationSource();
      const audioSSRC = (
        this.controller?.constructor as unknown as { generateSynchronisationSource(): number }
      ).generateSynchronisationSource();

      const session: SessionInfo = {
        address: request.targetAddress,
        ipv6: request.addressVersion === "ipv6",
        videoPort: request.video.port,
        videoReturnPort,
        videoCryptoSuite: request.video.srtpCryptoSuite,
        // ffmpeg wants base64(key || salt) — not the key on its own.
        videoSRTP: Buffer.concat([request.video.srtp_key, request.video.srtp_salt]),
        videoSSRC,
        audioPort: request.audio.port,
        audioReturnPort,
        audioCryptoSuite: request.audio.srtpCryptoSuite,
        audioSRTP: Buffer.concat([request.audio.srtp_key, request.audio.srtp_salt]),
        audioSSRC,
      };
      this.pending.set(request.sessionID, session);
      const expiry = setTimeout(() => this.dropPending(request.sessionID, true), PREPARED_TTL_MS);
      expiry.unref?.();
      this.pendingTimers.set(request.sessionID, expiry);

      const response: PrepareStreamResponse = {
        video: {
          port: videoReturnPort,
          ssrc: videoSSRC,
          // Echo HomeKit's own keying material straight back.
          srtp_key: request.video.srtp_key,
          srtp_salt: request.video.srtp_salt,
        },
        audio: {
          port: audioReturnPort,
          ssrc: audioSSRC,
          srtp_key: request.audio.srtp_key,
          srtp_salt: request.audio.srtp_salt,
        },
      };
      callback(undefined, response);
    } catch (err) {
      this.log.error("failed to prepare a stream", err);
      callback(err as Error);
    }
  }

  /** Forget a prepared session, cancelling its expiry. */
  private dropPending(sessionId: string, expired = false): void {
    const timer = this.pendingTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.pendingTimers.delete(sessionId);
    }
    if (this.pending.delete(sessionId) && expired) {
      this.log.debug(`prepared stream ${sessionId.substring(0, 8)} was never started; dropped`);
    }
  }

  handleStreamRequest(request: StreamingRequest, callback: StreamRequestCallback): void {
    switch (request.type) {
      case StreamRequestTypes.START:
        this.startStream(request, callback);
        break;
      case StreamRequestTypes.RECONFIGURE:
        // Restarting ffmpeg to honour a mid-stream bitrate change causes a
        // visible stall for a change the viewer will not notice.
        this.log.debug("ignoring reconfigure request");
        callback();
        break;
      case StreamRequestTypes.STOP:
        this.stopStream(request.sessionID);
        callback();
        break;
    }
  }

  private startStream(request: StartStreamRequest, callback: StreamRequestCallback): void {
    const session = this.pending.get(request.sessionID);
    if (!session) {
      callback(new Error(`no prepared session ${request.sessionID}`));
      return;
    }
    this.dropPending(request.sessionID);

    const { video, audio } = request;
    const bitrate = Math.min(video.max_bit_rate, this.options.maxBitrateKbps);
    const mtu = video.mtu > 0 ? video.mtu : session.ipv6 ? 1228 : 1378;

    this.log.info(
      `starting stream ${request.sessionID.substring(0, 8)}: ` +
        `${video.width}x${video.height}@${video.fps} ${bitrate} kbit/s`,
    );

    const args: string[] = [
      "-hide_banner",
      "-loglevel", this.options.debug ? "info" : "error",
      ...this.options.inputArgs,
      "-i", this.options.sourceUrl,
      "-an", "-sn", "-dn",
      "-map", "0:v:0",
    ];

    if (this.options.copyVideo) {
      // The source is already H.264 at a HomeKit-compatible profile, so pass
      // it through. On a Pi this is the difference between an idle CPU and a
      // busy one whenever anyone opens the Home app.
      args.push("-c:v", "copy");
    } else {
      args.push(
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-tune", "zerolatency",
        "-pix_fmt", "yuv420p",
        "-profile:v", "high",
        "-vf", `scale='min(${video.width},iw)':'min(${video.height},ih)':force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2`,
        "-r", String(video.fps),
        "-b:v", `${bitrate}k`,
        "-maxrate", `${bitrate}k`,
        "-bufsize", `${bitrate * 2}k`,
        // HomeKit's own comment says the minimum keyframe interval is about
        // five seconds; matching it keeps the stream joinable.
        "-force_key_frames", "expr:gte(t,n_forced*4)",
        "-sc_threshold", "0",
      );
    }

    args.push(
      "-payload_type", String(video.pt),
      "-ssrc", String(session.videoSSRC),
      "-f", "rtp",
    );
    const videoScheme = this.srtpArgs(args, session.videoCryptoSuite, session.videoSRTP);
    args.push(
      `${videoScheme}://${session.address}:${session.videoPort}` +
        `?rtcpport=${session.videoPort}&pkt_size=${mtu}`,
    );

    const wantsAudio =
      this.options.audioEnabled &&
      (audio.codec === AudioStreamingCodecType.OPUS ||
        audio.codec === AudioStreamingCodecType.AAC_ELD);

    if (wantsAudio) {
      const usingOpus = audio.codec === AudioStreamingCodecType.OPUS;
      if (usingOpus && !this.options.ffmpeg.libopus) {
        this.log.warn("HomeKit asked for Opus but this ffmpeg has no libopus; streaming video only");
      } else if (!usingOpus && !this.options.ffmpeg.libfdkAac) {
        this.log.warn(
          "HomeKit asked for AAC-ELD but this ffmpeg has no libfdk_aac; streaming video only",
        );
      } else {
        args.push("-f", "alsa", "-i", this.options.audioDevice, "-map", "1:a:0");
        if (usingOpus) {
          args.push("-c:a", "libopus", "-application", "lowdelay");
        } else {
          args.push("-c:a", "libfdk_aac", "-profile:a", "aac_eld");
        }
        args.push(
          "-flags", "+global_header",
          // AudioStreamingSamplerate really is kHz here, unlike its
          // recording-side namesake, which is an index.
          "-ar", `${audio.sample_rate}k`,
          "-b:a", `${Math.min(audio.max_bit_rate, this.options.audioBitrateKbps)}k`,
          "-ac", String(audio.channel),
          "-payload_type", String(audio.pt),
          "-ssrc", String(session.audioSSRC),
          "-f", "rtp",
        );
        const audioScheme = this.srtpArgs(args, session.audioCryptoSuite, session.audioSRTP);
        args.push(
          // Audio uses a small fixed packet size, not the video MTU.
          `${audioScheme}://${session.address}:${session.audioPort}` +
            `?rtcpport=${session.audioPort}&pkt_size=188`,
        );
      }
    }

    args.push(...this.options.extraArgs);

    const active: ActiveSession = {};
    let answered = false;
    const answer = (err?: Error) => {
      if (!answered) {
        answered = true;
        callback(err);
      }
    };

    active.video = new FfmpegProcess(this.options.ffmpeg.path, {
      args,
      log: this.log,
      label: `live-${request.sessionID.substring(0, 6)}`,
      debug: this.options.debug,
      // Answer once ffmpeg is actually producing, not when spawn() returns.
      onStart: () => answer(),
      // A camera that accepts the connection and then says nothing would
      // otherwise leave the Home app spinning until it gave up on its own,
      // with the process still running behind it. Fail the request instead,
      // so iOS can retry against a clean slate.
      startTimeoutMs: START_TIMEOUT_MS,
      onStartTimeout: () => {
        answer(new Error("ffmpeg produced no output; the camera may be unreachable"));
        this.forceStop(request.sessionID);
      },
      onExit: (code) => {
        if (!answered) {
          answer(new Error(`ffmpeg exited with code ${code} before streaming`));
        } else if (this.active.has(request.sessionID)) {
          this.log.warn(`stream ${request.sessionID.substring(0, 8)} ended unexpectedly`);
          this.forceStop(request.sessionID);
        }
      },
    });

    active.watchdog = this.startWatchdog(request.sessionID, session.videoReturnPort);
    this.active.set(request.sessionID, active);

    if (this.options.twoWayAudio) {
      this.startReturnAudio(request.sessionID, session, request, active);
    }
  }

  /**
   * Append the SRTP flags and return the URL scheme to use.
   *
   * ffmpeg only implements `AES_CM_128_HMAC_SHA1_80`, so the 256-bit suite is
   * never advertised. `NONE` exists for packet capture during development and
   * is not something iOS will select.
   */
  private srtpArgs(args: string[], suite: SRTPCryptoSuites, keyAndSalt: Buffer): "rtp" | "srtp" {
    if (suite === SRTPCryptoSuites.NONE) {
      return "rtp";
    }
    const name =
      suite === SRTPCryptoSuites.AES_CM_256_HMAC_SHA1_80
        ? "AES_CM_256_HMAC_SHA1_80"
        : "AES_CM_128_HMAC_SHA1_80";
    args.push("-srtp_out_suite", name, "-srtp_out_params", keyAndSalt.toString("base64"));
    return "srtp";
  }

  /**
   * Kill the stream when RTCP stops arriving.
   *
   * The Home app does not always send a STOP — if it is backgrounded or the
   * phone leaves the network, the only signal is that its RTCP receiver
   * reports go quiet.
   */
  private startWatchdog(sessionId: string, port: number): UdpSocket {
    const socket = createSocket("udp4");
    const arm = () => {
      const entry = this.active.get(sessionId);
      if (!entry) {
        return;
      }
      if (entry.timeout) {
        clearTimeout(entry.timeout);
      }
      entry.timeout = setTimeout(() => {
        this.log.info(`stream ${sessionId.substring(0, 8)} went quiet; stopping`);
        this.forceStop(sessionId);
      }, 5000);
      entry.timeout.unref();
    };
    socket.on("message", arm);
    // A bind failure cannot be shrugged off. The port was reserved and then
    // released before this bind, so another process can take it in between —
    // and a watchdog that never binds never hears RTCP, never fires, and the
    // stream it was supposed to end runs until something else notices. That
    // "something else" does not exist: the Home app backgrounds, the phone
    // leaves the network, and an ffmpeg encoder stays on the Pi for ever.
    // Ending the session is the safe failure.
    socket.on("error", (err) => {
      this.log.warn(`watchdog socket for ${sessionId.substring(0, 8)}: ${err.message}`);
      this.forceStop(sessionId);
    });
    socket.bind(port, () => arm());
    return socket;
  }

  private startReturnAudio(
    sessionId: string,
    session: SessionInfo,
    request: StartStreamRequest,
    active: ActiveSession,
  ): void {
    if (!this.options.ffmpeg.libfdkAac) {
      this.log.warn("two-way audio needs libfdk_aac to decode AAC-ELD; talkback disabled");
      return;
    }
    const args = [
      "-hide_banner",
      "-loglevel", this.options.debug ? "info" : "error",
      // Without `crypto` in the whitelist ffmpeg refuses the a=crypto line.
      "-protocol_whitelist", "pipe,udp,rtp,file,crypto",
      "-f", "sdp",
      "-c:a", "libfdk_aac",
      "-i", "pipe:0",
      "-f", "alsa",
      this.options.playbackDevice,
    ];
    const returnProcess = new FfmpegProcess(this.options.ffmpeg.path, {
      args,
      log: this.log,
      label: `talk-${sessionId.substring(0, 6)}`,
      debug: this.options.debug,
    });
    const ipVersion = session.ipv6 ? "IP6" : "IP4";
    // The config= blob is the AAC-ELD AudioSpecificConfig for 16 kHz mono; it
    // is only correct at that rate, which is why the rate is pinned here.
    const sdp =
      "v=0\r\n" +
      `o=- 0 0 IN ${ipVersion} ${session.address}\r\n` +
      "s=Talk\r\n" +
      `c=IN ${ipVersion} ${session.address}\r\n` +
      "t=0 0\r\n" +
      `m=audio ${session.audioReturnPort} RTP/AVP ${request.audio.pt}\r\n` +
      "b=AS:24\r\n" +
      `a=rtpmap:${request.audio.pt} MPEG4-GENERIC/16000/1\r\n` +
      "a=rtcp-mux\r\n" +
      `a=fmtp:${request.audio.pt} profile-level-id=1;mode=AAC-hbr;sizelength=13;` +
      "indexlength=3;indexdeltalength=3;config=F8F0212C00BC00\r\n" +
      `a=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:${session.audioSRTP.toString("base64")}\r\n`;
    returnProcess.stdin.end(sdp);
    active.returnAudio = returnProcess;
  }

  private stopStream(sessionId: string): void {
    const session = this.active.get(sessionId);
    if (!session) {
      return;
    }
    this.active.delete(sessionId);
    if (session.timeout) {
      clearTimeout(session.timeout);
    }
    session.video?.stop();
    session.returnAudio?.stop();
    try {
      session.watchdog?.close();
    } catch {
      /* already closed */
    }
    this.log.debug(`stopped stream ${sessionId.substring(0, 8)}`);
  }

  /** Stop and tell HAP-NodeJS, for a failure the controller does not know about. */
  private forceStop(sessionId: string): void {
    this.stopStream(sessionId);
    this.controller?.forceStopStreamingSession(sessionId);
  }

  shutdown(): void {
    for (const sessionId of [...this.active.keys()]) {
      this.stopStream(sessionId);
    }
    for (const timer of this.pendingTimers.values()) {
      clearTimeout(timer);
    }
    this.pendingTimers.clear();
    this.pending.clear();
  }

  get activeSessions(): number {
    return this.active.size;
  }
}
