import * as Workflows from "alchemy/Workflows";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { Journal } from "./journal.ts";
import {
  Approval,
  Approve,
  Checkout,
  Crash,
  Flaky,
  Greet,
  Hold,
  Nap,
  Naps,
  Parent,
} from "./workflows.ts";

/**
 * The routes the conformance cases drive, whichever engine runs the workflows:
 *
 * - `POST /start/<workflow>/<id>?…` starts a run and answers its execution id
 * - `GET /status/<workflow>/<id>?executionId=…` reads its status
 * - `POST /approve/<workflow>/<id>?executionId=…&by=…` signals its approval
 * - `POST /interrupt/<workflow>/<id>?executionId=…` interrupts it
 * - `GET /journal/<id>` lists what its activities recorded
 */
export const app = Effect.gen(function* () {
  const journal = yield* Journal;
  const workflows = {
    Greet: yield* Workflows.RunWorkflow(Greet),
    Nap: yield* Workflows.RunWorkflow(Nap),
    Naps: yield* Workflows.RunWorkflow(Naps),
    Approve: yield* Workflows.RunWorkflow(Approve),
    Hold: yield* Workflows.RunWorkflow(Hold),
    Checkout: yield* Workflows.RunWorkflow(Checkout),
    Parent: yield* Workflows.RunWorkflow(Parent),
    Flaky: yield* Workflows.RunWorkflow(Flaky),
    Crash: yield* Workflows.RunWorkflow(Crash),
  };
  return {
    fetch: Effect.gen(function* () {
      const request = yield* HttpServerRequest;
      const url = new URL(request.originalUrl, "http://conformance");
      const [, operation, name, id] = url.pathname.split("/");
      if (operation === "ready") return HttpServerResponse.text("ready");
      if (operation === "journal" && name) {
        return yield* HttpServerResponse.json(yield* journal.list(name));
      }
      const workflow = workflows[name as keyof typeof workflows] as typeof workflows.Checkout;
      if (!workflow || !id) return HttpServerResponse.text("Not Found", { status: 404 });
      // Every workflow's payload fields; each workflow reads the ones it declares.
      const payload = {
        id,
        name: url.searchParams.get("name") ?? "world",
        seconds: Number(url.searchParams.get("seconds") ?? "2"),
        count: Number(url.searchParams.get("count") ?? "1"),
        decline: url.searchParams.get("decline") === "true",
      };
      const run = workflow.get(url.searchParams.get("executionId") ?? "");
      switch (operation) {
        case "start": {
          const started = yield* workflow.start(payload);
          return yield* HttpServerResponse.json({ executionId: started.executionId });
        }
        case "status":
          return yield* HttpServerResponse.json(yield* run.status);
        case "approve": {
          yield* run.signal(Approval, url.searchParams.get("by") ?? "nobody");
          return HttpServerResponse.text("ok");
        }
        case "interrupt": {
          yield* run.interrupt;
          return HttpServerResponse.text("ok");
        }
        default:
          return HttpServerResponse.text("Not Found", { status: 404 });
      }
    }).pipe(
      // Report why a request failed, so a failing case shows it.
      Effect.catchCause((cause) =>
        Effect.succeed(HttpServerResponse.text(Cause.pretty(cause), { status: 500 })),
      ),
    ),
  };
});
