import type { InputProps } from "alchemy/Input";
import * as Output from "alchemy/Output";
import type { PlatformServices } from "alchemy/Platform";
import type { Implemented } from "alchemy/Workflows";
import type { ConfigError } from "effect/Config";
import * as Effect from "effect/Effect";
import * as Effectable from "effect/Effectable";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { type Workflow, WorkflowEngine } from "effect/workflow";
import { BuiltInRole } from "../Authorization/RoleAssignment.ts";
import { Scheduler, type SchedulerSkuName } from "../DurableTask/Scheduler.ts";
import { TaskHub } from "../DurableTask/TaskHub.ts";
import {
  CONNECTION_SETTING,
  makeEngine,
  makeHubCalls,
  orchestrate,
  orchestratorNameOf,
  recordStep,
  resolveOps,
  STEP_ACTIVITY,
  type Registration,
} from "./DurableEngine.ts";
import { Function, type FunctionProps, type FunctionServices } from "./Function.ts";

type WorkflowNames<W> = W extends Workflow.Workflow<infer Name, any, any, any> ? Name : never;

/** Workflows a host lists whose implementation is missing from the Layer it's given. */
type Missing<ROut, Name> = Name extends string
  ? Implemented<Name> extends ROut
    ? never
    : Name
  : never;

type ImplementsAll<ROut, Name> = [Missing<ROut, Name>] extends [never]
  ? unknown
  : { readonly "Missing workflow implementations": Missing<ROut, Name> };

/** Services the host's own machinery provides, so callers never see them. */
type WorkflowHostServices =
  | FunctionServices
  | PlatformServices
  | Function
  | WorkflowEngine.WorkflowEngine;

/** The Durable Task Scheduler and task hub that store a host's runs. */
export interface WorkflowDurableTask {
  /** The Durable Task Scheduler that stores the host's runs. */
  readonly scheduler: Scheduler;
  /** The task hub on the scheduler that the host's runs use. */
  readonly taskHub: TaskHub;
}

/** Options of a {@link WorkflowFunction | Azure.Functions.WorkflowFunction}. */
export interface WorkflowFunctionOptions<W extends ReadonlyArray<Workflow.Any>> {
  /** The workflows this function runs. */
  readonly workflows: W;
  /**
   * Location of the Durable Task Scheduler Alchemy creates for the runs.
   * Schedulers are offered in fewer regions than Functions (not `eastus`;
   * e.g. `eastus2`, `westus2`, `northeurope`). Changing it replaces the
   * scheduler and its task hub, and with them every run.
   * @default the `Azure.Location` layer, else the profile location
   */
  readonly schedulerLocation?: string;
  /**
   * Billing tier of the scheduler. Changing it replaces the scheduler.
   * @default "Consumption"
   */
  readonly schedulerSku?: SchedulerSkuName;
}

/**
 * An Azure Function that runs workflows: the class a `WorkflowFunction`
 * declares. `yield*` it for the function itself.
 */
export interface WorkflowFunctionClass<
  Self,
  W extends Workflow.Any = Workflow.Any,
> extends Effect.Effect<Function, never, Function["Providers"]> {
  readonly LogicalId: string;
  /** The workflows this function runs. */
  readonly workflows: ReadonlyArray<W>;
  /** The scheduler and task hub that store this function's runs. */
  readonly durableTask: Effect.Effect<WorkflowDurableTask, never, Function["Providers"]>;
  /**
   * Deploy the function with the Layer that implements its workflows. The
   * Layer must implement every workflow the function lists.
   */
  make<ROut, E, RIn, PropsReq = never>(
    props:
      | InputProps<FunctionProps>
      | Effect.Effect<InputProps<FunctionProps>, ConfigError, PropsReq>,
    workflows: Layer.Layer<ROut, E, RIn> & ImplementsAll<ROut, WorkflowNames<W>>,
  ): Layer.Layer<
    Self,
    never,
    Function["Providers"] | Exclude<PropsReq | RIn, WorkflowHostServices>
  >;
  new (_: never): {};
}

/**
 * An Azure Function (Flex Consumption) that runs Effect workflows on Durable
 * Functions, with a Durable Task Scheduler task hub as its backend. Each run
 * is one orchestration instance, named after the workflow and its execution
 * id.
 *
 * Alchemy creates the scheduler (Consumption tier) and a task hub for the
 * function, grants the function's managed identity **Durable Task Data
 * Contributor** on the hub, and points the Durable Functions extension at it
 * with an identity-based connection (no secrets).
 *
 * Every workflow is an orchestrator function. A step runs in its
 * orchestrator and records its result through an activity function, so a
 * finished step is replayed from the orchestration's history rather than run
 * again. `DurableClock.sleep` is a durable timer: the function stops, and
 * the scheduler wakes it when the timer is due, with no compute billed in
 * between. `DurableDeferred.await` waits for an external event, raised with
 * a run's `signal`. Interrupting a run raises an event it sees where it next
 * waits or starts a step; it finishes there, with its compensations run. A
 * workflow's child workflows run as sub-orchestrations of the same function.
 *
 * Other runtimes start and read its runs with
 * {@link DurableEngine | Azure.Functions.DurableEngine}.
 *
 * :::caution[One run waits on one thing at a time]
 * A run's durable waits (steps, timers, signals, child workflows) happen in
 * order. Racing two of them inside one run is not supported.
 * :::
 *
 * @see https://learn.microsoft.com/azure/azure-functions/durable/durable-task-scheduler/durable-task-scheduler
 *
 * ### Declaring a workflow function
 * **Example:** One function for the order workflows
 * ```typescript
 * // src/OrderWorkflows.ts
 * import * as Azure from "@alchemy.run/azure";
 * import * as Layer from "effect/Layer";
 * import { PlaceOrder, PlaceOrderLive, RefundOrder, RefundOrderLive } from "./orders.ts";
 *
 * export class OrderWorkflows extends Azure.Functions.WorkflowFunction<OrderWorkflows>()(
 *   "OrderWorkflows",
 *   { workflows: [PlaceOrder, RefundOrder], schedulerLocation: "westus2" },
 * ) {}
 *
 * export default OrderWorkflows.make(
 *   { main: import.meta.url, location: "westus2" },
 *   Layer.mergeAll(PlaceOrderLive, RefundOrderLive),
 * );
 * ```
 *
 * The Layer must implement every workflow the function lists: leaving one out
 * is a type error.
 *
 * **Example:** Deploying it from the stack
 * ```typescript
 * // alchemy.run.ts
 * import OrderWorkflowsLive, { OrderWorkflows } from "./src/OrderWorkflows.ts";
 *
 * export default Alchemy.Stack(
 *   "Orders",
 *   { providers: Azure.providers(), state: Alchemy.localState() },
 *   Effect.gen(function* () {
 *     const host = yield* OrderWorkflows;
 *     return { functionAppName: host.functionAppName };
 *   }).pipe(Effect.provide(OrderWorkflowsLive)),
 * );
 * ```
 *
 * ### Using bindings in a step
 * **Example:** A step that writes a receipt
 * ```typescript
 * export const PlaceOrderLive = Workflows.layer(
 *   PlaceOrder,
 *   Effect.gen(function* () {
 *     const receipts = yield* Azure.Storage.BlobContainerReadWrite(Receipts);
 *     return Effect.fn(function* ({ orderId }) {
 *       yield* Activity.make({
 *         name: "receipt",
 *         execute: receipts.put(`${orderId}.json`, JSON.stringify({ orderId })).pipe(Effect.orDie),
 *       });
 *     });
 *   }),
 * ).pipe(Layer.provide(Azure.Storage.BlobContainerReadWriteHttp));
 * ```
 *
 * ### Inspecting runs
 * **Example:** The Durable Task Scheduler dashboard
 * ```typescript
 * const { taskHub } = yield* OrderWorkflows.durableTask;
 * return { dashboard: taskHub.dashboardUrl };
 * ```
 *
 * @resource
 * @category Functions
 */
export const WorkflowFunction =
  <Self>() =>
  <const W extends ReadonlyArray<Workflow.Any>>(
    id: string,
    options: WorkflowFunctionOptions<W>,
  ): WorkflowFunctionClass<Self, W[number]> => {
    // `Function` is a Platform whose class-builder overloads TS cannot pick
    // between for a generic `Self` here.
    const fn = (Function as any)()(id);
    const make = fn.make;
    const durableTask = Effect.gen(function* () {
      const scheduler = yield* Scheduler(`${id}Scheduler`, {
        location: options.schedulerLocation,
        sku: options.schedulerSku,
      });
      const taskHub = yield* TaskHub(`${id}TaskHub`, { scheduler: scheduler.schedulerName });
      return { scheduler, taskHub } satisfies WorkflowDurableTask;
    });
    // The function resource, from anywhere: its own init, or another runtime's.
    const self = (Function as any)()(id);
    return Object.assign(
      fn,
      {
        workflows: options.workflows,
        durableTask,
        make: (props: unknown, workflows: Layer.Layer<any, any, any>) =>
          make(
            Effect.isEffect(props)
              ? Effect.map(props as Effect.Effect<FunctionProps, unknown, unknown>, withDurableTask)
              : withDurableTask(props as FunctionProps),
            makeWorkflowHost(options.workflows, durableTask, workflows),
          ),
      },
      Effectable.Prototype({
        label: `Azure.Functions.WorkflowFunction<${id}>`,
        evaluate: () => self,
      }),
    );
  };

/** App setting that holds the task hub name host.json reads. */
const HUB_SETTING = "DURABLE_TASK_HUB_NAME";

/** Point Durable Functions at the scheduler, in host.json (the scale controller reads it). */
const withDurableTask = (props: FunctionProps): FunctionProps => ({
  ...props,
  hostExtensions: {
    ...props.hostExtensions,
    durableTask: {
      hubName: `%${HUB_SETTING}%`,
      storageProvider: { type: "azureManaged", connectionStringName: CONNECTION_SETTING },
    },
  },
});

/**
 * The host's program: bind the task hub, register the workflows with the
 * engine, and register one orchestrator function per workflow plus the step
 * activity.
 */
const makeWorkflowHost = <ROut, E, RIn>(
  workflows: ReadonlyArray<Workflow.Any>,
  durableTask: Effect.Effect<WorkflowDurableTask, never, any>,
  layer: Layer.Layer<ROut, E, RIn>,
) =>
  Effect.gen(function* () {
    const host = yield* Function;
    const { scheduler, taskHub } = yield* durableTask;
    if (!globalThis.__ALCHEMY_RUNTIME__) {
      yield* host.bind`Allow(${host}, Azure.Functions.WorkflowFunction(${taskHub}))`({
        roleAssignments: [
          { roleDefinitionId: BuiltInRole.DurableTaskDataContributor, scope: taskHub.taskHubId },
        ],
        env: {
          [CONNECTION_SETTING]: Output.interpolate`Endpoint=${scheduler.endpoint};Authentication=ManagedIdentity;TaskHub=${taskHub.taskHubName}`,
          [HUB_SETTING]: taskHub.taskHubName,
        },
      });
    }
    const ops = yield* resolveOps;
    const calls = yield* makeHubCalls(ops, scheduler, taskHub);
    const handlers = new Map<string, Registration>();
    const engine = makeEngine({
      route: (workflowName) =>
        handlers.has(workflowName)
          ? Effect.succeed(calls)
          : Effect.die(new Error(`Workflow ${workflowName} is not hosted by this function`)),
      register: (workflow, execute) => void handlers.set(workflow._tag, { workflow, execute }),
    });
    // Workflows register for the life of the function instance.
    yield* Layer.buildWithScope(
      layer.pipe(Layer.provide(Layer.succeed(WorkflowEngine.WorkflowEngine, engine))),
      yield* Scope.make(),
    );
    for (const workflow of workflows) {
      yield* host.trigger(
        orchestratorNameOf(workflow._tag),
        { type: "orchestrationTrigger" },
        (invocation) => {
          const registration = handlers.get(workflow._tag);
          return registration
            ? orchestrate({ registration, engine, binding: invocation.input })
            : Effect.die(new Error(`Workflow ${workflow._tag} is not implemented here`));
        },
      );
    }
    yield* host.trigger(STEP_ACTIVITY, { type: "activityTrigger" }, (invocation) =>
      Effect.sync(() => recordStep(invocation.input)),
    );
  });
