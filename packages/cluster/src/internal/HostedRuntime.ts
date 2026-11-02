/**
 * The runtime context of something runners host (an entity, a workflow):
 * while deploying, its runners Layer registers how to deploy it, and it is
 * deployed once its Construction phase has run; on a runner, the built
 * class is kept for the runner to run.
 *
 * @internal
 */
import { createHostRuntimeContext, type HostRuntimeContext } from "alchemy/Runtime/Process";
import { Self } from "alchemy/Self";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { RunnersHost } from "./RunnersHostService.ts";

/** Declares the runners resources for one hosted class, given its collected env. */
export type DeployToRunners = (env: Record<string, unknown>) => Effect.Effect<void, never, any>;

export interface HostedRuntimeContext<Hosted> extends HostRuntimeContext {
  readonly Type: string;
  readonly alwaysServe: true;
  /**
   * Called by a runners Layer while the Construction phase runs: `deploy`
   * declares the runners that host this class, once its env is collected.
   */
  readonly registerRunners: (deploy: DeployToRunners) => Effect.Effect<void>;
  /**
   * Called by a runners Layer with the services it was built with: those
   * provided to it, like an entity's RPC middleware, stay with the class
   * after the Construction phase that provided them ends.
   */
  readonly provideServices: (services: Context.Context<never>) => Effect.Effect<void>;
  /** At runtime, the built class, once its Construction phase has run. */
  readonly hosted: () => Hosted | undefined;
}

/** A hosted class as its runners see it: the resource, with its runtime context. */
export interface HostedClass {
  readonly Type: string;
  readonly LogicalId: string;
  readonly Props: { readonly main: string };
  readonly registerRunners: (deploy: DeployToRunners) => Effect.Effect<void>;
  readonly provideServices: (services: Context.Context<never>) => Effect.Effect<void>;
  readonly bind: any;
}

/** The class was deployed without a runners Layer, so nothing would host it. */
export class HasNoRunners extends Data.TaggedError("Cluster.HasNoRunners")<{
  readonly message: string;
}> {}

/**
 * `build` turns what the Construction phase returned, the services it ran
 * with and the class's props into what the runner runs. `check`, while
 * deploying, fails the deploy when those services can't run it.
 */
export const makeHostedRuntimeContext =
  <Hosted>(
    typeId: string,
    build: (id: string, returned: unknown, context: Context.Context<never>, props: any) => Hosted,
    check?: (id: string, context: Context.Context<never>, props: any) => Effect.Effect<void>,
  ) =>
  (id: string): HostedRuntimeContext<Hosted> => {
    const base = createHostRuntimeContext(typeId)(id);
    let deploy: DeployToRunners | undefined;
    let hosted: Hosted | undefined;
    let services = Context.empty() as Context.Context<never>;

    const ctx: HostedRuntimeContext<Hosted> = {
      ...base,
      Type: typeId,
      // The Construction phase returns what the runner runs rather than a
      // handler shape: always hand it to `serve`.
      alwaysServe: true,
      registerRunners: (next) =>
        Effect.sync(() => {
          deploy = next;
        }),
      provideServices: (next) =>
        Effect.sync(() => {
          services = Context.merge(services, next);
        }),
      hosted: () => hosted,
      serve: (_handler, options) =>
        Effect.gen(function* () {
          // Runners provided to the class's Layer rather than its
          // implementation: ask them to host it now.
          const host = Option.getOrUndefined(yield* Effect.serviceOption(RunnersHost));
          const self = Option.getOrUndefined(yield* Effect.serviceOption(Self));
          if (deploy === undefined && host !== undefined && self !== undefined) {
            yield* host.host(self as unknown as HostedClass);
          }
          const context = Context.merge(services, yield* Effect.context<never>());
          // The props are on the resource, which `Self` is.
          const props = (self as { Props?: unknown } | undefined)?.Props;
          if (globalThis.__ALCHEMY_RUNTIME__) {
            hosted = build(id, options?.shape, context, props);
            return;
          }
          if (deploy === undefined) {
            return yield* Effect.die(
              new HasNoRunners({
                message:
                  `${typeId} '${id}' has no runners. Provide a runners Layer to its implementation, ` +
                  `for example ClusterDocker.Runners("Default").`,
              }),
            );
          }
          if (check !== undefined) {
            yield* check(id, context, props);
          }
          // The Construction phase has run, so every Config value it read is in `env`.
          yield* deploy(base.env);
        }),
    };
    return ctx;
  };
