/**
 * The places code mode programs run on Cloudflare.
 *
 * @module
 */
import type { Worker } from "@alchemy.run/cloudflare/Workers/Worker";
import { WorkerLoader } from "@alchemy.run/cloudflare/Workers/WorkerLoader";
import type { CodemodeRemote } from "@earendil-works/pi-codemode";
import { WorkerEnvironment } from "alchemy/Workers/WorkerEnvironment";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { CodeModeError, Eval, quickJSEvaluator, type Evaluation } from "../CodeMode.ts";

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
