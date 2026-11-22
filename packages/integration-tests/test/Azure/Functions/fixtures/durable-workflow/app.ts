import * as Workflows from "alchemy/Workflows";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { Approval, Approve, Checkout, Greet, Nap, Parent } from "./workflows.ts";

export type { Status } from "alchemy/Workflows";

/** The caller's routes: start, read, signal and interrupt the test workflows. */
export const app = Effect.gen(function* () {
  const workflows = {
    Greet: yield* Workflows.RunWorkflow(Greet),
    Nap: yield* Workflows.RunWorkflow(Nap),
    Approve: yield* Workflows.RunWorkflow(Approve),
    Checkout: yield* Workflows.RunWorkflow(Checkout),
    Parent: yield* Workflows.RunWorkflow(Parent),
  };
  return {
    fetch: Effect.gen(function* () {
      const request = yield* HttpServerRequest;
      const url = new URL(request.url, "http://durable-workflow");
      const [, operation, name, id] = url.pathname.split("/");
      // Ready once the caller's task hub role works: a run nobody started reads as NotStarted.
      if (operation === "ready") {
        const status = yield* workflows.Greet.get("ready").status;
        return yield* HttpServerResponse.json(status);
      }
      const workflow = workflows[name as keyof typeof workflows] as typeof workflows.Checkout;
      if (!workflow || !id) return HttpServerResponse.text("Not Found", { status: 404 });
      const payload = {
        id,
        name: url.searchParams.get("name") ?? "world",
        seconds: Number(url.searchParams.get("seconds") ?? "2"),
        decline: url.searchParams.get("decline") === "true",
      };
      const executionId = url.searchParams.get("executionId") ?? "";

      switch (operation) {
        case "start": {
          const run = yield* workflow.start(payload);
          return yield* HttpServerResponse.json({ executionId: run.executionId });
        }
        case "status": {
          const status = yield* workflow.get(executionId).status;
          return yield* HttpServerResponse.json(status);
        }
        case "approve": {
          yield* workflow.get(executionId).signal(Approval, url.searchParams.get("by") ?? "nobody");
          return HttpServerResponse.text("ok");
        }
        case "interrupt": {
          yield* workflow.get(executionId).interrupt;
          return HttpServerResponse.text("ok");
        }
        default:
          return HttpServerResponse.text("Not Found", { status: 404 });
      }
    }).pipe(
      // Report why a request failed, so a failing test shows it.
      Effect.catchCause((cause) =>
        Effect.succeed(HttpServerResponse.text(Cause.pretty(cause), { status: 500 })),
      ),
    ),
  };
});
