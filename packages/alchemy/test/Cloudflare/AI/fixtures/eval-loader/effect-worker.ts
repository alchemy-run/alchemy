/**
 * END-TO-END fixture for `Cloudflare.AI.EvalWorkerLoaderEffect` (the
 * EFFECT convention): the same session as `worker.ts`, but the model
 * writes a module that default-exports an `Effect` and the isolate
 * carries the bundled effect runtime (the ~763KB monolith `effect.js`,
 * with `import … from "effect/X"` statements rewritten to reference
 * it). Proves the runtime actually links and RUNS inside a real
 * dynamically-loaded Worker isolate.
 *
 * `POST /` takes `{ code }` (a complete program MODULE) and reports the
 * session facts; `GET /probe` drives the evaluator directly with a
 * hand-written effect graph, surfacing the full cause of any failure.
 */
import { Eval } from "@/AI/Eval.ts";
import * as AI from "@/AI/index.ts";
import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { sessionFacts } from "./org.ts";

export default class EvalLoaderEffectWorker extends Cloudflare.Worker<EvalLoaderEffectWorker>()(
  "EvalLoaderEffectWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const evaluator = yield* Eval;
    const codeMode = AI.CodeModeEffect().pipe(
      Layer.provide(Layer.succeed(Eval, evaluator)),
    );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;

        // Diagnostic door: the smallest possible proof that the
        // MONOLITH runtime works in-isolate — a program module that
        // imports effect, composes with Effect.gen, and awaits a tool.
        if (new URL(request.url, "http://x").pathname === "/probe") {
          const result = yield* evaluator
            .run({
              main: "main.js",
              modules: {
                "program.js": `
                  import * as Effect from "effect/Effect";
                  import * as Duration from "effect/Duration";
                  import { echo } from "./tools.raw.js";
                  export default Effect.gen(function* () {
                    console.log("probing effect");
                    yield* Effect.sleep(Duration.millis(1));
                    const value = yield* Effect.promise(() => echo({ n: 41 }));
                    return value;
                  });`,
                "main.js": `
                  import * as Effect from "effect/Effect";
                  import program from "./program.js";
                  export default () => Effect.runPromise(program);`,
              },
              tools: [
                {
                  name: "echo",
                  call: (input) =>
                    Effect.succeed(((input as { n: number }).n ?? 0) + 1),
                },
              ],
              timeout: "20 seconds",
            })
            .pipe(
              Effect.map((value) => ({ outcome: "ok" as const, value })),
              Effect.catch((error) =>
                Effect.succeed({ outcome: "fail" as const, error }),
              ),
              Effect.catchDefect((defect) =>
                Effect.succeed({
                  outcome: "defect" as const,
                  error: String(defect),
                  stack: (defect as Error)?.stack,
                }),
              ),
            );
          return yield* HttpServerResponse.json(result);
        }

        const { code } = (yield* request.json) as { code: string };
        return yield* HttpServerResponse.json(
          yield* sessionFacts({ code, codeMode }),
        );
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.succeed(
            HttpServerResponse.text(`CAUSE: ${cause}`, { status: 599 }),
          ),
        ),
      ),
    };
  }).pipe(Effect.provide(Cloudflare.AI.EvalWorkerLoaderEffect())),
) {}
