import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Eval, TOOLS_RAW_MODULE, type EvalTool } from "../../AI/Eval.ts";
import { typescript } from "../../Code/TypeScript.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import cloudflare_workers from "../Workers/cloudflare_workers.ts";
import type { Worker, WorkerEnvironment } from "../Workers/Worker.ts";
import { WorkerLoader, type WorkerStub } from "../Workers/WorkerLoader.ts";

export interface EvalWorkerLoaderOptions {
  /**
   * The `worker_loader` binding name registered on the hosting Worker.
   * @default "EVAL"
   */
  readonly name?: string;
  /**
   * Compatibility date for the dynamically loaded isolates.
   * @default "2026-01-28"
   */
  readonly compatibilityDate?: string;
  /**
   * Give the evaluated code default outbound network access. Off by
   * default: the isolate's `globalOutbound` is `null`, so the ONLY
   * capabilities the program has are its granted tools.
   * @default false
   */
  readonly allowNetwork?: boolean;
  /**
   * Extra modules added to every isolate's module map (name → ESM
   * source), importable by the program. This is how a RUNTIME reaches
   * the isolate — e.g. `Cloudflare.AI.EvalWorkerLoaderEffect` ships the
   * bundled effect runtime as `"effect.js"`.
   */
  readonly modules?: Record<string, string>;
  /**
   * Rewrite each module of the request's graph before it is loaded —
   * e.g. point `import … from "effect/X"` at a bundled runtime the
   * isolate carries. Applied to the model's `program.js` and every
   * convention-generated module; NOT to `{@link modules}` or the
   * reserved `tools.raw.js`/entry.
   */
  readonly transform?: (source: string) => string;
}

/** The Symbol under which the entry hands the isolate's `tools.raw.js`
 *  this call's dispatcher — ISOLATE-LOCAL (a throwaway sandbox worker,
 *  one evaluate per load), never host state. */
const DISPATCHER = `Symbol.for("alchemy/AI/EvalWorkerLoader/dispatcher")`;

/**
 * The evaluator-reserved `tools.raw.js` for the isolate: one named
 * async bridge per granted tool. Each call reads the current
 * dispatcher LAZILY (so static import at entry-load, before the
 * dispatcher exists, is fine) and RPCs back to the host, unwrapping
 * the JSON envelope — a declared failure is reconstructed into a
 * throwable with its `_tag` intact, so `catch (e) { e._tag }` matches.
 */
const toolsRawModule = (names: ReadonlyArray<string>): string =>
  typescript`
    const call = async (name, input) => {
      const dispatcher = globalThis[${DISPATCHER}];
      const envelope = JSON.parse(
        await dispatcher.call(name, JSON.stringify(input === undefined ? null : input)),
      );
      if (envelope.ok) return envelope.value;
      const raw = envelope.error;
      throw typeof raw === "object" && raw !== null
        ? Object.assign(new Error(raw.message ?? raw._tag ?? "tool call failed"), raw)
        : new Error(String(raw));
    };
    ${names
      .map(
        (name) =>
          `export const ${name} = (input) => call(${JSON.stringify(name)}, input);`,
      )
      .join("\n")}
  `;

/**
 * The isolate's entry — the pattern Cloudflare's own codemode executor
 * uses: a `WorkerEntrypoint` whose `evaluate` RPC method receives the
 * tool DISPATCHER as a call argument (a live RPC reference crosses as
 * an RPC argument, never as an `env` value). It stashes the dispatcher
 * for `tools.raw.js`, swaps `console` for a capturing one, runs the
 * program module's default thunk, and returns a JSON-encoded
 * `{ output, logs }` or `{ error, logs }`. `main` is the convention's
 * entry module (its default export is the async thunk).
 */
const entryModule = (main: string): string =>
  typescript`
    import { WorkerEntrypoint } from "cloudflare:workers";
    import run from "./${main}";

    const format = (value) =>
      typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));

    export default class Evaluator extends WorkerEntrypoint {
      async evaluate(dispatcher) {
        globalThis[${DISPATCHER}] = dispatcher;
        const logs = [];
        const record = (level) => (...args) => {
          logs.push((level === "log" ? "" : "[" + level + "] ") + args.map(format).join(" "));
        };
        const original = globalThis.console;
        globalThis.console = Object.assign({}, original, {
          log: record("log"),
          info: record("info"),
          warn: record("warn"),
          error: record("error"),
          debug: record("debug"),
        });
        try {
          const output = await run();
          return JSON.stringify({ output: output === undefined ? null : output, logs });
        } catch (error) {
          return JSON.stringify({ error: "program failed: " + error, logs });
        } finally {
          globalThis.console = original;
          delete globalThis[${DISPATCHER}];
        }
      }
    }
  `;

/**
 * Best-effort JSON projection of a tool failure so it survives the
 * isolate boundary with its identity intact: enumerable fields plus
 * the (non-enumerable) `_tag` and `message` the guest shim uses to
 * reconstruct a throwable.
 */
const encodeToolError = (error: unknown): unknown => {
  if (typeof error !== "object" || error === null) return String(error);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(error)) {
    try {
      JSON.stringify(value);
      out[key] = value;
    } catch {
      out[key] = String(value);
    }
  }
  const tagged = error as { _tag?: unknown; message?: unknown };
  if (typeof tagged._tag === "string") out._tag = tagged._tag;
  if (typeof tagged.message === "string") out.message = tagged.message;
  return out;
};

type ToolEnvelope =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: unknown };

/** The guest entrypoint's RPC surface, as seen through the typed stub. */
interface EvaluatorShape {
  readonly evaluate: (dispatcher: unknown) => Effect.Effect<unknown, unknown>;
}

/**
 * The ISOLATED Cloudflare {@link Eval}: every evaluation loads a fresh
 * sandboxed Worker isolate via the `worker_loader` binding
 * ({@link WorkerLoader}) and runs the model's MODULE GRAPH there —
 * full V8-isolate sandboxing, no filesystem, and (by default) no
 * network.
 *
 * Tools cross the boundary the way Cloudflare's own codemode executor
 * does: a `ToolDispatcher extends RpcTarget` holding this run's tool
 * closures is passed as an ARGUMENT to the guest's `evaluate` RPC
 * method (a live RPC reference serializes as an RPC call argument,
 * never as an `env` value). The entry stashes it on an ISOLATE-LOCAL
 * global for the generated `tools.raw.js` to read — the sandbox worker
 * is single-use (one load per eval), so there is no cross-run state
 * and nothing is shared on the host. Inputs, outputs, and declared
 * tool errors marshal as JSON, so `catch (e)` sees the same `_tag` in
 * the isolate as it would in-process.
 *
 * The base evaluator carries NOTHING but the program graph — pair it
 * with `AI.CodeModeAsync`. Runtimes reach the isolate through the
 * {@link EvalWorkerLoaderOptions} `modules` + `transform` seams;
 * `Cloudflare.AI.EvalWorkerLoaderEffect` uses them to put the bundled
 * effect runtime in scope for `AI.CodeModeEffect`.
 *
 * ```ts
 * Effect.provide(AI.CodeModeAsync())
 * Effect.provide(Cloudflare.AI.EvalWorkerLoader())
 * ```
 */
export const EvalWorkerLoader = (
  options?: EvalWorkerLoaderOptions,
): Layer.Layer<Eval, never, Worker | WorkerEnvironment> =>
  Layer.effect(
    Eval,
    Effect.gen(function* () {
      const loader = yield* WorkerLoader(options?.name ?? "EVAL");
      const compatibilityDate = options?.compatibilityDate ?? "2026-01-28";
      // `cloudflare:workers` resolves dynamically (plan/deploy evaluate
      // this module in bun, where the import falls back to a stub —
      // fine, because `run` only ever executes inside workerd).
      const { RpcTarget } = yield* cloudflare_workers;

      /**
       * One run's tool closures, held HOST-SIDE behind an RpcTarget.
       * The guest receives a stub of this instance as an `evaluate`
       * argument; every tool call in the program becomes
       * `dispatcher.call(name, inputJson)` back into it.
       */
      class ToolDispatcher extends RpcTarget {
        readonly #tools: ReadonlyMap<string, EvalTool>;
        constructor(tools: ReadonlyArray<EvalTool>) {
          super();
          this.#tools = new Map(tools.map((tool) => [tool.name, tool]));
        }
        call(name: string, inputJson: string): Promise<string> {
          const tool = this.#tools.get(name);
          const envelope: Promise<ToolEnvelope> =
            tool === undefined
              ? Promise.resolve({ ok: false, error: `unknown tool: ${name}` })
              : Effect.runPromise(
                  Effect.try({
                    try: () => JSON.parse(inputJson) as unknown,
                    catch: (cause) => `malformed tool input: ${cause}`,
                  }).pipe(
                    Effect.flatMap((input) => tool.call(input)),
                    Effect.map((value): ToolEnvelope => ({ ok: true, value })),
                    Effect.catch((error) =>
                      Effect.succeed<ToolEnvelope>({
                        ok: false,
                        error: encodeToolError(error),
                      }),
                    ),
                  ),
                ).catch((defect) => ({ ok: false, error: String(defect) }));
          return envelope.then(JSON.stringify);
        }
      }

      const transform = options?.transform ?? ((source: string) => source);

      return {
        run: ({ modules, main, tools, timeout }) =>
          Effect.gen(function* () {
            // model + convention modules (transformed), the runtime's
            // extra modules (effect.js, untransformed), and the two
            // reserved modules the isolate always carries
            const graph: Record<string, string> = {
              ...options?.modules,
              ...Object.fromEntries(
                Object.entries(modules).map(([name, source]) => [
                  name,
                  transform(source),
                ]),
              ),
              [TOOLS_RAW_MODULE]: toolsRawModule(
                tools.map((tool) => tool.name),
              ),
              "entry.js": entryModule(main),
            };

            // `load` is runtime-colored (isolates only exist inside a
            // running Worker); Eval.run only ever executes there — the
            // driver samples inside the deployed Worker — so erase the
            // color the same way StartContainer does for its eager start.
            const worker = yield* loader.load({
              compatibilityDate,
              mainModule: "entry.js",
              modules: graph,
              // `null` disables ALL outbound network access for the
              // isolate; tool calls still work — the dispatcher is an
              // RPC capability, not network.
              ...(options?.allowNetwork ? {} : { globalOutbound: null }),
            }) as Effect.Effect<
              WorkerStub,
              never,
              RuntimeContext
            > as Effect.Effect<WorkerStub>;

            const resultJson = yield* worker
              .getEntrypoint<EvaluatorShape>()
              .evaluate(new ToolDispatcher(tools))
              .pipe(
                // a module-level syntax error in the graph surfaces as
                // a failed RPC into the fresh isolate
                Effect.catchCause((cause) =>
                  Effect.fail(`code did not evaluate: ${Cause.squash(cause)}`),
                ),
              );
            const body = yield* Effect.try({
              try: () =>
                JSON.parse(String(resultJson)) as {
                  readonly output?: unknown;
                  readonly error?: string;
                  readonly logs?: ReadonlyArray<string>;
                },
              catch: (cause) => `eval response unreadable: ${cause}`,
            });
            if (body.error !== undefined) {
              return yield* Effect.fail(body.error);
            }
            return { output: body.output, logs: body.logs ?? [] };
          }).pipe(
            Effect.timeoutOrElse({
              duration: timeout,
              orElse: () =>
                Effect.fail(
                  `eval timed out after ${Duration.format(
                    Duration.fromInputUnsafe(timeout),
                  )} — split the work into smaller programs`,
                ),
            }),
          ),
      };
    }),
  );
