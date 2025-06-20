import { Scope } from "../scope.ts";
import type { LoggerApi } from "./cli.ts";

declare global {
  var _ALCHEMY_WARNINGS: Set<string> | undefined;
}

interface LoggerApiWithWarnings extends LoggerApi {
  warnOnce: (message: string) => void;
}

export const logger = new Proxy({} as LoggerApiWithWarnings, {
  get: (_, prop: keyof LoggerApiWithWarnings) => {
    const logger =
      Scope.get()?.logger ??
      ({
        log: console.log,
        error: console.error,
        warn: console.warn,
        task: () => {},
        exit: () => {},
      } as LoggerApi);
    if (prop === "warnOnce") {
      return (message: string) => {
        globalThis._ALCHEMY_WARNINGS ??= new Set();
        if (!globalThis._ALCHEMY_WARNINGS.has(message)) {
          globalThis._ALCHEMY_WARNINGS.add(message);
          logger.warn(message);
        }
      };
    }
    return logger[prop].bind(logger);
  },
});
