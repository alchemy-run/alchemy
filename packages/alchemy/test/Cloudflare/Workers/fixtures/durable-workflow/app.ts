import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Option from "effect/Option";
import { DurableDeferred, Workflow, WorkflowEngine } from "effect/workflow";
import { Journal } from "./journal.ts";
import { Approval, Approve, Checkout, Greet, Nap, Parent } from "./workflows.ts";

const workflows = { Greet, Nap, Approve, Checkout, Parent } as const;

export type PollResult =
  | { readonly status: "none" }
  | { readonly status: "suspended" }
  | { readonly status: "success"; readonly value: unknown }
  | { readonly status: "failure"; readonly error: unknown };

const pollResult = (result: Option.Option<Workflow.Result<unknown, unknown>>): PollResult => {
  if (Option.isNone(result)) return { status: "none" };
  if (result.value._tag === "Suspended") return { status: "suspended" };
  const exit = result.value.exit;
  if (Exit.isSuccess(exit)) return { status: "success", value: exit.value };
  const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail");
  return {
    status: "failure",
    error: failure?._tag === "Fail" ? failure.error : String(exit.cause),
  };
};

/** The test Worker's routes, whichever engine runs its workflows. */
export const app = Effect.gen(function* () {
  const journals = yield* Journal;
  // Handlers run after init, so they get the engine from here.
  const engine = yield* WorkflowEngine.WorkflowEngine;
  return {
    fetch: Effect.gen(function* () {
      const request = yield* HttpServerRequest;
      const url = new URL(request.url, "http://durable-workflow");
      const [, operation, name, id] = url.pathname.split("/");
      if (operation === "ready") return HttpServerResponse.text("ready");
      if (operation === "journal" && name) {
        return yield* HttpServerResponse.json(yield* journals.getByName(name).list());
      }
      const workflow = workflows[name as keyof typeof workflows];
      if (!workflow || !id) return HttpServerResponse.text("Not Found", { status: 404 });
      const payload = {
        id,
        name: url.searchParams.get("name") ?? "world",
        seconds: Number(url.searchParams.get("seconds") ?? "2"),
        decline: url.searchParams.get("decline") === "true",
      };
      const executionId = yield* (workflow as typeof Greet).executionId(payload);

      switch (operation) {
        // Start it and wait for the result.
        case "run": {
          const exit = yield* Effect.exit((workflow as typeof Checkout).execute(payload as never));
          return yield* HttpServerResponse.json(
            Exit.isSuccess(exit)
              ? { status: "success", value: exit.value }
              : pollResult(Option.some(new Workflow.Complete({ exit }))),
          );
        }
        // Start it without waiting.
        case "start": {
          yield* (workflow as typeof Greet).execute(payload as never, { discard: true });
          return yield* HttpServerResponse.json({ executionId });
        }
        case "poll":
          return yield* HttpServerResponse.json(
            pollResult(yield* (workflow as typeof Greet).poll(executionId)),
          );
        case "approve": {
          yield* DurableDeferred.done(Approval, {
            token: DurableDeferred.tokenFromExecutionId(Approval, { workflow, executionId }),
            exit: Exit.succeed(url.searchParams.get("by") ?? "nobody"),
          });
          return HttpServerResponse.text("ok");
        }
        case "interrupt": {
          yield* (workflow as typeof Greet).interrupt(executionId);
          return HttpServerResponse.text("ok");
        }
        default:
          return HttpServerResponse.text("Not Found", { status: 404 });
      }
    }).pipe(
      Effect.provideService(WorkflowEngine.WorkflowEngine, engine),
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
