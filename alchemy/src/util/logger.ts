import { Scope } from "../scope.ts";
import type { LoggerApi } from "./cli.tsx";

export const logger = new Proxy({} as LoggerApi, {
  get: (_, prop: keyof LoggerApi) =>
    Scope.current.logger[prop].bind(Scope.current.logger),
});
