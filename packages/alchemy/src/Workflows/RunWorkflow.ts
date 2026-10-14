import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import type * as Schema from "effect/Schema";
import { type DurableDeferred, type Workflow, WorkflowEngine } from "effect/workflow";
import type { Implemented } from "./Implemented.ts";

type NameOf<W> = W extends Workflow.Workflow<infer Name, any, any, any> ? Name : never;
type SuccessOf<W> = W extends Workflow.Workflow<any, any, infer S, any> ? S["Type"] : never;
type ErrorOf<W> = W extends Workflow.Workflow<any, any, any, infer E> ? E["Type"] : never;
type PayloadOf<W> =
  W extends Workflow.Workflow<any, infer P, any, any> ? P["~type.make.in"] : never;

/** Where a run is. */
export type Status<A, E> =
  | { readonly _tag: "NotStarted" }
  | { readonly _tag: "Running" }
  | { readonly _tag: "Completed"; readonly result: A }
  | { readonly _tag: "Failed"; readonly error: E }
  | { readonly _tag: "Interrupted" }
  | { readonly _tag: "Died"; readonly defect: unknown };

/** One run of a workflow. */
export interface Run<A, E> {
  /** The run's id. Store it to read the run again later, with `get`. */
  readonly executionId: string;
  /** Where the run is now. */
  readonly status: Effect.Effect<Status<A, E>>;
  /**
   * Wait for the run to finish: its result, or its failure. A run can take
   * days, so wait in tests and scripts, not in a request.
   */
  readonly result: Effect.Effect<A, E>;
  /** Complete a `DurableDeferred` the run waits on. */
  readonly signal: <Success extends Schema.Constraint>(
    deferred: DurableDeferred.DurableDeferred<Success, any>,
    value: Success["Type"],
  ) => Effect.Effect<void>;
  /** Stop the run: it fails where it waits, and its compensations run. */
  readonly interrupt: Effect.Effect<void>;
}

/** Starts and reads runs of one workflow. */
export interface WorkflowClient<W> {
  /** Start a run, or return the run already started with the same key. Returns at once. */
  readonly start: (payload: PayloadOf<W>) => Effect.Effect<Run<SuccessOf<W>, ErrorOf<W>>>;
  /** A run started earlier, by its id. */
  readonly get: (executionId: string) => Run<SuccessOf<W>, ErrorOf<W>>;
}

/** How often to check a run while waiting for it. */
const POLL = Schedule.min([Schedule.exponential("100 millis"), Schedule.spaced("5 seconds")]);

/**
 * Start and read runs of a workflow, on whichever engine the runtime
 * provides. Resolve it once, during init; its methods need nothing else.
 *
 * It needs the workflow implemented: by `Workflows.layer` in the same
 * runtime, or by a host a remote engine routes to. Running a workflow nothing
 * implements is a type error.
 *
 * ### Running a workflow
 * **Example:** Start a run from a request
 * ```typescript
 * import * as Workflows from "alchemy/Workflows";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * const app = Effect.gen(function* () {
 *   const greet = yield* Workflows.RunWorkflow(Greet);
 *   return {
 *     fetch: Effect.gen(function* () {
 *       const run = yield* greet.start({ name: "sam" });
 *       return HttpServerResponse.text(run.executionId);
 *     }),
 *   };
 * });
 * ```
 *
 * **Example:** Read a run later
 * ```typescript
 * const run = greet.get(executionId);
 * const status = yield* run.status;
 * yield* run.signal(Approval, "agent-7");
 * ```
 *
 * @primitive
 */
export const RunWorkflow = <W extends Workflow.Any>(
  workflow: W,
): Effect.Effect<
  WorkflowClient<W>,
  never,
  WorkflowEngine.WorkflowEngine | Implemented<NameOf<W>>
> =>
  Effect.gen(function* () {
    const engine = yield* WorkflowEngine.WorkflowEngine;
    const typed = workflow as unknown as Workflow.Workflow<string, any, any, any>;
    const run = (executionId: string): Run<SuccessOf<W>, ErrorOf<W>> => {
      const poll = engine.poll(typed, executionId);
      return {
        executionId,
        status: Effect.map(poll, (result): Status<SuccessOf<W>, ErrorOf<W>> => {
          if (Option.isNone(result)) return { _tag: "NotStarted" };
          if (result.value._tag === "Suspended") return { _tag: "Running" };
          const exit = result.value.exit;
          if (Exit.isSuccess(exit)) return { _tag: "Completed", result: exit.value };
          const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail");
          if (failure?._tag === "Fail") return { _tag: "Failed", error: failure.error };
          const defect = exit.cause.reasons.find((reason) => reason._tag === "Die");
          return defect?._tag === "Die"
            ? { _tag: "Died", defect: defect.defect }
            : { _tag: "Interrupted" };
        }) as Effect.Effect<Status<SuccessOf<W>, ErrorOf<W>>>,
        result: poll.pipe(
          Effect.flatMap((result) =>
            Option.isSome(result) && result.value._tag === "Complete"
              ? Effect.succeed(result.value.exit)
              : Effect.fail("running" as const),
          ),
          Effect.retry({ schedule: POLL }),
          Effect.orDie,
          Effect.flatten,
        ) as Effect.Effect<SuccessOf<W>, ErrorOf<W>>,
        signal: (deferred, value) =>
          engine.deferredDone(deferred, {
            workflowName: typed._tag,
            executionId,
            deferredName: deferred.name,
            exit: Exit.succeed(value),
          }) as Effect.Effect<void>,
        interrupt: engine.interrupt(typed, executionId),
      };
    };
    return {
      start: (payload) =>
        typed
          .execute(payload, { discard: true })
          .pipe(
            Effect.provideService(WorkflowEngine.WorkflowEngine, engine),
            Effect.map(run),
          ) as Effect.Effect<Run<SuccessOf<W>, ErrorOf<W>>>,
      get: run,
    } satisfies WorkflowClient<W>;
  });
