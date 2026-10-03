import * as postgresqlhsc from "@distilled.cloud/azure/postgresqlhsc";
import * as crypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { tagRecord } from "../../Tags.ts";
import { orUndefinedIfNotFound, stackAndStage } from "../Arm.ts";

/** Resource provider namespace of Azure Cosmos DB for PostgreSQL. */
export const COSMOS_POSTGRES_NAMESPACE = "Microsoft.DBforPostgreSQL";

/** Address of a cluster. */
export interface ClusterRef {
  readonly subscriptionId: string;
  readonly resourceGroupName: string;
  readonly clusterName: string;
}

/**
 * Only the cluster's own address. Child refs carry extra keys that distilled
 * would otherwise serialize as a request body, which `fetch` rejects on GET.
 */
export const clusterOnly = (ref: ClusterRef): ClusterRef => ({
  subscriptionId: ref.subscriptionId,
  resourceGroupName: ref.resourceGroupName,
  clusterName: ref.clusterName,
});

export const getCluster = (ref: ClusterRef) =>
  orUndefinedIfNotFound(postgresqlhsc.GetCluster(clusterOnly(ref)));

/**
 * Child resources (roles, firewall rules, configurations) carry no tags or
 * free-form fields, so ownership is inferred from the parent cluster.
 */
export const clusterOwnedByStack = (ref: ClusterRef) =>
  Effect.gen(function* () {
    const cluster = yield* getCluster(ref);
    if (cluster === undefined) return false;
    const tags = tagRecord(cluster.tags);
    const { stack, stage } = yield* stackAndStage;
    return tags["alchemy::stack"] === stack && tags["alchemy::stage"] === stage;
  });

/**
 * Cluster-level operations are serialized: while one runs (scaling, a
 * child's create/delete), further operations fail with a conflict. Retry
 * them, bounded.
 */
export const whileClusterBusy = {
  while: (e: { readonly _tag: string }) => e._tag === "ResourceConflict",
  schedule: Schedule.spaced("15 seconds"),
  times: 40,
} as const;

/** Random password satisfying Azure's complexity rules (all four classes). */
export const generatePassword = Effect.sync(() =>
  Redacted.make(
    `Aa1-${Buffer.from(crypto.randomBytes(24)).toString("base64url")}`,
  ),
);

export const reveal = (
  value: Redacted.Redacted<string> | string | undefined,
): string | undefined =>
  value === undefined
    ? undefined
    : Redacted.isRedacted(value)
      ? Redacted.value(value)
      : value;

export const sameText = (a: string | undefined, b: string | undefined) =>
  a?.toLowerCase() === b?.toLowerCase();
