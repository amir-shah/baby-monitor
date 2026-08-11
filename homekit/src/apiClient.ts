/**
 * Client for the babymon Python API.
 *
 * The bridge holds no state of its own: sensor values, detection events and
 * the nightly tag switches all live in the Python service. This keeps the two
 * processes independently restartable — the Home app briefly shows "no
 * response" while the API is down, and everything reconnects on its own.
 */

import { EventEmitter } from "node:events";

import type { Logger } from "./log.js";

export interface HomeKitState {
  child_id: number;
  night_of: string;
  temp_c: number | null;
  humidity_pct: number | null;
  motion: boolean;
  sound: boolean;
  sound_label: string | null;
  awake: boolean;
  sleep_state: string;
  camera_online: boolean;
  audio_online: boolean;
  tag_switches: Record<string, boolean>;
}

export interface MotionEvent {
  active: boolean;
  score: number;
  ts_ms: number;
}

export interface SoundEvent {
  active: boolean;
  label: string | null;
  confidence: number;
  peak_dbfs: number | null;
  ts_ms: number;
}

export interface ApiClientOptions {
  baseUrl: string;
  token?: string | undefined;
  log: Logger;
  /** Timeout for ordinary requests. Snapshots get their own, shorter one. */
  timeoutMs?: number;
}

/**
 * Emits:
 * * `state`      — `HomeKitState`, on every push and poll
 * * `motion`     — `MotionEvent`
 * * `sound`      — `SoundEvent`
 * * `connected` / `disconnected` — SSE link state
 */
export class BabymonApiClient extends EventEmitter {
  private readonly baseUrl: string;
  private readonly token: string | undefined;
  private readonly log: Logger;
  private readonly timeoutMs: number;

  private abort: AbortController | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private reconnectDelayMs = 1000;
  private running = false;
  private connected = false;
  private lastState: HomeKitState | undefined;

  constructor(options: ApiClientOptions) {
    super();
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.token = options.token;
    this.log = options.log.child("api");
    this.timeoutMs = options.timeoutMs ?? 10000;
  }

  get online(): boolean {
    return this.connected;
  }

  get state(): HomeKitState | undefined {
    return this.lastState;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const headers: Record<string, string> = { Accept: "application/json", ...extra };
    if (this.token) {
      headers.Authorization = `Bearer ${this.token}`;
    }
    return headers;
  }

  private async request<T>(path: string, init: RequestInit = {}, timeoutMs?: number): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs ?? this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
        headers: this.headers(init.headers as Record<string, string> | undefined),
      });
      if (!response.ok) {
        throw new Error(`${init.method ?? "GET"} ${path} -> HTTP ${response.status}`);
      }
      return (await response.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  async health(): Promise<{ status: string; version: string }> {
    return this.request("/api/health", {}, 5000);
  }

  async homekitState(): Promise<HomeKitState> {
    const state = await this.request<HomeKitState>("/api/homekit/state");
    this.lastState = state;
    return state;
  }

  /** Current frame as JPEG. Short timeout: the Home app will not wait. */
  async snapshot(width?: number, height?: number): Promise<Buffer> {
    const params = new URLSearchParams();
    if (width) {
      params.set("width", String(width));
    }
    if (height) {
      params.set("height", String(height));
    }
    const query = params.size > 0 ? `?${params.toString()}` : "";
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    try {
      const response = await fetch(`${this.baseUrl}/api/snapshot.jpg${query}`, {
        signal: controller.signal,
        headers: this.token ? { Authorization: `Bearer ${this.token}` } : {},
      });
      if (!response.ok) {
        throw new Error(`snapshot -> HTTP ${response.status}`);
      }
      return Buffer.from(await response.arrayBuffer());
    } finally {
      clearTimeout(timer);
    }
  }

  /** Flip a tag switch. Idempotent server-side, so retries are safe. */
  async setTag(slug: string, on: boolean, childId?: number): Promise<void> {
    await this.request("/api/homekit/tag", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug, on, child_id: childId }),
    });
  }

  /** Record that HKSV started or stopped, so clips line up with the timeline. */
  async reportRecording(
    state: "started" | "stopped",
    detail: Record<string, unknown> = {},
  ): Promise<void> {
    try {
      await this.request("/api/homekit/recording", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state, ...detail }),
      });
    } catch (err) {
      // Losing a log line must never disturb a recording in progress.
      this.log.debug(`could not report recording state: ${(err as Error).message}`);
    }
  }

  // -- server-sent events ---------------------------------------------------

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    void this.connect();
  }

  stop(): void {
    this.running = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.abort?.abort();
    this.abort = undefined;
    this.connected = false;
  }

  private scheduleReconnect(reason: string): void {
    if (!this.running || this.reconnectTimer) {
      return;
    }
    if (this.connected) {
      this.connected = false;
      this.emit("disconnected", reason);
    }
    this.log.debug(`reconnecting to the event stream in ${this.reconnectDelayMs}ms: ${reason}`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 30_000);
      void this.connect();
    }, this.reconnectDelayMs);
    this.reconnectTimer.unref();
  }

  private async connect(): Promise<void> {
    if (!this.running) {
      return;
    }
    const controller = new AbortController();
    this.abort = controller;
    try {
      const response = await fetch(
        `${this.baseUrl}/api/stream/events?types=state,motion,sound`,
        {
          signal: controller.signal,
          headers: this.headers({ Accept: "text/event-stream" }),
        },
      );
      if (!response.ok || !response.body) {
        throw new Error(`event stream -> HTTP ${response.status}`);
      }

      this.connected = true;
      this.reconnectDelayMs = 1000;
      this.log.info("connected to the babymon event stream");
      this.emit("connected");

      // Prime the sensors immediately rather than waiting for the first push.
      void this.homekitState()
        .then((state) => this.emit("state", state))
        .catch(() => undefined);

      await this.readEvents(response.body);
      this.scheduleReconnect("event stream ended");
    } catch (err) {
      if (controller.signal.aborted && !this.running) {
        return;
      }
      this.scheduleReconnect((err as Error).message);
    }
  }

  private async readEvents(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        return;
      }
      buffer += decoder.decode(value, { stream: true });
      // SSE frames are separated by a blank line; a partial frame stays in the
      // buffer until the rest of it arrives.
      let split = buffer.indexOf("\n\n");
      while (split !== -1) {
        this.handleFrame(buffer.slice(0, split));
        buffer = buffer.slice(split + 2);
        split = buffer.indexOf("\n\n");
      }
      if (buffer.length > 1_000_000) {
        throw new Error("event stream frame exceeded 1 MB; dropping the connection");
      }
    }
  }

  private handleFrame(frame: string): void {
    let event = "message";
    const dataLines: string[] = [];
    for (const line of frame.split("\n")) {
      if (line.startsWith("event:")) {
        event = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trim());
      }
    }
    if (dataLines.length === 0) {
      return;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(dataLines.join("\n"));
    } catch {
      this.log.debug(`ignoring unparseable ${event} frame`);
      return;
    }

    switch (event) {
      case "state":
        // The SSE `state` payload is the dashboard's shape; refresh the
        // HomeKit-shaped view rather than trying to map it here.
        void this.homekitState()
          .then((state) => this.emit("state", state))
          .catch(() => undefined);
        break;
      case "motion":
        this.emit("motion", payload as MotionEvent);
        break;
      case "sound":
        this.emit("sound", payload as SoundEvent);
        break;
      case "heartbeat":
        break;
      default:
        break;
    }
  }
}
