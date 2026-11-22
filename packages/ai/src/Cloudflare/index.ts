/**
 * `AI.Model` Layers on Cloudflare, and the places code mode programs run there.
 *
 * @module
 */
import * as Cloudflare from "@alchemy.run/cloudflare";
import type { Worker } from "@alchemy.run/cloudflare/Workers/Worker";
import { WorkerLoader } from "@alchemy.run/cloudflare/Workers/WorkerLoader";
import type { CodemodeRemote } from "@earendil-works/pi-codemode";
import { WorkerEnvironment } from "alchemy/Workers/WorkerEnvironment";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { CodeModeError, Eval } from "../CodeMode.ts";
import type { ModelClass } from "../Model.ts";

const load = <A>(run: () => Promise<A>): Effect.Effect<A, CodeModeError> =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      new CodeModeError({
        message:
          cause !== null && typeof cause === "object" && "message" in cause
            ? String(cause.message)
            : String(cause),
        cause,
      }),
  });

/** Which of Cloudflare's hosted models answers, and with what parameters. */
export type ModelOptions<E = never, R = never> = Parameters<
  Cloudflare.Workers.AIClient["model"]
>[0] & {
  /**
   * An AI Gateway to send each request through, which logs, caches and
   * rate-limits it. Without one, requests go straight to the model through
   * the Worker's AI binding.
   */
  gateway?: Effect.Effect<Cloudflare.AI.Gateway, E, R>;
};

/**
 * Back a model with one of the models Cloudflare hosts (the `@cf/...` ids).
 * It needs nothing beyond your Cloudflare account: no provider key.
 *
 * **Example:** Llama 3.3
 * ```typescript
 * import * as AI from "@alchemy.run/ai";
 * import * as AICloudflare from "@alchemy.run/ai/Cloudflare";
 *
 * export class Fast extends AI.Model<Fast>()("fast") {}
 *
 * export const FastLive = AICloudflare.Model(Fast, {
 *   model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
 * });
 * ```
 *
 * **Example:** Through an AI Gateway
 * ```typescript
 * import * as AI from "@alchemy.run/ai";
 * import * as AICloudflare from "@alchemy.run/ai/Cloudflare";
 * import * as Cloudflare from "@alchemy.run/cloudflare";
import type { Worker } from "@alchemy.run/cloudflare/Workers/Worker";
import { WorkerLoader } from "@alchemy.run/cloudflare/Workers/WorkerLoader";
import type { CodemodeRemote } from "@earendil-works/pi-codemode";
import { WorkerEnvironment } from "alchemy/Workers/WorkerEnvironment";
 *
 * export const Gateway = Cloudflare.AI.Gateway("Gateway", { collectLogs: true });
 *
 * export class Fast extends AI.Model<Fast>()("fast") {}
 *
 * export const FastLive = AICloudflare.Model(Fast, {
 *   model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
 *   gateway: Gateway,
 * });
 * ```
 *
 * @layer
 * @provides AI.Model
 * @peer @alchemy.run/cloudflare
 */
export const Model = <Self, E = never, R = never>(
  model: ModelClass<Self, string>,
  { gateway, ...options }: ModelOptions<E, R>,
) =>
  gateway === undefined
    ? Layer.unwrap(
        Effect.gen(function* () {
          const ai = yield* Cloudflare.Workers.AI();
          return model.layer(ai.model(options));
        }),
      ).pipe(Layer.provide(Cloudflare.Workers.AIBinding))
    : Layer.unwrap(
        Effect.gen(function* () {
          const client = yield* Cloudflare.AI.QueryGateway(yield* gateway);
          return model.layer(client.model(options));
        }),
      ).pipe(Layer.provide(Cloudflare.AI.QueryGatewayBinding));

/**
 * Run code mode programs in QuickJS on the Durable Object's own thread. A
 * script that computes without calling a tool blocks the object until it
 * calls one or spends its `interruptBudget`, so keep scripts to glue code.
 *
 * **Example:** Code mode in a Durable Object
 * ```typescript
 * const CodeModeLive = AI.CodeModeAsync.pipe(Layer.provide(AICloudflare.EvalInline()));
 * ```
 *
 * @layer
 * @provides AI.Eval
 */
export const EvalInline = (
  options: { readonly timeoutMs?: number; readonly interruptBudget?: number } = {},
): Layer.Layer<Eval> =>
  Layer.succeed(Eval, {
    sandbox: load(async () => {
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
 * Run code mode programs in an isolate of their own, loaded with a
 * `worker_loader` binding. The isolate has no network (`globalOutbound:
 * null`), no bindings, and no state: it runs the QuickJS VM, and every tool
 * call comes back over RPC to the Durable Object, which keeps the tools,
 * the deadline, and the journal a script replays from after a crash.
 *
 * **Example:** Code mode in a loaded isolate
 * ```typescript
 * const CodeModeLive = AI.CodeModeEffect.pipe(Layer.provide(AICloudflare.EvalWorkerLoader()));
 * ```
 *
 * @layer
 * @provides AI.Eval
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
            return yield* new CodeModeError({
              message: `AICloudflare.EvalWorkerLoader: no worker_loader binding named ${name}`,
            });
          }
          return yield* load(async () => {
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
