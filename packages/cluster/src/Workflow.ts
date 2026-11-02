import type { InputProps } from "alchemy/Input";
import * as Output from "alchemy/Output";
import { Platform, type PlatformProps, type PlatformServices } from "alchemy/Platform";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import { RuntimeContext, sanitizeKey } from "alchemy/RuntimeContext";
import type { Self } from "alchemy/Self";
import { type Execute, type Implemented, implemented } from "alchemy/Workflows";
import { ClusterSchema } from "effect/cluster";
import type * as ConfigError from "effect/Config";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import type * as Schema from "effect/Schema";
import {
  type Workflow as EffectWorkflow,
  WorkflowEngine as EffectWorkflowEngine,
} from "effect/workflow";
import { type EntityBindingContract, PlatformDeclaration, shardGroupKey } from "./Entity.ts";
import type { GatewayTarget } from "./internal/Gateway.ts";
import { type HostedRuntimeContext, makeHostedRuntimeContext } from "./internal/HostedRuntime.ts";
import { makeRemoteEngine } from "./internal/WorkflowGateway.ts";
import type { Providers } from "./Providers.ts";

export const WorkflowTypeId = "Cluster.Workflow";
export type WorkflowTypeId = typeof WorkflowTypeId;

export interface WorkflowProps extends PlatformProps {
  /** The module whose default export is this workflow's Layer. Usually `import.meta.url`. */
  main: string;
}

export interface WorkflowAttributes {
  /** The workflow's name. */
  workflow: string;
  /** The shard group of the runners that host it. */
  runners: string | undefined;
  /** The gateway URL callers start and read runs through. */
  gateway: string | undefined;
  /** The token callers present to the gateway. */
  token: Redacted.Redacted<string> | undefined;
}

export interface ClusterWorkflow extends Resource<
  WorkflowTypeId,
  WorkflowProps,
  WorkflowAttributes,
  EntityBindingContract,
  Providers
> {}

/**
 * A workflow as a runner runs it: the workflow, the handler its
 * Construction phase returned, and the services that phase ran with.
 * @internal
 */
export interface HostedWorkflow {
  readonly kind: "workflow";
  readonly workflow: EffectWorkflow.Any;
  readonly execute: (payload: any, executionId: string) => Effect.Effect<any, any, any>;
  readonly context: Context.Context<never>;
}

export type WorkflowRuntimeContext = HostedRuntimeContext<HostedWorkflow>;

/** Services the Construction phase may use without the caller providing them. */
type WorkflowServices = ClusterWorkflow | Providers | RuntimeContext | Self | Self<ClusterWorkflow>;

/** The workflow behind each declared resource id, for the runtime context. */
const workflows = new Map<string, EffectWorkflow.Any>();

/** Every `Cluster.Workflow` declared, by workflow name, for the engine. */
const declarations = new Map<string, Effect.Effect<ClusterWorkflow, never, any>>();

const platform = Platform(WorkflowTypeId, {
  createRuntimeContext: makeHostedRuntimeContext<HostedWorkflow>(
    WorkflowTypeId,
    (id, execute, context) => ({
      kind: "workflow",
      workflow: workflows.get(id)!,
      execute: execute as HostedWorkflow["execute"],
      context,
    }),
  ),
}) as unknown as Platform<ClusterWorkflow, WorkflowServices, unknown, WorkflowRuntimeContext>;

/** The resource type behind every workflow, which the providers register. @internal */
export const WorkflowResource = platform;

/** The resource id of a workflow: kept apart from an entity of the same name. */
const resourceId = (name: string) => `${name}Workflow`;

/**
 * A durable **Workflow** on an Effect Cluster: each run is a workflow
 * entity, so its activities are persisted, `DurableClock.sleep` is a
 * delayed message, and a run continues on another runner if its runner
 * dies.
 *
 * Declare the workflow with Effect's `Workflow.make`, then implement it here
 * as `Workflows.layer` does: an Effect that resolves bindings once per
 * runner and returns the handler. Provide a runners Layer to the result to
 * deploy it, and the result to the Stack.
 *
 * Start and read runs from any runtime with `Workflows.RunWorkflow`, with
 * {@link WorkflowEngine | Cluster.WorkflowEngine} provided for the
 * workflows it runs.
 *
 * ### Implementing a workflow
 * **Example:** One workflow per file
 * ```typescript
 * // src/PlaceOrder.ts
 * export const PlaceOrder = Workflow.make("PlaceOrder", {
 *   payload: { orderId: Schema.String },
 *   success: Schema.String,
 *   idempotencyKey: ({ orderId }) => orderId,
 * });
 *
 * // src/PlaceOrderLive.ts
 * export default Cluster.Workflow(
 *   PlaceOrder,
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const counters = yield* Counter;
 *     return Effect.fn(function* ({ orderId }) {
 *       const n = yield* Activity.make({
 *         name: "count",
 *         success: Schema.Int,
 *         execute: Effect.flatMap(counters.getByName("orders"), (counter) =>
 *           counter.Increment({ amount: 1 }),
 *         ),
 *       });
 *       return `order ${orderId} is #${n}`;
 *     });
 *   }),
 * ).pipe(Layer.provide(Default));
 * ```
 *
 * ### Running a workflow
 * **Example:** Start a run from any runtime
 * ```typescript
 * Effect.gen(function* () {
 *   const placeOrder = yield* Workflows.RunWorkflow(PlaceOrder);
 *   return {
 *     fetch: Effect.gen(function* () {
 *       const run = yield* placeOrder.start({ orderId: "o-1" });
 *       return HttpServerResponse.text(run.executionId);
 *     }),
 *   };
 * }).pipe(Effect.provide(Cluster.WorkflowEngine(PlaceOrder)));
 * ```
 *
 * @resource
 */
export const Workflow = <
  Name extends string,
  Payload extends EffectWorkflow.AnyStructSchema,
  Success extends Schema.Top,
  Error extends Schema.Top,
  R,
  InitReq = never,
>(
  workflow: EffectWorkflow.Workflow<Name, Payload, Success, Error>,
  props: InputProps<WorkflowProps>,
  impl: Effect.Effect<Execute<Payload, Success, Error, R>, ConfigError.ConfigError, InitReq>,
): Layer.Layer<
  Implemented<Name>,
  never,
  Providers | Exclude<InitReq, WorkflowServices | PlatformServices>
> => {
  const id = resourceId(workflow._tag);
  placeInRunnersGroup(workflow, id);
  workflows.set(id, workflow);
  const tag = (platform as any)()(id);
  declarations.set(workflow._tag, tag);
  const live = tag.make(props, impl) as Layer.Layer<never, never, any>;
  // A runner builds the Platform declaration; the Stack, both.
  return Object.assign(Layer.merge(live, implemented([workflow._tag])), {
    [PlatformDeclaration]: live,
  });
};

/**
 * Place a workflow in its runners' shard group, read when a run is routed:
 * the runners that host it have the group in their environment, so a child
 * run started on any of them, with the workflow as the code imports it,
 * reaches them.
 */
const placeInRunnersGroup = (workflow: EffectWorkflow.Any, id: string) => {
  const key = shardGroupKey(id);
  const self = workflow as unknown as { annotations: Context.Context<never> };
  self.annotations = Context.add(
    self.annotations,
    ClusterSchema.ShardGroup,
    () =>
      // A synchronous lookup at routing time; workerd has no `process`.
      (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env[key] ??
      "default",
  );
};

/** A workflow started outside any runtime. */
export class WorkflowEngineOutsideRuntime extends Data.TaggedError(
  "Cluster.WorkflowEngineOutsideRuntime",
)<{
  readonly message: string;
}> {}

/** No `Cluster.Workflow` in the Stack hosts the workflow. */
export class WorkflowNotHosted extends Data.TaggedError("Cluster.WorkflowNotHosted")<{
  readonly workflow: string;
}> {}

/**
 * Start and read runs of workflows `Cluster.Workflow` hosts, from any
 * runtime: a `WorkflowEngine` that reaches each workflow through the
 * gateway of the runners that host it.
 *
 * Pass the workflows the runtime runs. While deploying, it binds each one's
 * gateway into the runtime, wherever its `Cluster.Workflow` placed it, so it
 * takes no list of hosts. A workflow no `Cluster.Workflow` in the Stack
 * hosts fails the deploy.
 *
 * ### Running workflows
 * **Example:** From a Worker, a Lambda function or a container
 * ```typescript
 * Effect.gen(function* () {
 *   const placeOrder = yield* Workflows.RunWorkflow(PlaceOrder);
 *   return {
 *     fetch: Effect.gen(function* () {
 *       const run = yield* placeOrder.start({ orderId: "o-1" });
 *       return yield* HttpServerResponse.json(yield* run.status);
 *     }),
 *   };
 * }).pipe(Effect.provide(Cluster.WorkflowEngine(PlaceOrder)));
 * ```
 *
 * @layer
 * @provides WorkflowEngine
 */
export const WorkflowEngine = <const Workflows extends ReadonlyArray<EffectWorkflow.Any>>(
  ...runs: Workflows
): Layer.Layer<
  EffectWorkflowEngine.WorkflowEngine | Implemented<Workflows[number]["_tag"]>,
  never,
  Providers
> =>
  Layer.merge(
    Layer.effect(
      EffectWorkflowEngine.WorkflowEngine,
      Effect.gen(function* () {
        const ctx = Option.getOrUndefined(yield* Effect.serviceOption(RuntimeContext));
        const routes = new Map<string, GatewayTarget>();
        if (ctx !== undefined) {
          const bind = <T>(key: string, value: unknown) =>
            ctx
              .set(sanitizeKey(key), Output.isOutput(value) ? value : Output.literal(value))
              .pipe(Effect.flatMap((bound) => ctx.get<T>(bound)));
          for (const { _tag: name } of runs) {
            const declaration = declarations.get(name);
            if (!globalThis.__ALCHEMY_RUNTIME__ && declaration === undefined) {
              return yield* Effect.die(new WorkflowNotHosted({ workflow: name }));
            }
            // Built on a memo map of its own, as an entity's client is.
            const resource = globalThis.__ALCHEMY_RUNTIME__
              ? undefined
              : yield* declaration!.pipe(
                  Effect.provideServiceEffect(Layer.CurrentMemoMap, Layer.makeMemoMap),
                );
            const url = yield* bind<string>(`CLUSTER_WORKFLOW_${name}_GATEWAY`, resource?.gateway);
            const token = yield* bind<Redacted.Redacted<string> | string>(
              `CLUSTER_WORKFLOW_${name}_TOKEN`,
              resource?.token,
            );
            routes.set(name, {
              url: url ?? "",
              token:
                token === undefined
                  ? ""
                  : Redacted.isRedacted(token)
                    ? Redacted.value(token)
                    : token,
            });
          }
        }
        return makeRemoteEngine((name) => {
          const target = routes.get(name);
          if (target !== undefined) return Effect.succeed(target);
          return Effect.die(
            ctx === undefined
              ? new WorkflowEngineOutsideRuntime({
                  message: `Cluster.WorkflowEngine can only start '${name}' inside a runtime.`,
                })
              : new WorkflowNotHosted({ workflow: name }),
          );
        });
      }),
    ),
    implemented(runs.map((workflow) => workflow._tag)),
  ) as Layer.Layer<
    EffectWorkflowEngine.WorkflowEngine | Implemented<Workflows[number]["_tag"]>,
    never,
    Providers
  >;

export const WorkflowProvider = () =>
  Provider.succeed(platform, {
    stables: ["workflow"],
    reconcile: ({ id, bindings }) =>
      Effect.sync(() => {
        const attrs: WorkflowAttributes = {
          workflow: id.replace(/Workflow$/, ""),
          runners: undefined,
          gateway: undefined,
          token: undefined,
        };
        for (const { data } of bindings) {
          attrs.runners = data.runners ?? attrs.runners;
          attrs.gateway = data.gateway ?? attrs.gateway;
          attrs.token = data.token ?? attrs.token;
        }
        return attrs;
      }),
    delete: () => Effect.void,
  });
