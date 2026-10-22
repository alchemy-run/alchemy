import * as mongocluster from "@distilled.cloud/azure/mongocluster";
import * as Schedule from "effect/Schedule";
import { orUndefinedIfNotFound } from "../Arm.ts";

/**
 * A mongo cluster serializes control-plane operations: a cluster PATCH or a
 * child (firewall rule, user) PUT/DELETE that races another operation on
 * the same cluster fails with `Conflict`. Those are retried for a bounded
 * time.
 */
export const whileMongoClusterBusy = {
  while: (e: { readonly _tag: string }) => e._tag === "ResourceConflict",
  schedule: Schedule.spaced("10 seconds"),
  times: 30,
} as const;

export interface MongoClusterRef {
  readonly subscriptionId: string;
  readonly resourceGroupName: string;
  readonly mongoClusterName: string;
}

export const getMongoCluster = (ref: MongoClusterRef) =>
  orUndefinedIfNotFound(mongocluster.GetMongoCluster(ref));

/** ARM reports locations by display name (`East US`) in some responses. */
export const normalizeMongoLocation = (value: string | undefined) =>
  (value ?? "").replace(/\s+/g, "").toLowerCase();
