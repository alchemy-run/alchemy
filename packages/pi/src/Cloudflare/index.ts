/**
 * Pi Durable on Cloudflare: conversations in a Durable Object's SQLite.
 *
 * @module
 */
import { DurableObjectCallbacks } from "@alchemy.run/cloudflare/Workers/AlarmCallback";
import { DurableObjectState } from "@alchemy.run/cloudflare/Workers/DurableObjectState";
import type { Worker } from "@alchemy.run/cloudflare/Workers/Worker";
import { WorkerLoader } from "@alchemy.run/cloudflare/Workers/WorkerLoader";
import type { CodemodeRemote } from "@earendil-works/pi-codemode";
import { WorkerEnvironment } from "alchemy/Workers/WorkerEnvironment";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { Eval } from "../CodeMode.ts";
import { PiError } from "../Errors.ts";
import { fromPi } from "../internal/promise.ts";
import { Storage } from "../Storage.ts";

/**
 * Keep a harness's conversations in the SQLite of the Durable Object that
 * yields it, under the harness's table prefix (`pi_` by default). The
 * harness keeps the object's alarm armed while Pi has work, so an evicted
 * object wakes up and resumes where it stopped.
 *
 * **Example:** A harness in a Durable Object
 * ```typescript
 * const HarnessLive = Layer.mergeAll(ModelsLive, PiCloudflare.DurableObjectStorage);
 * ```
 *
 * @layer
 * @provides Pi.Storage
 */
export const DurableObjectStorage: Layer.Layer<Storage> = Layer.succeed(Storage, {
  instance: Effect.map(Effect.serviceOption(DurableObjectState), (state) => ({
    // At plan time the state is a stand-in with no id, and nothing opens the storage.
    id: Option.match(state, { onNone: () => "", onSome: (state) => state.id?.toString() ?? "" }),
    evictable: true,
    ...(Option.isSome(state)
      ? {
          callbacks: DurableObjectCallbacks.pipe(
            Layer.provide(Layer.succeed(DurableObjectState, state.value)),
          ),
        }
      : {}),
    open: (prefix: string) =>
      Option.isNone(state)
        ? Effect.fail(
            new PiError({
              message:
                "PiCloudflare.DurableObjectStorage is only available inside a Durable Object",
            }),
          )
        : fromPi(async () => {
            const { openDurableObjectSqliteStorage } =
              await import("@earendil-works/pi-durable/storage/sqlite/cloudflare");
            return openDurableObjectSqliteStorage(
              (state.value.raw as unknown as { storage: never }).storage,
              { prefix },
            );
          }),
  })),
});

/**
 * Run code-mode scripts in QuickJS on the Durable Object's own thread. A
 * script that computes without calling a tool blocks the object until it
 * calls one or spends its `interruptBudget`, so keep scripts to glue code.
 *
 * **Example:** Code mode in a Durable Object
 * ```typescript
 * const CodeModeLive = Pi.CodeModeAsync.pipe(Layer.provide(PiCloudflare.EvalInline()));
 * ```
 *
 * @layer
 * @provides Pi.Eval
 */
export const EvalInline = (
  options: { readonly timeoutMs?: number; readonly interruptBudget?: number } = {},
): Layer.Layer<Eval> =>
  Layer.succeed(Eval, {
    sandbox: fromPi(async () => {
      const { createInlineCodemodeSandbox } =
        await import("@earendil-works/pi-codemode/cloudflare");
      return createInlineCodemodeSandbox({
        timeoutMs: options.timeoutMs ?? 60_000,
        interruptBudget: options.interruptBudget ?? 50_000,
      });
    }),
  });

export interface EvalWorkerLoaderOptions {
  /**
   * The `worker_loader` binding the Worker gets.
   * @default "CODEMODE"
   */
  readonly name?: string;
  /**
   * Deadline of one script, including the time its tools take.
   * @default 60000
   */
  readonly timeoutMs?: number;
  /**
   * Interrupt polls a script may spend computing without calling a tool,
   * roughly 10,000 per second of CPU on Cloudflare.
   * @default 50000
   */
  readonly interruptBudget?: number;
  /**
   * Memory the VM may allocate in the isolate (128 MB in total).
   * @default 64 MB
   */
  readonly memoryLimitBytes?: number;
  /**
   * Compatibility date of the loaded isolate.
   * @default "2026-01-28"
   */
  readonly compatibilityDate?: string;
}

/**
 * Run code-mode scripts in an isolate of their own, loaded with a
 * `worker_loader` binding. The isolate has no network (`globalOutbound:
 * null`), no bindings, and no state: it runs the QuickJS VM, and every tool
 * call comes back over RPC to the Durable Object, which keeps the tools,
 * the deadline, and the journal a script replays from after a crash.
 *
 * **Example:** Code mode in a loaded isolate
 * ```typescript
 * const CodeModeLive = Pi.CodeModeEffect.pipe(Layer.provide(PiCloudflare.EvalWorkerLoader()));
 * ```
 *
 * @layer
 * @provides Pi.Eval
 */
export const EvalWorkerLoader = (
  options: EvalWorkerLoaderOptions = {},
): Layer.Layer<Eval, never, Worker | WorkerEnvironment> =>
  Layer.effect(
    Eval,
    Effect.gen(function* () {
      const name = options.name ?? "CODEMODE";
      // Registers the binding; the raw loader is read from the environment
      // where scripts run, since the VM's RPC protocol speaks promises.
      yield* WorkerLoader(name);
      const env = yield* WorkerEnvironment;
      const interruptBudget = options.interruptBudget ?? 50_000;
      const memoryLimitBytes = options.memoryLimitBytes ?? 64 * 1024 * 1024;
      return {
        sandbox: Effect.gen(function* () {
          const loader = (env as Record<string, unknown> | undefined)?.[name] as
            | RawWorkerLoader
            | undefined;
          if (loader === undefined) {
            return yield* new PiError({
              message: `PiCloudflare.EvalWorkerLoader: no worker_loader binding named ${name}`,
            });
          }
          return yield* fromPi(async () => {
            const [
              { RemoteCodemodeSandbox, cloudflareQuickJSWasm },
              { ISOLATE_MODULE, ISOLATE_VERSION },
            ] = await Promise.all([
              import("@earendil-works/pi-codemode/cloudflare"),
              import("../internal/codemode-isolate.generated.ts"),
            ]);
            const isolate = loader.get(
              `${ISOLATE_VERSION}-${interruptBudget}-${memoryLimitBytes}`,
              () => ({
                compatibilityDate: options.compatibilityDate ?? "2026-01-28",
                mainModule: "codemode.js",
                modules: {
                  "codemode.js": ISOLATE_MODULE,
                  // The Worker's compiled module: isolates cannot compile wasm.
                  "quickjs.wasm": { wasm: cloudflareQuickJSWasm as WebAssembly.Module },
                },
                // The limits are the isolate's, whatever a client asks for.
                env: {
                  MAX_INTERRUPT_BUDGET: interruptBudget,
                  MAX_MEMORY_LIMIT_BYTES: memoryLimitBytes,
                },
                globalOutbound: null,
              }),
            );
            return new RemoteCodemodeSandbox({
              timeoutMs: options.timeoutMs ?? 60_000,
              interruptBudget,
              memoryLimitBytes,
              remote: () => isolate.getEntrypoint() as unknown as CodemodeRemote,
            });
          });
        }),
      };
    }),
  );

/** The `worker_loader` binding as the Workers runtime hands it over. */
interface RawWorkerLoader {
  get(
    id: string,
    code: () => {
      readonly compatibilityDate: string;
      readonly mainModule: string;
      readonly modules: Record<string, string | { readonly wasm: WebAssembly.Module }>;
      readonly env: Record<string, unknown>;
      readonly globalOutbound: null;
    },
  ): { getEntrypoint(): unknown };
}
