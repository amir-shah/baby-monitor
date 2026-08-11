/**
 * babymon HomeKit bridge.
 *
 * Everything about this project is Python except this process, and the reason
 * is narrow: HomeKit Secure Video is only properly implemented in HAP-NodeJS.
 * The Python side owns the sensors, the database and the analytics; this owns
 * the HAP accessory and nothing else.
 *
 * The one hard ordering requirement is the first statement of `main`:
 * `HAPStorage.setCustomStoragePath` must be called before anything touches
 * storage, and it must be given an absolute path. Left unset, HAP-NodeJS
 * resolves `persist` against the current working directory — so a systemd unit
 * with a different WorkingDirectory silently loses every pairing.
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

import { Accessory, HAPStorage, MDNSAdvertiser } from "@homebridge/hap-nodejs";

import { buildAccessory } from "./accessory.js";
import { BabymonApiClient } from "./apiClient.js";
import { probeFfmpeg } from "./camera/ffmpeg.js";
import { loadConfig, readVersion } from "./config.js";
import { createLogger, type Logger } from "./log.js";

async function main(): Promise<void> {
  const bootLog = createLogger(
    (process.env.BABYMON_LOG_LEVEL ?? "info").toLowerCase() as "info",
  );
  bootLog.info(`babymon HomeKit bridge ${readVersion()} on Node ${process.version}`);

  const config = await loadConfig(bootLog);
  const log = createLogger(config.logLevel);

  // Must come before any Accessory is constructed, and must be absolute.
  const hapDir = resolve(config.hapDir);
  mkdirSync(hapDir, { recursive: true });
  HAPStorage.setCustomStoragePath(hapDir);
  log.info(`pairing state in ${hapDir}`);

  const ffmpeg = await probeFfmpeg(config.ffmpegPath);
  log.info(`using ${ffmpeg.version}`);
  reportCodecs(ffmpeg, config.hksv.enabled, log);

  const api = new BabymonApiClient({
    baseUrl: config.apiUrl,
    token: config.apiToken,
    log,
  });
  api.start();

  const built = buildAccessory(config, api, ffmpeg, log);

  built.accessory.publish(
    {
      username: config.username,
      pincode: config.pin,
      port: config.port,
      category: built.accessory.category,
      setupID: config.setupId,
      advertiser: config.advertiser as MDNSAdvertiser,
      // The accessory is named exactly what the user configured; HAP-NodeJS
      // would otherwise append username-derived material to it.
      addIdentifyingMaterial: false,
    },
    false,
  );

  // setupURI() asserts if called before publish().
  const setupUri = built.accessory.setupURI();
  log.info("");
  log.info(`  ${config.name} is ready to pair.`);
  log.info(`  Setup code: ${config.pin}`);
  log.info(`  Setup URI:  ${setupUri}`);
  log.info("");
  if (config.hksv.enabled) {
    log.info(
      "  HomeKit Secure Video is advertised. To use it you need an iCloud+ plan and a " +
        "home hub (Apple TV 4K or HomePod), and you must turn on recording for this " +
        "camera in the Home app: camera settings -> Recording Options.",
    );
  }
  if (config.advertiser === "ciao") {
    log.info(
      "  Note: this Pi probably runs avahi-daemon, which competes with the built-in " +
        "mDNS responder for UDP 5353. If the accessory appears and then vanishes, or " +
        "will not pair, set homekit.advertiser to \"avahi\".",
    );
  }

  installShutdownHandlers(built.accessory, built.shutdown, api, log);
}

function reportCodecs(
  ffmpeg: { libfdkAac: boolean; libopus: boolean; libx264: boolean; h264V4l2m2m: boolean },
  hksv: boolean,
  log: Logger,
): void {
  const present = [
    ffmpeg.libx264 && "libx264",
    ffmpeg.h264V4l2m2m && "h264_v4l2m2m (hardware)",
    ffmpeg.libopus && "libopus",
    ffmpeg.libfdkAac && "libfdk_aac",
  ].filter(Boolean);
  log.info(`ffmpeg codecs: ${present.join(", ") || "none detected"}`);

  if (!ffmpeg.libopus && !ffmpeg.libfdkAac) {
    log.warn(
      "neither libopus nor libfdk_aac is available, so the Home app will have no " +
        "audio. `apt install ffmpeg` normally provides libopus.",
    );
  }
  if (!ffmpeg.libfdkAac) {
    log.info(
      "libfdk_aac is absent (Debian cannot ship it), so live audio will use Opus and " +
        "two-way talkback is unavailable. " +
        (hksv ? "HKSV recordings use AAC-LC, which works on this build." : ""),
    );
  }
  if (!ffmpeg.h264V4l2m2m && !ffmpeg.libx264) {
    log.error("no H.264 encoder at all; video will not work");
  }
}

function installShutdownHandlers(
  accessory: Accessory,
  shutdown: () => void,
  api: BabymonApiClient,
  log: Logger,
): void {
  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) {
      return;
    }
    stopping = true;
    log.info(`received ${signal}; shutting down`);
    try {
      shutdown();
      api.stop();
      accessory.unpublish();
    } catch (err) {
      log.error("error during shutdown", err);
    }
    // Give ffmpeg a moment to die before the process does, so no orphan is
    // left holding the camera.
    setTimeout(() => process.exit(0), 800).unref();
  };

  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("uncaughtException", (err) => {
    log.error("uncaught exception", err);
    stop("uncaughtException");
  });
  process.on("unhandledRejection", (reason) => {
    // Not fatal: a rejected fetch to a briefly-down API must not unpair the
    // camera. Log it and carry on.
    log.error("unhandled rejection", reason);
  });
}

main().catch((err) => {
  process.stderr.write(`[babymon-hk] FATAL ${(err as Error).message}\n`);
  if ((err as Error).stack) {
    process.stderr.write(`${(err as Error).stack}\n`);
  }
  process.exit(1);
});
