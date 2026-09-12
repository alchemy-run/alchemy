/**
 * END-TO-END fixture for `Cloudflare.AI.EvalWorkerLoader` (the ASYNC
 * convention): the Worker runs a COMPLETE agent session in-worker —
 * real DriverLocal, the shared charter from `org.ts`, real
 * CodeModeAsync — with the isolate evaluator as the only substitution
 * from the in-process suite (`DriverLocal.test.ts` runs the same shape
 * over `EvalFunction`).
 *
 * `POST /` takes `{ code }` (a complete program MODULE) and reports the
 * session facts; `GET /probe` drives the evaluator directly, with the
 * full cause of any failure or defect surfaced.
 */
import { Eval } from "@/AI/Eval.ts";
import * as AI from "@/AI/index.ts";
import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { sessionFacts } from "./org.ts";

export default class EvalLoaderWorker extends Cloudflare.Worker<EvalLoaderWorker>()(
  "EvalLoaderWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    // Resolved ONCE at init: registers the worker_loader binding and
    // yields the evaluator the per-request sessions close over.
    const evaluator = yield* Eval;
    const codeMode = AI.CodeModeAsync().pipe(
      Layer.provide(Layer.succeed(Eval, evaluator)),
    );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;

        // Diagnostic door: run the evaluator DIRECTLY (no driver, no
        // codemode) and surface the full cause of any failure/defect.
        if (new URL(request.url, "http://x").pathname === "/probe") {
          const result = yield* evaluator
            .run({
              main: "main.js",
              modules: {
                "main.js": `
                  import { echo } from "./tools.raw.js";
                  export default async function () {
                    console.log("probing");
                    return echo({ n: 41 });
                  }`,
              },
              tools: [
                {
                  name: "echo",
                  call: (input) =>
                    Effect.succeed(((input as { n: number }).n ?? 0) + 1),
                },
              ],
              timeout: "10 seconds",
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
        // diagnostics fixture: EVERY failure mode comes back as text,
        // never a blind 500
        Effect.catchCause((cause) =>
          Effect.succeed(
            HttpServerResponse.text(`CAUSE: ${cause}`, { status: 599 }),
          ),
        ),
      ),
    };
  }).pipe(Effect.provide(Cloudflare.AI.EvalWorkerLoader())),
) {}
