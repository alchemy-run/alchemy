import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import {
  WorkflowError,
  type NativeWorkflowStep,
  type WorkflowStepContextData,
  type WorkflowTaskConfig,
  type WorkflowWaitForEventOptions,
} from "./WorkflowTypes.ts";

/** The current Celld workflow run, with no unsupported native schedule metadata. */
export class WorkflowEvent extends Context.Service<
  WorkflowEvent,
  {
    readonly payload: unknown;
    readonly timestamp: Date;
    readonly instanceId: string;
    readonly workflowName: string;
  }
>()("Celld.Workflows.WorkflowEvent") {}

/** Effective policy and attempt information inside a durable task. */
export class WorkflowStepContext extends Context.Service<
  WorkflowStepContext,
  WorkflowStepContextData
>()("Celld.Workflows.WorkflowStepContext") {}

/** The native step engine for the current invocation. @internal */
export class WorkflowStep extends Context.Service<
  WorkflowStep,
  NativeWorkflowStep
>()("Celld.Workflows.WorkflowStep") {}

/** Convert a rejected native call without losing its cause. @internal */
export const workflowCall = <A>(call: () => PromiseLike<A>) =>
  Effect.tryPromise({
    try: call,
    catch: (cause) =>
      new WorkflowError({
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      }),
  });

/**
 * Run a durable task with native replay and retry semantics. Dependencies are
 * captured from the current run; per-attempt context is supplied by Celld.
 *
 * ### Persist a task result
 * **Example:** Read the attempt counter
 * ```typescript
 * const result = yield* Celld.Workflows.task("attempt", Effect.gen(function* () {
 *   return (yield* Celld.Workflows.WorkflowStepContext).attempt;
 * }), { retries: { limit: 3, delay: "1 second", backoff: "linear" } });
 * ```
 *
 * @binding
 * @product Celld
 */
export const task = <A, E, R, RetryR = never>(
  name: string,
  effect: Effect.Effect<A, E, R>,
  options: WorkflowTaskConfig<RetryR> = {},
): Effect.Effect<
  A,
  WorkflowError,
  WorkflowStep | RuntimeContext | Exclude<R | RetryR, WorkflowStepContext>
> =>
  Effect.gen(function* () {
    const step = yield* WorkflowStep;
    const captured =
      yield* Effect.context<Exclude<R | RetryR, WorkflowStepContext>>();
    const delay = options.retries?.delay;
    return yield* workflowCall(() =>
      step.do(
        name,
        {
          ...(options.timeout === undefined
            ? {}
            : { timeout: options.timeout }),
          ...(options.retries === undefined
            ? {}
            : {
                retries: {
                  ...options.retries,
                  delay:
                    typeof delay === "function"
                      ? (input: {
                          ctx: WorkflowStepContextData;
                          error: Error;
                        }) =>
                          Effect.runPromise(
                            delay(input).pipe(
                              Effect.provide(
                                Layer.succeed(
                                  WorkflowStepContext,
                                  input.ctx,
                                ).pipe(
                                  Layer.provideMerge(
                                    Layer.succeedContext(captured),
                                  ),
                                ),
                              ),
                            ) as Effect.Effect<string | number>,
                          )
                      : delay!,
                },
              }),
        },
        (context) =>
          Effect.runPromise(
            effect.pipe(
              Effect.provide(
                Layer.succeed(WorkflowStepContext, context).pipe(
                  Layer.provideMerge(Layer.succeedContext(captured)),
                ),
              ),
            ) as Effect.Effect<A, E>,
          ),
      ),
    );
  });

/**
 * Sleep durably; numeric durations are milliseconds.
 *
 * ### Delay a workflow
 * **Example:** Sleep between tasks
 * ```typescript
 * yield* Celld.Workflows.sleep("cooldown", "10 seconds");
 * ```
 *
 * @binding
 * @product Celld
 */
export const sleep = (
  name: string,
  duration: string | number,
): Effect.Effect<void, WorkflowError, WorkflowStep | RuntimeContext> =>
  WorkflowStep.use((step) => workflowCall(() => step.sleep(name, duration)));

/**
 * Sleep until an absolute time, preserving the native deadline on replay.
 *
 * ### Wait for a deadline
 * **Example:** Sleep until a supplied timestamp
 * ```typescript
 * yield* Celld.Workflows.sleepUntil("deadline", input.deadline);
 * ```
 *
 * @binding
 * @product Celld
 */
export const sleepUntil = (
  name: string,
  timestamp: Date | number,
): Effect.Effect<void, WorkflowError, WorkflowStep | RuntimeContext> =>
  WorkflowStep.use((step) =>
    workflowCall(() => step.sleepUntil(name, timestamp)),
  );

/**
 * Wait durably for an external instance event.
 *
 * ### Receive approval
 * **Example:** Read the native event envelope
 * ```typescript
 * const event = yield* Celld.Workflows.waitForEvent<{ approved: boolean }>(
 *   "approval", { type: "approval", timeout: "1 day" });
 * ```
 *
 * @binding
 * @product Celld
 */
export const waitForEvent = <T = unknown>(
  name: string,
  options: WorkflowWaitForEventOptions,
) =>
  WorkflowStep.use((step) =>
    workflowCall(() => step.waitForEvent<T>(name, options)),
  ) as Effect.Effect<
    import("./WorkflowTypes.ts").WorkflowStepEvent<T>,
    WorkflowError,
    WorkflowStep | RuntimeContext
  >;
