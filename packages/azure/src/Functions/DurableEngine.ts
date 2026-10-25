import * as dts from "@distilled.cloud/azure/durabletask-data";
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
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { Workflow, WorkflowEngine } from "effect/workflow";
import { BuiltInRole } from "../Authorization/RoleAssignment.ts";
import * as AzureBindings from "../AzureBindings.ts";
import type { Scheduler } from "../DurableTask/Scheduler.ts";
import type { TaskHub } from "../DurableTask/TaskHub.ts";
import type { Function } from "./Function.ts";
import type { WorkflowFunctionClass } from "./WorkflowFunction.ts";

type WorkflowNames<W> = W extends Workflow.Workflow<infer Name, any, any, any> ? Name : never;

type ImplementedEach<Name> = Name extends string ? Implemented<Name> : never;

type HostedBy<Host> = Host extends WorkflowFunctionClass<any, infer W> ? WorkflowNames<W> : never;

/**
 * Run workflows hosted by {@link WorkflowFunction | Azure.Functions.WorkflowFunction}s
 * from another runtime: a `WorkflowEngine` that starts, reads, signals and
 * interrupts each workflow's runs in the Durable Task Scheduler task hub of
 * the function that hosts it.
 *
 * Provide it to the caller's program, and resolve each workflow's client
 * with `Workflows.RunWorkflow` during init. It grants the caller
 * **Durable Task Data Contributor** on each host's task hub: an Azure
 * Function (or other managed-identity host) gets the role on its identity;
 * any other host (a Cloudflare Worker, an AWS Lambda) gets an Entra service
 * principal with the role. Running a workflow none of the hosts list is a
 * type error.
 *
 * ### Running workflows from another function
 * **Example:** An API that starts orders
 * ```typescript
 * import * as Azure from "@alchemy.run/azure";
 * import * as Workflows from "alchemy/Workflows";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 * import { OrderWorkflows } from "./OrderWorkflows.ts";
 * import { PlaceOrder } from "./orders.ts";
 *
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const placeOrder = yield* Workflows.RunWorkflow(PlaceOrder);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const run = yield* placeOrder.start({ orderId: "o-1" });
 *         return HttpServerResponse.text(run.executionId);
 *       }),
 *     };
 *   }).pipe(Effect.provide(Azure.Functions.DurableEngine(OrderWorkflows))),
 * ) {}
 * ```
 *
 * **Example:** Workflows across several hosts
 * ```typescript
 * Effect.provide(Azure.Functions.DurableEngine(OrderWorkflows, BillingWorkflows))
 * ```
 *
 * ### Reading a run
 * **Example:** Status, signal, and interrupt
 * ```typescript
 * const run = placeOrder.get(executionId);
 * const status = yield* run.status; // NotStarted | Running | Completed | Failed | Interrupted | Died
 * yield* run.signal(Approval, "agent-7");
 * yield* run.interrupt;
 * ```
 *
 * @layer
 * @provides WorkflowEngine
 * @product Functions
 */
export const DurableEngine = <const Hosts extends ReadonlyArray<WorkflowFunctionClass<any, any>>>(
  ...hosts: Hosts
): Layer.Layer<
  WorkflowEngine.WorkflowEngine | ImplementedEach<HostedBy<Hosts[number]>>,
  never,
  Function["Providers"]
> =>
  Layer.merge(
    Layer.effect(
      WorkflowEngine.WorkflowEngine,
      Effect.gen(function* () {
        const bind = yield* AzureBindings.Bind;
        const ops = yield* resolveOps;
        const routes = new Map<string, HubCalls>();
        for (const host of hosts) {
          // The host is a dependency: its orchestrator functions run the runs.
          const fn = yield* host;
          const { scheduler, taskHub } = yield* host.durableTask;
          if (!globalThis.__ALCHEMY_RUNTIME__) {
            yield* bind`Azure.Functions.DurableEngine(${fn})`({
              roleAssignments: [
                {
                  roleDefinitionId: BuiltInRole.DurableTaskDataContributor,
                  scope: taskHub.taskHubId,
                },
              ],
            });
          }
          const calls = yield* makeHubCalls(ops, scheduler, taskHub);
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
    Function["Providers"]
  >;

// ---------------------------------------------------------------- names

/** App setting that holds the Durable Task Scheduler connection string. */
export const CONNECTION_SETTING = "DURABLE_TASK_SCHEDULER_CONNECTION_STRING";

/** The activity function every step records its result through. */
export const STEP_ACTIVITY = "alchemy-step";

/** An external event with this name interrupts the run that receives it. */
export const INTERRUPT_EVENT = "alchemy.interrupt";

/**
 * The orchestrator function of a workflow: a letter first, then letters,
 * digits, `_` and `-` (Functions names, at most 128).
 *
 * @internal
 */
export const orchestratorNameOf = (workflowName: string) =>
  `workflow-${workflowName}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 128);

/**
 * A run's orchestration instance ID: the workflow and execution id, within
 * 100 letters, digits, `-` and `_` (the strictest Durable Task backend's
 * limit; `/`, `\`, `#` and `?` are never allowed).
 *
 * @internal
 */
export const instanceIdOf = (workflowName: string, executionId: string) => {
  const name = `${workflowName}-${executionId}`.replace(/[^A-Za-z0-9_-]/g, "_");
  if (name.length <= 100) return name;
  let hash = 2166136261;
  for (const char of name) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
  return `${name.slice(0, 91)}-${hash.toString(16).padStart(8, "0")}`;
};

// ---------------------------------------------------------------- the task hub, over REST

/** What a run's orchestration is started with. */
export interface RunInput {
  readonly executionId: string;
  /** The payload, encoded. */
  readonly payload: unknown;
}

/** What one step records: its name, and its exit, encoded. */
export interface StepRecord {
  readonly name: string;
  readonly exit?: unknown;
}

/** The task hub operations, with the runtime's Azure credentials. */
export const resolveOps = Effect.gen(function* () {
  // One at a time: resolving distilled operations in `Effect.all` dies.
  const create = yield* AzureBindings.withCredentials(dts.CreateOrchestration);
  const get = yield* AzureBindings.withCredentials(dts.GetOrchestration);
  const payloads = yield* AzureBindings.withCredentials(dts.GetOrchestrationPayloads);
  const addEvents = yield* AzureBindings.withCredentials(dts.AddHistoryEvents);
  return { create, get, payloads, addEvents };
});

type Ops = Effect.Success<typeof resolveOps>;

/** One task hub's calls, for the hosts and callers that use it. */
export interface HubCalls {
  /** Start a run's orchestration; a run that exists already is left alone. */
  readonly start: (
    workflowName: string,
    instanceId: string,
    input: RunInput,
  ) => Effect.Effect<void>;
  /** A run's status, output and failure; undefined when it does not exist. */
  readonly read: (instanceId: string) => Effect.Effect<RunState | undefined>;
  /** Raise an external event on a run. */
  readonly raise: (instanceId: string, name: string, input: string) => Effect.Effect<void>;
  /** Terminate a run where it is. */
  readonly terminate: (instanceId: string) => Effect.Effect<void>;
}

/** An orchestration instance as the engine reads it. */
interface RunState {
  readonly status: string;
  /** The output, as JSON text, once the run finished. */
  readonly output: string | undefined;
  /** Why the run failed, when the orchestrator itself failed. */
  readonly failure: string | undefined;
}

/** A role assignment answers 403 for a minute or two after it is made. */
const whileRolePropagates = {
  while: (error: { readonly _tag: string }) => error._tag === "DurableTaskAccessDenied",
  schedule: Schedule.spaced("5 seconds"),
  times: 36,
};

const TERMINAL = new Set([
  "ORCHESTRATION_STATUS_COMPLETED",
  "ORCHESTRATION_STATUS_FAILED",
  "ORCHESTRATION_STATUS_TERMINATED",
  "ORCHESTRATION_STATUS_CANCELED",
]);

/** The task hub calls of one scheduler and hub, resolved where they run. */
export const makeHubCalls = (ops: Ops, scheduler: Scheduler, taskHub: TaskHub) =>
  Effect.gen(function* () {
    const endpoint = yield* scheduler.endpoint;
    const hubName = yield* taskHub.taskHubName;
    const where = Effect.gen(function* () {
      const url = yield* endpoint;
      const hub = yield* hubName;
      return { endpoint: url, taskHub: hub };
    });
    const get = (instanceId: string) =>
      Effect.flatMap(where, (target) =>
        ops.get({ ...target, instanceId }).pipe(
          Effect.retry(whileRolePropagates),
          Effect.catchTag("OrchestrationNotFound", () => Effect.succeed(undefined)),
        ),
      );
    const addEvent = (
      instanceId: string,
      event: Omit<dts.NewHistoryEvent, "eventId" | "timestamp">,
    ) =>
      Effect.gen(function* () {
        const target = yield* where;
        const timestamp = yield* Effect.sync(() => new Date().toISOString());
        return yield* ops
          .addEvents({ ...target, events: { [instanceId]: { eventId: -1, timestamp, ...event } } })
          .pipe(Effect.retry(whileRolePropagates));
      });
    const calls: HubCalls = {
      start: (workflowName, instanceId, input) =>
        Effect.gen(function* () {
          // A finished instance can be started again under its id: only a run
          // that has never existed is created.
          const existing = yield* get(instanceId);
          if (existing !== undefined) return;
          const target = yield* where;
          yield* ops
            .create({
              ...target,
              name: orchestratorNameOf(workflowName),
              instanceId,
              input: JSON.stringify(input),
            })
            .pipe(
              Effect.retry(whileRolePropagates),
              // Started concurrently: the same key always names the same run.
              Effect.catchTag("OrchestrationAlreadyExists", () => Effect.void),
            );
        }).pipe(Effect.orDie),
      read: (instanceId) =>
        Effect.gen(function* () {
          const instance = yield* get(instanceId);
          if (instance === undefined) return undefined;
          const status = instance.orchestrationStatus ?? "ORCHESTRATION_STATUS_PENDING";
          if (!TERMINAL.has(status)) return { status, output: undefined, failure: undefined };
          const target = yield* where;
          const payloads = yield* ops
            .payloads({ ...target, instanceId })
            .pipe(Effect.retry(whileRolePropagates));
          return {
            status,
            output: payloads.output ?? undefined,
            failure: payloads.failureDetails?.errorMessage ?? undefined,
          };
        }).pipe(Effect.orDie),
      raise: (instanceId, name, input) =>
        addEvent(instanceId, { eventRaised: { name, input } }).pipe(
          Effect.flatMap((result) =>
            (result.notFound ?? []).includes(instanceId)
              ? Effect.fail("not started" as const)
              : Effect.void,
          ),
          // A signal can race the start that creates the run.
          Effect.retry({
            while: (error) => error === "not started",
            schedule: Schedule.spaced("1 second"),
            times: 10,
          }),
          Effect.orDie,
        ),
      terminate: (instanceId) =>
        addEvent(instanceId, {
          executionTerminated: { input: JSON.stringify("interrupted"), recurse: true },
        }).pipe(Effect.asVoid, Effect.orDie),
    };
    return calls;
  });

/** Read a run's result from its instance: undefined while it runs. */
const readResult = (calls: HubCalls, workflow: Workflow.AnyWithProps, instanceId: string) =>
  Effect.gen(function* () {
    const instance = yield* calls.read(instanceId);
    if (instance === undefined) return undefined;
    switch (instance.status) {
      case "ORCHESTRATION_STATUS_COMPLETED":
        return instance.output === undefined
          ? new Workflow.Complete({
              exit: Exit.die(new Error(`Workflow run ${instanceId} completed without a result`)),
            })
          : yield* decodeResult(workflow, instance.output);
      case "ORCHESTRATION_STATUS_TERMINATED":
      case "ORCHESTRATION_STATUS_CANCELED":
        return new Workflow.Complete({ exit: Exit.interrupt() });
      case "ORCHESTRATION_STATUS_FAILED":
        return new Workflow.Complete({
          exit: Exit.die(new Error(`Workflow run ${instanceId} failed: ${instance.failure ?? ""}`)),
        });
      default:
        return new Workflow.Suspended({});
    }
  });

// ---------------------------------------------------------------- orchestration replay

/** One event of the history the Durable Functions extension hands an orchestrator. */
interface HistoryEvent {
  readonly EventType: number;
  readonly EventId?: number;
  readonly Timestamp?: string;
  readonly Name?: string;
  readonly Input?: unknown;
  readonly Result?: unknown;
  readonly TaskScheduledId?: number;
  readonly TimerId?: number;
  readonly FireAt?: string;
  readonly Reason?: string;
  readonly Details?: string;
}

/** Durable Task history event types (`HistoryEventType`). */
const EventType = {
  TaskScheduled: 4,
  TaskCompleted: 5,
  TaskFailed: 6,
  SubOrchestrationInstanceCreated: 7,
  SubOrchestrationInstanceCompleted: 8,
  SubOrchestrationInstanceFailed: 9,
  TimerCreated: 10,
  TimerFired: 11,
  OrchestratorStarted: 12,
  EventRaised: 15,
} as const;

/** Out-of-process orchestrator actions (`AsyncActionType`). */
const ActionType = {
  CallActivity: 0,
  CallSubOrchestrator: 2,
  CreateTimer: 5,
  WaitForExternalEvent: 6,
} as const;

type Action =
  | { readonly actionType: 0; readonly functionName: string; readonly input: StepRecord }
  | {
      readonly actionType: 2;
      readonly functionName: string;
      readonly instanceId: string;
      readonly input: RunInput;
    }
  | { readonly actionType: 5; readonly fireAt: string; readonly isCanceled: boolean }
  | {
      readonly actionType: 6;
      readonly externalEventName: string;
      readonly reason: "ExternalEvent";
    };

/** What the orchestrator answers the extension with (`OrchestratorState`). */
export interface OrchestratorState {
  readonly isDone: boolean;
  readonly actions: ReadonlyArray<ReadonlyArray<Action>>;
  readonly output?: unknown;
  readonly schemaVersion: number;
}

/** The orchestration trigger's input: the instance, its input, and its history. */
export interface OrchestrationBinding {
  readonly history?: ReadonlyArray<HistoryEvent>;
  readonly input?: unknown;
  readonly instanceId?: string;
  readonly upperSchemaVersion?: number;
  readonly upperSchemaVersionNew?: number;
}

interface Completion {
  readonly index: number;
  readonly ok: boolean;
  readonly result: unknown;
  readonly reason: string;
}

/** A JSON value the extension may hand over as text or already parsed. */
const asJson = (value: unknown): unknown => {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

const asText = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value));

/**
 * One orchestrator invocation's view of its history, and the actions it
 * produces. Every invocation replays the workflow from the start: an action
 * whose outcome is in the history resolves from it, the first one that is
 * not ends the invocation, and the actions so far go back to the extension.
 */
class Replay {
  readonly scheduled = new Set<number>();
  readonly completions = new Map<number, Completion>();
  readonly timers = new Map<number, string>();
  readonly fired = new Map<number, number>();
  readonly raised: Array<{
    readonly name: string;
    readonly input: unknown;
    readonly index: number;
  }> = [];
  readonly consumed = new Map<string, number>();
  readonly interruptIndex: number | undefined;
  readonly now: number;
  readonly actions: Action[] = [];
  sequence = 0;
  interruptDelivered = false;
  frozen = false;

  /** Ends the invocation with the actions so far. */
  readonly freeze: (replay: Replay) => void;

  constructor(history: ReadonlyArray<HistoryEvent>, freeze: (replay: Replay) => void) {
    this.freeze = freeze;
    let interruptIndex: number | undefined;
    let now = 0;
    history.forEach((event, index) => {
      switch (event.EventType) {
        case EventType.TaskScheduled:
        case EventType.SubOrchestrationInstanceCreated:
          if (event.EventId !== undefined) this.scheduled.add(event.EventId);
          break;
        case EventType.TimerCreated:
          if (event.EventId !== undefined) {
            this.scheduled.add(event.EventId);
            this.timers.set(event.EventId, event.FireAt ?? "");
          }
          break;
        case EventType.TaskCompleted:
        case EventType.SubOrchestrationInstanceCompleted:
          if (event.TaskScheduledId !== undefined) {
            this.completions.set(event.TaskScheduledId, {
              index,
              ok: true,
              result: event.Result,
              reason: "",
            });
          }
          break;
        case EventType.TaskFailed:
        case EventType.SubOrchestrationInstanceFailed:
          if (event.TaskScheduledId !== undefined) {
            this.completions.set(event.TaskScheduledId, {
              index,
              ok: false,
              result: undefined,
              reason: [event.Reason, event.Details].filter(Boolean).join(": "),
            });
          }
          break;
        case EventType.TimerFired:
          if (event.TimerId !== undefined) this.fired.set(event.TimerId, index);
          break;
        case EventType.OrchestratorStarted: {
          const at = event.Timestamp ? Date.parse(event.Timestamp) : Number.NaN;
          if (!Number.isNaN(at)) now = at;
          break;
        }
        case EventType.EventRaised:
          if (event.Name === INTERRUPT_EVENT) interruptIndex ??= index;
          else if (event.Name !== undefined) {
            this.raised.push({ name: event.Name, input: event.Input, index });
          }
          break;
      }
    });
    this.interruptIndex = interruptIndex;
    this.now = now;
  }

  /** An interrupt arrived and this replay has not delivered it yet. */
  get interruptPending() {
    return this.interruptIndex !== undefined && !this.interruptDelivered;
  }

  /** Whether an interrupt arrived before the history event at `index`. */
  interruptedBefore(index: number) {
    return this.interruptPending && this.interruptIndex! < index;
  }

  /** The next event named `name` this replay has not consumed. */
  nextEvent(name: string) {
    const seen = this.consumed.get(name) ?? 0;
    return this.raised.filter((event) => event.name === name)[seen];
  }

  consume(name: string) {
    this.consumed.set(name, (this.consumed.get(name) ?? 0) + 1);
  }
}

/** The run in progress: its replay, its services, and the clocks it scheduled. */
class CurrentRun extends Context.Service<
  CurrentRun,
  {
    readonly replay: Replay;
    readonly context: Context.Context<never>;
    readonly clocks: Map<string, Duration.Duration>;
    readonly instance: WorkflowEngine.WorkflowInstance["Service"];
  }
>()("alchemy/Azure/Functions/DurableWorkflows/CurrentRun") {}

const currentRun = (operation: string) =>
  Effect.flatMap(Effect.serviceOption(CurrentRun), (run) =>
    Option.isSome(run)
      ? Effect.succeed(run.value)
      : Effect.die(new Error(`WorkflowFunction: ${operation} only runs inside a workflow run`)),
  );

/** End this invocation here: the actions so far go back to the extension. */
const freeze = (replay: Replay): Effect.Effect<never> =>
  Effect.suspend(() => {
    if (!replay.frozen) {
      replay.frozen = true;
      replay.freeze(replay);
    }
    return Effect.never;
  });

/** Wake the run with an interrupt, so its compensations run. */
const deliverInterrupt = (run: CurrentRun["Service"]): Effect.Effect<never> =>
  Effect.sync(() => {
    run.replay.interruptDelivered = true;
    run.instance.interrupted = true;
    run.instance.suspended = false;
  }).pipe(Effect.andThen(Effect.interrupt));

/** After the invocation ended, a parallel branch stops where it is. */
const whenLive = <A>(replay: Replay, effect: Effect.Effect<A>): Effect.Effect<A> =>
  Effect.suspend(() => (replay.frozen ? Effect.never : effect));

// ---------------------------------------------------------------- the engine

type Execute = (
  payload: object,
  executionId: string,
) => Effect.Effect<
  unknown,
  unknown,
  WorkflowEngine.WorkflowInstance | WorkflowEngine.WorkflowEngine
>;

/** A workflow a host runs, and its handler. */
export interface Registration {
  readonly workflow: Workflow.AnyWithProps;
  readonly execute: Execute;
}

/** The engine over the task hubs `route` names, for hosts and callers alike. */
export const makeEngine = (options: {
  /** The calls for the task hub that runs a workflow. */
  readonly route: (workflowName: string) => Effect.Effect<HubCalls>;
  readonly register: (workflow: Workflow.AnyWithProps, execute: Execute) => void;
}): WorkflowEngine.WorkflowEngine["Service"] => {
  const { route } = options;
  return WorkflowEngine.makeUnsafe({
    register: (workflow, execute) =>
      Effect.sync(() => options.register(workflow as Workflow.AnyWithProps, execute)),

    execute: (workflow, opts) =>
      Effect.gen(function* () {
        const typed = workflow as Workflow.AnyWithProps;
        const instanceId = instanceIdOf(workflow._tag, opts.executionId);
        const payload = yield* Schema.encodeEffect(payloadCodec(typed))(opts.payload).pipe(
          Effect.orDie,
        );
        const input: RunInput = { executionId: opts.executionId, payload };
        const run = yield* Effect.serviceOption(CurrentRun);
        if (Option.isSome(run) && !opts.discard) {
          // A child workflow: a sub-orchestration of this run.
          const { replay } = run.value;
          return yield* whenLive(
            replay,
            Effect.gen(function* () {
              const id = replay.sequence;
              const action: Action = {
                actionType: ActionType.CallSubOrchestrator,
                functionName: orchestratorNameOf(workflow._tag),
                instanceId,
                input,
              };
              if (!replay.scheduled.has(id)) {
                if (replay.interruptPending) return yield* deliverInterrupt(run.value);
                replay.sequence++;
                replay.actions.push(action);
                return yield* freeze(replay);
              }
              replay.sequence++;
              replay.actions.push(action);
              const done = replay.completions.get(id);
              if (done === undefined) return yield* freeze(replay);
              return done.ok
                ? yield* decodeResult(typed, asText(done.result))
                : new Workflow.Complete({
                    exit: Exit.die(
                      new Error(`Child workflow ${instanceId} failed: ${done.reason}`),
                    ),
                  });
            }),
          );
        }
        const calls = yield* route(workflow._tag);
        yield* calls.start(workflow._tag, instanceId, input);
        if (opts.discard) return undefined;
        const result = yield* readResult(calls, typed, instanceId);
        return result ?? new Workflow.Suspended({});
      }) as Effect.Effect<any>,

    poll: (workflow, executionId) =>
      Effect.gen(function* () {
        const calls = yield* route(workflow._tag);
        const result = yield* readResult(
          calls,
          workflow as Workflow.AnyWithProps,
          instanceIdOf(workflow._tag, executionId),
        );
        return result === undefined ? Option.none() : Option.some(result);
      }),

    // The run sees the interrupt where it next waits or starts a step, and
    // finishes there with its compensations run.
    interrupt: (workflow, executionId) =>
      Effect.gen(function* () {
        const calls = yield* route(workflow._tag);
        const instanceId = instanceIdOf(workflow._tag, executionId);
        const instance = yield* calls.read(instanceId);
        if (instance === undefined || TERMINAL.has(instance.status)) return;
        yield* calls.raise(instanceId, INTERRUPT_EVENT, JSON.stringify(null));
      }),

    interruptUnsafe: (workflow, executionId) =>
      Effect.gen(function* () {
        const calls = yield* route(workflow._tag);
        const instanceId = instanceIdOf(workflow._tag, executionId);
        const instance = yield* calls.read(instanceId);
        if (instance === undefined || TERMINAL.has(instance.status)) return;
        yield* calls.terminate(instanceId);
      }),

    // Every run continues on its own; there's nothing to resume.
    resume: () => Effect.void,

    // A step runs in the orchestrator, and its exit is recorded through the
    // step activity, so a replay reads it from the history instead.
    activityExecute: (activity, attempt) =>
      Effect.gen(function* () {
        const run = yield* currentRun("activity execution");
        const { replay } = run;
        const name = `${activity.name}/${attempt}`;
        const id = replay.sequence;
        if (replay.scheduled.has(id)) {
          replay.sequence++;
          replay.actions.push({
            actionType: ActionType.CallActivity,
            functionName: STEP_ACTIVITY,
            input: { name },
          });
          const done = replay.completions.get(id);
          if (done === undefined) return yield* freeze(replay);
          if (!done.ok) {
            return new Workflow.Complete({
              exit: Exit.die(new Error(`Step ${name} failed to record: ${done.reason}`)),
            });
          }
          const record = asJson(done.result) as StepRecord;
          return new Workflow.Complete({ exit: yield* decodeExit(asText(record.exit)) });
        }
        if (replay.interruptPending) return yield* deliverInterrupt(run);
        replay.sequence++;
        const instance = yield* WorkflowEngine.WorkflowInstance;
        const activityInstance = WorkflowEngine.WorkflowInstance.initial(
          instance.workflow,
          instance.executionId,
        );
        activityInstance.interrupted = instance.interrupted;
        const text = yield* activity.executeEncoded.pipe(
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
                  makeCurrentActivity(instance.workflow._tag, instance.executionId, activity.name),
                ),
              ),
            ),
          ),
        ) as Effect.Effect<string>;
        return yield* whenLive(
          replay,
          Effect.suspend(() => {
            replay.actions.push({
              actionType: ActionType.CallActivity,
              functionName: STEP_ACTIVITY,
              input: { name, exit: JSON.parse(text) },
            });
            return freeze(replay);
          }),
        );
      }),

    // A clock's sleep is a durable timer; a signal is an external event.
    deferredResult: (deferred) =>
      Effect.gen(function* () {
        const run = yield* currentRun("DurableDeferred reads");
        const { replay } = run;
        const duration = run.clocks.get(deferred.name);
        if (duration !== undefined) {
          return yield* whenLive(
            replay,
            Effect.gen(function* () {
              const id = replay.sequence;
              const fireAt = replay.timers.get(id);
              if (fireAt === undefined) {
                if (replay.interruptPending) return yield* deliverInterrupt(run);
                replay.sequence++;
                replay.actions.push({
                  actionType: ActionType.CreateTimer,
                  fireAt: new Date(replay.now + Duration.toMillis(duration)).toISOString(),
                  isCanceled: false,
                });
                return yield* freeze(replay);
              }
              replay.sequence++;
              const firedAt = replay.fired.get(id);
              if (firedAt !== undefined && !replay.interruptedBefore(firedAt)) {
                replay.actions.push({
                  actionType: ActionType.CreateTimer,
                  fireAt,
                  isCanceled: false,
                });
                return Option.some(Exit.void);
              }
              if (replay.interruptPending) {
                // Cancel it, so the actions after it are not held behind it.
                replay.actions.push({
                  actionType: ActionType.CreateTimer,
                  fireAt,
                  isCanceled: true,
                });
                return yield* deliverInterrupt(run);
              }
              replay.actions.push({
                actionType: ActionType.CreateTimer,
                fireAt,
                isCanceled: false,
              });
              return yield* freeze(replay);
            }),
          );
        }
        return yield* whenLive(
          replay,
          Effect.gen(function* () {
            const event = replay.nextEvent(deferred.name);
            if (event !== undefined && !replay.interruptedBefore(event.index)) {
              replay.consume(deferred.name);
              return Option.some(yield* decodeExit(asText(event.input)));
            }
            if (replay.interruptPending) return yield* deliverInterrupt(run);
            replay.actions.push({
              actionType: ActionType.WaitForExternalEvent,
              externalEventName: deferred.name,
              reason: "ExternalEvent",
            });
            return yield* freeze(replay);
          }),
        );
      }),

    deferredDone: (opts) =>
      Effect.gen(function* () {
        const calls = yield* route(opts.workflowName);
        yield* calls.raise(
          instanceIdOf(opts.workflowName, opts.executionId),
          opts.deferredName,
          yield* encodeExit(opts.exit),
        );
      }),

    scheduleClock: (_workflow, opts) =>
      Effect.flatMap(currentRun("DurableClock scheduling"), (run) =>
        Effect.sync(() => void run.clocks.set(opts.clock.deferred.name, opts.clock.duration)),
      ),
  });
};

// ---------------------------------------------------------------- hosting

/** The step activity: what the orchestrator recorded is the step's result. */
export const recordStep = (input: unknown): StepRecord => asJson(input) as StepRecord;

/**
 * One orchestrator invocation: replay the run against its history and
 * answer with the actions it took, and its encoded exit once it finished.
 */
export const orchestrate = (options: {
  readonly registration: Registration;
  readonly engine: WorkflowEngine.WorkflowEngine["Service"];
  readonly binding: unknown;
}): Effect.Effect<OrchestratorState> =>
  Effect.gen(function* () {
    const { workflow, execute } = options.registration;
    const binding = asJson(options.binding) as OrchestrationBinding;
    const schemaVersion = Math.max(
      1,
      Math.min(3, binding.upperSchemaVersionNew ?? binding.upperSchemaVersion ?? 1),
    );
    const input = asJson(binding.input) as RunInput;
    const outcome = yield* Deferred.make<OrchestratorState>();
    const replay = new Replay(binding.history ?? [], (frozen) =>
      Deferred.doneUnsafe(
        outcome,
        Effect.succeed({ isDone: false, actions: [[...frozen.actions]], schemaVersion }),
      ),
    );
    const payload = yield* Schema.decodeEffect(payloadCodec(workflow))(input.payload).pipe(
      Effect.orDie,
    );
    const instance = WorkflowEngine.WorkflowInstance.initial(workflow, input.executionId);
    const context = yield* Effect.context<never>();
    // The run is left where it stops when the invocation ends early; the
    // next invocation replays it from the history.
    yield* execute(payload as object, input.executionId).pipe(
      Workflow.intoResult,
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(WorkflowEngine.WorkflowInstance, instance),
          Layer.succeed(WorkflowEngine.WorkflowEngine, options.engine),
          Layer.succeed(CurrentRun, { replay, context, clocks: new Map(), instance }),
        ),
      ),
      Effect.flatMap((result) =>
        result._tag === "Complete"
          ? encodeResult(workflow, result.exit)
          : Effect.die(new Error(`Workflow ${workflow._tag} suspended unexpectedly`)),
      ),
      Effect.flatMap((text) =>
        Deferred.succeed(outcome, {
          isDone: true,
          actions: [[...replay.actions]],
          output: JSON.parse(text),
          schemaVersion,
        }),
      ),
      Effect.catchCause((cause) => Deferred.failCause(outcome, cause)),
      Effect.forkDetach,
    );
    return yield* Deferred.await(outcome);
  }).pipe(Effect.orDie) as Effect.Effect<OrchestratorState>;
