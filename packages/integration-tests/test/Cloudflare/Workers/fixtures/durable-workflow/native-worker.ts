import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Workflows from "alchemy/Workflows";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import { app } from "../../../../Workflows/conformance/app.ts";
import { WorkflowsLive } from "../../../../Workflows/conformance/workflows.ts";
import { JournalLive } from "./journal.ts";
import { StepTimeout, StepTimeoutLive } from "./step-config.ts";

/**
 * The conformance workflows on Cloudflare Workflows, through NativeEngine,
 * plus `StepTimeout`, whose activity sets its own `step.do` config:
 *
 * - `POST /step-timeout/<id>` starts a run and answers its execution id
 * - `GET /step-timeout/<id>?executionId=…` reads its status
 */
export default class NativeEngineWorker extends Cloudflare.Worker<NativeEngineWorker>()(
  "NativeEngineWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const conformance = yield* app;
    const stepTimeout = yield* Workflows.RunWorkflow(StepTimeout);
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl, "http://native");
        const [, operation, id] = url.pathname.split("/");
        if (operation !== "step-timeout" || !id) return yield* conformance.fetch;
        if (request.method === "POST") {
          const run = yield* stepTimeout.start({ id });
          return yield* HttpServerResponse.json({ executionId: run.executionId });
        }
        const status = yield* stepTimeout.get(url.searchParams.get("executionId") ?? "").status;
        return yield* HttpServerResponse.json(
          status._tag === "Died" ? { _tag: "Died", defect: String(status.defect) } : status,
        );
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.succeed(HttpServerResponse.text(String(cause), { status: 500 })),
        ),
      ),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(WorkflowsLive, StepTimeoutLive).pipe(
        Layer.provideMerge(Layer.mergeAll(Cloudflare.Workflows.NativeEngine, JournalLive)),
      ),
    ),
  ),
) {}
