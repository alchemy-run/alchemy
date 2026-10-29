import type { Credentials } from "@distilled.cloud/aws/Credentials";
import * as Lambda from "@distilled.cloud/aws/lambda";
import * as Binding from "alchemy/Binding";
import type { InputProps } from "alchemy/Input";
import * as Output from "alchemy/Output";
import {
  CurrentActivity,
  decodeExit,
  decodeResult,
  encodeExit,
  encodeResult,
  makeCurrentActivity,
  payloadCodec,
} from "alchemy/WorkflowEncoding";
import { type Implemented, implemented } from "alchemy/Workflows";
import type { ConfigError } from "effect/Config";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Effectable from "effect/Effectable";
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
import * as AWSBindings from "../AWSBindings.ts";
import { DurableStep } from "./Durable.ts";
import {
  DurableFunction,
  type DurableFunctionImpl,
  type DurableFunctionInitServices,
  type DurableFunctionProps,
} from "./DurableFunction.ts";
import { Function } from "./Function.ts";
import { qualifierOf } from "./QualifiedArn.ts";

type WorkflowNames<W> = W extends Workflow.Workflow<infer Name, any, any, any> ? Name : never;

type ImplementedEach<Name> = Name extends string ? Implemented<Name> : never;

/** Workflows a host lists whose implementation is missing from the Layer it's given. */
type Missing<ROut, Name> = Name extends string
  ? Implemented<Name> extends ROut
    ? never
    : Name
  : never;

type ImplementsAll<ROut, Name> = [Missing<ROut, Name>] extends [never]
  ? unknown
  : { readonly "Missing workflow implementations": Missing<ROut, Name> };

/**
 * A Lambda durable function that runs workflows: the class a
 * `WorkflowFunction` declares. `yield*` it for the Lambda function itself.
 */
export interface WorkflowFunctionClass<
  Self,
  W extends Workflow.Any = Workflow.Any,
> extends Effect.Effect<Function, never, Function["Providers"]> {
  readonly LogicalId: string;
  /** The workflows this function runs. */
  readonly workflows: ReadonlyArray<W>;
  /**
   * Deploy the function with the Layer that implements its workflows. The
   * Layer must implement every workflow the function lists.
   */
  make<ROut, E, RIn, PropsReq = never>(
    props:
      | InputProps<DurableFunctionProps>
      | Effect.Effect<InputProps<DurableFunctionProps>, ConfigError, PropsReq>,
    workflows: Layer.Layer<ROut, E, RIn> & ImplementsAll<ROut, WorkflowNames<W>>,
  ): Layer.Layer<
    Self,
    never,
    | Function["Providers"]
    | Exclude<PropsReq | RIn, DurableFunctionInitServices | WorkflowEngine.WorkflowEngine>
  >;
  new (_: never): {};
}

/**
 * A Lambda durable function that runs Effect workflows. Each run is one
 * durable execution of the function, named after the workflow and its
 * execution id.
 *
 * Steps run as durable steps, so a finished step's result is replayed rather
 * than run again. `DurableClock.sleep` is a durable wait: the invocation ends,
 * and Lambda invokes the function again when it's due, with no compute billed
 * in between. `DurableDeferred.await` waits for a callback, completed with a
 * run's `signal`. A workflow's child workflows run in the same function.
 *
 * Other functions start and read its runs with
 * {@link DurableFunctionEngine | AWS.Lambda.DurableFunctionEngine}.
 *
 * ### Declaring a workflow function
 * **Example:** One function for the order workflows
 * ```typescript
 * // src/OrderWorkflows.ts
 * import * as AWS from "@alchemy.run/aws";
 * import * as Layer from "effect/Layer";
 * import { PlaceOrder, PlaceOrderLive, RefundOrder, RefundOrderLive } from "./orders.ts";
 *
 * export class OrderWorkflows extends AWS.Lambda.WorkflowFunction<OrderWorkflows>()(
 *   "OrderWorkflows",
 *   { workflows: [PlaceOrder, RefundOrder] },
 * ) {}
 *
 * export default OrderWorkflows.make(
 *   { main: import.meta.url, executionTimeout: "7 days" },
 *   Layer.mergeAll(PlaceOrderLive, RefundOrderLive),
 * );
 * ```
 *
 * The Layer must implement every workflow the function lists: leaving one out
 * is a type error.
 *
 * @resource
 */
export const WorkflowFunction =
  <Self>() =>
  <const W extends ReadonlyArray<Workflow.Any>>(
    id: string,
    options: {
      /** The workflows this function runs. */
      readonly workflows: W;
    },
  ): WorkflowFunctionClass<Self, W[number]> => {
    const durable = (DurableFunction as any)()(id);
    const make = durable.make;
    // The Lambda function, from anywhere: its own init, or another function's.
    const self = (Function as any)()(id);
    return Object.assign(
      durable,
      {
        workflows: options.workflows,
        make: (props: unknown, workflows: Layer.Layer<any, any, any>) =>
          make(props, makeWorkflowRunner(workflows)),
      },
      Effectable.Prototype({
        label: `AWS.Lambda.WorkflowFunction<${id}>`,
        evaluate: () => self,
      }),
    );
  };

// ---------------------------------------------------------------- callers

type HostedBy<Host> = Host extends WorkflowFunctionClass<any, infer W> ? WorkflowNames<W> : never;

/**
 * Run workflows hosted by {@link WorkflowFunction | AWS.Lambda.WorkflowFunction}s
 * from another Lambda function: a `WorkflowEngine` that starts, reads,
 * signals and interrupts each workflow's runs on the function that hosts it.
 *
 * Provide it to the calling function, and resolve each workflow's client with
 * `Workflows.RunWorkflow` during init. It grants the caller the IAM it needs
 * on each host. Running a workflow none of the hosts list is a type error.
 *
 * ### Running workflows from another function
 * **Example:** An API that starts orders
 * ```typescript
 * import * as AWS from "@alchemy.run/aws";
 * import * as Workflows from "alchemy/Workflows";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 * import { OrderWorkflows } from "./OrderWorkflows.ts";
 * import { PlaceOrder } from "./orders.ts";
 *
 * export class Api extends AWS.Lambda.Function<Api>()("Api") {}
 *
 * export default Api.make(
 *   { main: import.meta.url, functionUrl: true },
 *   Effect.gen(function* () {
 *     const placeOrder = yield* Workflows.RunWorkflow(PlaceOrder);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const run = yield* placeOrder.start({ orderId: "o-1" });
 *         return HttpServerResponse.text(run.executionId);
 *       }),
 *     };
 *   }).pipe(Effect.provide(AWS.Lambda.DurableFunctionEngine(OrderWorkflows))),
 * );
 * ```
 *
 * **Example:** Workflows across several functions
 * ```typescript
 * Effect.provide(AWS.Lambda.DurableFunctionEngine(OrderWorkflows, BillingWorkflows))
 * ```
 *
 * @layer
 * @provides WorkflowEngine
 * @product Lambda
 */
export const DurableFunctionEngine = <
  const Hosts extends ReadonlyArray<WorkflowFunctionClass<any, any>>,
>(
  ...hosts: Hosts
): Layer.Layer<
  WorkflowEngine.WorkflowEngine | ImplementedEach<HostedBy<Hosts[number]>>,
  never,
  LambdaServices | Function["Providers"]
> =>
  Layer.merge(
    Layer.effect(
      WorkflowEngine.WorkflowEngine,
      Effect.gen(function* () {
        const bind = yield* AWSBindings.Bind;
        const routes = new Map<string, Calls>();
        for (const host of hosts) {
          const fn = yield* host;
          // Not a Binding.Service, so name the bound host for the credential
          // routing (e.g. an emulated caller reaching a real-cloud host in dev).
          const targeting = Effect.provideService(Binding.Targets, [fn]);
          if (!globalThis.__ALCHEMY_RUNTIME__) {
            yield* bind`AWS.Lambda.DurableFunctionEngine(${fn})`({
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["lambda:InvokeFunction"],
                  Resource: [fn.functionArn, Output.interpolate`${fn.functionArn}:*`],
                },
                // Durable execution ARNs aren't function ARNs, so reading and
                // signalling runs is granted account-wide, as the host's own is.
                {
                  Effect: "Allow",
                  Action: [
                    "lambda:ListDurableExecutionsByFunction",
                    "lambda:GetDurableExecution",
                    "lambda:GetDurableExecutionHistory",
                    "lambda:StopDurableExecution",
                    "lambda:SendDurableExecutionCallbackSuccess",
                    "lambda:SendDurableExecutionCallbackFailure",
                  ],
                  Resource: ["*"],
                },
              ],
            }).pipe(targeting);
          }
          const functionName = yield* fn.functionName;
          // Runs start on the host's alias when it sets one.
          const qualifier = yield* qualifierOf(fn).bind(
            `${fn.LogicalId}.qualifier`,
          ) as Effect.Effect<Effect.Effect<string>>;
          // The engine's calls, resolved with the caller's AWS credentials.
          const withContext = yield* AWSBindings.withCredentials(
            Effect.map(
              Effect.context<LambdaServices>(),
              (context) =>
                <A, E>(effect: Effect.Effect<A, E, LambdaServices>) =>
                  Effect.provideContext(effect, context),
            ),
          ).pipe(targeting);
          const calls = makeCalls(
            (effect) => withContext(effect).pipe(targeting),
            functionName,
            qualifier,
          );
          for (const workflow of host.workflows) routes.set(workflow._tag, calls);
        }
        return makeEngine({
          route: (workflowName) => {
            const calls = routes.get(workflowName);
            return calls
              ? Effect.succeed(calls)
              : Effect.die(new Error(`No WorkflowFunction hosts workflow ${workflowName}`));
          },
          // Workflows run on their hosts; nothing registers here.
          register: () => undefined,
        });
      }),
    ),
    implemented(
      hosts.flatMap((host) => host.workflows.map((workflow) => workflow._tag)),
    ) as Layer.Layer<ImplementedEach<HostedBy<Hosts[number]>>>,
  ) as Layer.Layer<
    WorkflowEngine.WorkflowEngine | ImplementedEach<HostedBy<Hosts[number]>>,
    never,
    LambdaServices | Function["Providers"]
  >;

// ---------------------------------------------------------------- hosting

/** What a durable function running workflows is started with. */
interface WorkflowInvocation {
  /** The workflow's tag. */
  readonly workflow: string;
  readonly executionId: string;
  /** The payload, encoded. */
  readonly payload: unknown;
}

/** The services the engines call Lambda with. */
type LambdaServices = Credentials | HttpClient.HttpClient;

/**
 * The durable function body that runs the given workflows: each invocation is
 * one run of one workflow. Child workflows start in the same function.
 */
const makeWorkflowRunner = <ROut, E, RIn>(
  workflows: Layer.Layer<ROut, E, RIn>,
): Effect.Effect<
  DurableFunctionImpl<WorkflowInvocation, string>,
  E,
  Exclude<RIn, WorkflowEngine.WorkflowEngine> | LambdaServices
> =>
  Effect.gen(function* () {
    const context = yield* Effect.context<LambdaServices>();
    const functionName = yield* Effect.sync(() => process.env.AWS_LAMBDA_FUNCTION_NAME);
    // Child workflows start on the version this function is running.
    const version = yield* Effect.sync(() => process.env.AWS_LAMBDA_FUNCTION_VERSION ?? "$LATEST");
    const handlers = new Map<string, Registration>();
    const calls = makeCalls(
      (effect) => effect.pipe(Effect.provide(context)),
      functionName
        ? Effect.succeed(functionName)
        : Effect.die(new Error("AWS_LAMBDA_FUNCTION_NAME is not set")),
      Effect.succeed(version),
    );
    const engine = makeEngine({
      route: (workflowName) =>
        handlers.has(workflowName)
          ? Effect.succeed(calls)
          : Effect.die(new Error(`Workflow ${workflowName} is not hosted by this function`)),
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
    Exclude<RIn, WorkflowEngine.WorkflowEngine> | LambdaServices
  >;

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
>()("alchemy/AWS/Lambda/DurableWorkflows/CurrentRun") {}

const currentRun = (operation: string) =>
  Effect.flatMap(Effect.serviceOption(CurrentRun), (run) =>
    Option.isSome(run)
      ? Effect.succeed(run.value)
      : Effect.die(new Error(`WorkflowFunction: ${operation} only runs inside a workflow run`)),
  );

/** A callback failed with this type interrupts the run waiting on it. */
const INTERRUPT = "alchemy/WorkflowInterrupted";

/** The SDK's callback error arrives wrapped, with the type in its cause chain. */
const isInterrupt = (defect: unknown) => {
  let node = defect;
  for (let depth = 0; node !== null && typeof node === "object" && depth < 5; depth++) {
    const error = node as {
      readonly name?: unknown;
      readonly message?: unknown;
      readonly cause?: unknown;
    };
    if (
      error.name === INTERRUPT ||
      (typeof error.message === "string" && error.message.includes(INTERRUPT))
    ) {
      return true;
    }
    node = error.cause;
  }
  return false;
};

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
  provide: <A, E>(effect: Effect.Effect<A, E, LambdaServices>) => Effect.Effect<A, E>,
  functionName: Effect.Effect<string>,
  qualifier: Effect.Effect<string>,
): Calls => {
  const run = <A, E>(effect: Effect.Effect<A, E, LambdaServices>) =>
    provide(effect).pipe(Effect.orDie);
  return {
    start: (executionName, invocation) =>
      Effect.flatMap(Effect.all([functionName, qualifier]), ([FunctionName, Qualifier]) =>
        run(
          Lambda.invoke({
            FunctionName,
            Qualifier,
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
      Effect.flatMap(functionName, (FunctionName) =>
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
  /** The calls for the function that hosts a workflow. */
  readonly route: (workflowName: string) => Effect.Effect<Calls>;
  readonly register: (workflow: Workflow.AnyWithProps, execute: Execute) => void;
}): WorkflowEngine.WorkflowEngine["Service"] => {
  const { route } = options;
  return WorkflowEngine.makeUnsafe({
    register: (workflow, execute) =>
      Effect.sync(() => options.register(workflow as Workflow.AnyWithProps, execute)),

    execute: (workflow, opts) =>
      Effect.gen(function* () {
        const calls = yield* route(workflow._tag);
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
        const calls = yield* route(workflow._tag);
        const arn = yield* calls.find(executionNameOf(workflow._tag, executionId));
        if (!arn) return Option.none();
        const result = yield* readResult(calls, workflow as Workflow.AnyWithProps, arn);
        return Option.some(result ?? new Workflow.Suspended({}));
      }),

    // A run waiting on a signal is woken with an interrupt, so its
    // compensations run; a run busy in a step can only be stopped.
    interrupt: (workflow, executionId) =>
      Effect.gen(function* () {
        const calls = yield* route(workflow._tag);
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
        const calls = yield* route(workflow._tag);
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
                run.context.pipe(
                  Context.add(WorkflowEngine.WorkflowInstance, activityInstance),
                  Context.add(
                    CurrentActivity,
                    makeCurrentActivity(
                      instance.workflow._tag,
                      instance.executionId,
                      activity.name,
                    ),
                  ),
                ),
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
              isInterrupt(defect)
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
        const calls = yield* route(opts.workflowName);
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
