import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { ExecutionContext } from "../../ExecutionContext.ts";
import { isScopeEjected } from "./HttpServer.ts";
import { getWorkerExport } from "./WorkerBridge.ts";
import {
  WorkflowEvent as WorkflowEventService,
  type WorkflowExport,
  type WorkflowImpl,
  WorkflowStep,
} from "./Workflow.ts";

/**
 * Create a WorkflowBridge class that extends `WorkflowEntrypoint` and
 * delegates the `run(event, step)` call to the Effect-native workflow body
 * registered via `worker.export(...)`.
 *
 * The bridge provides `WorkflowEvent` and `WorkflowStep` as Effect
 * services so the user writes `yield* WorkflowEvent` and `yield* task(...)`
 * instead of receiving callback parameters.
 */
export const makeWorkflowBridge =
  (
    WorkflowEntrypoint: abstract new (
      ctx: unknown,
      env: unknown,
    ) => { run(event: any, step: any): Promise<unknown> },
    {
      entrypoint,
      stack,
    }: {
      entrypoint: Effect.Effect<Record<string, any>>;
      stack: { name: string; stage: string };
    },
  ) =>
  (className: string) =>
    class WorkflowBridge extends WorkflowEntrypoint {
      readonly fn: Promise<WorkflowImpl<unknown, unknown>>;

      constructor(ctx: unknown, env: unknown) {
        super(ctx, env);

        const { globalContext, exported } = getWorkerExport<WorkflowExport>({
          entrypoint,
          stack,
          exportName: className,
        });

        this.fn = exported.pipe(
          Effect.flatMap((wf) => wf.make(env)),
          Effect.provide(globalContext),
          Effect.runPromise,
        ) as Promise<WorkflowImpl<unknown, unknown>>;
      }

      async run(event: any, step: any): Promise<unknown> {
        const fn = await this.fn;
        // Each run-invocation gets a fresh ExecutionContext (scope + cache),
        // following the same per-invocation-scope pattern as
        // `WorkerBridge.processEvent`. `task` threads this into every step via
        // the surrounding body context, so `@binding` helpers that need it
        // (e.g. `Drizzle.postgres`) resolve their per-run resources inside
        // workflow steps. The same scope is also provided as the ambient
        // `Scope` service, matching the Worker and Durable Object bridges.
        const scope = Scope.makeUnsafe();
        const exit = await Effect.runPromiseExit(
          fn(event.payload).pipe(
            Effect.provide(
              Layer.succeed(
                WorkflowEventService,
                wrapWorkflowEvent(event),
              ).pipe(
                Layer.provideMerge(
                  Layer.succeed(WorkflowStep, wrapWorkflowStep(step)),
                ),
                Layer.provideMerge(
                  Layer.succeed(ExecutionContext, { scope, cache: {} }),
                ),
                Layer.provideMerge(Layer.succeed(Scope.Scope, scope)),
              ),
            ),
          ) as Effect.Effect<unknown>,
        );
        // Settle the run's resources with its real exit, unless a binding
        // ejected the scope to outlive the invocation. The workflow runtime has
        // no `waitUntil` to detach cleanup to, so close inline — a failing
        // finalizer (e.g. a pg pool `end()` on a dropped connection) is logged
        // and ignored so it can't mask the run's outcome.
        if (!isScopeEjected(scope)) {
          await Scope.close(scope, exit).pipe(
            Effect.ignoreCause({
              log: "Warn",
              message: "Workflow run scope close failed",
            }),
            Effect.runPromise,
          );
        }
        if (Exit.isSuccess(exit)) {
          return exit.value;
        }
        throw Cause.squash(exit.cause);
      }
    };

const wrapWorkflowEvent = (
  event: any,
): { payload: unknown; timestamp: Date; instanceId: string } => ({
  payload: event.payload,
  timestamp:
    event.timestamp instanceof Date
      ? event.timestamp
      : new Date(event.timestamp),
  instanceId: event.instanceId ?? "",
});

const wrapWorkflowStep = (step: any): WorkflowStep["Service"] => ({
  do: <T>(name: string, effect: Effect.Effect<T>): Effect.Effect<T> =>
    Effect.tryPromise(
      () => step.do(name, () => Effect.runPromise(effect)) as Promise<T>,
    ),
  sleep: (name: string, duration: string | number): Effect.Effect<void> =>
    Effect.tryPromise(() => step.sleep(name, duration)),
  sleepUntil: (name: string, timestamp: Date | number): Effect.Effect<void> =>
    Effect.tryPromise(() =>
      step.sleepUntil(
        name,
        timestamp instanceof Date ? timestamp.toISOString() : timestamp,
      ),
    ),
});
