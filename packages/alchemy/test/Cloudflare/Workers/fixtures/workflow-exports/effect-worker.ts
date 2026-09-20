import * as Cloudflare from "@/Cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

export class ValidationWorkflow extends Cloudflare.Workflow<ValidationWorkflow>()(
  "ValidationWorkflow",
  Effect.succeed(
    Effect.fn(function* (params: { value: string }) {
      return yield* Cloudflare.Workflows.task("value", Effect.succeed(params));
    }),
  ),
) {}

export default class WorkflowValidationWorker extends Cloudflare.Worker<WorkflowValidationWorker>()(
  "WorkflowValidationWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const workflow = yield* ValidationWorkflow;
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        if (request.url === "/start") {
          const instance = yield* workflow.create({
            params: { value: "workflow-export-ok" },
          });
          return yield* HttpServerResponse.json({ instanceId: instance.id });
        }
        if (request.url.startsWith("/status/")) {
          const instance = yield* workflow.get(
            request.url.slice("/status/".length),
          );
          return yield* HttpServerResponse.json(yield* instance.status());
        }
        return HttpServerResponse.text("workflow-export-ready");
      }),
    };
  }),
) {}
