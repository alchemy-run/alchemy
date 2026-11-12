import * as backup from "@distilled.cloud/clickhouse-cloud/backup";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { organizationId as currentOrganizationId } from "../Credentials.ts";
import { requireResult } from "../internal/Errors.ts";
import type { Providers } from "../Providers.ts";

export interface BackupConfigurationProps {
  /**
   * ID of the service whose backups to configure, e.g. a
   * `ClickHouseCloud.Service.Service`'s `serviceId`. Changing it replaces
   * the resource.
   */
  serviceId: string;
  /** Hours between backups. Omit to leave the service's setting alone. */
  backupPeriodInHours?: number;
  /**
   * Hours backups are kept: a whole number of days, from 24 (1 day) to
   * 1080 (45 days). Omit to leave the service's setting alone.
   */
  backupRetentionPeriodInHours?: number;
  /**
   * Time of day backups start, `HH:MM` in UTC. Setting it makes backups
   * daily. Omit to leave the service's setting alone.
   */
  backupStartTime?: string;
}

export interface BackupConfigurationAttributes {
  /** Service ID. */
  serviceId: string;
  /** Organization that owns the service. */
  organizationId: string;
  /** Hours between backups. */
  backupPeriodInHours: number | undefined;
  /** Hours backups are kept. */
  backupRetentionPeriodInHours: number | undefined;
  /** Daily start time, `HH:MM` UTC, when set. */
  backupStartTime: string | undefined;
}

export type BackupConfiguration = Resource<
  "ClickHouseCloud.Backup.BackupConfiguration",
  BackupConfigurationProps,
  BackupConfigurationAttributes,
  never,
  Providers
>;

/**
 * The backup schedule and retention of a ClickHouse Cloud service. Every
 * service has one; only the settings you declare change.
 *
 * Destroying the resource resets the settings it managed to ClickHouse's
 * defaults. It never deletes backups: backups are taken on the schedule and
 * expire with the retention period. Changing the settings needs an API key
 * with the Admin role.
 * @see https://clickhouse.com/docs/cloud/manage/backups/configurable-backups
 *
 * ### Configuring Backups
 * **Example:** Back up every 12 hours and keep a week of backups
 * ```typescript
 * const analytics = yield* ClickHouseCloud.Service.Service("Analytics", {
 *   provider: "aws",
 *   region: "us-east-1",
 *   ipAccessList: [{ source: "0.0.0.0/0" }],
 * });
 * yield* ClickHouseCloud.Backup.BackupConfiguration("AnalyticsBackups", {
 *   serviceId: analytics.serviceId,
 *   backupPeriodInHours: 12,
 *   backupRetentionPeriodInHours: 168,
 * });
 * ```
 *
 * **Example:** One backup a day at 03:00 UTC
 * ```typescript
 * const analytics = yield* ClickHouseCloud.Service.Service("Analytics", {
 *   provider: "aws",
 *   region: "us-east-1",
 *   ipAccessList: [{ source: "0.0.0.0/0" }],
 * });
 * yield* ClickHouseCloud.Backup.BackupConfiguration("NightlyBackups", {
 *   serviceId: analytics.serviceId,
 *   backupStartTime: "03:00",
 * });
 * ```
 *
 * :::caution
 * Changing `serviceId` replaces the resource: the old service's settings
 * are reset to defaults.
 * :::
 *
 * @resource
 * @product Backup
 */
export const BackupConfiguration = Resource<BackupConfiguration>(
  "ClickHouseCloud.Backup.BackupConfiguration",
);

const MANAGED = [
  "backupPeriodInHours",
  "backupRetentionPeriodInHours",
  "backupStartTime",
] as const satisfies ReadonlyArray<keyof BackupConfigurationProps>;

const toAttributes = (
  organizationId: string,
  serviceId: string,
  config: backup.BackupConfiguration,
): BackupConfigurationAttributes => ({
  serviceId,
  organizationId,
  backupPeriodInHours: config.backupPeriodInHours,
  backupRetentionPeriodInHours: config.backupRetentionPeriodInHours,
  backupStartTime: config.backupStartTime,
});

const getConfiguration = (organizationId: string, serviceId: string) =>
  backup.getBackupConfiguration({ organizationId, serviceId }).pipe(
    Effect.flatMap(requireResult("getBackupConfiguration")),
    // A missing service has no backup configuration.
    Effect.catchTag("NotFound", () => Effect.undefined),
  );

export const BackupConfigurationProvider = () =>
  Provider.effect(
    BackupConfiguration,
    Effect.succeed({
      stables: ["serviceId", "organizationId"],
      // Deleting resets settings on a service: nuke deletes the services.
      nuke: { singleton: true, dependsOn: ["ClickHouseCloud.Service.Service"] },
      list: () => Effect.succeed([]),
      diff: Effect.fn(function* ({ news, olds, output }) {
        if (!isResolved(news) || output === undefined || olds === undefined) return undefined;
        if (news.serviceId !== output.serviceId) return { action: "replace" } as const;
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
        const observed = yield* backup
          .getBackupConfiguration({ organizationId, serviceId })
          .pipe(Effect.flatMap(requireResult("getBackupConfiguration")));
        // Sync only the declared settings that differ.
        const patch = Object.fromEntries(
          MANAGED.flatMap((key) =>
            news[key] !== undefined && news[key] !== observed[key] ? [[key, news[key]]] : [],
          ),
        ) as Partial<Pick<BackupConfigurationProps, (typeof MANAGED)[number]>>;
        if (Object.keys(patch).length === 0) {
          return toAttributes(organizationId, serviceId, observed);
        }
        const updated = yield* backup
          .updateBackupConfiguration({ organizationId, serviceId, ...patch })
          .pipe(Effect.flatMap(requireResult("updateBackupConfiguration")));
        return toAttributes(organizationId, serviceId, updated);
      }),
      delete: Effect.fn(function* ({ olds, output }) {
        // `null` resets a setting to its default; only managed settings reset.
        const reset = Object.fromEntries(
          MANAGED.flatMap((key) => (olds[key] !== undefined ? [[key, null]] : [])),
        );
        if (Object.keys(reset).length === 0) return;
        yield* backup
          .updateBackupConfiguration({
            organizationId: output.organizationId,
            serviceId: output.serviceId,
            ...reset,
          })
          .pipe(Effect.catchTag("NotFound", () => Effect.void));
      }),
    }),
  );
