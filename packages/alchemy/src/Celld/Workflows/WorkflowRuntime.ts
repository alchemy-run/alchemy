import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { runWorkflowTask } from "../../Workers/WorkflowCallback.ts";
import { terminalFailureMessage } from "../../Workers/WorkflowFailure.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import {
  WorkflowError,
  NonRetryableError,
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
 * captured from the current run; each attempt and dynamic retry delay owns a
 * fresh scope. Interrupting the task interrupts and joins active callbacks.
 *
 * Retry exhaustion restores the application's typed failure. Persisted replay
 * retains supported tags and data, not class prototypes or object identity.
 * Failures must fit the 16 KiB transport and 64 nesting levels; cycles, shared
 * references, accessors, functions, and symbols are rejected. Defects and native
 * control rejections remain defects; NonRetryableError stops native retries.
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
  E,
  | WorkflowStep
  | WorkflowEvent
  | RuntimeContext
  | Exclude<R | RetryR, WorkflowStepContext | Scope.Scope>
> =>
  Effect.gen(function* () {
    const step = yield* WorkflowStep;
    const event = yield* WorkflowEvent;
    const captured = (yield* Effect.context<
      Exclude<R | RetryR, WorkflowStepContext | Scope.Scope>
    >()).pipe(Context.omit(Scope.Scope, WorkflowStepContext));
    const provideAttempt = (context: WorkflowStepContextData) =>
      Layer.succeed(WorkflowStepContext, context).pipe(
        Layer.provideMerge(Layer.succeedContext(captured)),
      );
    const delay = options.retries?.delay;
    return yield* runWorkflowTask({
      name,
      isNativeTerminal: (error): error is NonRetryableError =>
        error instanceof NonRetryableError,
      identity: { workflow: event.workflowName, instanceId: event.instanceId },
      terminalFailure: (message) =>
        Effect.runPromise(
          Effect.sync(
            () => new NonRetryableError(terminalFailureMessage(message)),
          ),
        ),
      effect: (context: WorkflowStepContextData) =>
        effect.pipe(Effect.provide(provideAttempt(context))) as Effect.Effect<
          A,
          E,
          Scope.Scope
        >,
      native: (callback, run) =>
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
                            run(
                              delay(input).pipe(
                                Effect.provide(provideAttempt(input.ctx)),
                              ) as Effect.Effect<
                                string | number,
                                never,
                                Scope.Scope
                              >,
                            )
                        : delay!,
                  },
                }),
          },
          callback,
        ),
    });
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
): Effect.Effect<void, never, WorkflowStep | RuntimeContext> =>
  WorkflowStep.use((step) => Effect.promise(() => step.sleep(name, duration)));

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
): Effect.Effect<void, never, WorkflowStep | RuntimeContext> =>
  WorkflowStep.use((step) =>
    Effect.promise(() => step.sleepUntil(name, timestamp)),
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
    Effect.promise(() => step.waitForEvent<T>(name, options)),
  ) as Effect.Effect<
    import("./WorkflowTypes.ts").WorkflowStepEvent<T>,
    never,
    WorkflowStep | RuntimeContext
  >;
