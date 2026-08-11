/**
 * The HomeKit accessory: camera, sensors and tag switches.
 *
 * Published as a **standalone** accessory rather than behind a bridge. That is
 * not a stylistic choice — HomeKit Secure Video is unreliable to
 * non-functional for bridged cameras, and every shipping implementation
 * publishes cameras externally for exactly this reason.
 *
 * The sensor services are more than decoration. `sensors: { motion: true }` is
 * what makes `EventTriggerOption.MOTION` appear in the accessory's advertised
 * recording configuration; without it the home hub has no reason ever to open
 * a recording stream, and HKSV silently never records.
 */

import {
  Accessory,
  AudioBitrate,
  AudioRecordingCodecType,
  AudioRecordingSamplerate,
  AudioStreamingCodecType,
  AudioStreamingSamplerate,
  CameraController,
  type CameraControllerOptions,
  Categories,
  Characteristic,
  H264Level,
  H264Profile,
  MediaContainerType,
  Service,
  SRTPCryptoSuites,
  uuid,
  VideoCodecType,
} from "@homebridge/hap-nodejs";

import type { BabymonApiClient, HomeKitState } from "./apiClient.js";
import { BabymonRecordingDelegate } from "./camera/recordingDelegate.js";
import { Prebuffer } from "./camera/prebuffer.js";
import { BabymonStreamingDelegate } from "./camera/streamingDelegate.js";
import type { FfmpegCapabilities } from "./camera/ffmpeg.js";
import type { BridgeConfig } from "./config.js";
import { readVersion } from "./config.js";
import type { Logger } from "./log.js";

export interface BuiltAccessory {
  accessory: Accessory;
  controller: CameraController;
  streaming: BabymonStreamingDelegate;
  recording: BabymonRecordingDelegate | undefined;
  shutdown: () => void;
}

export function buildAccessory(
  config: BridgeConfig,
  api: BabymonApiClient,
  ffmpeg: FfmpegCapabilities,
  log: Logger,
): BuiltAccessory {
  const accessory = new Accessory(config.name, uuid.generate(`babymon:${config.username}`));
  accessory.category = Categories.IP_CAMERA;

  accessory
    .getService(Service.AccessoryInformation)!
    .setCharacteristic(Characteristic.Manufacturer, "babymon")
    .setCharacteristic(Characteristic.Model, "Nursery Monitor")
    .setCharacteristic(Characteristic.SerialNumber, config.username.replace(/:/g, ""))
    .setCharacteristic(Characteristic.FirmwareRevision, readVersion());

  const streaming = new BabymonStreamingDelegate({
    ffmpeg,
    api,
    log,
    sourceUrl: config.video.sourceUrl,
    // Localhost RTSP over UDP loses packets under load and tears frames; TCP
    // costs nothing over the loopback interface.
    inputArgs: config.video.sourceUrl.startsWith("rtsp://")
      ? ["-rtsp_transport", "tcp", "-fflags", "+genpts", "-use_wallclock_as_timestamps", "1"]
      : ["-fflags", "+genpts"],
    copyVideo: config.video.copyVideo,
    maxBitrateKbps: config.video.maxBitrateKbps,
    audioEnabled: config.audio.enabled,
    audioDevice: config.audio.device,
    audioBitrateKbps: config.audio.bitrateKbps,
    twoWayAudio: config.audio.twoWay,
    playbackDevice: config.audio.playbackDevice,
    extraArgs: config.video.extraArgs,
    debug: config.video.debug,
  });

  let recording: BabymonRecordingDelegate | undefined;
  let prebuffer: Prebuffer | undefined;

  if (config.hksv.enabled) {
    prebuffer = new Prebuffer({
      ffmpegPath: ffmpeg.path,
      sourceUrl: config.video.sourceUrl,
      durationMs: config.hksv.prebufferMs,
      // Roughly 30 seconds at the configured bitrate, with generous headroom
      // so a bitrate spike trims by time rather than exhausting memory.
      maxBytes: Math.max(16 * 1024 * 1024, (config.hksv.maxBitrateKbps * 1000 * 30) / 8),
      inputArgs: config.video.sourceUrl.startsWith("rtsp://")
        ? ["-rtsp_transport", "tcp"]
        : [],
      log,
      debug: config.video.debug,
    });
    recording = new BabymonRecordingDelegate({
      ffmpeg,
      prebuffer,
      log,
      audioDevice: config.audio.device,
      audioEnabled: config.hksv.audio,
      allowCopy: config.video.copyVideo,
      sourceWidth: config.video.maxWidth,
      sourceHeight: config.video.maxHeight,
      stopWhenTriggerClears: config.hksv.stopWhenTriggerClears,
      maxDurationMs: config.hksv.maxDurationMs,
      debug: config.video.debug,
      onRecordingStateChange: (state, detail) => void api.reportRecording(state, detail),
    });
  }

  const options: CameraControllerOptions = {
    // HKSV cameras expose exactly one stream.
    cameraStreamCount: 1,
    delegate: streaming,
    streamingOptions: {
      // ffmpeg only implements the 128-bit suite, so advertising the 256-bit
      // one would let iOS negotiate something we cannot produce.
      supportedCryptoSuites: [SRTPCryptoSuites.AES_CM_128_HMAC_SHA1_80],
      video: {
        codec: {
          profiles: [H264Profile.BASELINE, H264Profile.MAIN, H264Profile.HIGH],
          levels: [H264Level.LEVEL3_1, H264Level.LEVEL3_2, H264Level.LEVEL4_0],
        },
        resolutions: buildResolutions(config.video.maxWidth, config.video.maxHeight, config.video.maxFps),
      },
      audio: {
        twoWayAudio: config.audio.twoWay,
        codecs: buildStreamingCodecs(ffmpeg),
      },
    },
    sensors: {
      // Required for HKSV: this is what puts MOTION into the advertised
      // event-trigger options. Without it the hub never records.
      motion: config.sensors.motion || config.hksv.enabled,
      occupancy: config.sensors.sound,
    },
  };

  if (recording) {
    options.recording = {
      delegate: recording,
      options: {
        prebufferLength: config.hksv.prebufferMs,
        mediaContainerConfiguration: {
          type: MediaContainerType.FRAGMENTED_MP4,
          fragmentLength: config.hksv.fragmentMs,
        },
        video: {
          type: VideoCodecType.H264,
          parameters: {
            profiles: [H264Profile.HIGH],
            levels: [H264Level.LEVEL4_0],
          },
          resolutions: buildResolutions(
            config.hksv.maxWidth,
            config.hksv.maxHeight,
            config.hksv.maxFps,
          ),
        },
        audio: {
          codecs: {
            // AAC-ELD needs libfdk_aac, which Debian's ffmpeg does not ship.
            // Advertising it on a build that cannot produce it gives a camera
            // that pairs and then fails the moment audio is negotiated.
            type: ffmpeg.libfdkAac ? AudioRecordingCodecType.AAC_ELD : AudioRecordingCodecType.AAC_LC,
            audioChannels: 1,
            samplerate: AudioRecordingSamplerate.KHZ_32,
            bitrateMode: AudioBitrate.VARIABLE,
          },
        },
      },
    };
  }

  const controller = new CameraController(options);
  accessory.configureController(controller);
  streaming.controller = controller;
  if (recording) {
    recording.controller = controller;
  }

  const sensors = attachSensors(accessory, controller, config, api, log, recording);

  return {
    accessory,
    controller,
    streaming,
    recording,
    shutdown: () => {
      sensors.dispose();
      streaming.shutdown();
      recording?.shutdown();
      prebuffer?.stop();
    },
  };
}

/**
 * Resolutions to advertise, capped at the source's own.
 *
 * HomeKit requires 1920x1080 and 1280x720 be offered where the camera can
 * manage them, and the 320x240@15 entry is what an Apple Watch picks.
 */
function buildResolutions(
  maxWidth: number,
  maxHeight: number,
  maxFps: number,
): [number, number, number][] {
  const candidates: [number, number, number][] = [
    [1920, 1080, 30],
    [1280, 960, 30],
    [1280, 720, 30],
    [1024, 768, 30],
    [640, 480, 30],
    [640, 360, 30],
    [480, 360, 30],
    [480, 270, 30],
    [320, 240, 30],
    [320, 240, 15],
    [320, 180, 30],
  ];
  const allowed = candidates
    .filter(([w, h]) => w <= maxWidth && h <= maxHeight)
    .map(([w, h, fps]) => [w, h, Math.min(fps, maxFps)] as [number, number, number]);
  // Never advertise an empty list: iOS then cannot select anything and the
  // camera shows as unsupported.
  return allowed.length > 0 ? allowed : [[320, 240, Math.min(15, maxFps)]];
}

function buildStreamingCodecs(ffmpeg: FfmpegCapabilities) {
  const codecs = [];
  if (ffmpeg.libopus) {
    codecs.push({
      type: AudioStreamingCodecType.OPUS,
      audioChannels: 1,
      bitrate: AudioBitrate.VARIABLE,
      // An Apple Watch wants Opus at 16 kHz specifically.
      samplerate: [AudioStreamingSamplerate.KHZ_16, AudioStreamingSamplerate.KHZ_24],
    });
  }
  if (ffmpeg.libfdkAac) {
    codecs.push({
      type: AudioStreamingCodecType.AAC_ELD,
      audioChannels: 1,
      bitrate: AudioBitrate.VARIABLE,
      samplerate: [AudioStreamingSamplerate.KHZ_16, AudioStreamingSamplerate.KHZ_24],
    });
  }
  if (codecs.length === 0) {
    // HAP-NodeJS will substitute a default so that video still works, but the
    // operator should know why the Home app has no sound.
    return [
      {
        type: AudioStreamingCodecType.OPUS,
        audioChannels: 1,
        bitrate: AudioBitrate.VARIABLE,
        samplerate: [AudioStreamingSamplerate.KHZ_16, AudioStreamingSamplerate.KHZ_24],
      },
    ];
  }
  return codecs;
}

// ---------------------------------------------------------------------------

interface SensorHandles {
  dispose: () => void;
}

function attachSensors(
  accessory: Accessory,
  controller: CameraController,
  config: BridgeConfig,
  api: BabymonApiClient,
  log: Logger,
  recording: BabymonRecordingDelegate | undefined,
): SensorHandles {
  const scoped = log.child("sensors");

  const temperature = config.sensors.temperature
    ? accessory.addService(Service.TemperatureSensor, "Nursery Temperature", "temp")
    : undefined;
  const humidity = config.sensors.humidity
    ? accessory.addService(Service.HumiditySensor, "Nursery Humidity", "humidity")
    : undefined;
  // A contact sensor rather than a switch: contact sensors are first-class
  // automation triggers in the Home app, so "if awake after 06:00, turn on the
  // hall light" is expressible without a shortcut.
  const awake = config.sensors.awakeContact
    ? accessory.addService(Service.ContactSensor, "Awake", "awake")
    : undefined;

  const switches = new Map<string, Service>();
  for (const entry of config.tagSwitches) {
    const service = accessory.addService(Service.Switch, entry.label, `tag-${entry.slug}`);
    service
      .getCharacteristic(Characteristic.On)
      .onSet(async (value) => {
        try {
          await api.setTag(entry.slug, Boolean(value));
          scoped.info(`${entry.label} -> ${value ? "on" : "off"}`);
        } catch (err) {
          scoped.warn(`could not record ${entry.slug}: ${(err as Error).message}`);
          throw err;
        }
      });
    switches.set(entry.slug, service);
  }

  const onState = (state: HomeKitState) => {
    if (temperature && state.temp_c !== null) {
      temperature.updateCharacteristic(Characteristic.CurrentTemperature, state.temp_c);
    }
    if (humidity && state.humidity_pct !== null) {
      humidity.updateCharacteristic(
        Characteristic.CurrentRelativeHumidity,
        Math.round(state.humidity_pct),
      );
    }
    if (awake) {
      awake.updateCharacteristic(
        Characteristic.ContactSensorState,
        state.awake
          ? Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
          : Characteristic.ContactSensorState.CONTACT_DETECTED,
      );
    }
    for (const [slug, service] of switches) {
      const on = Boolean(state.tag_switches?.[slug]);
      if (service.getCharacteristic(Characteristic.On).value !== on) {
        // updateCharacteristic, not setCharacteristic: this reflects a change
        // that already happened, and must not call back into the API.
        service.updateCharacteristic(Characteristic.On, on);
      }
    }
  };

  const onMotion = (event: { active: boolean; score: number }) => {
    controller.motionService?.updateCharacteristic(
      Characteristic.MotionDetected,
      event.active,
    );
    if (config.hksv.triggers.includes("motion")) {
      recording?.setTriggerActive(event.active);
    }
    scoped.debug(`motion ${event.active ? "detected" : "cleared"} (${event.score})`);
  };

  const onSound = (event: { active: boolean; label: string | null; confidence: number }) => {
    controller.occupancyService?.updateCharacteristic(
      Characteristic.OccupancyDetected,
      event.active
        ? Characteristic.OccupancyDetected.OCCUPANCY_DETECTED
        : Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED,
    );
    if (config.hksv.triggers.includes("sound")) {
      // HomeKit only knows how to be triggered by motion, so a cry has to
      // arrive as motion for a recording to start. Without this, the one event
      // most worth recording is the one that never is.
      if (event.active) {
        controller.motionService?.updateCharacteristic(Characteristic.MotionDetected, true);
      }
      recording?.setTriggerActive(event.active);
    }
    if (event.label) {
      scoped.debug(`sound ${event.active ? event.label : "cleared"} (${event.confidence})`);
    }
  };

  const onDisconnected = () => {
    // Mark the sensors inactive rather than leaving stale values that look
    // live. StatusActive is exactly what this characteristic is for.
    for (const service of [temperature, humidity, awake]) {
      service?.updateCharacteristic(Characteristic.StatusActive, false);
    }
  };
  const onConnected = () => {
    for (const service of [temperature, humidity, awake]) {
      service?.updateCharacteristic(Characteristic.StatusActive, true);
    }
  };

  api.on("state", onState);
  api.on("motion", onMotion);
  api.on("sound", onSound);
  api.on("disconnected", onDisconnected);
  api.on("connected", onConnected);

  return {
    dispose: () => {
      api.off("state", onState);
      api.off("motion", onMotion);
      api.off("sound", onSound);
      api.off("disconnected", onDisconnected);
      api.off("connected", onConnected);
    },
  };
}
