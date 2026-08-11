/** Minimal structured logger. journald adds its own timestamps, so we don't. */

export type LogLevel = "debug" | "info" | "warn" | "error";

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string, err?: unknown): void;
  child(scope: string): Logger;
}

export function createLogger(level: LogLevel = "info", scope = "babymon-hk"): Logger {
  const threshold = ORDER[level] ?? ORDER.info;

  const emit = (at: LogLevel, message: string) => {
    if (ORDER[at] < threshold) {
      return;
    }
    const line = `[${scope}] ${at.toUpperCase().padEnd(5)} ${message}`;
    if (at === "error" || at === "warn") {
      process.stderr.write(line + "\n");
    } else {
      process.stdout.write(line + "\n");
    }
  };

  return {
    debug: (m) => emit("debug", m),
    info: (m) => emit("info", m),
    warn: (m) => emit("warn", m),
    error: (m, err) => {
      emit("error", m);
      if (err instanceof Error && err.stack) {
        emit("error", err.stack);
      } else if (err !== undefined) {
        emit("error", String(err));
      }
    },
    child: (childScope: string) => createLogger(level, `${scope}:${childScope}`),
  };
}
