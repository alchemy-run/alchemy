import * as ske from "@distilled.cloud/stackit/ske";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { StackitEnvironment } from "../Environment.ts";
import { hasUnresolvedTrigger } from "../internal/diff.ts";
import type { Providers } from "../Providers.ts";
import {
  getClusterOrUndefined,
  isCredentialExpiring,
  isCredentialRevoked,
  mintedAtOf,
} from "./internal.ts";

/** The API's default kubeconfig lifetime, in seconds. */
const DEFAULT_EXPIRATION_SECONDS = 3600;

/** The API answered `CreateKubeconfig` without the kubeconfig or its expiry. */
export class KubeconfigNotReturned extends Data.TaggedError("Stackit.SKE.KubeconfigNotReturned")<{
  readonly clusterName: string;
  readonly message: string;
}> {}

export interface KubeconfigProps {
  /** Name of the cluster, e.g. a `Stackit.SKE.Cluster`'s `clusterName`. Changing it replaces the kubeconfig. */
  clusterName: string;
  /**
   * How long each minted kubeconfig stays valid, in seconds, from 600 (10
   * minutes) to 15552000 (6 months). Changing it replaces the kubeconfig. It can't
   * be revoked once minted, so keep it short.
   * @default 3600
   */
  expirationSeconds?: number;
  /**
   * Re-mint on a deploy this many seconds before expiry, so a deploy never leaves
   * a kubeconfig that's about to lapse. Updates in place.
   * @default a tenth of `expirationSeconds`
   */
  refreshBeforeSeconds?: number;
  /** Project of the cluster. Defaults to the profile's. Changing it replaces the kubeconfig. */
  projectId?: string;
  /** Region of the cluster. Defaults to the profile's. Changing it replaces the kubeconfig. */
  region?: string;
}

export interface KubeconfigAttributes {
  /** Name of the cluster. */
  clusterName: string;
  /** Project of the cluster. */
  projectId: string;
  /** Region of the cluster. */
  region: string;
  /** The admin kubeconfig, as YAML. Grants full control of the cluster. */
  kubeconfig: Redacted.Redacted<string>;
  /** When this kubeconfig stops working, as an RFC 3339 timestamp. */
  expirationTimestamp: string;
  /** When this kubeconfig was minted, by the API's clock. */
  mintedAt: string;
  /** The lifetime it was minted with, in seconds. */
  expirationSeconds: number;
}

export type Kubeconfig = Resource<
  "Stackit.SKE.Kubeconfig",
  KubeconfigProps,
  KubeconfigAttributes,
  never,
  Providers
>;

/**
 * A short-lived admin kubeconfig for a STACKIT Kubernetes Engine cluster, for
 * tools that need a kubeconfig file. To deploy `Kubernetes.*` workloads you don't
 * need one: pass the `Stackit.SKE.Cluster` itself as `cluster`, and Alchemy mints
 * a credential per connection that is never persisted.
 *
 * ### How Expiry Works <!-- api-prose -->
 * The API has no way to read a kubeconfig back, list it or revoke it. So this
 * resource holds the one it minted, and replaces it when it stops being useful.
 * Every plan checks three things, and a deploy mints a new kubeconfig when any
 * of them holds:
 *
 * - it is within `refreshBeforeSeconds` of `expirationTimestamp`, or past it;
 * - the cluster was recreated after it was minted;
 * - a credentials rotation completed after it was minted.
 *
 * Between deploys nothing renews it. Its consumers must redeploy before
 * `expirationTimestamp`, so set `expirationSeconds` longer than the gap between
 * your deploys. For a process that runs on its own schedule, mint at runtime with
 * `Stackit.SKE.CreateKubeconfig` instead.
 *
 * Destroying this resource doesn't revoke the kubeconfig: it stays valid until it
 * expires, unless a `Stackit.SKE.CompleteCredentialsRotation` invalidates it
 * first. That is the only revocation STACKIT offers, and it invalidates every
 * kubeconfig of the cluster.
 *
 * ### Creating a Kubeconfig
 * **Example:** A kubeconfig valid for a week, renewed in its last day
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const cluster = yield* Stackit.SKE.Cluster("Cluster", {
 *   nodepools: [
 *     {
 *       name: "workers",
 *       machineType: "c1.2",
 *       availabilityZones: ["eu01-1"],
 *       minimum: 1,
 *       maximum: 3,
 *     },
 *   ],
 * });
 * const access = yield* Stackit.SKE.Kubeconfig("Access", {
 *   clusterName: cluster.clusterName,
 *   expirationSeconds: 7 * 24 * 3600,
 *   refreshBeforeSeconds: 24 * 3600,
 * });
 * ```
 *
 * ### Using the Kubeconfig
 * **Example:** Hand it to another system as a secret
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const cluster = yield* Stackit.SKE.Cluster.ref("Cluster");
 * const access = yield* Stackit.SKE.Kubeconfig("Access", {
 *   clusterName: cluster.clusterName,
 *   expirationSeconds: 30 * 24 * 3600,
 * });
 * // Stays `Redacted`; a redeploy updates the Worker whenever it is re-minted.
 * yield* Cloudflare.Worker("Operator", {
 *   main: "./src/operator.ts",
 *   env: { KUBECONFIG_YAML: access.kubeconfig },
 * });
 * ```
 *
 * @resource
 * @product STACKIT Kubernetes Engine
 * @category SKE
 */
export const Kubeconfig = Resource<Kubeconfig>("Stackit.SKE.Kubeconfig");

const refreshWindowOf = (props: Pick<KubeconfigProps, "refreshBeforeSeconds">, ttl: number) =>
  props.refreshBeforeSeconds ?? ttl / 10;

/**
 * Why a held kubeconfig can't be kept: it is expiring, or the cluster no longer
 * accepts it. `undefined` when it is still good. Only a cluster that exists can
 * say what it accepts, so a missing one is a reason too.
 */
const staleReason = Effect.fn(function* (
  output: KubeconfigAttributes,
  refreshBeforeSeconds: number,
) {
  const now = yield* Clock.currentTimeMillis;
  if (
    isCredentialExpiring({
      expirationTimestamp: output.expirationTimestamp,
      refreshBeforeSeconds,
      now,
    })
  ) {
    return "expiring" as const;
  }
  const cluster = yield* getClusterOrUndefined(output.projectId, output.region, output.clusterName);
  if (cluster === undefined) return "cluster-missing" as const;
  return isCredentialRevoked(output.mintedAt, cluster) ? ("revoked" as const) : undefined;
});

export const KubeconfigProvider = () =>
  Provider.succeed(Kubeconfig, {
    stables: ["clusterName", "projectId", "region"],
    // No `list`: the API can't enumerate kubeconfigs, and they expire by themselves.

    // The engine only calls `read` to recover or adopt, so expiry is decided here:
    // this is what every plan runs.
    diff: Effect.fn(function* ({ news, output }) {
      if (output === undefined) return undefined;
      // Nothing physical is at stake, so a replacement just mints a new one.
      if (
        hasUnresolvedTrigger<KubeconfigProps>(news, [
          "clusterName",
          "expirationSeconds",
          "projectId",
          "region",
        ])
      ) {
        return { action: "replace" } as const;
      }
      if (!isResolved(news)) return undefined;
      const env = yield* StackitEnvironment.current;
      if (
        news.clusterName !== output.clusterName ||
        (news.projectId ?? env.projectId) !== output.projectId ||
        (news.region ?? env.region) !== output.region ||
        (news.expirationSeconds ?? DEFAULT_EXPIRATION_SECONDS) !== output.expirationSeconds
      ) {
        return { action: "replace" } as const;
      }
      const stale = yield* staleReason(output, refreshWindowOf(news, output.expirationSeconds));
      return stale === undefined ? undefined : ({ action: "update" } as const);
    }),

    read: Effect.fn(function* ({ output }) {
      // The API can't find a kubeconfig, so there's nothing to recover or adopt.
      if (output === undefined) return undefined;
      const stale = yield* staleReason(output, 0);
      return stale === undefined ? output : undefined;
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const env = yield* StackitEnvironment.current;
      const projectId = news.projectId ?? output?.projectId ?? env.projectId;
      const region = news.region ?? output?.region ?? env.region;
      const clusterName = news.clusterName;
      const expirationSeconds = news.expirationSeconds ?? DEFAULT_EXPIRATION_SECONDS;

      // Observe: the held kubeconfig, while it is for this cluster and still good.
      if (
        output !== undefined &&
        output.clusterName === clusterName &&
        output.projectId === projectId &&
        output.region === region &&
        output.expirationSeconds === expirationSeconds &&
        (yield* staleReason(output, refreshWindowOf(news, expirationSeconds))) === undefined
      ) {
        return output;
      }

      // Ensure: mint a new one. A missing cluster fails with the typed `NotFound`.
      const minted = yield* ske.createKubeconfig({
        projectId,
        region,
        clusterName,
        // `int64` is a string on the wire.
        expirationSeconds: String(expirationSeconds),
      });
      if (minted.kubeconfig === undefined || minted.expirationTimestamp === undefined) {
        return yield* new KubeconfigNotReturned({
          clusterName,
          message: `STACKIT returned no kubeconfig for SKE cluster ${clusterName}`,
        });
      }
      return {
        clusterName,
        projectId,
        region,
        kubeconfig:
          typeof minted.kubeconfig === "string"
            ? Redacted.make(minted.kubeconfig)
            : minted.kubeconfig,
        expirationTimestamp: minted.expirationTimestamp,
        mintedAt: mintedAtOf(minted.expirationTimestamp, expirationSeconds),
        expirationSeconds,
      };
    }),

    // The API has no revoke: a kubeconfig stays valid until it expires or a
    // credentials rotation completes. Deleting only forgets it.
    delete: () => Effect.void,
  });
