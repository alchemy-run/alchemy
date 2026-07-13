import { type DurableObject, env, waitUntil } from "cloudflare:workers";

interface Env {
  ALCHEMY_TEST_WORKER_NAME: string;
  ALCHEMY_TEST_LOGGER: DurableObjectNamespace<
    DurableObject & {
      log(item: {
        message: string;
        method: string;
        workerName: string;
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

const hasTestLoggerEnv = (env: Cloudflare.Env): env is Env => {
  return "ALCHEMY_TEST_WORKER_NAME" in env && "ALCHEMY_TEST_LOGGER" in env;
};

const patchConsoleMethod = (method: PatchedMethod) => {
  const originalMethod = console[method];
  console[method] = (...args: any[]) => {
    originalMethod(...args);
    if (!hasTestLoggerEnv(env)) return;
    const stub = env.ALCHEMY_TEST_LOGGER.getByName("global");
    waitUntil(
      stub.log({
        message: renderItem(args),
        method,
        workerName: env.ALCHEMY_TEST_WORKER_NAME,
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
