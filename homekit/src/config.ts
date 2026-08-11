/**
 * Configuration for the HomeKit bridge.
 *
 * There is deliberately no second config file. The bridge asks the Python API
 * for the effective configuration at startup, so `babymon.yaml` stays the one
 * place anything is configured and the two processes cannot drift apart. Only
 * the handful of values needed to *reach* the API come from the environment.
 *
 * If the API is not up yet — systemd starting both at once, a Pi still
 * booting — the bridge waits rather than failing, because a camera accessory
 * that vanishes from the Home app on every reboot is worse than one that takes
 * thirty seconds to appear.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { Logger } from "./log.js";

export interface TagSwitch {
  slug: string;
  label: string;
}

export interface BridgeConfig {
  apiUrl: string;
  apiToken: string | undefined;

  name: string;
  pin: string;
  setupId: string;
  username: string;
  port: number;
  advertiser: "ciao" | "bonjour-hap" | "avahi" | "resolved";
  hapDir: string;
  ffmpegPath: string;

  video: {
    sourceUrl: string;
    copyVideo: boolean;
    maxWidth: number;
    maxHeight: number;
    maxFps: number;
    maxBitrateKbps: number;
    extraArgs: string[];
    debug: boolean;
  };

  audio: {
    enabled: boolean;
    device: string;
    bitrateKbps: number;
    twoWay: boolean;
    playbackDevice: string;
  };

  hksv: {
    enabled: boolean;
    prebufferMs: number;
    fragmentMs: number;
    maxWidth: number;
    maxHeight: number;
    maxFps: number;
    maxBitrateKbps: number;
    audio: boolean;
    triggers: string[];
    /** Stop a recording once the local trigger clears. */
    stopWhenTriggerClears: boolean;
    /** Ceiling on one recording, so a stuck sensor cannot record forever. */
    maxDurationMs: number;
  };

  sensors: {
    temperature: boolean;
    humidity: boolean;
    motion: boolean;
    sound: boolean;
    awakeContact: boolean;
  };

  tagSwitches: TagSwitch[];
  logLevel: "debug" | "info" | "warn" | "error";
}

/** Shape of the subset of `GET /api/config` this bridge reads. */
interface RemoteConfig {
  site?: { name?: string };
  paths?: { hap_dir?: string };
  camera?: { rtsp_url?: string; width?: number; height?: number; fps?: number };
  homekit?: {
    enabled?: boolean;
    name?: string;
    pin?: string;
    setup_id?: string;
    username?: string;
    port?: number;
    advertiser?: string;
    video?: Record<string, unknown>;
    audio?: Record<string, unknown>;
    hksv?: Record<string, unknown>;
    sensors?: Record<string, boolean>;
    tag_switches?: { slug: string; label: string }[];
  };
  logging?: { level?: string };
}

function env(name: string, fallback?: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value === "" ? fallback : value;
}

function num(value: unknown, fallback: number): number {
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return ["1", "true", "yes", "on"].includes(value.toLowerCase());
  }
  return fallback;
}

/**
 * Fetch the effective configuration, waiting for the API to come up.
 *
 * The secrets the API redacts from `/api/config` — the HomeKit PIN above all —
 * have to come from the environment, which is where they belong anyway.
 */
export async function loadConfig(log: Logger): Promise<BridgeConfig> {
  const apiUrl = (env("BABYMON_HOMEKIT__API_URL") ?? env("BABYMON_API_URL") ?? "http://127.0.0.1:8080")
    .replace(/\/+$/, "");
  const apiToken = env("BABYMON_HOMEKIT__API_TOKEN") ?? env("BABYMON_API_TOKEN");

  const remote = await fetchConfig(apiUrl, apiToken, log);
  const hk = remote.homekit ?? {};
  const video = (hk.video ?? {}) as Record<string, unknown>;
  const audio = (hk.audio ?? {}) as Record<string, unknown>;
  const hksv = (hk.hksv ?? {}) as Record<string, unknown>;
  const sensors = hk.sensors ?? {};

  const pin = env("BABYMON_HOMEKIT__PIN") ?? (typeof hk.pin === "string" && hk.pin !== "***" ? hk.pin : undefined);
  if (!pin) {
    throw new Error(
      "no HomeKit setup code. The API redacts it from /api/config, so set " +
        "BABYMON_HOMEKIT__PIN in the bridge's environment (deploy/babymon.env).",
    );
  }
  if (!/^\d{3}-\d{2}-\d{3}$/.test(pin)) {
    throw new Error(`BABYMON_HOMEKIT__PIN must look like 031-45-154, got ${JSON.stringify(pin)}`);
  }

  const username = env("BABYMON_HOMEKIT__USERNAME") ?? hk.username;
  if (!username || !/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(username)) {
    throw new Error(
      `the HomeKit username must be an uppercase MAC-like string, got ${JSON.stringify(username)}`,
    );
  }

  const hapDir = resolve(
    env("BABYMON_PATHS__HAP_DIR") ?? remote.paths?.hap_dir ?? "/var/lib/babymon/hap",
  );

  const sourceUrl =
    env("BABYMON_HOMEKIT__VIDEO__SOURCE_URL") ??
    (typeof video.source_url === "string" ? video.source_url : undefined) ??
    remote.camera?.rtsp_url ??
    "rtsp://127.0.0.1:8554/babymon";

  return {
    apiUrl,
    apiToken,
    name: env("BABYMON_HOMEKIT__NAME") ?? hk.name ?? remote.site?.name ?? "Baby Monitor",
    pin,
    setupId: (env("BABYMON_HOMEKIT__SETUP_ID") ?? hk.setup_id ?? "BBMN").toUpperCase(),
    username,
    port: num(env("BABYMON_HOMEKIT__PORT") ?? hk.port, 51826),
    advertiser: (env("BABYMON_HOMEKIT__ADVERTISER") ?? hk.advertiser ?? "ciao") as BridgeConfig["advertiser"],
    hapDir,
    ffmpegPath: env("BABYMON_FFMPEG_PATH") ?? "ffmpeg",

    video: {
      sourceUrl,
      copyVideo: bool(video.copy_video, true),
      maxWidth: num(video.max_width, 1280),
      maxHeight: num(video.max_height, 720),
      maxFps: num(video.max_fps, 15),
      maxBitrateKbps: num(video.max_bitrate_kbps, 1500),
      extraArgs: Array.isArray(video.extra_args) ? (video.extra_args as string[]) : [],
      debug: bool(env("BABYMON_HOMEKIT__VIDEO__DEBUG") ?? video.debug, false),
    },

    audio: {
      enabled: bool(audio.enabled, true),
      device: (audio.device as string) ?? "default",
      bitrateKbps: num(audio.bitrate_kbps, 24),
      twoWay: bool(audio.two_way, false),
      playbackDevice: (audio.playback_device as string) ?? "default",
    },

    hksv: {
      enabled: bool(hksv.enabled, true),
      // HomeKit's own floor is 4000 ms; anything less and recordings start
      // after the event that triggered them.
      prebufferMs: Math.max(4000, num(hksv.prebuffer_s, 6) * 1000),
      fragmentMs: num(hksv.fragment_ms, 4000),
      maxWidth: num(hksv.max_width, 1920),
      maxHeight: num(hksv.max_height, 1080),
      maxFps: num(hksv.max_fps, 30),
      maxBitrateKbps: num(hksv.max_bitrate_kbps, 2000),
      audio: bool(hksv.audio, true),
      triggers: Array.isArray(hksv.triggers) ? (hksv.triggers as string[]) : ["motion", "sound"],
      stopWhenTriggerClears: bool(hksv.stop_when_trigger_clears, false),
      maxDurationMs: num(hksv.max_duration_s, 300) * 1000,
    },

    sensors: {
      temperature: bool(sensors.temperature, true),
      humidity: bool(sensors.humidity, true),
      // Motion is not merely a sensor: it is what makes HKSV's MOTION event
      // trigger appear at all, so turning it off disables recording entirely.
      motion: bool(sensors.motion, true),
      sound: bool(sensors.sound, true),
      awakeContact: bool(sensors.awake_contact, true),
    },

    tagSwitches: (hk.tag_switches ?? []).filter(
      (entry) => typeof entry?.slug === "string" && typeof entry?.label === "string",
    ),
    logLevel: (env("BABYMON_LOG_LEVEL") ?? remote.logging?.level ?? "info").toLowerCase() as
      BridgeConfig["logLevel"],
  };
}

async function fetchConfig(
  apiUrl: string,
  token: string | undefined,
  log: Logger,
): Promise<RemoteConfig> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const deadline = Date.now() + 120_000;
  let delay = 1000;
  let lastError = "";

  while (Date.now() < deadline) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      try {
        const response = await fetch(`${apiUrl}/api/config`, {
          headers,
          signal: controller.signal,
        });
        if (response.status === 401 || response.status === 403) {
          throw new Error(
            "the API rejected the bridge's credentials. Set BABYMON_HOMEKIT__API_TOKEN " +
              "to a token listed in api.auth.tokens.",
          );
        }
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        return (await response.json()) as RemoteConfig;
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      lastError = (err as Error).message;
      if (lastError.includes("rejected the bridge")) {
        throw err;
      }
      log.info(`waiting for the babymon API at ${apiUrl} (${lastError})`);
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 10_000);
    }
  }
  throw new Error(`the babymon API at ${apiUrl} did not respond within two minutes: ${lastError}`);
}

/** Read package.json for the accessory's firmware revision. */
export function readVersion(): string {
  try {
    const url = new URL("../package.json", import.meta.url);
    const parsed = JSON.parse(readFileSync(url, "utf8")) as { version?: string };
    return parsed.version ?? "1.0.0";
  } catch {
    return "1.0.0";
  }
}
