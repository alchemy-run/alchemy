import * as Cause from "effect/Cause";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { buildEventTelemetry } from "../../Telemetry.ts";
import { isScopeEjected } from "../Workers/HttpServer.ts";
import { getWorkerExport } from "../Workers/WorkerBridge.ts";
import {
  WorkflowEvent as WorkflowEventService,
  type WorkflowExport,
  type WorkflowImpl,
  WorkflowStep,
  WorkflowStepContext,
  type WorkflowStepConfig,
  type WorkflowStepEvent,
  type WorkflowTaskOptions,
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
        readonly fn: WorkflowImpl<unknown, unknown>;
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
                fn: fn as WorkflowImpl<unknown, unknown>,
                telemetry,
              })),
              Effect.runPromise,
            ),
        );
      }

      async run(event: any, step: any): Promise<unknown> {
        const { context, fn, telemetry } = await this.build;
        // Each run-invocation gets a fresh `Scope`, following the same
        // per-invocation-scope pattern as `WorkerBridge.processEvent`. `task`
        // threads it into every step via the surrounding body context, so
        // `@binding` helpers that acquire per-run resources against the
        // ambient scope (e.g. `Drizzle.Postgres`) resolve them inside
        // workflow steps, matching the Worker and Durable Object bridges.
        const scope = Scope.makeUnsafe();
        const exit = await Effect.runPromiseExit(
          fn(event.payload).pipe(
            Effect.provide(
              Layer.mergeAll(
                Layer.succeed(WorkflowEventService, wrapWorkflowEvent(event)),
                Layer.succeed(WorkflowStep, wrapWorkflowStep(step)),
                Layer.succeed(Scope.Scope, scope),
                // The configured telemetry exporters, attached to the run's
                // scope by `buildEventTelemetry` so buffered telemetry
                // flushes when the scope closes at the end of the
                // run-invocation.
                Layer.effectContext(
                  buildEventTelemetry(context, scope, telemetry()),
                ),
              ).pipe(Layer.provideMerge(Layer.succeedContext(context))),
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
  };

const wrapWorkflowEvent = (event: any): WorkflowEventService["Service"] => ({
  payload: event.payload,
  timestamp:
    event.timestamp instanceof Date
      ? event.timestamp
      : new Date(event.timestamp),
  instanceId: event.instanceId ?? "",
  workflowName: event.workflowName ?? "",
  schedule: event.schedule,
});

export const wrapWorkflowStep = (step: any): WorkflowStep["Service"] => ({
  do: <T>(options: WorkflowTaskOptions<T, any, any>): Effect.Effect<T> => {
    const { name } = options;
    // The surrounding body context is already provided in `task`; the bridge
    // supplies `WorkflowStepContext` and runs the step to completion, so the
    // effect is fully satisfied (R = never) at this boundary.
    const effect = options.effect as Effect.Effect<
      T,
      never,
      WorkflowStepContext
    >;
    const config = toWorkflowStepConfig(options);
    const rollbackEffect = options.rollback;
    const callback = (context: any) =>
      Effect.runPromise(
        effect.pipe(
          Effect.provideService(WorkflowStepContext, {
            step: context.step,
            attempt: context.attempt,
            config: context.config,
          }),
        ),
      );
    const rollback = rollbackEffect
      ? {
          rollback: (context: any) =>
            Effect.runPromise(
              rollbackEffect({
                error: context.error,
                output: context.output,
              }) as Effect.Effect<void>,
            ),
          // Scrubbed like the step's own config, and for the same reason: a
          // rollback does not get a config of its own — `executeRollbacks`
          // feeds this straight back through `ctx.do(target, config ?? {}, …)`,
          // so it lands on the identical defaults-merge and the identical
          // duration parse. This one arrives from the caller rather than being
          // synthesized here, so it is a narrower door, but it is the same door
          // — and it opens during rollback of an already-failing instance,
          // where the crash is even harder to attribute.
          rollbackConfig: definedStepConfig(options.rollbackConfig),
        }
      : undefined;
    return Effect.promise(() => {
      if (config && rollback) return step.do(name, config, callback, rollback);
      if (config) return step.do(name, config, callback);
      if (rollback) return step.do(name, callback, rollback);
      return step.do(name, callback);
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

/**
 * A `WorkflowStepConfig` carrying only the keys that have a value — or
 * `undefined` when none do, so the engine keeps every default it has.
 *
 * **A step config must never carry a key it has no value for.** The Workflows
 * engine merges one over its own defaults by spread —
 * `{ ...defaultConfig, ...stepConfig, retries: { ...defaultConfig.retries, ...stepConfig.retries } }`
 * — and an own property whose value is `undefined` still wins a spread. So a
 * config with `timeout: undefined` replaces the engine's `timeout: "10 minutes"`
 * with `undefined`. The engine parses that with itty-time's
 * `(e) => { if (!isNaN(+e)) return +e; e.match(/…/) … }`, and `+undefined` is
 * `NaN`, so it reaches `.match` on `undefined` and throws
 * `Cannot read properties of undefined (reading 'match')`.
 *
 * The symptom is badly disguised. That parse is the first statement of the
 * step's `timeoutPromise`, which *races* the callback rather than gating it —
 * so the step body runs and succeeds on every attempt, and the instance only
 * errors afterwards, with a message naming nothing in the user's workflow. A
 * step with `retries: { limit: 3 }` logs four successful bodies and then fails.
 *
 * `retries: undefined` happens to be survivable today, because the engine
 * rebuilds `retries` from its defaults with an explicit key *after* the spread.
 * It is the same mistake and is dropped for the same reason rather than relying
 * on that.
 *
 * The guard is `=== undefined` rather than falsy so that a caller's `timeout: 0`
 * is forwarded instead of dropped. The engine rejects `0` as invalid, which is a
 * better answer than silently running the step under the 10-minute default.
 */
const definedStepConfig = (
  config: WorkflowStepConfig | undefined,
): WorkflowStepConfig | undefined => {
  if (config === undefined) return undefined;
  const defined: WorkflowStepConfig = {};
  if (config.retries !== undefined) defined.retries = config.retries;
  if (config.timeout !== undefined) defined.timeout = config.timeout;
  return defined.retries === undefined && defined.timeout === undefined
    ? undefined
    : defined;
};

/**
 * The step's own config. Built from the options bag rather than passed through,
 * so this is where the `undefined` used to be synthesized: the old
 * `{ retries: options.retries, timeout: options.timeout }` literal set both keys
 * whether or not the caller gave both, which broke every step configured with
 * retries alone.
 */
const toWorkflowStepConfig = (
  options: WorkflowTaskOptions<any, any, any>,
): WorkflowStepConfig | undefined =>
  definedStepConfig({ retries: options.retries, timeout: options.timeout });
