import * as Lambda from "@distilled.cloud/aws/lambda";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { DurableDeferred, type Workflow } from "effect/workflow";
import * as AWS from "@/AWS";
import { executionNameOf } from "@/AWS/Lambda/DurableWorkflowEngine.ts";
import * as Test from "@/Test/Alchemy";
import * as Core from "@/Test/Core";
import HostLive, { WorkflowHostFunction } from "./fixtures/durable-workflows/host.ts";
import {
  Approval,
  Approve,
  Checkout,
  Greet,
  Nap,
  Parent,
} from "./fixtures/durable-workflows/workflows.ts";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "LambdaDurableWorkflows");

/** A fresh id per run, so a retried test never reads an earlier attempt's execution. */
const freshId = (prefix: string) =>
  Effect.sync(() => `${prefix}-${crypto.randomUUID().slice(0, 8)}`);

describe(
  "Lambda DurableWorkflowEngine",
  { tags: ["provider:aws", "provider:aws:lambda", "live"] },
  () => {
    let functionName: string;

    beforeAll(
      Effect.gen(function* () {
        yield* sharedStack.destroy();
        const outputs = yield* sharedStack.deploy(
          Effect.gen(function* () {
            const host = yield* WorkflowHostFunction;
            return { functionName: host.functionName };
          }).pipe(Effect.provide(HostLive)),
        );
        functionName = outputs.functionName;
      }),
      { timeout: 600_000 },
    );
    afterAll(sharedStack.destroy(), { timeout: 120_000 });

    const engine = () => AWS.Lambda.DurableWorkflowEngine({ functionName });

    /** The durable execution of a run. */
    const executionOf = (workflow: Workflow.Any, executionId: string) =>
      Lambda.listDurableExecutionsByFunction({
        FunctionName: functionName,
        DurableExecutionName: executionNameOf(workflow._tag, executionId),
      }).pipe(
        Effect.map((page) => page.DurableExecutions ?? []),
        Effect.repeat({
          schedule: Schedule.spaced("1 second"),
          until: (executions) => executions.length > 0,
          times: 20,
        }),
      );

    /** The steps a run finished, in order, from its history. */
    const stepsOf = (workflow: Workflow.Any, executionId: string) =>
      Effect.gen(function* () {
        const [execution] = yield* executionOf(workflow, executionId);
        const events = yield* Lambda.getDurableExecutionHistory
          .items({ DurableExecutionArn: execution!.DurableExecutionArn })
          .pipe(Stream.runCollect);
        return [...events]
          .filter((event) => event.StepSucceededDetails !== undefined && event.Name)
          .map((event) => event.Name!)
          .filter((name) => !name.startsWith("child"))
          .map((name) => name.replace(/\/\d+$/, ""));
      });

    /** Poll a run until it finishes. */
    const awaitResult = (workflow: typeof Greet, executionId: string) =>
      workflow.poll(executionId).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("2 seconds"),
          until: (result) => Option.isSome(result) && result.value._tag === "Complete",
          times: 45,
        }),
        Effect.map((result) =>
          Option.isSome(result) && result.value._tag === "Complete" ? result.value.exit : undefined,
        ),
      );

    test.provider(
      "runs a workflow and returns its result",
      (_stack) =>
        Effect.gen(function* () {
          const id = yield* freshId("greet");
          const result = yield* Greet.execute({ id, name: "sam" });
          expect(result).toBe("hello sam");
          expect(yield* stepsOf(Greet, yield* Greet.executionId({ id, name: "sam" }))).toEqual([
            "greet",
            "log",
          ]);
        }).pipe(Effect.provide(engine())),
      { timeout: 120_000 },
    );

    test.provider(
      "starting the same execution twice runs it once",
      (_stack) =>
        Effect.gen(function* () {
          const id = yield* freshId("twice");
          const first = yield* Greet.execute({ id, name: "world" }, { discard: true });
          const second = yield* Greet.execute({ id, name: "world" }, { discard: true });
          expect(second).toBe(first);
          expect(yield* awaitResult(Greet, first)).toEqual(Exit.succeed("hello world"));
          expect((yield* executionOf(Greet, first)).length).toBe(1);
        }).pipe(Effect.provide(engine())),
      { timeout: 120_000 },
    );

    test.provider(
      "sleeps durably between steps",
      (_stack) =>
        Effect.gen(function* () {
          const id = yield* freshId("nap");
          const executionId = yield* Nap.execute({ id, seconds: 3 }, { discard: true });
          expect(yield* awaitResult(Nap as never, executionId)).toEqual(Exit.succeed("rested"));
          expect(yield* stepsOf(Nap, executionId)).toEqual(["before", "after"]);
        }).pipe(Effect.provide(engine())),
      { timeout: 120_000 },
    );

    test.provider(
      "waits for a signal from outside",
      (_stack) =>
        Effect.gen(function* () {
          const id = yield* freshId("approve");
          const executionId = yield* Approve.execute({ id }, { discard: true });
          yield* DurableDeferred.done(Approval, {
            token: DurableDeferred.tokenFromExecutionId(Approval, {
              workflow: Approve,
              executionId,
            }),
            exit: Exit.succeed("agent"),
          });
          expect(yield* awaitResult(Approve as never, executionId)).toEqual(
            Exit.succeed("approved by agent"),
          );
          expect(yield* stepsOf(Approve, executionId)).toEqual(["requested", "approved"]);
        }).pipe(Effect.provide(engine())),
      { timeout: 180_000 },
    );

    test.provider(
      "a typed failure runs compensations",
      (_stack) =>
        Effect.gen(function* () {
          const id = yield* freshId("declined");
          const exit = yield* Effect.exit(Checkout.execute({ id, decline: true }));
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail");
            expect(failure?._tag === "Fail" ? failure.error._tag : undefined).toBe("Declined");
          }
          const executionId = yield* Checkout.executionId({ id, decline: true });
          expect(yield* stepsOf(Checkout, executionId)).toEqual(["reserve", "charge", "release"]);
        }).pipe(Effect.provide(engine())),
      { timeout: 120_000 },
    );

    test.provider(
      "a successful workflow keeps its steps",
      (_stack) =>
        Effect.gen(function* () {
          const id = yield* freshId("charged");
          expect(yield* Checkout.execute({ id, decline: false })).toBe("charged");
          const executionId = yield* Checkout.executionId({ id, decline: false });
          expect(yield* stepsOf(Checkout, executionId)).toEqual(["reserve", "charge"]);
        }).pipe(Effect.provide(engine())),
      { timeout: 120_000 },
    );

    test.provider(
      "interrupting a waiting workflow finishes it",
      (_stack) =>
        Effect.gen(function* () {
          const id = yield* freshId("interrupt");
          const executionId = yield* Approve.execute({ id }, { discard: true });
          // Interrupt once it's waiting on its signal.
          yield* stepsOf(Approve, executionId).pipe(
            Effect.repeat({
              schedule: Schedule.spaced("1 second"),
              until: (steps) => steps.includes("requested"),
              times: 30,
            }),
          );
          yield* Approve.interrupt(executionId);
          const exit = yield* awaitResult(Approve as never, executionId);
          expect(exit !== undefined && Exit.isFailure(exit)).toBe(true);
          expect(yield* stepsOf(Approve, executionId)).toEqual(["requested"]);
          // Woken through its callback and finished by itself, not stopped.
          const [execution] = yield* executionOf(Approve, executionId);
          expect(execution!.Status).toBe("SUCCEEDED");
        }).pipe(Effect.provide(engine())),
      { timeout: 180_000 },
    );

    test.provider(
      "runs a child workflow",
      (_stack) =>
        Effect.gen(function* () {
          const id = yield* freshId("parent");
          expect(yield* Parent.execute({ id })).toBe("parent got hello child");
        }).pipe(Effect.provide(engine())),
      { timeout: 180_000 },
    );
  },
);
