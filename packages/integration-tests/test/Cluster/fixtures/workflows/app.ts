/** The front's workflow routes: start, read, signal and interrupt runs, and read journals. */
import * as Workflows from "alchemy/Workflows";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { Journal } from "./journal.ts";
import { Approval, Approve, Checkout, Greet, Nap, Parent } from "./workflows.ts";

export const workflowApp = Effect.gen(function* () {
  const journals = yield* Journal;
  const workflows = {
    Greet: yield* Greet,
    Nap: yield* Nap,
    Approve: yield* Approve,
    Checkout: yield* Checkout,
    Parent: yield* Parent,
  };
  // The same workflow through Alchemy's engine-neutral API, on Cluster.WorkflowEngine.
  const portable = yield* Workflows.RunWorkflow(Greet.workflow);
  // `/wf/<operation>/<workflow>/<id>`, or `/wf/journal/<id>`.
  return (url: URL) =>
    Effect.gen(function* () {
      const [, , operation, name, id] = url.pathname.split("/");
      if (operation === "journal" && name) {
        const journal = yield* journals.getByName(name);
        return yield* HttpServerResponse.json(yield* journal.List());
      }
      const workflow = (
        operation === "portable" ? portable : workflows[name as keyof typeof workflows]
      ) as typeof workflows.Checkout;
      if (!workflow || !id) return HttpServerResponse.text("Not Found", { status: 404 });
      const payload = {
        id,
        name: url.searchParams.get("name") ?? "world",
        seconds: Number(url.searchParams.get("seconds") ?? "2"),
        decline: url.searchParams.get("decline") === "true",
      };
      const run = () => workflow.get(url.searchParams.get("executionId") ?? "");
      switch (operation) {
        // Start it and wait for the result.
        case "portable":
        case "run": {
          const started = yield* workflow.start(payload);
          yield* Effect.exit(started.result);
          return yield* HttpServerResponse.json(yield* started.status);
        }
        case "start": {
          const started = yield* workflow.start(payload);
          return yield* HttpServerResponse.json({ executionId: started.executionId });
        }
        case "status":
          return yield* HttpServerResponse.json(yield* run().status);
        case "approve":
          yield* run().signal(Approval, url.searchParams.get("by") ?? "nobody");
          return HttpServerResponse.text("ok");
        case "interrupt":
          yield* run().interrupt;
          return HttpServerResponse.text("ok");
        default:
          return HttpServerResponse.text("Not Found", { status: 404 });
      }
    });
});
