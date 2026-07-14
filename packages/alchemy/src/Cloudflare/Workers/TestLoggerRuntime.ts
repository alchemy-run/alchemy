import { DurableObject, env, waitUntil } from "cloudflare:workers";
import { Constants } from "./TestLoggerWorker.ts";

interface Env {
  ALCHEMY_STACK_NAME: string;
  ALCHEMY_STAGE: string;
  [Constants.TEST_LOGGER_WORKER_NAME_BINDING]: string;
  [Constants.TEST_LOGGER_DO_BINDING]: DurableObjectNamespace<
    DurableObject & {
      log(item: {
        stack: string;
        stage: string;
        worker: string;
        message: string;
        method: string;
      }): Promise<void>;
    }
  >;
}

const PATCHED_METHODS = [
  "log",
  "error",
  "warn",
  "info",
  "debug",
  "trace",
  "dir",
] as const;
type PatchedMethod = (typeof PATCHED_METHODS)[number];

const hasTestLoggerEnv = (env: Cloudflare.Env): env is Env =>
  "ALCHEMY_STACK_NAME" in env &&
  "ALCHEMY_STAGE" in env &&
  Constants.TEST_LOGGER_DO_BINDING in env &&
  Constants.TEST_LOGGER_WORKER_NAME_BINDING in env;

const patchConsoleMethod = (method: PatchedMethod) => {
  const originalMethod = console[method];
  console[method] = (...args: any[]) => {
    originalMethod(...args);
    if (!hasTestLoggerEnv(env)) {
      originalMethod(
        "[test logger] TEST LOGGER NOT ENABLED",
        JSON.stringify(env),
      );
      return;
    }
    originalMethod(
      "[test logger] TEST LOGGER ENABLED",
      JSON.stringify(env),
      JSON.stringify({
        message: renderItem(args),
        method,
        stack: env.ALCHEMY_STACK_NAME,
        stage: env.ALCHEMY_STAGE,
        worker: env[Constants.TEST_LOGGER_WORKER_NAME_BINDING],
      }),
    );
    const stub = env[Constants.TEST_LOGGER_DO_BINDING].getByName("global");
    waitUntil(
      stub.log({
        message: renderItem(args),
        method,
        stack: env.ALCHEMY_STACK_NAME,
        stage: env.ALCHEMY_STAGE,
        worker: env[Constants.TEST_LOGGER_WORKER_NAME_BINDING],
      }),
    );
  };
};

const renderItem = (item: unknown): string => {
  if (typeof item === "string") return item;
  if (item instanceof Error) return item.stack ?? String(item);
  try {
    return JSON.stringify(item, (_key, value) =>
      typeof value === "bigint" ? value.toString() : value,
    );
  } catch {
    return String(item);
  }
};

export const patchConsole = () => {
  for (const method of PATCHED_METHODS) {
    patchConsoleMethod(method);
  }
};
