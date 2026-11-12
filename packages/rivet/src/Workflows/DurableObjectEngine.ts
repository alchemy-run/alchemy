/**
 * Effect `WorkflowEngine` on Rivet Durable Objects. Each workflow is a class
 * name on one host Durable Object; each execution is the instance
 * `<WorkflowClass>/<executionId>`, with its journal in that instance's
 * SQLite. Wake-ups are durable callbacks over the instance's alarm.
 *
 * @module
 */
import { entrypointLayer, entrypointTag } from "alchemy/Runtime/Bootstrap";
import { RuntimeContext } from "alchemy/RuntimeContext";
import { makeDurableObjectEngine, type ObjectImpl } from "alchemy/Workers/DurableObjectEngine";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import type { WorkflowEngine } from "effect/workflow";
import { alarmCallbacks } from "../AlarmCallback.ts";
import {
  DurableObject,
  type DurableObjectNamespace,
  type DurableObjectRuntimeContext,
  makeNamespace,
  PlatformDeclaration,
} from "../DurableObject.ts";
import { DurableObjectState } from "../DurableObjectState.ts";
import { NodeHost, type PoolHost } from "../Host.ts";
import type { Providers } from "../Providers.ts";

/** The SQL storage the workflow engine journals each run in. */
interface EngineStateShape {
  readonly storage: {
    readonly sql: {
      exec<T extends Record<string, unknown>>(
        query: string,
        ...bindings: ReadonlyArray<unknown>
      ): Effect.Effect<{ toArray(): Effect.Effect<T[]> }>;
    };
    readonly transaction: DurableObjectState["Service"]["storage"]["transaction"];
  };
}

/** A run's instance state, as the workflow engine reads it. */
class EngineState extends Context.Service<EngineState, EngineStateShape>()(
  "Rivet/Workflows/EngineState",
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

/** Built for one instance: an execution's methods. */
type InstanceBuild = Effect.Effect<
  Record<string, unknown>,
  never,
  EngineState | RuntimeContext | Scope.Scope
>;

/** What a Workflow host class's instance returns. */
export interface WorkflowShape {
  readonly alarm: () => Effect.Effect<void>;
  readonly [method: string]: unknown;
}

/** A Workflow host class was asked for an object of a class it doesn't host. */
export class WorkflowClassNotHosted extends Data.TaggedError("Rivet.WorkflowClassNotHosted")<{
  readonly message: string;
}> {}

/** Split `<class>/<key>` back into its class and key. */
const parseMultiplexedName = (name: string) => {
  const slash = name.indexOf("/");
  return slash < 0 ? undefined : { className: name.slice(0, slash), key: name.slice(slash + 1) };
};

/**
 * The class phase of the class that hosts workflows: each instance builds
 * the execution its name says (`SendWelcomeWorkflow/exec-1`) from the
 * classes the engine declared on this node.
 */
const hostClassPhase = (name: string, classes: ReadonlyMap<string, InstanceBuild>) =>
  Effect.gen(function* () {
    return Effect.gen(function* () {
      const state = yield* DurableObjectState;
      const parsed = parseMultiplexedName(state.id.name);
      const build = parsed === undefined ? undefined : classes.get(parsed.className);
      if (build === undefined) {
        return yield* Effect.die(
          new WorkflowClassNotHosted({
            message: `Rivet.DurableObject '${name}' hosts no Workflow class for '${state.id.name}'.`,
          }),
        );
      }
      const callbacks = alarmCallbacks(state.storage, {
        set: (at) => state.storage.setAlarm(at),
        get: state.storage.getAlarm(),
      });
      const runtime = yield* RuntimeContext;
      const record = yield* build.pipe(
        Effect.provideService(EngineState, engineState(state)),
        Effect.provideService(RuntimeContext, { ...runtime, makeCallback: callbacks.makeCallback }),
      );
      return { ...record, alarm: () => callbacks.fire } satisfies WorkflowShape;
    });
  });

/**
 * Every workflow class on one Rivet Durable Object: the execution
 * `SendWelcomeWorkflow` named `e-1` is the instance
 * `SendWelcomeWorkflow/e-1`.
 */
const multiplexed = (
  name: string,
  namespace: DurableObjectNamespace<any>,
  onDeclare: (className: string, build: InstanceBuild) => void,
) => {
  const remote = (cls: string) => ({
    getByName: (key: string) => namespace.getByName(`${cls}/${key}`),
  });
  return makeDurableObjectEngine({
    declare: (cls, impl: ObjectImpl<EngineState>) =>
      Effect.sync(() => {
        onDeclare(cls, Effect.flatten(impl) as InstanceBuild);
        return remote(cls) as never;
      }),
    // EngineState matches the SQL + transaction surface the shared engine needs.
    state: EngineState as never,
  });
};

/** Options for {@link layerDurableObjectEngine}. */
export interface DurableObjectEngineOptions<PoolReq> {
  /**
   * The Rivet Durable Object class that hosts every workflow execution.
   * @default "Workflows"
   */
  readonly name?: string;
  /**
   * The module that exports the workflows Layer (the one this engine is
   * provided to), usually `import.meta.url`. The pool's nodes load it to run
   * executions.
   */
  readonly main: string;
  /**
   * The export of {@link main} that holds the workflows Layer.
   * @default "default"
   */
  readonly handler?: string;
  /** The pool whose nodes run the workflows, e.g. `RivetDocker.SwarmPool("Default")`. */
  readonly pool: Layer.Layer<PoolHost, never, PoolReq>;
}

/**
 * Runs Effect workflows on Rivet Durable Objects. Provide it next to your
 * workflow Layers, as `Cloudflare.Workflows.layerDurableObjectEngine()` would
 * be on Cloudflare. Each workflow gets a class name on one host Durable
 * Object (`name`); each execution is one instance, named
 * `<WorkflowClass>/<executionId>`, with its journal in that instance's
 * SQLite. Wake-ups are the instance's alarm via durable callbacks.
 *
 * ### Running workflows on Rivet
 * **Example:** Provide the engine to a Worker
 * ```typescript
 * import * as Rivet from "@alchemy.run/rivet";
 * import * as RivetDocker from "@alchemy.run/rivet/Docker";
 * import * as Workflows from "alchemy/Workflows";
 * import * as Effect from "effect/Effect";
 * import * as Layer from "effect/Layer";
 * import { Activity, Workflow } from "effect/workflow";
 * import * as Schema from "effect/Schema";
 *
 * const SendWelcome = Workflow.make("SendWelcome", {
 *   payload: { userId: Schema.String },
 *   idempotencyKey: ({ userId }) => userId,
 * });
 *
 * const SendWelcomeLive = Workflows.layer(
 *   SendWelcome,
 *   Effect.fn(function* ({ userId }) {
 *     yield* Activity.make({ name: "send", execute: Effect.log(`welcome, ${userId}`) });
 *   }),
 * );
 *
 * const ControlPlane = RivetDocker.SwarmControlPlane("Rivet");
 * const Default = RivetDocker.SwarmPool("Default").pipe(Layer.provide(ControlPlane));
 *
 * export const WorkflowsLive = SendWelcomeLive.pipe(
 *   Layer.provideMerge(
 *     Rivet.Workflows.layerDurableObjectEngine({
 *       main: import.meta.url,
 *       handler: "WorkflowsLive",
 *       pool: Default,
 *     }),
 *   ),
 * );
 * ```
 *
 * @layer
 * @provides WorkflowEngine
 */
export const layerDurableObjectEngine = <PoolReq>(
  options: DurableObjectEngineOptions<PoolReq>,
): Layer.Layer<WorkflowEngine.WorkflowEngine, never, PoolReq | Providers> => {
  const name = options.name ?? "Workflows";
  // oxlint-disable-next-line effecttsgo/unsafe-effect-type-assertion -- the class is declared dynamically; its requirements are the pool's and the providers'
  return Layer.unwrap(
    Effect.gen(function* () {
      const classes = new Map<string, InstanceBuild>();
      const Objects = (DurableObject as any)()(
        name,
        { main: options.main, handler: options.handler ?? "default" },
        hostClassPhase(name, classes).pipe(Effect.provide(options.pool)),
      );
      const node = yield* Effect.serviceOption(NodeHost);
      if (Option.isSome(node)) {
        const context = yield* Layer.build(entrypointLayer(Objects[PlatformDeclaration]));
        const hosted = (
          Context.get(context, entrypointTag).RuntimeContext as DurableObjectRuntimeContext
        ).hosted();
        if (hosted !== undefined) yield* node.value.host(hosted);
        const self = makeNamespace(
          name,
          yield* Config.all({
            endpoint: Config.String("RIVET_ENDPOINT").pipe(Config.withDefault("")),
            token: Config.String("RIVET_TOKEN").pipe(Config.withDefault("")),
            namespace: Config.String("RIVET_NAMESPACE").pipe(Config.withDefault("")),
            pool: Config.String("RIVET_POOL").pipe(Config.withDefault("")),
          }).pipe(Effect.orDie),
        );
        return multiplexed(name, self, (cls, build) => classes.set(cls, build));
      }
      const namespace = (yield* Objects) as DurableObjectNamespace<any>;
      return multiplexed(name, namespace, () => undefined);
    }),
  ) as Layer.Layer<WorkflowEngine.WorkflowEngine, never, PoolReq | Providers>;
};
