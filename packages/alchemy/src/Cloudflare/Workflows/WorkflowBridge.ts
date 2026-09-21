import * as Cause from "effect/Cause";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import {
  runWorkflowTask,
  withWorkflowScope,
} from "../../Workers/WorkflowCallback.ts";
import {
  callbackFailure,
  terminalFailureMessage,
  type WorkflowIdentity,
} from "../../Workers/WorkflowFailure.ts";
import { buildEventTelemetry } from "../../TelemetryRuntime.ts";
import { isScopeEjected } from "../Workers/HttpServer.ts";
import { getWorkerExport } from "../Workers/WorkerBridge.ts";
import type {
  WorkflowExport,
  WorkflowImpl,
  WorkflowStepConfig,
  WorkflowStepEvent,
  WorkflowTaskOptions,
} from "./Workflow.ts";
import {
  WorkflowEvent as WorkflowEventService,
  WorkflowStep,
  WorkflowStepContext,
} from "./WorkflowRuntime.ts";

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
  (className: string) => {
    // One isolate-lifetime layer build shared by every instantiation of this
    // workflow class — `build` memoizes the built context.
    const { build } = getWorkerExport<WorkflowExport>({
      entrypoint,
      stack,
      exportName: className,
    });

    return class WorkflowBridge extends WorkflowEntrypoint {
      readonly build: Promise<{
        readonly context: Context.Context<never>;
        readonly fn: WorkflowImpl<unknown, unknown, unknown>;
        readonly telemetry: () => Layer.Layer<never, any, any> | undefined;
      }>;

      constructor(ctx: unknown, env: unknown) {
        super(ctx, env);

        this.build = build(() => {}).then(
          ({ context, export: wf, telemetry }) =>
            wf.make(env).pipe(
              Effect.provideContext(context),
              Effect.map((fn) => ({
                context,
                fn: fn as WorkflowImpl<unknown, unknown, unknown>,
                telemetry,
              })),
              Effect.runPromise,
            ),
        );
      }

      async run(event: any, step: any): Promise<unknown> {
        const { context, fn, telemetry } = await this.build;
        const exit = await Effect.runPromiseExit(
          withWorkflowScope(
            Effect.gen(function* () {
              const scope = yield* Scope.Scope;
              return yield* fn(event.payload).pipe(
                Effect.provide(
                  Layer.mergeAll(
                    Layer.succeed(
                      WorkflowEventService,
                      wrapWorkflowEvent(event),
                    ),
                    Layer.succeed(
                      WorkflowStep,
                      wrapWorkflowStep(step, {
                        workflow: JSON.stringify([
                          stack.name,
                          stack.stage,
                          className,
                          event.workflowName ?? "",
                        ]),
                        instanceId: event.instanceId,
                      }),
                    ),
                    Layer.succeed(Scope.Scope, scope),
                    Layer.effectContext(
                      buildEventTelemetry(context, scope, telemetry()),
                    ),
                  ).pipe(Layer.provideMerge(Layer.succeedContext(context))),
                ),
              ) as Effect.Effect<unknown, unknown>;
            }),
            isScopeEjected,
          ),
        );
        if (Exit.isSuccess(exit)) {
          return exit.value;
        }
        throw Cause.squash(exit.cause);
      }
    };
  };

const wrapWorkflowEvent = (event: any): WorkflowEventService["Service"] => ({
  payload: event.payload,
  timestamp:
    event.timestamp instanceof Date
      ? event.timestamp
      : new Date(event.timestamp),
  instanceId: event.instanceId ?? "",
  workflowName: event.workflowName ?? "",
  schedule: event.schedule ?? undefined,
});

const terminalFailure = async (message: string): Promise<Error> => {
  const { NonRetryableError } = await import("cloudflare:workflows");
  return new NonRetryableError(terminalFailureMessage(message));
};

export const wrapWorkflowStep = (
  step: any,
  identity?: WorkflowIdentity,
): WorkflowStep["Service"] => ({
  do: <T, E>(
    options: WorkflowTaskOptions<T, any, any, E>,
  ): Effect.Effect<T, E> => {
    const { name } = options;
    // `task` provides application services; the bridge supplies attempt-local services.
    const effect = options.effect as Effect.Effect<
      T,
      E,
      WorkflowStepContext | Scope.Scope
    >;
    const config = definedStepConfig(options);
    const rollbackEffect = options.rollback;
    const rollback = rollbackEffect
      ? {
          // Native compensation may run after this step and the run scope have closed.
          rollback: async (context: any) => {
            const exit = await Effect.runPromiseExit(
              Effect.scoped(
                rollbackEffect({
                  error: context.error,
                  output: context.output,
                }) as Effect.Effect<void, unknown, Scope.Scope>,
              ),
            );
            if (Exit.isFailure(exit))
              throw await callbackFailure(
                exit.cause,
                terminalFailure,
                name,
                identity,
              );
          },
          rollbackConfig: definedStepConfig(options.rollbackConfig),
        }
      : undefined;
    return runWorkflowTask({
      name,
      identity,
      terminalFailure,
      effect: (context: any) =>
        effect.pipe(
          Effect.provideService(WorkflowStepContext, {
            step: context.step,
            attempt: context.attempt,
            config: context.config,
          }),
        ),
      native: (callback) => {
        if (config && rollback)
          return step.do(name, config, callback, rollback);
        if (config) return step.do(name, config, callback);
        if (rollback) return step.do(name, callback, rollback);
        return step.do(name, callback);
      },
    });
  },
  sleep: (name: string, duration: string | number): Effect.Effect<void> =>
    Effect.promise(() => step.sleep(name, duration)),
  sleepUntil: (name: string, timestamp: Date | number): Effect.Effect<void> =>
    Effect.promise(() => step.sleepUntil(name, timestamp)),
  waitForEvent: <T>(
    name: string,
    options: any,
  ): Effect.Effect<WorkflowStepEvent<T>> =>
    Effect.promise(
      () => step.waitForEvent(name, options) as Promise<WorkflowStepEvent<T>>,
    ),
});

// Own undefined properties overwrite the engine's defaults for steps and rollbacks.
const definedStepConfig = (
  options: WorkflowStepConfig | undefined,
): WorkflowStepConfig | undefined => {
  if (options === undefined) return undefined;
  const config: WorkflowStepConfig = {};
  if (options.retries !== undefined) config.retries = options.retries;
  if (options.timeout !== undefined) config.timeout = options.timeout;
  return Object.keys(config).length > 0 ? config : undefined;
};
