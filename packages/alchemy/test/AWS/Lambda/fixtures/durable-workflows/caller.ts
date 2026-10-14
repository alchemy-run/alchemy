import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import path from "pathe";
import * as Lambda from "@/AWS/Lambda";
import * as Workflows from "@/Workflows/index.ts";
import { TestWorkflows } from "./host.ts";
import { Approval, Approve, Checkout, Greet, Nap, Parent } from "./workflows.ts";

const main = path.resolve(import.meta.dirname, "caller.ts");

/** A plain Lambda function that runs the test workflows on TestWorkflows, over HTTP. */
export class WorkflowCaller extends Lambda.Function<WorkflowCaller>()("WorkflowCaller") {}

export default WorkflowCaller.make(
  { main, functionUrl: true, timeout: Duration.seconds(60) },
  Effect.gen(function* () {
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
        const url = new URL(request.originalUrl, "http://caller");
        const [, operation, name, id] = url.pathname.split("/");
        if (operation === "ready") return HttpServerResponse.text("ready");
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
          case "status":
            return yield* HttpServerResponse.json(yield* workflow.get(executionId).status);
          case "approve": {
            yield* workflow.get(executionId).signal(Approval, url.searchParams.get("by") ?? "");
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
        Effect.catchCause((cause) =>
          Effect.succeed(HttpServerResponse.text(Cause.pretty(cause), { status: 500 })),
        ),
      ),
    };
  }).pipe(Effect.provide(Lambda.DurableFunctionEngine(TestWorkflows))),
);
