import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import { spawn } from "node:child_process";
import {
  SecretManager as SecretManagerService,
  SecretManagerError,
  type SecretManagerLayer,
  type SecretManagerResolveOptions,
} from "../SecretManager.ts";

const managerName = "Varlock";
const loadMutex = Semaphore.makeUnsafe(1);
const outputMarker = "__ALCHEMY_VARLOCK_ENV__";
const maxOutputBytes = 16 * 1024 * 1024;

// A found container without a scalar value prevents the generic fallback
// provider from exposing Varlock's private runtime payload while still making
// Config.option(Config.string("__VARLOCK_ENV")) resolve to None. This policy
// belongs to the Varlock adapter; the core SecretManager only composes generic
// ConfigProviders.
const withoutPrivateRuntimeBinding = (
  provider: ConfigProvider.ConfigProvider,
) =>
  ConfigProvider.make((path) =>
    path.length === 1 && path[0] === "__VARLOCK_ENV"
      ? Effect.succeed(ConfigProvider.makeRecord(new Set()))
      : provider.load(path),
  );

// Varlock keeps resolved environment state globally inside its runtime module.
// Resolve in an isolated process so one Alchemy stage cannot poison another.
// This calls the public programmatic API; it does not use auto-load, the CLI,
// console patching, or Varlock's internal graph APIs.
const loaderSource = `
(async () => {
  const consoleMethods = {
    debug: console.debug,
    error: console.error,
    info: console.info,
    log: console.log,
    warn: console.warn,
  };
  const varlock = await import(process.env.__ALCHEMY_VARLOCK_ENTRY);
  await varlock.load();
  const consolePatched = Object.entries(consoleMethods).some(
    ([name, method]) => console[name] !== method,
  );
  process.stdout.write(${JSON.stringify(outputMarker)} + JSON.stringify({
    ok: true,
    env: process.env,
    consolePatched,
  }));
})().catch((cause) => {
  process.stdout.write(${JSON.stringify(outputMarker)} + JSON.stringify({
    ok: false,
    error: cause instanceof Error
      ? { name: cause.name, message: cause.message, stack: cause.stack }
      : { name: "Error", message: String(cause) },
  }));
  process.exitCode = 1;
});
`;

interface LoaderSuccess {
  readonly ok: true;
  readonly env: NodeJS.ProcessEnv;
  readonly consolePatched: boolean;
}

interface LoaderFailure {
  readonly ok: false;
  readonly error: {
    readonly name: string;
    readonly message: string;
    readonly stack?: string;
  };
}

type LoaderResult = LoaderSuccess | LoaderFailure;

const missingDependency = (cause: unknown) => {
  if (cause === null || typeof cause !== "object") return false;
  if ("code" in cause && cause.code === "MODULE_NOT_FOUND") return true;
  const message = "message" in cause ? cause.message : undefined;
  return (
    typeof message === "string" &&
    (message.includes("Cannot find package 'varlock'") ||
      message.includes('Cannot find package "varlock"') ||
      message.includes("Cannot find module 'varlock'") ||
      message.includes('Cannot find module "varlock"'))
  );
};

const loadError = (cause: unknown) =>
  new SecretManagerError({
    manager: managerName,
    message: missingDependency(cause)
      ? "Varlock is configured for this stack but is not installed. Install it with `pnpm add varlock`, `npm install varlock`, or your package manager's equivalent."
      : "Varlock could not load or validate this stack's environment. Run `varlock load` for detailed diagnostics.",
    cause,
  });

/** @internal */
export const resolveVarlockEntry = (
  resolve: () => string = () => import.meta.resolve("varlock"),
) =>
  Effect.try({
    try: resolve,
    catch: loadError,
  });

/** @internal */
export const loadVarlockEnvironment = (
  entry: string,
  stack: string,
  stage: string | undefined,
) =>
  Effect.tryPromise({
    try: (signal) =>
      new Promise<NodeJS.ProcessEnv>((resolve, reject) => {
        const env: NodeJS.ProcessEnv = {
          ...process.env,
          __ALCHEMY_VARLOCK_ENTRY: entry,
        };
        delete env.__VARLOCK_ENV;
        env.ALCHEMY_STACK = stack;
        if (stage !== undefined) env.ALCHEMY_STAGE = stage;

        const child = spawn(process.execPath, ["--eval", loaderSource], {
          cwd: process.cwd(),
          env,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let settled = false;
        const cleanup = () => signal.removeEventListener("abort", onAbort);
        const fail = (cause: unknown) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(cause);
        };
        const succeed = (loaded: NodeJS.ProcessEnv) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(loaded);
        };
        const onAbort = () => {
          child.kill();
          const error = new Error("Varlock loader was interrupted.");
          error.name = "AbortError";
          fail(error);
        };
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) {
          onAbort();
          return;
        }

        let stdout = "";
        let outputBytes = 0;
        const rejectOversized = () => {
          child.kill();
          fail(new Error("Varlock produced more than 16 MiB of output."));
        };
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          outputBytes += Buffer.byteLength(chunk);
          if (outputBytes > maxOutputBytes) return rejectOversized();
          stdout += chunk;
        });
        child.stderr.on("data", (chunk: Buffer) => {
          outputBytes += chunk.byteLength;
          if (outputBytes > maxOutputBytes) rejectOversized();
        });
        child.on("error", fail);
        child.on("close", (code, exitSignal) => {
          if (settled) return;
          const marker = stdout.lastIndexOf(outputMarker);
          if (marker < 0) {
            fail(
              new Error(
                exitSignal === null
                  ? `Varlock loader exited with code ${code ?? "unknown"}.`
                  : `Varlock loader exited after signal ${exitSignal}.`,
              ),
            );
            return;
          }
          try {
            const result = JSON.parse(
              stdout.slice(marker + outputMarker.length),
            ) as LoaderResult;
            if (!result.ok) {
              const error = new Error(result.error.message);
              error.name = result.error.name;
              error.stack = result.error.stack;
              fail(error);
              return;
            }
            if (code !== 0) {
              fail(new Error(`Varlock loader exited with code ${code}.`));
              return;
            }
            if (result.consolePatched) {
              fail(new Error("Varlock changed global console methods."));
              return;
            }
            delete result.env.__ALCHEMY_VARLOCK_ENTRY;
            delete result.env.__VARLOCK_ENV;
            succeed(result.env);
          } catch {
            fail(new Error("Varlock loader returned an invalid environment."));
          }
        });
      }),
    catch: loadError,
  });

const resolve = Effect.fn("Varlock.secrets.resolve")(function* ({
  stack,
  stage,
}: SecretManagerResolveOptions) {
  return yield* Semaphore.withPermits(
    loadMutex,
    1,
  )(
    Effect.gen(function* () {
      const entry = yield* resolveVarlockEntry();
      const resolved = yield* loadVarlockEnvironment(entry, stack, stage);
      return withoutPrivateRuntimeBinding(ConfigProvider.fromUnknown(resolved));
    }),
  );
});

/**
 * Load and validate an Alchemy stack's configuration with Varlock.
 *
 * Values remain available through Effect `Config`, including
 * `Config.redacted` for secrets. For stage-aware commands, Alchemy exposes the
 * stack and current stage as `ALCHEMY_STACK` and `ALCHEMY_STAGE` while
 * Varlock resolves the environment.
 *
 * ### Configure a Stack
 * **Example:** Use Varlock for stack configuration
 * ```typescript
 * import * as Alchemy from "alchemy";
 * import * as Cloudflare from "alchemy/Cloudflare";
 * import * as Varlock from "alchemy/Varlock";
 * import * as Config from "effect/Config";
 * import * as Effect from "effect/Effect";
 *
 * export default Alchemy.Stack(
 *   "app",
 *   {
 *     providers: Cloudflare.providers(),
 *     state: Cloudflare.state(),
 *     secrets: Varlock.secrets(),
 *   },
 *   Effect.gen(function* () {
 *     const apiKey = yield* Config.redacted("API_KEY");
 *     return { configured: apiKey !== undefined };
 *   }),
 * );
 * ```
 *
 * @layer
 * @provides SecretManager
 * @peer varlock
 * @product Varlock
 */
export const secrets = (): SecretManagerLayer =>
  Layer.succeed(SecretManagerService, {
    name: managerName,
    resolve,
  });
