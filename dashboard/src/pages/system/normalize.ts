/**
 * Defensive readers for the three system endpoints.
 *
 * `docs/API.md` describes these three loosely — "Host, kernel, model,
 * temperatures, disk, versions" — and the service is more specific than the
 * document in ways the document does not pin down: health components arrive as
 * `{"ok": true, "detail": ""}` objects rather than status strings, host facts
 * are nested under `host`, and `GET /api/config` wraps the effective config in
 * `{"config": …, "warnings": […]}`.
 *
 * Rather than pick one reading and render "undefined" when the other turns up,
 * every field here is read through a narrowing helper that accepts both
 * shapes. That keeps the System page — the page you open precisely *because*
 * something is wrong — from being the page that breaks first when the contract
 * shifts under it.
 */

// ---------------------------------------------------------------------------
// Primitive readers
// ---------------------------------------------------------------------------

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

/** First non-null of several candidate paths. */
function pick<T>(...candidates: (T | null | undefined)[]): T | null {
  for (const candidate of candidates) {
    if (candidate !== null && candidate !== undefined) return candidate;
  }
  return null;
}

// ---------------------------------------------------------------------------
// GET /api/health
// ---------------------------------------------------------------------------

export interface ComponentStatus {
  name: string;
  /** Null when the service reported something this client cannot interpret. */
  ok: boolean | null;
  /** Why, when it is not ok. */
  detail: string | null;
  /** The raw word, for a component reporting "disabled" rather than a boolean. */
  state: string | null;
}

export interface HealthView {
  status: 'ok' | 'degraded' | 'unknown';
  uptimeS: number | null;
  version: string | null;
  components: ComponentStatus[];
  /** Names the service itself listed as degraded. */
  degraded: string[];
}

/** Components the contract promises, in the order they are worth reading. */
const COMPONENT_ORDER = ['camera', 'audio', 'env', 'db'] as const;

const COMPONENT_LABELS: Record<string, string> = {
  camera: 'Camera',
  audio: 'Microphone',
  env: 'Temperature and humidity',
  db: 'Database',
  runtime: 'Runtime',
};

export function componentLabel(name: string): string {
  return COMPONENT_LABELS[name] ?? name.replace(/[-_]+/g, ' ');
}

export function normalizeHealth(raw: unknown): HealthView {
  const root = asRecord(raw) ?? {};
  const statusWord = str(root.status);
  const componentsRaw = asRecord(root.components) ?? {};

  const names = [
    ...COMPONENT_ORDER.filter((name) => name in componentsRaw),
    ...Object.keys(componentsRaw).filter((name) => !COMPONENT_ORDER.includes(name as never)),
  ];

  const components = names.map<ComponentStatus>((name) => {
    const value = componentsRaw[name];

    // Shape A, the documented one: a status word.
    if (typeof value === 'string') {
      return {
        name,
        ok: value === 'ok' ? true : value === 'disabled' ? null : false,
        detail: value === 'ok' ? null : value,
        state: value,
      };
    }
    // Shape B, what the service sends: {"ok": bool, "detail": string}.
    const record = asRecord(value);
    if (record) {
      const ok = typeof record.ok === 'boolean' ? record.ok : null;
      return {
        name,
        ok,
        detail: str(record.detail),
        state: str(record.state) ?? (ok === null ? null : ok ? 'ok' : 'down'),
      };
    }
    if (typeof value === 'boolean') {
      return { name, ok: value, detail: null, state: value ? 'ok' : 'down' };
    }
    return { name, ok: null, detail: null, state: null };
  });

  return {
    status: statusWord === 'ok' ? 'ok' : statusWord === 'degraded' ? 'degraded' : 'unknown',
    uptimeS: num(root.uptime_s),
    version: str(root.version),
    components,
    degraded: strings(root.degraded),
  };
}

// ---------------------------------------------------------------------------
// GET /api/system/info
// ---------------------------------------------------------------------------

export interface DiskView {
  path: string;
  totalBytes: number | null;
  usedBytes: number | null;
  freeBytes: number | null;
  usedFraction: number | null;
  available: boolean;
}

export interface DatabaseView {
  path: string | null;
  schemaVersion: number | null;
  sizeBytes: number | null;
  freeBytes: number | null;
  walBytes: number | null;
  diskTotalBytes: number | null;
  diskFreeBytes: number | null;
  rows: { table: string; count: number }[];
}

export interface SystemInfoView {
  hostname: string | null;
  model: string | null;
  system: string | null;
  release: string | null;
  machine: string | null;
  cpuCount: number | null;
  loadAvg: number[] | null;
  uptimeS: number | null;
  temperatures: { name: string; celsius: number }[];
  memory: { totalBytes: number; availableBytes: number } | null;
  disks: DiskView[];
  media: { dir: string | null; trackedBytes: number | null } | null;
  database: DatabaseView | null;
  versions: { name: string; value: string }[];
  configSource: string | null;
  warnings: string[];
}

export function normalizeSystemInfo(raw: unknown): SystemInfoView {
  const root = asRecord(raw) ?? {};
  const host = asRecord(root.host) ?? {};

  const temperaturesRaw = asRecord(root.temperatures_c) ?? asRecord(root.temperatures) ?? {};
  const temperatures = Object.entries(temperaturesRaw)
    .map(([name, value]) => ({ name, celsius: num(value) }))
    .filter((entry): entry is { name: string; celsius: number } => entry.celsius !== null);

  const versionsRaw = asRecord(root.versions) ?? {};
  const versions = Object.entries(versionsRaw)
    .map(([name, value]) => ({ name, value: str(value) }))
    .filter((entry): entry is { name: string; value: string } => entry.value !== null);

  const memory = asRecord(root.memory);
  const media = asRecord(root.media);

  return {
    hostname: pick(str(host.hostname), str(root.hostname)),
    model: pick(str(host.model), str(root.model)),
    system: pick(str(host.system), str(root.os)),
    release: pick(str(host.release), str(root.kernel)),
    machine: str(host.machine),
    cpuCount: num(host.cpu_count),
    loadAvg: readLoadAvg(pick(host.load_avg, root.load_avg)),
    uptimeS: pick(num(host.uptime_s), num(root.uptime_s)),
    temperatures,
    memory:
      memory && num(memory.total_bytes) !== null
        ? {
            totalBytes: num(memory.total_bytes) ?? 0,
            availableBytes: num(memory.available_bytes) ?? 0,
          }
        : null,
    disks: readDisks(root.disk),
    media: media ? { dir: str(media.dir), trackedBytes: num(media.tracked_bytes) } : null,
    database: readDatabase(root.database),
    versions,
    configSource: str(root.config_source),
    warnings: strings(root.warnings),
  };
}

function readLoadAvg(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  const numbers = value.map(num).filter((entry): entry is number => entry !== null);
  return numbers.length > 0 ? numbers : null;
}

function readDisks(value: unknown): DiskView[] {
  const entries = Array.isArray(value) ? value : value === undefined ? [] : [value];
  return entries
    .map(asRecord)
    .filter((entry): entry is Record<string, unknown> => entry !== undefined)
    .map((entry) => {
      const total = num(entry.total_bytes);
      const used = num(entry.used_bytes);
      const free = num(entry.free_bytes);
      return {
        path: str(entry.path) ?? 'disk',
        totalBytes: total,
        usedBytes: used,
        freeBytes: free,
        usedFraction:
          num(entry.used_fraction) ?? (total && used !== null && total > 0 ? used / total : null),
        available: entry.available !== false,
      };
    });
}

function readDatabase(value: unknown): DatabaseView | null {
  const record = asRecord(value);
  if (!record) return null;
  const rowsRaw = asRecord(record.rows) ?? {};
  const rows = Object.entries(rowsRaw)
    .map(([table, count]) => ({ table, count: num(count) }))
    .filter((entry): entry is { table: string; count: number } => entry.count !== null)
    .sort((a, b) => b.count - a.count);

  return {
    path: str(record.path),
    schemaVersion: num(record.schema_version),
    sizeBytes: num(record.size_bytes),
    freeBytes: num(record.free_bytes),
    walBytes: num(record.wal_bytes),
    diskTotalBytes: num(record.disk_total_bytes),
    diskFreeBytes: num(record.disk_free_bytes),
    rows,
  };
}

// ---------------------------------------------------------------------------
// GET /api/config
// ---------------------------------------------------------------------------

export interface ConfigView {
  config: Record<string, unknown>;
  warnings: string[];
}

/** Unwraps `{"config": …}` when present, and takes the body as-is when not. */
export function normalizeConfig(raw: unknown): ConfigView {
  const root = asRecord(raw) ?? {};
  const inner = asRecord(root.config);
  return {
    config: inner ?? root,
    warnings: strings(root.warnings),
  };
}

/** `config.get('camera', 'rtsp_url')` without ten lines of narrowing. */
export function configValue(config: Record<string, unknown>, ...path: string[]): unknown {
  let cursor: unknown = config;
  for (const key of path) {
    const record = asRecord(cursor);
    if (!record) return undefined;
    cursor = record[key];
  }
  return cursor;
}

export function configString(config: Record<string, unknown>, ...path: string[]): string | null {
  return str(configValue(config, ...path));
}

export function configNumber(config: Record<string, unknown>, ...path: string[]): number | null {
  return num(configValue(config, ...path));
}

export function configBool(config: Record<string, unknown>, ...path: string[]): boolean | null {
  const value = configValue(config, ...path);
  return typeof value === 'boolean' ? value : null;
}
