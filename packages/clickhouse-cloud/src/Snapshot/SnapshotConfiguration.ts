import * as snapshot from "@distilled.cloud/clickhouse-cloud/snapshot";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { organizationId as currentOrganizationId } from "../Credentials.ts";
import { requireResult } from "../Errors.ts";
import type { Providers } from "../Providers.ts";

export interface SnapshotConfigurationProps {
  /** ID of a primary service, e.g. a `ClickHouseCloud.Service.Service`'s `serviceId`. Changing it replaces the resource. */
  serviceId: string;
  /**
   * Whether scheduled snapshots run.
   * @default true
   */
  enabled?: boolean;
  /** Minutes between snapshots: 10, 20, 30 or 60. Omit to leave it alone. */
  gap?: 10 | 20 | 30 | 60;
  /**
   * Minutes of history the snapshots cover: a whole number of days (a
   * multiple of 1440), at least 1440, with `timeFrame / gap` at most 300.
   * Omit to leave it alone.
   */
  timeFrame?: number;
}

export interface SnapshotConfigurationAttributes {
  /** Service ID. */
  serviceId: string;
  /** Organization ID. */
  organizationId: string;
  /** Whether scheduled snapshots run. */
  enabled: boolean | undefined;
  /** Minutes between snapshots. */
  gap: number | undefined;
  /** Minutes of history kept. */
  timeFrame: number | undefined;
}

export type SnapshotConfiguration = Resource<
  "ClickHouseCloud.Snapshot.SnapshotConfiguration",
  SnapshotConfigurationProps,
  SnapshotConfigurationAttributes,
  never,
  Providers
>;

/**
 * Scheduled snapshots of a primary service: full copies taken every `gap`
 * minutes and kept for `timeFrame` minutes, for recovery points closer
 * together than backups. The endpoints are in beta and early access.
 *
 * Only declared settings change. Destroying the resource switches
 * snapshots off (`enabled: false`); the API has no reset. Needs an
 * organization eligible for snapshots (`Organization.snapshots`) and an
 * Admin key.
 * @see https://clickhouse.com/docs/cloud/manage/backups
 *
 * ### Scheduling Snapshots
 * **Example:** Hourly snapshots for a day
 * ```typescript
 * const analytics = yield* ClickHouseCloud.Service.Service("Analytics", {
 *   provider: "aws",
 *   region: "us-east-1",
 *   ipAccessList: [{ source: "0.0.0.0/0" }],
 * });
 * yield* ClickHouseCloud.Snapshot.SnapshotConfiguration("AnalyticsSnapshots", {
 *   serviceId: analytics.serviceId,
 *   gap: 60,
 *   timeFrame: 1440,
 * });
 * ```
 *
 * :::caution
 * Changing `serviceId` replaces the resource: the old service's snapshots
 * are switched off.
 * :::
 *
 * Uses ClickHouse Cloud API endpoints marked Beta: `getSnapshotConfiguration`, `updateSnapshotConfiguration`.
 *
 * @resource
 * @product Snapshot
 */
export const SnapshotConfiguration = Resource<SnapshotConfiguration>(
  "ClickHouseCloud.Snapshot.SnapshotConfiguration",
);

const toAttributes = (
  organizationId: string,
  serviceId: string,
  config: snapshot.SnapshotConfiguration,
): SnapshotConfigurationAttributes => ({
  serviceId,
  organizationId,
  enabled: config.enabled,
  gap: config.gap,
  timeFrame: config.timeFrame,
});

const getConfiguration = (organizationId: string, serviceId: string) =>
  snapshot.getSnapshotConfiguration({ organizationId, serviceId }).pipe(
    Effect.flatMap(requireResult("getSnapshotConfiguration")),
    Effect.catchTag("NotFound", () => Effect.undefined),
  );

export const SnapshotConfigurationProvider = () =>
  Provider.effect(
    SnapshotConfiguration,
    Effect.succeed({
      stables: ["serviceId", "organizationId"],
      nuke: { singleton: true, dependsOn: ["ClickHouseCloud.Service.Service"] },
      list: () => Effect.succeed([]),
      diff: Effect.fn(function* ({ news, olds }) {
        if (!isResolved(news) || olds === undefined) return undefined;
        if (news.serviceId !== olds.serviceId) return { action: "replace" } as const;
        return undefined;
      }),
      read: Effect.fn(function* ({ olds, output }) {
        const organizationId = output?.organizationId ?? (yield* currentOrganizationId);
        const serviceId = output?.serviceId ?? olds.serviceId;
        const config = yield* getConfiguration(organizationId, serviceId);
        return config === undefined ? undefined : toAttributes(organizationId, serviceId, config);
      }),
      reconcile: Effect.fn(function* ({ news, output }) {
        const organizationId = output?.organizationId ?? (yield* currentOrganizationId);
        const { serviceId } = news;
        // Observe
        const observed = yield* snapshot
          .getSnapshotConfiguration({ organizationId, serviceId })
          .pipe(Effect.flatMap(requireResult("getSnapshotConfiguration")));
        // Sync only declared settings that differ; null is not accepted.
        const want = { enabled: news.enabled ?? true, gap: news.gap, timeFrame: news.timeFrame };
        const patch = Object.fromEntries(
          (["enabled", "gap", "timeFrame"] as const).flatMap((key) =>
            want[key] !== undefined && want[key] !== observed[key] ? [[key, want[key]]] : [],
          ),
        ) as Partial<snapshot.SnapshotConfiguration>;
        if (Object.keys(patch).length === 0) {
          return toAttributes(organizationId, serviceId, observed);
        }
        const updated = yield* snapshot
          .updateSnapshotConfiguration({ organizationId, serviceId, ...patch })
          .pipe(Effect.flatMap(requireResult("updateSnapshotConfiguration")));
        return toAttributes(organizationId, serviceId, updated);
      }),
      delete: Effect.fn(function* ({ output }) {
        yield* snapshot
          .updateSnapshotConfiguration({
            organizationId: output.organizationId,
            serviceId: output.serviceId,
            enabled: false,
          })
          .pipe(Effect.catchTag("NotFound", () => Effect.void));
      }),
    }),
  );
