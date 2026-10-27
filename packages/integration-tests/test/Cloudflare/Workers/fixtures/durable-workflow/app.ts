import * as Workflows from "alchemy/Workflows";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { Journal } from "./journal.ts";
import { Approval, Approve, Checkout, Greet, Hold, Nap, Parent } from "./workflows.ts";

export type { Status } from "alchemy/Workflows";

/** The test Worker's routes, whichever engine runs its workflows. */
export const app = Effect.gen(function* () {
  const journals = yield* Journal;
  const workflows = {
    Greet: yield* Workflows.RunWorkflow(Greet),
    Nap: yield* Workflows.RunWorkflow(Nap),
    Approve: yield* Workflows.RunWorkflow(Approve),
    Hold: yield* Workflows.RunWorkflow(Hold),
    Checkout: yield* Workflows.RunWorkflow(Checkout),
    Parent: yield* Workflows.RunWorkflow(Parent),
  };
  return {
    fetch: Effect.gen(function* () {
      const request = yield* HttpServerRequest;
      const url = new URL(request.url, "http://durable-workflow");
      const [, operation, name, id] = url.pathname.split("/");
      if (operation === "ready") return HttpServerResponse.text("ready");
      if (operation === "journal" && name) {
        return yield* HttpServerResponse.json(yield* journals.getByName(name).list());
      }
      const workflow = workflows[name as keyof typeof workflows] as typeof workflows.Checkout;
      if (!workflow || !id) return HttpServerResponse.text("Not Found", { status: 404 });
      const payload = {
        id,
        name: url.searchParams.get("name") ?? "world",
        seconds: Number(url.searchParams.get("seconds") ?? "2"),
        decline: url.searchParams.get("decline") === "true",
      };

      switch (operation) {
        // Start it and wait for the result.
        case "run": {
          const run = yield* workflow.start(payload);
          yield* Effect.exit(run.result);
          return yield* HttpServerResponse.json(yield* run.status);
        }
        // Start it without waiting.
        case "start": {
          const run = yield* workflow.start(payload);
          return yield* HttpServerResponse.json({ executionId: run.executionId });
        }
        case "status": {
          const run = workflow.get(url.searchParams.get("executionId") ?? "");
          return yield* HttpServerResponse.json(yield* run.status);
        }
        case "approve": {
          const run = workflow.get(url.searchParams.get("executionId") ?? "");
          yield* run.signal(Approval, url.searchParams.get("by") ?? "nobody");
          return HttpServerResponse.text("ok");
        }
        case "interrupt": {
          yield* workflow.get(url.searchParams.get("executionId") ?? "").interrupt;
          return HttpServerResponse.text("ok");
        }
        default:
          return HttpServerResponse.text("Not Found", { status: 404 });
      }
    }).pipe(
      // Report why a request failed, so a failing test shows it.
      Effect.catchCause((cause) =>
        Effect.succeed(
          HttpServerResponse.text(
            `${Cause.pretty(cause)}\n${String((Cause.squash(cause) as { cause?: unknown })?.cause ?? "")}`,
            { status: 500 },
          ),
        ),
      ),
    ),
  };
});
