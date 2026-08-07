/**
 * A **Rivet cluster**: the infrastructure a {@link Worker} runs against —
 * the [Rivet Engine](https://rivet.dev) (the actor orchestrator), NOT the
 * user's code. Runners (the processes executing `Alchemy.DurableObject`
 * actors) connect OUT to the engine; deploying a `Rivet.Worker` composes a
 * runner deployment against this cluster.
 *
 * The cluster is host-agnostic: WHERE the engine runs is owned by a
 * pluggable {@link ClusterHost} contributed by a cloud provider layer —
 * `AWS.providers()` registers the `aws-ecs` host. The cluster carries no
 * code; deploy a {@link Worker} onto it.
 *
 * @section Creating a Cluster
 * @example
 * ```typescript
 * export class Actors extends Rivet.Cluster<Actors>()("Actors") {}
 * ```
 */
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import type { InputProps } from "../Input.ts";
import type { Named, Tag } from "../Named.ts";
import { Platform, type PlatformProps } from "../Platform.ts";
import * as Provider from "../Provider.ts";
import { Resource, isResourceOfType } from "../Resource.ts";
import type { BaseRuntimeContext } from "../RuntimeContext.ts";
import { resolveClusterHost, type ClusterHostProps } from "./ClusterHost.ts";
import type { Providers } from "./Providers.ts";

export const ClusterTypeId = "Rivet.Cluster";
export type ClusterTypeId = typeof ClusterTypeId;

export interface ClusterProps extends PlatformProps {
  /**
   * Which registered {@link ClusterHost} runs the engine, plus its
   * host-specific options. When omitted, the sole registered host is used.
   */
  host?: ClusterHostProps;
  /**
   * Number of engine nodes. Only meaningful with a multi-node storage
   * backend — the built-in RocksDB backend is single-node.
   * @default 1
   */
  instances?: number;
  /**
   * The Rivet Engine release the default image is pinned to.
   * @default DEFAULT_RIVET_VERSION
   */
  rivetVersion?: string;
  /**
   * Full engine image override (escape hatch past {@link rivetVersion}).
   * @default `rivetdev/engine:${rivetVersion}`
   */
  image?: string;
  /** Tags applied to host-composed cloud resources. */
  tags?: Record<string, string>;
  /** Written by the cluster host's `compose` — never set manually. @internal */
  hostKind?: string;
  /** Written by the cluster host's `compose` — never set manually. @internal */
  endpoint?: string;
  /** Written by the cluster host's `compose` — never set manually. @internal */
  adminToken?: Redacted.Redacted<string>;
  /** Written by the cluster host's `compose` — never set manually. @internal */
  hostState?: Record<string, any>;
}

export interface Cluster extends Resource<
  ClusterTypeId,
  ClusterProps,
  {
    /** The HTTP endpoint callers reach the engine's guard service on. */
    endpoint: string;
    /** The engine's admin token (auths gateway calls and runners). */
    adminToken: Redacted.Redacted<string>;
    /** The {@link ClusterHost} kind running the engine. */
    hostKind: string;
    /** Host-specific state (compute identifiers, network attachment). */
    hostState: Record<string, any> | undefined;
  },
  {},
  Providers
> {}

export const isCluster = <T>(value: T): value is T & Cluster =>
  isResourceOfType(value, ClusterTypeId);

/**
 * Compose the cluster's platform-specific children (network, engine
 * compute, discovery, admin token) through the registered
 * {@link ClusterHost} and rewrite the props with the connection material.
 * A no-op at runtime.
 */
const transformClusterProps = (
  id: string,
  props: ClusterProps,
): Effect.Effect<ClusterProps, unknown, any> =>
  Effect.gen(function* () {
    // Composition is a plan/deploy concern — never runs inside bundles.
    if (globalThis.__ALCHEMY_RUNTIME__) {
      return props;
    }
    const { kind, host } = yield* resolveClusterHost(props.host?.kind);
    const composed = yield* host.compose({ id, props });
    return {
      ...props,
      hostKind: kind,
      endpoint: composed.endpoint,
      adminToken: composed.adminToken,
      hostState: composed.hostState,
    } as ClusterProps;
  });

/** A cluster carries no code — there is nothing to serve at init. */
const makeClusterContext = (id: string): BaseRuntimeContext => ({
  Type: ClusterTypeId,
  id,
  env: {},
  get: () => Effect.succeed(undefined),
  set: (key) => Effect.succeed(key),
});

/**
 * A cluster takes no impl (it carries no code), so its class surface adds
 * the tag + props forms the generic `Platform` type lacks.
 */
export type ClusterClass = {
  <Self>(): {
    <const Id extends string>(
      id: Id,
      props?: InputProps<ClusterProps>,
    ): Effect.Effect<Cluster, never, Providers> &
      Named<Id> & {
        new (_: never): Named<Id> & Tag<ClusterTypeId>;
      };
  };
  (
    id: string,
    props?: InputProps<ClusterProps>,
  ): Effect.Effect<Cluster, never, Providers>;
} & Platform<Cluster, never, void, BaseRuntimeContext>;

export const Cluster: ClusterClass = Platform(ClusterTypeId, {
  createRuntimeContext: makeClusterContext,
  transformProps: transformClusterProps,
}) as ClusterClass;

export const ClusterProvider = () =>
  Provider.succeed(Cluster, {
    stables: ["hostKind"],

    read: ({ output }) => Effect.succeed(output),

    // The cluster's physical substance lives in the host-composed children —
    // this resource just persists the connection material they produced.
    reconcile: ({ id, news }) =>
      Effect.gen(function* () {
        if (
          news.endpoint === undefined ||
          news.adminToken === undefined ||
          news.hostKind === undefined
        ) {
          return yield* Effect.die(
            new Error(
              `Rivet.Cluster '${id}' has no composed host state — is a cluster host registered in the stack's providers?`,
            ),
          );
        }
        return {
          endpoint: news.endpoint,
          adminToken: news.adminToken,
          hostKind: news.hostKind,
          hostState: news.hostState,
        };
      }),

    delete: () => Effect.void,
  });
