import type { Credentials } from "@distilled.cloud/aws/Credentials";
import * as Lambda from "@distilled.cloud/aws/lambda";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { Workflow, WorkflowEngine } from "effect/workflow";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import {
  decodeExit,
  decodeResult,
  encodeExit,
  encodeResult,
  payloadCodec,
} from "../../WorkflowEncoding.ts";
import { DurableStep } from "./Durable.ts";
import type { DurableFunctionImpl } from "./DurableFunction.ts";

/** What a durable function running workflows is started with. */
export interface WorkflowInvocation {
  /** The workflow's tag. */
  readonly workflow: string;
  readonly executionId: string;
  /** The payload, encoded. */
  readonly payload: unknown;
}

/** The services a client engine calls Lambda with. */
type LambdaServices = Credentials | HttpClient.HttpClient;

/**
 * Host Effect workflows in an AWS Lambda durable function. Pass the workflow
 * Layers (from `Workflow.toLayer`) as the function's implementation; each run
 * is one durable execution, named after the workflow and its execution id.
 *
 * Steps run as durable steps, so a finished step's result is replayed rather
 * than run again. `DurableClock.sleep` is a durable wait: the invocation ends,
 * and Lambda invokes the function again when it's due. `DurableDeferred.await`
 * waits for a callback, completed from outside with `DurableDeferred.done`.
 *
 * ### Hosting workflows
 * **Example:** A durable function that runs workflows
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 * import * as Layer from "effect/Layer";
 * import { CheckoutLive, GreetLive } from "./workflows.ts";
 *
 * export default class Workflows extends AWS.Lambda.DurableFunction<Workflows>()(
 *   "Workflows",
 *   { main: import.meta.url, executionTimeout: "7 days" },
 *   AWS.Lambda.WorkflowHost(Layer.mergeAll(GreetLive, CheckoutLive)),
 * ) {}
 * ```
 *
 * @layer
 * @provides WorkflowEngine
 * @product Lambda
 */
export const WorkflowHost = <ROut, E, RIn>(
  workflows: Layer.Layer<ROut, E, RIn>,
): Effect.Effect<
  DurableFunctionImpl<WorkflowInvocation, string>,
  E,
  Exclude<RIn, WorkflowEngine.WorkflowEngine | RuntimeContext> | LambdaServices
> =>
  Effect.gen(function* () {
    const context = yield* Effect.context<LambdaServices>();
    const functionName = yield* Effect.sync(() => process.env.AWS_LAMBDA_FUNCTION_NAME);
    // Child workflows start on the version this function is running.
    const version = yield* Effect.sync(() => process.env.AWS_LAMBDA_FUNCTION_VERSION ?? "$LATEST");
    const handlers = new Map<string, Registration>();
    const engine = makeEngine({
      calls: makeCalls(
        context,
        () =>
          functionName
            ? Effect.succeed(functionName)
            : Effect.die(new Error("AWS_LAMBDA_FUNCTION_NAME is not set")),
        version,
      ),
      register: (workflow, execute) => handlers.set(workflow._tag, { workflow, execute }),
    });
    // Workflows register for the life of the function instance.
    yield* Layer.buildWithScope(
      workflows.pipe(Layer.provide(Layer.succeed(WorkflowEngine.WorkflowEngine, engine))),
      yield* Scope.make(),
    );

    return (invocation: WorkflowInvocation) =>
      Effect.gen(function* () {
        const registration = handlers.get(invocation.workflow);
        if (!registration) {
          return yield* Effect.die(new Error(`Workflow ${invocation.workflow} is not hosted here`));
        }
        const durable = yield* DurableStep;
        const runContext = yield* Effect.context<never>();
        const { workflow, execute } = registration;
        const payload = yield* Schema.decodeEffect(payloadCodec(workflow))(invocation.payload).pipe(
          Effect.orDie,
        );
        const instance = WorkflowEngine.WorkflowInstance.initial(workflow, invocation.executionId);
        const result = yield* execute(payload as object, invocation.executionId).pipe(
          Workflow.intoResult,
          Effect.provide(
            Layer.mergeAll(
              Layer.succeed(WorkflowEngine.WorkflowInstance, instance),
              Layer.succeed(WorkflowEngine.WorkflowEngine, engine),
              Layer.succeed(CurrentRun, {
                durable,
                context: runContext,
                clocks: new Map(),
                instance,
              }),
            ),
          ),
        );
        // Every wait blocks inside the durable execution, so a run always finishes.
        if (result._tag === "Suspended") {
          return yield* Effect.die(new Error(`Workflow ${workflow._tag} suspended unexpectedly`));
        }
        return yield* encodeResult(workflow, result.exit);
      }) as Effect.Effect<string, never, never>;
  }) as Effect.Effect<
    DurableFunctionImpl<WorkflowInvocation, string>,
    E,
    Exclude<RIn, WorkflowEngine.WorkflowEngine | RuntimeContext> | LambdaServices
  >;

/**
 * A `WorkflowEngine` that starts, reads, signals and interrupts workflows
 * hosted by a durable function, by name, through the Lambda API. Use it
 * wherever the ambient AWS credentials may call that function.
 *
 * @layer
 * @provides WorkflowEngine
 * @product Lambda
 */
export const DurableWorkflowEngine = (options: {
  /** The durable function hosting the workflows, by name or ARN. */
  readonly functionName: string;
  /**
   * The version or alias runs start on. Durable executions replay against the
   * version they started on, so production should name a version or alias.
   * @default "$LATEST"
   */
  readonly qualifier?: string;
}): Layer.Layer<WorkflowEngine.WorkflowEngine, never, LambdaServices> =>
  Layer.effect(
    WorkflowEngine.WorkflowEngine,
    Effect.map(Effect.context<LambdaServices>(), (context) =>
      makeEngine({
        calls: makeCalls(
          context,
          () => Effect.succeed(options.functionName),
          options.qualifier ?? "$LATEST",
        ),
        register: () => undefined,
      }),
    ),
  );

// ---------------------------------------------------------------- the engine

type Execute = (
  payload: object,
  executionId: string,
) => Effect.Effect<
  unknown,
  unknown,
  WorkflowEngine.WorkflowInstance | WorkflowEngine.WorkflowEngine
>;

interface Registration {
  readonly workflow: Workflow.AnyWithProps;
  readonly execute: Execute;
}

/** The run in progress: its durable context, and the clocks it has scheduled. */
class CurrentRun extends Context.Service<
  CurrentRun,
  {
    readonly durable: DurableStep["Service"];
    readonly context: Context.Context<never>;
    readonly clocks: Map<string, Duration.Duration>;
    readonly instance: WorkflowEngine.WorkflowInstance["Service"];
  }
>()("alchemy/AWS/Lambda/DurableWorkflowEngine/CurrentRun") {}

const currentRun = (operation: string) =>
  Effect.flatMap(Effect.serviceOption(CurrentRun), (run) =>
    Option.isSome(run)
      ? Effect.succeed(run.value)
      : Effect.die(
          new Error(`DurableWorkflowEngine: ${operation} only runs inside a workflow run`),
        ),
  );

/** A callback failed with this type interrupts the run waiting on it. */
const INTERRUPT = "alchemy/WorkflowInterrupted";

/** Lambda's calls for one host function. */
interface Calls {
  readonly start: (executionName: string, invocation: WorkflowInvocation) => Effect.Effect<void>;
  readonly find: (executionName: string) => Effect.Effect<string | undefined>;
  readonly get: (
    executionArn: string,
  ) => Effect.Effect<{ readonly status: string; readonly result: string | undefined }>;
  readonly history: (executionArn: string) => Effect.Effect<ReadonlyArray<Lambda.Event>>;
  readonly stop: (executionArn: string) => Effect.Effect<void>;
  readonly succeed: (callbackId: string, result: string) => Effect.Effect<void>;
  readonly fail: (callbackId: string, errorType: string) => Effect.Effect<void>;
}

const unwrap = (value: string | Redacted.Redacted<string> | undefined) =>
  value === undefined ? undefined : Redacted.isRedacted(value) ? Redacted.value(value) : value;

const makeCalls = (
  context: Context.Context<LambdaServices>,
  functionName: () => Effect.Effect<string>,
  qualifier: string,
): Calls => {
  const run = <A, E>(effect: Effect.Effect<A, E, LambdaServices>) =>
    effect.pipe(Effect.provide(context), Effect.orDie);
  return {
    start: (executionName, invocation) =>
      Effect.flatMap(functionName(), (FunctionName) =>
        run(
          Lambda.invoke({
            FunctionName,
            Qualifier: qualifier,
            InvocationType: "Event",
            DurableExecutionName: executionName,
            Payload: JSON.stringify(invocation),
          }).pipe(
            // Already started: the same key always names the same run.
            Effect.catchTag("DurableExecutionAlreadyStartedException", () => Effect.void),
            Effect.asVoid,
          ),
        ),
      ),
    find: (executionName) =>
      Effect.flatMap(functionName(), (FunctionName) =>
        run(
          Lambda.listDurableExecutionsByFunction({
            FunctionName,
            DurableExecutionName: executionName,
          }).pipe(Effect.map((page) => page.DurableExecutions?.[0]?.DurableExecutionArn)),
        ),
      ),
    get: (executionArn) =>
      run(
        Lambda.getDurableExecution({ DurableExecutionArn: executionArn }).pipe(
          Effect.map((execution) => ({
            status: execution.Status,
            result: unwrap(execution.Result),
          })),
        ),
      ),
    history: (executionArn) =>
      run(
        Lambda.getDurableExecutionHistory.items({ DurableExecutionArn: executionArn }).pipe(
          Stream.runCollect,
          Effect.map((events) => [...events]),
        ),
      ),
    stop: (executionArn) =>
      run(Lambda.stopDurableExecution({ DurableExecutionArn: executionArn }).pipe(Effect.asVoid)),
    succeed: (callbackId, result) =>
      run(
        Lambda.sendDurableExecutionCallbackSuccess({ CallbackId: callbackId, Result: result }).pipe(
          Effect.asVoid,
        ),
      ),
    fail: (callbackId, errorType) =>
      run(
        Lambda.sendDurableExecutionCallbackFailure({
          CallbackId: callbackId,
          Error: { ErrorType: errorType, ErrorMessage: errorType },
        }).pipe(Effect.asVoid),
      ),
  };
};

/**
 * A durable execution's name: the workflow and execution id, within Lambda's
 * limit of 64 letters, digits, `-` and `_`.
 */
/** @internal */
export const executionNameOf = (workflowName: string, executionId: string) => {
  const name = `${workflowName}-${executionId}`.replace(/[^A-Za-z0-9_-]/g, "_");
  if (name.length <= 64) return name;
  let hash = 2166136261;
  for (const char of name) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
  return `${name.slice(0, 55)}-${hash.toString(16).padStart(8, "0")}`;
};

/**
 * Callbacks a run is waiting on: started, and not yet completed. A callback's
 * name is on the `waitForCallback` context it was started in, its parent.
 */
const pendingCallbacks = (events: ReadonlyArray<Lambda.Event>) => {
  const names = new Map<string, string>();
  const started = new Map<string, { readonly name: string; readonly callbackId: string }>();
  for (const event of events) {
    if (event.SubType === "WaitForCallback" && event.Id && event.Name) {
      names.set(event.Id, event.Name);
    }
    if (event.CallbackStartedDetails && event.Id) {
      started.set(event.Id, {
        name: (event.ParentId && names.get(event.ParentId)) ?? event.Name ?? "",
        callbackId: event.CallbackStartedDetails.CallbackId,
      });
    }
    if (
      event.Id &&
      (event.CallbackSucceededDetails ||
        event.CallbackFailedDetails ||
        event.CallbackTimedOutDetails)
    ) {
      started.delete(event.Id);
    }
  }
  return [...started.values()];
};

/** Find a waiting run's callback, retrying while the run is on its way to the wait. */
const findCallback = (calls: Calls, executionName: string, deferredName: string) =>
  Effect.gen(function* () {
    const arn = yield* calls.find(executionName);
    if (!arn) return yield* Effect.fail("not started" as const);
    const callback = pendingCallbacks(yield* calls.history(arn)).find(
      (pending) => pending.name === deferredName,
    );
    return callback ? callback.callbackId : yield* Effect.fail("not waiting" as const);
  }).pipe(
    Effect.retry({
      schedule: Schedule.min([Schedule.exponential("200 millis"), Schedule.spaced("5 seconds")]),
      times: 40,
    }),
    Effect.catch((reason) =>
      Effect.die(
        new Error(
          `Workflow execution ${executionName} is ${reason === "not started" ? "not started" : `not waiting on ${deferredName}`}`,
        ),
      ),
    ),
  );

/** Read a run's result from Lambda: undefined while it runs. */
const readResult = (calls: Calls, workflow: Workflow.AnyWithProps, executionArn: string) =>
  Effect.gen(function* () {
    const { status, result } = yield* calls.get(executionArn);
    switch (status) {
      case "RUNNING":
        return undefined;
      case "SUCCEEDED":
        return yield* decodeResult(workflow, JSON.parse(result ?? "null") as string);
      case "STOPPED":
        return new Workflow.Complete({ exit: Exit.interrupt() });
      default:
        return new Workflow.Complete({
          exit: Exit.die(new Error(`Workflow execution ${executionArn} ended ${status}`)),
        });
    }
  });

const makeEngine = (options: {
  readonly calls: Calls;
  readonly register: (workflow: Workflow.AnyWithProps, execute: Execute) => void;
}): WorkflowEngine.WorkflowEngine["Service"] => {
  const { calls } = options;
  return WorkflowEngine.makeUnsafe({
    register: (workflow, execute) =>
      Effect.sync(() => options.register(workflow as Workflow.AnyWithProps, execute)),

    execute: (workflow, opts) =>
      Effect.gen(function* () {
        const executionName = executionNameOf(workflow._tag, opts.executionId);
        const payload = yield* Schema.encodeEffect(payloadCodec(workflow as Workflow.AnyWithProps))(
          opts.payload,
        ).pipe(Effect.orDie);
        yield* calls.start(executionName, {
          workflow: workflow._tag,
          executionId: opts.executionId,
          payload,
        });
        if (opts.discard) return undefined;
        const run = yield* Effect.serviceOption(CurrentRun);
        if (Option.isNone(run)) {
          const arn = yield* calls.find(executionName);
          const result = arn
            ? yield* readResult(calls, workflow as Workflow.AnyWithProps, arn)
            : undefined;
          return result ?? new Workflow.Suspended({});
        }
        // A child workflow: wait for it here, with durable waits between checks.
        for (let check = 0; ; check++) {
          const text = yield* run.value.durable.step({
            name: `child/${executionName}/${check}`,
            effect: Effect.gen(function* () {
              const arn = yield* calls.find(executionName);
              const result = arn
                ? yield* readResult(calls, workflow as Workflow.AnyWithProps, arn)
                : undefined;
              return result
                ? yield* encodeResult(workflow as Workflow.AnyWithProps, result.exit)
                : "";
            }),
          });
          if (text !== "") return yield* decodeResult(workflow as Workflow.AnyWithProps, text);
          yield* run.value.durable.wait(`child-wait/${executionName}/${check}`, "5 seconds");
        }
      }) as Effect.Effect<any>,

    poll: (workflow, executionId) =>
      Effect.gen(function* () {
        const arn = yield* calls.find(executionNameOf(workflow._tag, executionId));
        if (!arn) return Option.none();
        const result = yield* readResult(calls, workflow as Workflow.AnyWithProps, arn);
        return Option.some(result ?? new Workflow.Suspended({}));
      }),

    // A run waiting on a signal is woken with an interrupt, so its
    // compensations run; a run busy in a step can only be stopped.
    interrupt: (workflow, executionId) =>
      Effect.gen(function* () {
        const arn = yield* calls.find(executionNameOf(workflow._tag, executionId));
        if (!arn) return;
        const pending = pendingCallbacks(yield* calls.history(arn));
        if (pending.length === 0) return yield* calls.stop(arn);
        yield* Effect.forEach(pending, (callback) => calls.fail(callback.callbackId, INTERRUPT), {
          discard: true,
        });
      }),

    interruptUnsafe: (workflow, executionId) =>
      Effect.gen(function* () {
        const arn = yield* calls.find(executionNameOf(workflow._tag, executionId));
        if (arn) yield* calls.stop(arn);
      }),

    // Every run continues on its own; there's nothing to resume.
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
        const text = yield* run.durable.step({
          name: `${activity.name}/${attempt}`,
          effect: activity.executeEncoded.pipe(
            Workflow.intoResult,
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
        return new Workflow.Complete({ exit: yield* decodeExit(text) });
      }),

    // A clock's sleep is a durable wait; a signal is a callback to wait for.
    deferredResult: (deferred) =>
      Effect.gen(function* () {
        const run = yield* currentRun("DurableDeferred reads");
        const duration = run.clocks.get(deferred.name);
        if (duration !== undefined) {
          yield* run.durable.wait(deferred.name, Duration.max(duration, Duration.seconds(1)));
          return Option.some(Exit.void);
        }
        const text = yield* run.durable
          .waitForCallback<string>({ name: deferred.name, submitter: () => Effect.void })
          .pipe(
            Effect.catchDefect((defect) =>
              String(defect).includes(INTERRUPT) ||
              JSON.stringify(defect ?? null).includes(INTERRUPT)
                ? Effect.sync(() => {
                    run.instance.interrupted = true;
                    run.instance.suspended = false;
                  }).pipe(Effect.andThen(Effect.interrupt))
                : Effect.die(defect),
            ),
          );
        return Option.some(
          yield* decodeExit(typeof text === "string" ? text : JSON.stringify(text)),
        );
      }),

    deferredDone: (opts) =>
      Effect.gen(function* () {
        const executionName = executionNameOf(opts.workflowName, opts.executionId);
        const callbackId = yield* findCallback(calls, executionName, opts.deferredName);
        yield* calls.succeed(callbackId, yield* encodeExit(opts.exit));
      }),

    scheduleClock: (_workflow, opts) =>
      Effect.flatMap(currentRun("DurableClock scheduling"), (run) =>
        Effect.sync(() => void run.clocks.set(opts.clock.deferred.name, opts.clock.duration)),
      ),
  });
};
