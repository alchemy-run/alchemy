import type { InputProps } from "alchemy/Input";
import type { Named } from "alchemy/Named";
import * as Output from "alchemy/Output";
import {
  Platform,
  type PlatformIdentity,
  type PlatformProps,
  type PlatformServices,
} from "alchemy/Platform";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import { RuntimeContext, sanitizeKey } from "alchemy/RuntimeContext";
import type { Self } from "alchemy/Self";
import {
  type Execute,
  type Implemented,
  implemented,
  makeRun,
  type WorkflowClient,
} from "alchemy/Workflows";
import { ClusterSchema } from "effect/cluster";
import type * as ConfigError from "effect/Config";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Effectable from "effect/Effectable";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import type * as Schema from "effect/Schema";
import {
  Workflow as EffectWorkflow,
  WorkflowEngine as EffectWorkflowEngine,
} from "effect/workflow";
import { type EntityBindingContract, PlatformDeclaration, shardGroupKey } from "./Entity.ts";
import { bindRoute, type GatewayTarget } from "./internal/Gateway.ts";
import { type HostedRuntimeContext, makeHostedRuntimeContext } from "./internal/HostedRuntime.ts";
import { makeRemoteEngine } from "./internal/WorkflowGateway.ts";
import type { Providers } from "./Providers.ts";

export const WorkflowTypeId = "Cluster.Workflow";
export type WorkflowTypeId = typeof WorkflowTypeId;

export interface WorkflowProps extends PlatformProps {
  /**
   * The module whose default export is this workflow: the class, or the
   * Layer its `.make(...)` returned. Usually `import.meta.url`.
   */
  main: string;
}

export interface WorkflowAttributes {
  /** The workflow's name. */
  workflow: string;
  /** The shard group of the pool that hosts it. */
  pool: string | undefined;
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

type AnyWorkflow = EffectWorkflow.Workflow<string, any, any, any>;

type PayloadOf<W> = W extends EffectWorkflow.Workflow<any, infer P, any, any> ? P : never;
type SuccessOf<W> = W extends EffectWorkflow.Workflow<any, any, infer S, any> ? S : never;
type ErrorOf<W> = W extends EffectWorkflow.Workflow<any, any, any, infer E> ? E : never;

/** A workflow's handler, typed by its declaration. */
export type WorkflowHandler<W> = Execute<
  PayloadOf<W> & EffectWorkflow.AnyStructSchema,
  SuccessOf<W> & Schema.Top,
  ErrorOf<W> & Schema.Top,
  any
>;

/**
 * A declared workflow: the tag callers `yield*` for its client, carrying
 * Effect's workflow surface (`.workflow`, `.execute`, `.withCompensation`),
 * implemented by `.make(props, impl)`.
 */
export type WorkflowTag<Self, W extends AnyWorkflow> = Effect.Effect<
  WorkflowClient<W>,
  never,
  Providers
> &
  Named<W["_tag"]> &
  PlatformIdentity<W["_tag"]> & {
    /** The Effect workflow behind the class, for Effect's own APIs. */
    readonly workflow: W;
    /** Run it as a child of the current workflow, as Effect's `Workflow.execute`. */
    readonly execute: W["execute"];
    /** Undo a step when the workflow fails later, as Effect's `withCompensation`. */
    readonly withCompensation: W["withCompensation"];
    /** Type the workflow's handler against its payload, success and error. */
    of<Handler extends WorkflowHandler<W>>(handler: Handler): Handler;
    /**
     * The workflow's implementation, as a Layer: an Effect that resolves
     * bindings once per runner and returns the handler. Provide a pool
     * Layer to `impl` to deploy it; provide the returned Layer to the Stack.
     */
    make<InitReq = never>(
      props: InputProps<WorkflowProps>,
      impl: Effect.Effect<WorkflowHandler<W>, ConfigError.ConfigError, InitReq>,
    ): Layer.Layer<
      Self | Implemented<W["_tag"]>,
      never,
      Providers | Exclude<InitReq, WorkflowServices | PlatformServices>
    >;
    new (_: never): WorkflowClient<W>;
  };

/**
 * A workflow declared with its implementation: the class callers `yield*`,
 * which also deploys it.
 */
export type WorkflowInline<W extends AnyWorkflow, Req> = Effect.Effect<
  WorkflowClient<W>,
  never,
  Req
> &
  Named<W["_tag"]> &
  PlatformIdentity<W["_tag"]> & {
    /** The Effect workflow behind the class, for Effect's own APIs. */
    readonly workflow: W;
    /** Run it as a child of the current workflow, as Effect's `Workflow.execute`. */
    readonly execute: W["execute"];
    /** Undo a step when the workflow fails later, as Effect's `withCompensation`. */
    readonly withCompensation: W["withCompensation"];
    /** Type the workflow's handler against its payload, success and error. */
    of<Handler extends WorkflowHandler<W>>(handler: Handler): Handler;
    new (_: never): WorkflowClient<W>;
  };

type WorkflowOf<
  Name extends string,
  Payload extends Schema.Struct.Fields | EffectWorkflow.AnyStructSchema,
  Success extends Schema.Top,
  Error extends Schema.Top,
> = EffectWorkflow.Workflow<
  Name,
  Payload extends Schema.Struct.Fields ? Schema.Struct<Payload> : Payload,
  Success,
  Error
>;

/** The class surface of {@link Workflow}. */
export interface WorkflowClass {
  // `Self` names the class (`extends Cluster.Workflow<PlaceOrder>()`).
  <Self>(): {
    /**
     * Declared like Effect's `Workflow.make`, with its implementation: an
     * Effect that resolves bindings once per runner and returns the
     * handler. Provide a pool Layer to `impl` to deploy it.
     */
    <
      const Name extends string,
      Payload extends Schema.Struct.Fields | EffectWorkflow.AnyStructSchema,
      Success extends Schema.Top = Schema.Void,
      Error extends Schema.Top = Schema.Never,
      InitReq = never,
    >(
      name: Name,
      options: Parameters<typeof EffectWorkflow.make<Name, Payload, Success, Error>>[1],
      props: InputProps<WorkflowProps>,
      impl: Effect.Effect<
        WorkflowHandler<WorkflowOf<Name, Payload, Success, Error>>,
        ConfigError.ConfigError,
        InitReq
      >,
    ): WorkflowInline<
      WorkflowOf<Name, Payload, Success, Error>,
      Providers | Exclude<InitReq, WorkflowServices | PlatformServices>
    >;
    /** Declared like Effect's `Workflow.make`, implemented by `.make(props, impl)`. */
    <
      const Name extends string,
      Payload extends Schema.Struct.Fields | EffectWorkflow.AnyStructSchema,
      Success extends Schema.Top = Schema.Void,
      Error extends Schema.Top = Schema.Never,
    >(
      name: Name,
      options: Parameters<typeof EffectWorkflow.make<Name, Payload, Success, Error>>[1],
    ): WorkflowTag<Self, WorkflowOf<Name, Payload, Success, Error>>;
  };
}

/**
 * A durable **Workflow** on an Effect Cluster: each run is a workflow
 * entity, so its activities are persisted, `DurableClock.sleep` is a
 * delayed message, and a run continues on another runner if its runner
 * dies.
 *
 * Declare it like Effect's `Workflow.make`, from a name and its schemas,
 * with its implementation: an Effect that resolves bindings once per runner
 * and returns the handler. Providing a pool Layer to the implementation is
 * what deploys it. Or declare it bare and implement it with
 * `.make(props, impl)`, as a Layer: callers import the bare declaration
 * without bundling the implementation or its pool.
 *
 * `yield* PlaceOrder` from any runtime returns its client: `start` a run,
 * then read, signal or interrupt it.
 *
 * ### Declaring a workflow
 * **Example:** A workflow, with its implementation
 * ```typescript
 * // src/PlaceOrder.ts
 * export default class PlaceOrder extends Cluster.Workflow<PlaceOrder>()(
 *   "PlaceOrder",
 *   {
 *     payload: { orderId: Schema.String },
 *     success: Schema.String,
 *     idempotencyKey: ({ orderId }) => orderId,
 *   },
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
 *   }).pipe(Effect.provide(Default)),
 * ) {}
 * ```
 *
 * ### Keeping its code out of its callers
 * **Example:** A bare declaration, which callers import
 * ```typescript
 * // src/PlaceOrder.ts
 * export class PlaceOrder extends Cluster.Workflow<PlaceOrder>()("PlaceOrder", {
 *   payload: { orderId: Schema.String },
 *   success: Schema.String,
 *   idempotencyKey: ({ orderId }) => orderId,
 * }) {}
 * ```
 *
 * **Example:** Its implementation, as a Layer, deployed to a pool
 * ```typescript
 * // src/PlaceOrderLive.ts
 * export default PlaceOrder.make(
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const counters = yield* Counter;
 *     return PlaceOrder.of(
 *       Effect.fn(function* ({ orderId }) {
 *         const n = yield* Activity.make({
 *           name: "count",
 *           success: Schema.Int,
 *           execute: Effect.flatMap(counters.getByName("orders"), (counter) =>
 *             counter.Increment({ amount: 1 }),
 *           ),
 *         });
 *         return `order ${orderId} is #${n}`;
 *       }),
 *     );
 *   }).pipe(Effect.provide(Default)),
 * );
 * ```
 *
 * ### Running a workflow
 * **Example:** Start a run from any runtime
 * ```typescript
 * const placeOrder = yield* PlaceOrder;
 * const run = yield* placeOrder.start({ orderId: "o-1" });
 * const status = yield* run.status;
 * ```
 *
 * **Example:** A child workflow, inside another workflow
 * ```typescript
 * const receipt = yield* PlaceOrder.execute({ orderId: "o-1" });
 * ```
 *
 * @resource
 */
export const Workflow: WorkflowClass = (() =>
  (
    name: string,
    options: Parameters<typeof EffectWorkflow.make>[1],
    props?: InputProps<WorkflowProps>,
    impl?: unknown,
  ) => {
    const workflow = EffectWorkflow.make(name, options) as AnyWorkflow;
    const id = resourceId(name);
    placeInShardGroup(workflow, id);
    workflows.set(id, workflow);
    const members = {
      LogicalId: name,
      workflow,
      execute: workflow.execute.bind(workflow),
      withCompensation: workflow.withCompensation,
      of: (handler: unknown) => handler,
    };
    // With an implementation, the class deploys it, and a runner builds it.
    if (impl !== undefined) {
      const declaration = (platform as any)()(id, props, impl);
      declarations.set(name, declaration);
      return Object.assign(
        class {},
        members,
        { [PlatformDeclaration]: declaration },
        Effectable.Prototype({
          label: `${WorkflowTypeId}<${name}>`,
          evaluate: () => clientOf(workflow, declaration),
        }),
      );
    }
    const tag = (platform as any)()(id);
    declarations.set(name, tag);
    return Object.assign(
      class {},
      members,
      {
        make: (props: InputProps<WorkflowProps>, impl: unknown) => {
          const live = tag.make(props, impl) as Layer.Layer<never, never, any>;
          // A runner builds the Platform declaration; the Stack, both.
          return Object.assign(Layer.merge(live, implemented([name])), {
            [PlatformDeclaration]: live,
          });
        },
      },
      Effectable.Prototype({
        label: `${WorkflowTypeId}<${name}>`,
        evaluate: () => clientOf(workflow, tag),
      }),
    );
  }) as unknown as WorkflowClass;

/**
 * Bind the gateway of the pool that hosts `name` into the current
 * runtime: from its resource while deploying, from the environment at
 * runtime. Undefined outside any runtime.
 */
const routeOf = (
  name: string,
  declaration: Effect.Effect<ClusterWorkflow, never, any> | undefined,
) =>
  Effect.gen(function* () {
    const ctx = Option.getOrUndefined(yield* Effect.serviceOption(RuntimeContext));
    if (ctx === undefined) return undefined;
    if (!globalThis.__ALCHEMY_RUNTIME__ && declaration === undefined) {
      return yield* Effect.die(new WorkflowNotHosted({ workflow: name }));
    }
    // Built on a memo map of its own, as an entity's client is.
    const resource = globalThis.__ALCHEMY_RUNTIME__
      ? undefined
      : yield* declaration!.pipe(
          Effect.provideServiceEffect(Layer.CurrentMemoMap, Layer.makeMemoMap),
        );
    const bind = <T>(key: string, value: unknown) =>
      ctx
        .set(sanitizeKey(key), Output.isOutput(value) ? value : Output.literal(value))
        .pipe(Effect.flatMap((bound) => ctx.get<T>(bound)));
    const url = yield* bind<string>(`CLUSTER_WORKFLOW_${name}_GATEWAY`, resource?.gateway);
    const token = yield* bind<Redacted.Redacted<string> | string>(
      `CLUSTER_WORKFLOW_${name}_TOKEN`,
      resource?.token,
    );
    // A Worker calling a gateway Worker reaches it through a service binding.
    const service = sanitizeKey(`CLUSTER_WORKFLOW_${name}_SERVICE`);
    if (!globalThis.__ALCHEMY_RUNTIME__) yield* bindRoute(resourceId(name), service);
    return {
      url: url ?? "",
      token: token === undefined ? "" : Redacted.isRedacted(token) ? Redacted.value(token) : token,
      service,
    } satisfies GatewayTarget;
  });

const unrouted = (name: string, inRuntime: boolean) =>
  Effect.die(
    inRuntime
      ? new WorkflowNotHosted({ workflow: name })
      : new WorkflowEngineOutsideRuntime({
          message: `Cluster.Workflow '${name}' can only be started inside a runtime.`,
        }),
  );

/** `yield* PlaceOrder`: its client, over the gateway of the pool that hosts it. */
const clientOf = (workflow: AnyWorkflow, declaration: Effect.Effect<ClusterWorkflow, never, any>) =>
  Effect.gen(function* () {
    const target = yield* routeOf(workflow._tag, declaration);
    const engine = makeRemoteEngine(() =>
      target === undefined ? unrouted(workflow._tag, false) : Effect.succeed(target),
    );
    const run = (executionId: string) => makeRun(engine, workflow, executionId);
    return {
      start: (payload) =>
        workflow
          .execute(payload, { discard: true })
          .pipe(
            Effect.provideService(EffectWorkflowEngine.WorkflowEngine, engine),
            Effect.map(run),
          ),
      get: run,
    } as WorkflowClient<AnyWorkflow>;
  });

/**
 * Place a workflow in its pool's shard group, read when a run is routed:
 * the pool that hosts it has the group in their environment, so a child
 * run started on any of them reaches them.
 */
const placeInShardGroup = (workflow: EffectWorkflow.Any, id: string) => {
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
 * Run `Cluster.Workflow`s through Alchemy's engine-neutral
 * `Workflows.RunWorkflow`: a `WorkflowEngine` that reaches each workflow
 * through the gateway of the pool that hosts it. Use it for code that
 * runs the same workflow on any engine; otherwise `yield*` the workflow.
 *
 * ### Running workflows on any engine
 * **Example:** `Workflows.RunWorkflow` on the cluster
 * ```typescript
 * Effect.gen(function* () {
 *   const placeOrder = yield* Workflows.RunWorkflow(PlaceOrder.workflow);
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
export const WorkflowEngine = <
  const Workflows extends ReadonlyArray<{ readonly workflow: EffectWorkflow.Any }>,
>(
  ...runs: Workflows
): Layer.Layer<
  EffectWorkflowEngine.WorkflowEngine | Implemented<Workflows[number]["workflow"]["_tag"]>,
  never,
  Providers
> =>
  Layer.merge(
    Layer.effect(
      EffectWorkflowEngine.WorkflowEngine,
      Effect.gen(function* () {
        const inRuntime = Option.isSome(yield* Effect.serviceOption(RuntimeContext));
        const routes = new Map<string, GatewayTarget>();
        for (const { workflow } of runs) {
          const target = yield* routeOf(workflow._tag, declarations.get(workflow._tag));
          if (target !== undefined) routes.set(workflow._tag, target);
        }
        return makeRemoteEngine((name) => {
          const target = routes.get(name);
          return target === undefined ? unrouted(name, inRuntime) : Effect.succeed(target);
        });
      }),
    ),
    implemented(runs.map(({ workflow }) => workflow._tag)),
  ) as Layer.Layer<
    EffectWorkflowEngine.WorkflowEngine | Implemented<Workflows[number]["workflow"]["_tag"]>,
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
          pool: undefined,
          gateway: undefined,
          token: undefined,
        };
        for (const { data } of bindings) {
          attrs.pool = data.pool ?? attrs.pool;
          attrs.gateway = data.gateway ?? attrs.gateway;
          attrs.token = data.token ?? attrs.token;
        }
        return attrs;
      }),
    delete: () => Effect.void,
  });
