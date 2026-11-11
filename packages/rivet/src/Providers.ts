import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import { ProfileStoreLive } from "alchemy/Auth/Profile";
import * as Provider from "alchemy/Provider";
import { Random, RandomProvider } from "alchemy/Random";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import { RivetCloudAuth } from "./Cloud/AuthProvider.ts";
import {
  Cluster as RivetCloudCluster,
  ClusterProvider as RivetCloudClusterProvider,
} from "./Cloud/Cluster.ts";
import { CredentialsLive as RivetCloudCredentials } from "./Cloud/CredentialsLive.ts";
import {
  RunnerPool as RivetCloudRunnerPool,
  RunnerPoolProvider as RivetCloudRunnerPoolProvider,
} from "./Cloud/RunnerPool.ts";
import { DurableObjectProvider, DurableObjectResource } from "./DurableObject.ts";
import { Namespace, NamespaceProvider } from "./Namespace.ts";
import { Pool, PoolProvider } from "./Pool.ts";

/** Service tag bundling every Rivet provider. */
export class Providers extends Provider.ProviderCollection<Providers>()("Rivet") {}

export type ProviderRequirements = Layer.Services<ReturnType<typeof providers>>;

/**
 * The Rivet providers Layer. Each resource carries the endpoint and admin
 * token of the control plane it belongs to. It also registers Rivet Cloud
 * sign-in, which only `RivetCloud.ControlPlane` uses.
 *
 * @example
 * ```ts
 * Alchemy.Stack("App", { providers: Layer.mergeAll(AWS.providers(), Rivet.providers()) }, ...)
 * ```
 */
export const providers = () =>
  Layer.effect(
    Providers,
    Provider.collection([
      DurableObjectResource,
      Namespace,
      Pool,
      Random,
      RivetCloudCluster,
      RivetCloudRunnerPool,
    ]),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        DurableObjectProvider(),
        NamespaceProvider(),
        PoolProvider(),
        RandomProvider(),
        RivetCloudClusterProvider(),
        RivetCloudRunnerPoolProvider(),
      ),
    ),
    Layer.provide(FetchHttpClient.layer),
    // Rivet Cloud sign-in, resolved only when a RivetCloud.ControlPlane deploys.
    Layer.provideMerge(RivetCloudCredentials),
    Layer.provideMerge(RivetCloudAuth),
    Layer.provideMerge(ProfileStoreLive),
    Layer.provideMerge(CredentialsStoreLive),
    Layer.orDie,
  );
