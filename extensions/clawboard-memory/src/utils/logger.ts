import type { PluginLogger } from "../../api.js";

export function createComponentLogger(logger: PluginLogger, component: string): PluginLogger {
  const prefix = `[clawboard-memory:${component}]`;
  return {
    debug: (message) => logger.debug?.(`${prefix} ${message}`),
    info: (message) => logger.info(`${prefix} ${message}`),
    warn: (message) => logger.warn(`${prefix} ${message}`),
    error: (message) => logger.error(`${prefix} ${message}`),
  };
}
