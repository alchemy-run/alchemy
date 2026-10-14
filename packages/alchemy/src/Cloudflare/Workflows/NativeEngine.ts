import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { Workflow as EffectWorkflow, WorkflowEngine } from "effect/workflow";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import {
  decodeExit,
  decodeResult,
  encodeExit,
  encodeResult,
  payloadCodec,
} from "../../WorkflowEncoding.ts";
import type { Worker } from "../Workers/Worker.ts";
import { Workflow, type WorkflowHandle } from "./Workflow.ts";
import { WorkflowStep } from "./WorkflowRuntime.ts";

/** What each Cloudflare Workflow instance runs: one execution of one Effect workflow. */
interface Invocation {
  readonly workflow: string;
  readonly executionId: string;
  readonly payload: unknown;
}

/**
 * Host Effect workflows on Cloudflare Workflows: provides a `WorkflowEngine` to
 * the given workflow Layers (from `Workflow.toLayer`), and to everything after
 * them. One Cloudflare Workflow class, `NativeEngine`, runs them all; each
 * execution is one instance, named after the workflow and its execution id.
 *
 * Steps run with `step.do`, so a finished step is replayed rather than run
 * again. `DurableClock.sleep` is `step.sleep`, and `DurableDeferred.await`
 * waits for an event that `DurableDeferred.done` sends.
 *
 * ### Hosting workflows
 * **Example:** Provide workflows to a Worker
 * ```typescript
 * export default class AppWorker extends Cloudflare.Worker<AppWorker>()(
 *   "AppWorker",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const engine = yield* WorkflowEngine.WorkflowEngine;
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* SendWelcome.execute({ userId: "u-1" }, { discard: true });
 *         return HttpServerResponse.text("ok");
 *       }).pipe(Effect.provideService(WorkflowEngine.WorkflowEngine, engine)),
 *     };
 *   }).pipe(Effect.provide(Cloudflare.Workflows.NativeEngine(SendWelcomeLive))),
 * ) {}
 * ```
 *
 * @layer
 * @provides WorkflowEngine
 * @product Workflows
 */
export const NativeEngine = <ROut, E, RIn>(
  workflows: Layer.Layer<ROut, E, RIn>,
): Layer.Layer<
  ROut | WorkflowEngine.WorkflowEngine,
  E,
  Exclude<RIn, WorkflowEngine.WorkflowEngine | RuntimeContext> | Worker
> =>
  // A handler only runs inside a run, which provides its own RuntimeContext.
  workflows.pipe(Layer.provideMerge(NativeEngineLayer)) as Layer.Layer<
    ROut | WorkflowEngine.WorkflowEngine,
    E,
    Exclude<RIn, WorkflowEngine.WorkflowEngine | RuntimeContext> | Worker
  >;

type Execute = (
  payload: object,
  executionId: string,
) => Effect.Effect<
  unknown,
  unknown,
  WorkflowEngine.WorkflowInstance | WorkflowEngine.WorkflowEngine
>;

/** The run in progress: its step context, and the clocks it has scheduled. */
class CurrentRun extends Context.Service<
  CurrentRun,
  {
    readonly step: WorkflowStep["Service"];
    readonly context: Context.Context<never>;
    readonly clocks: Map<string, Duration.Duration>;
    readonly instance: WorkflowEngine.WorkflowInstance["Service"];
  }
>()("alchemy/Cloudflare/Workflows/NativeEngine/CurrentRun") {}

const currentRun = (operation: string) =>
  Effect.flatMap(Effect.serviceOption(CurrentRun), (run) =>
    Option.isSome(run)
      ? Effect.succeed(run.value)
      : Effect.die(new Error(`NativeEngine: ${operation} only runs inside a workflow run`)),
  );

/**
 * A name Cloudflare accepts for an instance id or event type: up to 100
 * letters, digits, `-` and `_`.
 */
const nameOf = (...parts: ReadonlyArray<string>) => {
  const name = parts.join("-").replace(/[^A-Za-z0-9_-]/g, "_");
  if (name.length <= 100) return name;
  let hash = 2166136261;
  for (const char of name) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
  return `${name.slice(0, 91)}-${hash.toString(16).padStart(8, "0")}`;
};

/** Every wait for a signal also waits for this event, which interrupts the run. */
const INTERRUPT = "alchemy-interrupt";

/** How long a run waits for a signal; Cloudflare's limit for `waitForEvent`. */
const SIGNAL_TIMEOUT = "365 days";

/**
 * Retry a Workflows binding call while the Workflow class is still
 * propagating after a deploy, which Cloudflare reports as "Worker not found",
 * for about a minute.
 */
const inTransit = <A>(call: Effect.Effect<A>): Effect.Effect<A> =>
  call.pipe(
    Effect.catchDefect((defect) =>
      String(defect).includes("Worker not found") ? Effect.fail(defect) : Effect.die(defect),
    ),
    Effect.retry({
      schedule: Schedule.min([Schedule.exponential("100 millis"), Schedule.spaced("2 seconds")]),
      times: 35,
    }),
    Effect.catch((defect) => Effect.die(defect)),
  ) as Effect.Effect<A>;

/**
 * Send an event to an instance, retrying any failure for about a minute: a run
 * takes each signal and interrupt at most once, so sending one again is safe.
 */
const sendEvent = (
  handle: WorkflowHandle,
  id: string,
  event: { type: string; payload?: unknown },
) =>
  handle.get(id).pipe(
    Effect.flatMap((instance) => instance.sendEvent(event)),
    Effect.catchDefect((defect) => Effect.fail(defect)),
    Effect.retry({
      schedule: Schedule.min([Schedule.exponential("100 millis"), Schedule.spaced("2 seconds")]),
      times: 35,
    }),
    Effect.catch((defect) => Effect.die(defect)),
  ) as Effect.Effect<void>;

/** An instance's status, or undefined if there's no such instance. */
const statusOf = (handle: WorkflowHandle, id: string) =>
  inTransit(handle.get(id).pipe(Effect.flatMap((instance) => instance.status()))).pipe(
    Effect.exit,
    Effect.map((exit) => (Exit.isSuccess(exit) ? exit.value : undefined)),
  );

/** An instance's result, or undefined while it runs. */
const resultOf = (
  handle: WorkflowHandle,
  workflow: EffectWorkflow.AnyWithProps,
  id: string,
): Effect.Effect<EffectWorkflow.Complete<unknown, unknown> | undefined | null> =>
  Effect.gen(function* () {
    const status = yield* statusOf(handle, id);
    if (status === undefined) return null;
    switch (status.status) {
      case "complete":
        return yield* decodeResult(workflow, status.output as string);
      case "terminated":
        return new EffectWorkflow.Complete({ exit: Exit.interrupt() });
      case "errored":
        return new EffectWorkflow.Complete({
          exit: Exit.die(new Error(status.error?.message ?? `Workflow instance ${id} errored`)),
        });
      default:
        return undefined;
    }
  });

/** A `WorkflowEngine` on Cloudflare Workflows. */
const NativeEngineLayer: Layer.Layer<WorkflowEngine.WorkflowEngine, never, Worker> = Layer.effect(
  WorkflowEngine.WorkflowEngine,
  Effect.gen(function* () {
    const handlers = new Map<
      string,
      { readonly workflow: EffectWorkflow.AnyWithProps; readonly execute: Execute }
    >();
    let engine: WorkflowEngine.WorkflowEngine["Service"];

    const handle = yield* Workflow(
      "NativeEngine",
      Effect.succeed((invocation: Invocation) =>
        Effect.gen(function* () {
          const registration = handlers.get(invocation.workflow);
          if (!registration) {
            return yield* Effect.die(
              new Error(`Workflow ${invocation.workflow} is not hosted here`),
            );
          }
          const step = yield* WorkflowStep;
          const context = yield* Effect.context<never>();
          const { workflow, execute } = registration;
          const payload = yield* Schema.decodeEffect(payloadCodec(workflow))(
            invocation.payload,
          ).pipe(Effect.orDie);
          const instance = WorkflowEngine.WorkflowInstance.initial(
            workflow,
            invocation.executionId,
          );
          const result = yield* execute(payload as object, invocation.executionId).pipe(
            EffectWorkflow.intoResult,
            Effect.provide(
              Layer.mergeAll(
                Layer.succeed(WorkflowEngine.WorkflowInstance, instance),
                Layer.succeed(WorkflowEngine.WorkflowEngine, engine),
                Layer.succeed(CurrentRun, { step, context, clocks: new Map(), instance }),
              ),
            ),
          );
          // Every wait blocks inside the instance, so a run always finishes.
          if (result._tag === "Suspended") {
            return yield* Effect.die(new Error(`Workflow ${workflow._tag} suspended unexpectedly`));
          }
          return yield* encodeResult(workflow, result.exit);
        }),
      ),
    ) as Effect.Effect<WorkflowHandle, never, Worker>;

    engine = WorkflowEngine.makeUnsafe({
      register: (workflow, execute) =>
        Effect.sync(
          () =>
            void handlers.set(workflow._tag, {
              workflow: workflow as EffectWorkflow.AnyWithProps,
              execute,
            }),
        ),

      execute: (workflow, opts) =>
        Effect.gen(function* () {
          const id = nameOf(workflow._tag, opts.executionId);
          const payload = yield* Schema.encodeEffect(
            payloadCodec(workflow as EffectWorkflow.AnyWithProps),
          )(opts.payload).pipe(Effect.orDie);
          // The same key always names the same run: create it only once.
          if ((yield* statusOf(handle, id)) === undefined) {
            yield* inTransit(
              handle.create({
                id,
                params: { workflow: workflow._tag, executionId: opts.executionId, payload },
              }),
            ).pipe(
              Effect.exit,
              Effect.flatMap((exit) =>
                Exit.isSuccess(exit)
                  ? Effect.void
                  : Effect.flatMap(statusOf(handle, id), (status) =>
                      status === undefined ? Effect.failCause(exit.cause) : Effect.void,
                    ),
              ),
            );
          }
          if (opts.discard) return undefined;
          const run = yield* Effect.serviceOption(CurrentRun);
          if (Option.isNone(run)) {
            const result = yield* resultOf(handle, workflow as EffectWorkflow.AnyWithProps, id);
            return result ?? new EffectWorkflow.Suspended({});
          }
          // A child workflow: wait for it here, sleeping between checks.
          for (let check = 0; ; check++) {
            const text = yield* run.value.step.do({
              name: `child/${id}/${check}`,
              effect: resultOf(handle, workflow as EffectWorkflow.AnyWithProps, id).pipe(
                Effect.flatMap((result) =>
                  result
                    ? encodeResult(workflow as EffectWorkflow.AnyWithProps, result.exit)
                    : Effect.succeed(""),
                ),
              ),
            });
            if (text !== "") {
              return yield* decodeResult(workflow as EffectWorkflow.AnyWithProps, text);
            }
            yield* run.value.step.sleep(`child-wait/${id}/${check}`, "5 seconds");
          }
        }) as Effect.Effect<any>,

      poll: (workflow, executionId) =>
        Effect.map(
          resultOf(
            handle,
            workflow as EffectWorkflow.AnyWithProps,
            nameOf(workflow._tag, executionId),
          ),
          (result) =>
            result === null
              ? Option.none()
              : Option.some(result ?? new EffectWorkflow.Suspended({})),
        ),

      // The run wakes from whatever it waits for, fails there, and runs
      // its compensations.
      interrupt: (workflow, executionId) =>
        sendEvent(handle, nameOf(workflow._tag, executionId), { type: INTERRUPT }),

      interruptUnsafe: (workflow, executionId) =>
        inTransit(
          handle
            .get(nameOf(workflow._tag, executionId))
            .pipe(Effect.flatMap((instance) => instance.terminate())),
        ),

      // Every instance continues on its own; there's nothing to resume.
      resume: () => Effect.void,

      activityExecute: (activity, attempt) =>
        Effect.gen(function* () {
          const run = yield* currentRun("activity execution");
          const instance = yield* WorkflowEngine.WorkflowInstance;
          const activityInstance = WorkflowEngine.WorkflowInstance.initial(
            instance.workflow,
            instance.executionId,
          );
          activityInstance.interrupted = instance.interrupted;
          // The step never fails: its exit, failure or not, is its result.
          const text = yield* run.step.do({
            name: `${activity.name}/${attempt}`,
            effect: activity.executeEncoded.pipe(
              EffectWorkflow.intoResult,
              Effect.flatMap((result) =>
                result._tag === "Complete"
                  ? encodeExit(result.exit)
                  : Effect.die(new Error(`Activity ${activity.name} suspended inside a step`)),
              ),
              // The run's services, with the step's own instance.
              Effect.provide(
                Layer.succeedContext(
                  Context.add(run.context, WorkflowEngine.WorkflowInstance, activityInstance),
                ),
              ),
            ) as Effect.Effect<string>,
          });
          return new EffectWorkflow.Complete({ exit: yield* decodeExit(text) });
        }),

      deferredResult: (deferred) =>
        Effect.gen(function* () {
          const run = yield* currentRun("DurableDeferred reads");
          const duration = run.clocks.get(deferred.name);
          if (duration !== undefined) {
            yield* run.step.sleep(deferred.name, Duration.toMillis(duration));
            return Option.some(Exit.void);
          }
          const signal = yield* run.step
            .waitForEvent<string>(deferred.name, {
              type: nameOf(deferred.name),
              timeout: SIGNAL_TIMEOUT,
            })
            .pipe(
              Effect.map((event) => ({ interrupted: false, payload: event.payload })),
              Effect.raceFirst(
                run.step
                  .waitForEvent(`${deferred.name}/interrupt`, {
                    type: INTERRUPT,
                    timeout: SIGNAL_TIMEOUT,
                  })
                  .pipe(Effect.as({ interrupted: true, payload: "" })),
              ),
            );
          if (signal.interrupted) {
            run.instance.interrupted = true;
            run.instance.suspended = false;
            return yield* Effect.interrupt;
          }
          return Option.some(yield* decodeExit(signal.payload));
        }),

      deferredDone: (opts) =>
        Effect.gen(function* () {
          const payload = yield* encodeExit(opts.exit);
          yield* sendEvent(handle, nameOf(opts.workflowName, opts.executionId), {
            type: nameOf(opts.deferredName),
            payload,
          });
        }),

      scheduleClock: (_workflow, opts) =>
        Effect.flatMap(currentRun("DurableClock scheduling"), (run) =>
          Effect.sync(() => void run.clocks.set(opts.clock.deferred.name, opts.clock.duration)),
        ),
    });
    return engine;
  }),
);
