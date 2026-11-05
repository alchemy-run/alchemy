import * as docdb from "@distilled.cloud/aws/docdb";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeDocDBAccountHttpBinding } from "./BindingHttp.ts";

/**
 * Runtime binding for the `DescribeEvents` operation (IAM action
 * `rds:DescribeEvents`).
 *
 * Returns events related to DocumentDB clusters, instances, snapshots, and
 * parameter groups from the last 24 hours (up to 14 days with an explicit
 * time window) — failovers, maintenance, configuration changes. Provide the
 * implementation with `Effect.provide(AWS.DocDB.DescribeEventsHttp)`.
 * ### Monitoring Clusters
 * **Example:** Read a Cluster's Recent Events
 * ```typescript
 * const describeEvents = yield* AWS.DocDB.DescribeEvents();
 *
 * const page = yield* describeEvents({
 *   SourceIdentifier: clusterId,
 *   SourceType: "db-cluster",
 * });
 * for (const event of page.Events ?? []) {
 *   yield* Effect.logInfo(`${event.Date}: ${event.Message}`);
 * }
 * ```
 *
 * @binding
 */
export interface DescribeEvents extends Binding.Service<
  DescribeEvents,
  "AWS.DocDB.DescribeEvents",
  () => Effect.Effect<
    (
      request?: docdb.DescribeEventsMessage,
    ) => Effect.Effect<docdb.EventsMessage, docdb.DescribeEventsError>
  >
> {}
export const DescribeEvents = Binding.Service<DescribeEvents>("AWS.DocDB.DescribeEvents");

export const DescribeEventsHttp = Layer.effect(
  DescribeEvents,
  makeDocDBAccountHttpBinding({
    tag: "AWS.DocDB.DescribeEvents",
    operation: docdb.describeEvents,
    actions: ["rds:DescribeEvents"],
  }),
);
