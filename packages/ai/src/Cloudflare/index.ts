/**
 * `AI.Model` Layers on Cloudflare, the places code mode programs run there,
 * and a Durable Object for each session of a process.
 *
 * @module
 */
import * as Cloudflare from "@alchemy.run/cloudflare";
import {
  DurableObjectCallbacks,
  outsideAlarmPass,
} from "@alchemy.run/cloudflare/Workers/AlarmCallback";
import {
  DurableObject,
  type InlineDurableObjectProps,
} from "@alchemy.run/cloudflare/Workers/DurableObject";
import { DurableObjectState } from "@alchemy.run/cloudflare/Workers/DurableObjectState";
import type { Worker } from "@alchemy.run/cloudflare/Workers/Worker";
import { WorkerLoader } from "@alchemy.run/cloudflare/Workers/WorkerLoader";
import type { CodemodeRemote } from "@earendil-works/pi-codemode";
import { RuntimeContext } from "alchemy/RuntimeContext";
import { WorkerEnvironment } from "alchemy/Workers/WorkerEnvironment";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import { CodeModeError, Eval, quickJSEvaluator, type Evaluation } from "../CodeMode.ts";
import * as Host from "../Host.ts";
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
 * Run code mode programs in a QuickJS VM on the Durable Object's own
 * thread. A program that computes without calling a tool blocks the object
 * until it calls one or spends its `interruptBudget`, so keep programs to
 * glue code. The VM is deterministic, so on Pi a program resumes after a
 * restart.
 *
 * **Example:** Code mode in a Durable Object
 * ```typescript
 * const CodeModeLive = AI.CodeModeAsync.pipe(Layer.provide(AICloudflare.EvalQuickJS()));
 * ```
 *
 * @layer
 * @provides AI.Eval
 */
export const EvalQuickJS = (
  options: { readonly timeoutMs?: number; readonly interruptBudget?: number } = {},
): Layer.Layer<Eval> =>
  Layer.succeed(
    Eval,
    quickJSEvaluator(
      load(async () => {
        const { createInlineCodemodeSandbox } =
          await import("@earendil-works/pi-codemode/cloudflare");
        return createInlineCodemodeSandbox({
          timeoutMs: options.timeoutMs ?? 60_000,
          interruptBudget: options.interruptBudget ?? 50_000,
        });
      }),
    ),
  );

export interface EvalWorkerLoaderOptions {
  /**
   * The `worker_loader` binding the Worker gets.
   * @default "CODEMODE"
   */
  readonly name?: string;
  /**
   * Deadline of one program, including the time its tools take.
   * @default 60000
   */
  readonly timeoutMs?: number;
  /**
   * Compatibility date of the loaded isolate.
   * @default "2026-01-28"
   */
  readonly compatibilityDate?: string;
}

/**
 * Run code mode programs in an isolate of their own, loaded with a
 * `worker_loader` binding. The program is the isolate's code and runs on
 * V8 directly. The isolate has no network (`globalOutbound: null`), no
 * bindings, and no state: a tool call is the only way out, and it comes
 * back to this Worker.
 *
 * A program's call is given up at `timeoutMs`. Programs do not resume
 * after a restart; for that, use a QuickJS evaluator.
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
      // where programs run, since its stubs speak promises.
      yield* WorkerLoader(name);
      const env = yield* WorkerEnvironment;
      const timeoutMs = options.timeoutMs ?? 60_000;
      return {
        run: (script, tools) =>
          Effect.gen(function* () {
            const loader = loaderOf(env, name);
            if (loader === undefined) {
              return yield* new CodeModeError({
                message: `AICloudflare.EvalWorkerLoader: no worker_loader binding named ${name}`,
              });
            }
            const source = isolateModule(script);
            // The same program loads the same isolate.
            const id = yield* load(() => digest(source));
            const isolate = loader.get(id, () => ({
              compatibilityDate: options.compatibilityDate ?? "2026-01-28",
              mainModule: "program.js",
              modules: { "program.js": source },
              env: {},
              globalOutbound: null,
            }));
            const call = async (tool: string, args: unknown): Promise<CallOutcome> => {
              const execute = tools[tool];
              if (execute === undefined) return { ok: false, message: `Unknown tool ${tool}` };
              try {
                return { ok: true, value: await execute(args) };
              } catch (cause) {
                return { ok: false, message: messageOf(cause) };
              }
            };
            // A program that does not compile fails where the isolate loads.
            return yield* Effect.promise(() =>
              (isolate.getEntrypoint() as unknown as ProgramIsolate)
                .run(call)
                .catch((cause): Evaluation => ({
                  ok: false,
                  message: messageOf(cause),
                  output: [],
                })),
            ).pipe(
              Effect.timeoutOrElse({
                duration: timeoutMs,
                orElse: () =>
                  Effect.succeed<Evaluation>({
                    ok: false,
                    message: `The program ran longer than ${timeoutMs} ms.`,
                    output: [],
                  }),
              }),
            );
          }),
      };
    }),
  );

export interface EvalQuickJSWorkerLoaderOptions extends EvalWorkerLoaderOptions {
  /**
   * Interrupt polls a program may spend computing without calling a tool,
   * roughly 10,000 per second of CPU on Cloudflare.
   * @default 50000
   */
  readonly interruptBudget?: number;
  /**
   * Memory the VM may allocate in the isolate (128 MB in total).
   * @default 64 MB
   */
  readonly memoryLimitBytes?: number;
}

/**
 * Run code mode programs in a QuickJS VM inside an isolate of its own,
 * loaded with a `worker_loader` binding. The VM keeps a long program off
 * the Durable Object's thread, counts its steps and memory, and is
 * deterministic, so on Pi a program resumes after a restart. It
 * interprets the program, so it is slower than `EvalWorkerLoader`.
 *
 * **Example:** A QuickJS VM in a loaded isolate
 * ```typescript
 * const CodeModeLive = AI.CodeModeAsync.pipe(
 *   Layer.provide(AICloudflare.EvalQuickJSWorkerLoader()),
 * );
 * ```
 *
 * @layer
 * @provides AI.Eval
 */
export const EvalQuickJSWorkerLoader = (
  options: EvalQuickJSWorkerLoaderOptions = {},
): Layer.Layer<Eval, never, Worker | WorkerEnvironment> =>
  Layer.effect(
    Eval,
    Effect.gen(function* () {
      const name = options.name ?? "CODEMODE";
      yield* WorkerLoader(name);
      const env = yield* WorkerEnvironment;
      const interruptBudget = options.interruptBudget ?? 50_000;
      const memoryLimitBytes = options.memoryLimitBytes ?? 64 * 1024 * 1024;
      return quickJSEvaluator(
        Effect.gen(function* () {
          const loader = loaderOf(env, name);
          if (loader === undefined) {
            return yield* new CodeModeError({
              message: `AICloudflare.EvalQuickJSWorkerLoader: no worker_loader binding named ${name}`,
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
      );
    }),
  );

/** How a tool call ended, as it crosses back into the isolate. */
type CallOutcome =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly message: string };

/** The entrypoint of the module `isolateModule` writes. */
interface ProgramIsolate {
  run(call: (tool: string, args: unknown) => Promise<CallOutcome>): Promise<Evaluation>;
}

const messageOf = (cause: unknown): string =>
  cause !== null && typeof cause === "object" && "message" in cause
    ? String(cause.message)
    : String(cause);

const digest = async (text: string): Promise<string> =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

/**
 * The isolate's module: its entrypoint runs `script` as the body of an
 * async function over `tools`, `console` and `text`, with each tool call
 * going back through `call`.
 */
const isolateModule = (
  script: string,
): string => `import { WorkerEntrypoint } from "cloudflare:workers";
const __alchemyShow = (value) => {
  if (typeof value === "string") return value;
  try { return JSON.stringify(value) ?? String(value); } catch { return String(value); }
};
export default class extends WorkerEntrypoint {
  async run(__alchemyCall) {
    const __alchemyOutput = [];
    const text = (value) => { __alchemyOutput.push(__alchemyShow(value)); };
    const console = Object.fromEntries(["log", "info", "warn", "error", "debug"].map((level) => [
      level,
      (...values) => { __alchemyOutput.push(values.map(__alchemyShow).join(" ")); },
    ]));
    const tools = new Proxy({}, {
      get: (_target, name) =>
        typeof name !== "string" || name === "then"
          ? undefined
          : async (args) => {
              const outcome = await __alchemyCall(name, args === undefined ? {} : args);
              if (outcome.ok) return outcome.value;
              throw new Error(outcome.message);
            },
    });
    try {
      const value = await (async (tools, console, text) => {
${script}
      })(tools, console, text);
      return {
        ok: true,
        value: value === undefined ? undefined : JSON.parse(JSON.stringify(value)),
        output: __alchemyOutput,
      };
    } catch (error) {
      const message =
        error !== null && typeof error === "object" && typeof error.message === "string"
          ? error.message
          : String(error);
      return { ok: false, message, output: __alchemyOutput };
    }
  }
}
`;

const loaderOf = (env: unknown, name: string): RawWorkerLoader | undefined =>
  (env as Record<string, unknown> | undefined)?.[name] as RawWorkerLoader | undefined;

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

/** What one session's Durable Object answers. */
interface SessionObject {
  readonly call: (
    key: string,
    method: string,
    args: ReadonlyArray<unknown>,
  ) => Effect.Effect<unknown, unknown, RuntimeContext>;
}

/**
 * Declare a Durable Object class on the host Worker from inside a Layer.
 * The inline form of `Cloudflare.DurableObject` is typed for single-stage
 * implementations, so it is re-typed here for the two-stage form it runs.
 */
const declare = DurableObject as unknown as (
  name: string,
  props: InlineDurableObjectProps,
  impl: Effect.Effect<
    Effect.Effect<SessionObject, never, DurableObjectState | RuntimeContext | Scope.Scope>,
    never,
    DurableObjectState
  >,
) => Effect.Effect<{ readonly getByName: (name: string) => SessionObject }, never, Worker>;

/**
 * How long to keep retrying a call that failed in transit: an object being
 * reset reports an opaque error, and for a while after a deploy some
 * objects still run the previous code. About a minute in total.
 */
const TRANSIT_RETRY = {
  schedule: Schedule.min([Schedule.exponential("100 millis"), Schedule.spaced("2 seconds")]),
  times: 35,
} as const;

/**
 * Host a process on Cloudflare Durable Objects: each session in an object
 * of its own, named after the session's key. Give it the process's Layer
 * with everything a session needs (its harness, model, tools, and the
 * Domain models its prose mentions). It gives back the same process:
 * `get(key)` is a handle on that session's object, and each call is an RPC
 * to it.
 *
 * The Worker that provides it declares one Durable Object class per
 * process, `<Name>Process`. Each object builds the Layer for itself, so a
 * harness opens on that object's storage and alarm, and a session carries
 * on after its object is evicted.
 *
 * The Layer may need the process it provides, as a Domain model whose
 * policy holds it does: this provides it, inside each object and out.
 *
 * ### Hosting a process
 * **Example:** A Durable Object for each session
 * ```typescript
 * import * as AI from "@alchemy.run/ai";
 * import * as AICloudflare from "@alchemy.run/ai/Cloudflare";
 * import * as Pi from "@alchemy.run/pi";
 * import * as PiCloudflare from "@alchemy.run/pi/Cloudflare";
 * import * as Layer from "effect/Layer";
 * import { EngineerLive } from "./Engineer.process.ts";
 * import { Smart, SmartLive } from "./Models.ts";
 *
 * const Agents = Layer.mergeAll(Pi.HarnessLive, Pi.CodingTools, AI.DefaultModel(Smart)).pipe(
 *   Layer.provide(Layer.mergeAll(PiCloudflare.DurableObjectStorage, SmartLive)),
 * );
 *
 * export const EngineerSessions = AICloudflare.layerDurableObjects(
 *   EngineerLive.pipe(Layer.provide(Agents)),
 * );
 * ```
 *
 * ### With a Domain model
 * A model whose policy holds the process needs it, and the process's prose
 * needs the model. Leave the model needing the process, give it to the
 * prose, and provide the hosted process to the model.
 *
 * **Example:** A model and the process it hands work to
 * ```typescript
 * const WorkshopLive = Workshop.layer(TaskWorkLive).pipe(
 *   Layer.provide(DomainCloudflare.layerDurableObjects()),
 * );
 *
 * const EngineerSessions = AICloudflare.layerDurableObjects(
 *   EngineerLive.pipe(Layer.provide(Layer.mergeAll(Agents, WorkshopLive))),
 * );
 *
 * export const Live = WorkshopLive.pipe(Layer.provide(EngineerSessions));
 * ```
 *
 * @layer
 */
export const layerDurableObjects = <A, E, R>(
  layer: Layer.Layer<A, E, R>,
): Layer.Layer<A, E, Exclude<R, A> | Worker> =>
  Host.make(layer, (name, instance) =>
    Effect.map(
      declare(
        `${name}Process`.replace(/[^A-Za-z0-9_]/g, "_"),
        {},
        Effect.succeed(
          Effect.gen(function* () {
            const state = yield* DurableObjectState;
            const runtime = yield* RuntimeContext;
            return yield* instance({
              apart: true,
              // Outside the alarm pass, so a callback's alarm isn't held open by it.
              background: (effect) =>
                state
                  .waitUntil(outsideAlarmPass(effect))
                  .pipe(Effect.provideService(RuntimeContext, runtime)),
            }).pipe(Effect.provide(DurableObjectCallbacks));
          }),
        ),
      ),
      (namespace): Host.Instances => ({
        call: (key, method, args) =>
          namespace
            .getByName(key)
            .call(key, method, args)
            .pipe(
              Effect.catchDefect((defect) => Effect.fail(defect)),
              Effect.retry(TRANSIT_RETRY),
              Effect.orDie,
            ),
      }),
    ),
  );
