import { DurableObject, env, waitUntil } from "cloudflare:workers";
import { Constants, testLoggerInstanceName } from "./TestLoggerConstants.ts";

/**
 * Runtime half of the test-logging pipeline. Bundled into Workers deployed
 * with test logging enabled (see `WorkerBundle.ts`): the virtual entry calls
 * {@link patchConsole} before the user module loads, so every `console.*`
 * call is mirrored to the account's `alchemy-test-logger` Durable Object,
 * which buffers rows and pushes them to any connected tail websocket.
 */

interface TestLoggerEnv {
  ALCHEMY_STACK_NAME: string;
  ALCHEMY_STAGE: string;
  [Constants.TEST_LOGGER_WORKER_NAME_BINDING]: string;
  [Constants.TEST_LOGGER_DO_BINDING]: DurableObjectNamespace<
    DurableObject & {
      log(entry: {
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

const hasTestLoggerEnv = (env: unknown): env is TestLoggerEnv =>
  typeof env === "object" &&
  env !== null &&
  "ALCHEMY_STACK_NAME" in env &&
  "ALCHEMY_STAGE" in env &&
  Constants.TEST_LOGGER_DO_BINDING in env &&
  Constants.TEST_LOGGER_WORKER_NAME_BINDING in env;

const render = (item: unknown): string => {
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

const patchConsoleMethod = (method: PatchedMethod) => {
  const original = console[method];
  console[method] = (...args: unknown[]) => {
    original(...args);
    if (!hasTestLoggerEnv(env)) return;
    const stub = env[Constants.TEST_LOGGER_DO_BINDING].getByName(
      testLoggerInstanceName({
        name: env.ALCHEMY_STACK_NAME,
        stage: env.ALCHEMY_STAGE,
      }),
    );
    try {
      waitUntil(
        stub
          .log({
            worker: env[Constants.TEST_LOGGER_WORKER_NAME_BINDING],
            message: args.map(render).join(" "),
            method,
          })
          .catch(() => {}),
      );
    } catch {
      // `waitUntil` throws outside a request context (e.g. logs during
      // isolate startup) — the original console output already happened.
    }
  };
};

let patched = false;

/** Patch `console.*` to mirror log lines to the test-logger Durable Object. */
export const patchConsole = () => {
  if (patched) return;
  patched = true;
  for (const method of PATCHED_METHODS) {
    patchConsoleMethod(method);
  }
};
