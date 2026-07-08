/**
 * Worker-side test-logging runtime: patches the global `console` so every
 * log call is also forwarded (via `waitUntil`) to the account-level
 * `alchemy-test-logger` Durable Object, tagged with the request ID captured
 * from the `alchemy-request-id` header through `AsyncLocalStorage`.
 *
 * This module is bundled into every Effect-native Worker (imported by
 * `WorkerBridge`) and into wrapped external workers (via the generated
 * virtual entry). It must therefore:
 *
 * - never import `cloudflare:workers` statically (the alchemy package is
 *   also loaded in Node by the CLI) — the bindings are handed in by the
 *   caller and/or resolved through a lazy dynamic import;
 * - be a no-op unless the {@link TEST_LOGGER_BINDING} binding is present in
 *   the worker's environment (i.e. the stack was deployed with test logging
 *   enabled).
 */
import { AsyncLocalStorage } from "node:async_hooks";
import {
  TEST_LOGGER_BINDING,
  TEST_LOGGER_DO_NAME_ENV,
  TEST_LOGGER_WORKER_NAME_ENV,
} from "./constants.ts";

interface TestLoggerStub {
  log(entry: {
    message: string;
    method: string;
    workerName: string;
    requestId: string | undefined;
  }): Promise<unknown>;
}

interface TestLoggerNamespace {
  getByName(name: string): TestLoggerStub;
}

type WaitUntil = (promise: Promise<unknown>) => void;

const RequestIdStorage = new AsyncLocalStorage<string>();

let currentEnv: Record<string, unknown> | undefined;
let currentWaitUntil: WaitUntil | undefined;
let installed = false;

const PATCHED_METHODS = [
  "log",
  "error",
  "warn",
  "info",
  "debug",
  "trace",
  "dir",
] as const;

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

const forwardLog = (method: string, items: unknown[]) => {
  const env = currentEnv;
  const namespace = env?.[TEST_LOGGER_BINDING] as
    | TestLoggerNamespace
    | undefined;
  if (!namespace || typeof namespace.getByName !== "function") return;
  try {
    const doName =
      typeof env?.[TEST_LOGGER_DO_NAME_ENV] === "string"
        ? (env[TEST_LOGGER_DO_NAME_ENV] as string)
        : "default";
    const workerName =
      typeof env?.[TEST_LOGGER_WORKER_NAME_ENV] === "string"
        ? (env[TEST_LOGGER_WORKER_NAME_ENV] as string)
        : "";
    const promise = namespace.getByName(doName).log({
      message: items.map(renderItem).join(" "),
      method,
      workerName,
      requestId: RequestIdStorage.getStore(),
    });
    // Swallow forwarding failures — test logging must never break the
    // worker under test.
    promise.catch(() => {});
    currentWaitUntil?.(promise);
  } catch {
    // ignore — e.g. `waitUntil` called outside of a request context
  }
};

/**
 * Install the console patch. Idempotent; a no-op unless the test-logger
 * binding is (or becomes) available in the worker environment.
 *
 * `env` / `waitUntil` may be passed directly by callers that have them (the
 * generated external wrapper entry, the Worker/DO bridges). Missing pieces
 * are filled in through a lazy `import("cloudflare:workers")`.
 */
export const installTestLogging = (
  env?: unknown,
  waitUntil?: WaitUntil,
): void => {
  if (env !== undefined && env !== null && typeof env === "object") {
    currentEnv = env as Record<string, unknown>;
  }
  if (waitUntil !== undefined) {
    currentWaitUntil = waitUntil;
  }
  if (installed) return;
  // Only patch inside a worker that actually has the logger binding —
  // never in Node (CLI/tests) and never in production workers.
  if (currentEnv?.[TEST_LOGGER_BINDING] === undefined) return;
  installed = true;
  if (currentWaitUntil === undefined) {
    void import("cloudflare:workers").then(
      (m) => {
        currentWaitUntil ??= (m as { waitUntil?: WaitUntil }).waitUntil;
      },
      () => {},
    );
  }
  for (const method of PATCHED_METHODS) {
    const original = console[method].bind(console);
    console[method] = (...items: unknown[]) => {
      original(...items);
      forwardLog(method, items);
    };
  }
};

const getRequestId = (request: unknown): string | undefined => {
  const headers = (
    request as { headers?: { get?: (name: string) => string | null } } | null
  )?.headers;
  if (!headers || typeof headers.get !== "function") return undefined;
  return headers.get("alchemy-request-id") ?? undefined;
};

/**
 * Run `fn` inside an `AsyncLocalStorage` context carrying the request ID
 * read from the request's `alchemy-request-id` header, so console calls made
 * anywhere in the request's async flow are correlated to the originating
 * test. Passes straight through when the header (or the request) is absent.
 */
export const runWithRequestId = <T>(request: unknown, fn: () => T): T => {
  const requestId = getRequestId(request);
  if (requestId === undefined) return fn();
  return RequestIdStorage.run(requestId, fn);
};

/**
 * Wrap the default export of an external (non-Effect) worker module so its
 * `fetch` handler runs inside the request-ID context. Handles both plain
 * `ExportedHandler` objects and `WorkerEntrypoint` subclasses; anything else
 * is returned unchanged.
 */
export const wrapExternalWorker = (entrypoint: any): any => {
  if (entrypoint === null || entrypoint === undefined) return entrypoint;
  if (typeof entrypoint === "function") {
    if (typeof entrypoint.prototype?.fetch !== "function") return entrypoint;
    return class extends entrypoint {
      fetch(request: unknown, ...args: unknown[]) {
        return runWithRequestId(request, () =>
          super.fetch(request as any, ...args),
        );
      }
    };
  }
  if (
    typeof entrypoint === "object" &&
    typeof entrypoint.fetch === "function"
  ) {
    return {
      ...entrypoint,
      fetch: (request: unknown, ...args: unknown[]) =>
        runWithRequestId(request, () => entrypoint.fetch(request, ...args)),
    };
  }
  return entrypoint;
};
