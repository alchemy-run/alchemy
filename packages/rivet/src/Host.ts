import type { Input } from "alchemy/Input";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

/**
 * What a host needs to run one `Rivet.Worker`: the bundle to build, and the
 * environment the Worker's bindings collected.
 */
export interface WorkerDeployment {
  /** The Worker's logical id. Hosts derive their resource ids from it. */
  readonly id: string;
  /** The module that exports the Worker, usually its `import.meta.url`. */
  readonly main: string;
  /** The export of {@link main} that holds the Worker. */
  readonly handler: string;
  /** Environment values the Worker's bindings registered. */
  readonly env: Record<string, unknown>;
}

/** What a host reports back about a deployed Worker. */
export interface HostedWorker {
  /** Where the Worker serves HTTP, if it is reachable. */
  readonly url?: Input<string> | undefined;
}

/** Declare the resources that run a Worker's nodes. @internal */
export type DeployWorker = (
  deployment: WorkerDeployment,
) => Effect.Effect<HostedWorker, never, any>;

/**
 * Where a `Rivet.Worker` runs. Provided to the Worker's Effect by a host
 * Layer — `RivetDocker.Service()`, `RivetAWS.EcsService()`, … — which
 * declares the cloud resources for the Worker's nodes when it deploys.
 */
export class Host extends Context.Service<Host, { readonly kind: string }>()("Rivet.Host") {}
