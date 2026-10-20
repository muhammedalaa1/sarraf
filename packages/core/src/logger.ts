export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

const noop = (): void => {
  // intentionally empty: silentLogger drops every message
};

export const silentLogger: Logger = { debug: noop, info: noop, warn: noop, error: noop };

/** Logs warnings and errors only. The default when `debug` is off. */
export const defaultLogger: Logger = {
  debug: noop,
  info: noop,
  warn: (message, meta) => console.warn(`[sarraf] ${message}`, meta ?? ""),
  error: (message, meta) => console.error(`[sarraf] ${message}`, meta ?? ""),
};

export const consoleLogger: Logger = {
  debug: (message, meta) => console.debug(`[sarraf] ${message}`, meta ?? ""),
  info: (message, meta) => console.info(`[sarraf] ${message}`, meta ?? ""),
  warn: defaultLogger.warn,
  error: defaultLogger.error,
};
