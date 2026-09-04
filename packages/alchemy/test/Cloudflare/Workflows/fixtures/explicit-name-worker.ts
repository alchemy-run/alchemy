import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

export const EXPLICIT_WORKFLOW_NAME = "existing-effect-workflow-physical-name";

export class ExplicitNameWorkflow extends Cloudflare.Workflow<ExplicitNameWorkflow>()(
  "ExplicitNameWorkflow",
  { workflowName: EXPLICIT_WORKFLOW_NAME },
  Effect.succeed(
    Effect.fn(function* () {
      return "ok";
    }),
  ),
) {}

export default class ExplicitNameWorkflowWorker extends Cloudflare.Worker<ExplicitNameWorkflowWorker>()(
  "ExplicitNameWorkflowWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    yield* ExplicitNameWorkflow;
    return {
      fetch: Effect.succeed(HttpServerResponse.text("ok")),
    };
  }),
) {}
