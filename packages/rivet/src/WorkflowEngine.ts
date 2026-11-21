import type { Callbacks } from "alchemy/Callback";
import { entrypointLayer, entrypointTag } from "alchemy/Runtime/Bootstrap";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import { makeDurableObjectEngine } from "alchemy/Workers/DurableObjectEngine";
import { InputGate } from "alchemy/Workers/InputGate";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import type { WorkflowEngine } from "effect/workflow";
import {
  DurableObject,
  type DurableObjectNamespace,
  type DurableObjectRuntimeContext,
  makeNamespace,
  PlatformDeclaration,
} from "./DurableObject.ts";
import { DurableObjectCallbacks } from "./DurableObjectCallbacks.ts";
import { DurableObjectState, type DurableObjectStorage } from "./DurableObjectState.ts";
import { NodeHost, type PoolHost } from "./Host.ts";
import type { Providers } from "./Providers.ts";

/** Options for {@link layerWorkflowEngine}. */
export interface WorkflowEngineOptions<PoolReq> {
  /** The Rivet Durable Object class every execution is an instance of: its actors' name. */
  readonly name: string;
  /**
   * The module that exports the workflows' Layer (the one this engine is
   * provided to), usually `import.meta.url`. The pool's nodes load it to run
   * the workflows.
   */
  readonly main: string;
  /**
   * The export of {@link main} that holds the workflows' Layer.
   * @default "default"
   */
  readonly handler?: string;
  /** The pool whose nodes run the workflows, e.g. `RivetDocker.SwarmPool("Default")`. */
  readonly pool: Layer.Layer<PoolHost, never, PoolReq>;
}

/** The engine was asked for an execution of a workflow this class doesn't host. */
export class WorkflowNotHosted extends Data.TaggedError("Rivet.WorkflowNotHosted")<{
  readonly message: string;
}> {}

/** Built for one execution: its object's methods. */
type ExecutionBuild = Effect.Effect<
  Record<string, unknown>,
  never,
  EngineState | RuntimeContext | Callbacks | Scope.Scope
>;

/** The SQL storage the engine journals each execution in. */
interface EngineStateShape {
  readonly storage: {
    readonly sql: {
      exec<T extends Record<string, unknown>>(
        query: string,
        ...bindings: ReadonlyArray<unknown>
      ): Effect.Effect<{ toArray(): Effect.Effect<T[]> }>;
    };
    readonly transaction: DurableObjectStorage["transaction"];
  };
}

/** An execution's instance state, as the engine reads it. */
class EngineState extends Context.Service<EngineState, EngineStateShape>()(
  "Rivet/WorkflowEngine/EngineState",
) {}

/**
 * The engine's SQL over a Rivet instance's database: its schema arrives as
 * one script, and RivetKit runs one statement per call.
 */
const engineState = (state: DurableObjectState["Service"]): EngineStateShape => ({
  storage: {
    sql: {
      exec: <T extends Record<string, unknown>>(
        query: string,
        ...bindings: ReadonlyArray<unknown>
      ) => {
        const statements = query
          .split(";")
          .map((statement) => statement.trim())
          .filter((statement) => statement.length > 0);
        if (statements.length <= 1) return state.storage.sql.exec<T>(query, ...bindings);
        return Effect.forEach(statements, (statement) => state.storage.sql.exec<T>(statement)).pipe(
          Effect.map((cursors) => cursors[cursors.length - 1]!),
        );
      },
    },
    transaction: (effect, options) => state.storage.transaction(effect, options),
  },
});

/**
 * The class phase of the class every execution is an instance of: each
 * instance builds the execution its name says (`SendWelcomeWorkflow/u-1`)
 * from the workflows registered on this node.
 */
const hostClassPhase = (name: string, workflows: ReadonlyMap<string, ExecutionBuild>) =>
  Effect.gen(function* () {
    // The engine's executions were written for Cloudflare's input gate.
    yield* Layer.buildWithScope(InputGate, yield* Scope.make());
    return Effect.gen(function* () {
      const state = yield* DurableObjectState;
      const slash = state.id.name.indexOf("/");
      const build = slash < 0 ? undefined : workflows.get(state.id.name.slice(0, slash));
      if (build === undefined) {
        return yield* Effect.die(
          new WorkflowNotHosted({
            message: `Rivet.DurableObject '${name}' hosts no workflow for '${state.id.name}'.`,
          }),
        );
      }
      return yield* build.pipe(
        Effect.provideService(EngineState, engineState(state)),
        Effect.provide(DurableObjectCallbacks),
      );
    });
  });

/**
 * Every workflow on one Rivet class: the execution `u-1` of `SendWelcome` is
 * the instance `SendWelcomeWorkflow/u-1`. `onRegister` keeps each workflow's
 * execution object where the class runs.
 */
const engineOver = (
  namespace: DurableObjectNamespace<any>,
  onRegister: (workflow: string, build: ExecutionBuild) => void,
) =>
  makeDurableObjectEngine({
    declare: (workflow, impl) =>
      Effect.sync(() => {
        // oxlint-disable-next-line effecttsgo/unsafe-effect-type-assertion -- an instance provides the engine's state, its Callbacks and its RuntimeContext
        onRegister(workflow, Effect.flatten(impl) as ExecutionBuild);
        return {
          getByName: (executionId: string) =>
            namespace.getByName(`${workflow}/${executionId}`) as never,
        };
      }),
    // The engine reads only `toArray` from its cursors, which Rivet's have.
    state: EngineState as never,
  });

/**
 * Effect's `WorkflowEngine` on Rivet Durable Objects. Provide it to the
 * workflows' Layer (`Workflows.layer(...)`) in every runtime that starts or
 * reads runs, and export that Layer from `main` so the pool's nodes run it.
 *
 * Every execution is one instance of the Durable Object class `name`, named
 * after its workflow and execution id, with its journal in that instance's
 * SQLite. Its sleeps, signals and retries are durable callbacks
 * (`Rivet.DurableObjectCallbacks`), so a run that waits uses no compute
 * until it wakes. Built in a caller, the Layer deploys the class to `pool`
 * and reaches executions through the control plane's gateway; on a node of
 * the pool, the same Layer hosts the class.
 *
 * A run replays its workflow from the top: finished activities return their
 * stored results, and the first unfinished one runs and is stored. Runs of
 * one execution never overlap, and a run that fails or is cut short is
 * retried.
 *
 * ### Running workflows on Rivet
 * **Example:** Start a run from a Docker service
 * ```typescript
 * import * as Docker from "@alchemy.run/docker";
 * import * as Rivet from "@alchemy.run/rivet";
 * import * as RivetDocker from "@alchemy.run/rivet/Docker";
 * import * as Workflows from "alchemy/Workflows";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 * import * as Layer from "effect/Layer";
 * import * as Schema from "effect/Schema";
 * import { Activity, Workflow } from "effect/workflow";
 *
 * const ControlPlane = RivetDocker.SwarmControlPlane("Rivet");
 * const Default = RivetDocker.SwarmPool("Default").pipe(Layer.provide(ControlPlane));
 *
 * export const SendWelcome = Workflow.make("SendWelcome", {
 *   payload: { userId: Schema.String },
 *   idempotencyKey: ({ userId }) => userId,
 * });
 *
 * // The pool's nodes load this export to run the workflows.
 * export const WorkflowsLive = Workflows.layer(
 *   SendWelcome,
 *   Effect.fn(function* ({ userId }) {
 *     yield* Activity.make({ name: "send", execute: Effect.log(`welcome, ${userId}`) });
 *   }),
 * ).pipe(
 *   Layer.provideMerge(
 *     Rivet.layerWorkflowEngine({
 *       name: "Workflows",
 *       main: import.meta.url,
 *       handler: "WorkflowsLive",
 *       pool: Default,
 *     }),
 *   ),
 * );
 *
 * export default class Api extends Docker.Service<Api>()(
 *   "Api",
 *   Effect.gen(function* () {
 *     const cluster = yield* Rivet.Cluster;
 *     return {
 *       main: import.meta.url,
 *       port: 3000,
 *       networks: cluster.network?.kind === "docker" ? [{ name: cluster.network.name }] : [],
 *     };
 *   }).pipe(Effect.provide(ControlPlane)),
 *   Effect.gen(function* () {
 *     const welcome = yield* Workflows.RunWorkflow(SendWelcome);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const run = yield* welcome.start({ userId: "u-1" });
 *         return HttpServerResponse.text(run.executionId);
 *       }),
 *     };
 *   }).pipe(Effect.provide(WorkflowsLive)),
 * ) {}
 * ```
 *
 * @layer
 * @provides WorkflowEngine
 * @product Durable Objects
 */
export const layerWorkflowEngine = <PoolReq>(
  options: WorkflowEngineOptions<PoolReq>,
): Layer.Layer<WorkflowEngine.WorkflowEngine, never, PoolReq | Providers> =>
  // oxlint-disable-next-line effecttsgo/unsafe-effect-type-assertion -- the class is declared dynamically; its requirements are the pool's and the providers'
  Layer.unwrap(
    Effect.gen(function* () {
      const workflows = new Map<string, ExecutionBuild>();
      const Executions = (DurableObject as any)()(
        options.name,
        { main: options.main, handler: options.handler ?? "default" },
        hostClassPhase(options.name, workflows).pipe(Effect.provide(options.pool)),
      );
      const node = yield* Effect.serviceOption(NodeHost);
      if (Option.isSome(node)) {
        // A node of the pool: host the class, as the bootstrap hosts an
        // exported one, with the workflows registered here.
        const context = yield* Layer.build(entrypointLayer(Executions[PlatformDeclaration]));
        const hosted = (
          Context.get(context, entrypointTag).RuntimeContext as DurableObjectRuntimeContext
        ).hosted();
        if (hosted !== undefined) yield* node.value.host(hosted);
        // A run reaches other executions (its children, its parent) through
        // the control plane: they may run on another node.
        const self = makeNamespace(
          options.name,
          yield* Config.all({
            endpoint: Config.String("RIVET_ENDPOINT").pipe(Config.withDefault("")),
            token: Config.String("RIVET_TOKEN").pipe(Config.withDefault("")),
            namespace: Config.String("RIVET_NAMESPACE").pipe(Config.withDefault("")),
            pool: Config.String("RIVET_POOL").pipe(Config.withDefault("")),
          }).pipe(Effect.orDie),
        );
        return engineOver(self, (workflow, build) => workflows.set(workflow, build));
      }
      // A caller: deploy the class, and reach executions through the gateway.
      return engineOver((yield* Executions) as DurableObjectNamespace<any>, () => undefined);
    }),
  ) as Layer.Layer<WorkflowEngine.WorkflowEngine, never, PoolReq | Providers>;
