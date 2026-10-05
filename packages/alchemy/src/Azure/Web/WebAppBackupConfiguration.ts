import * as web from "@distilled.cloud/azure/web";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { lower, matchesDesired, reveal, siteWhere } from "./common.ts";

/** How often and how long scheduled backups are kept. */
export interface WebAppBackupSchedule {
  /** Run a backup every `frequencyInterval` `frequencyUnit`s, e.g. `1`. */
  frequencyInterval: number;
  /** Unit of `frequencyInterval`. */
  frequencyUnit: "Day" | "Hour";
  /**
   * Keep at least one backup regardless of `retentionPeriodInDays`.
   * @default true
   */
  keepAtLeastOneBackup?: boolean;
  /**
   * Days after which backups are deleted (`0` keeps them forever).
   * @default 30
   */
  retentionPeriodInDays?: number;
  /** When the schedule starts (ISO 8601). @default now */
  startTime?: string;
}

/** A database included in the app's backups. */
export interface WebAppBackupDatabase {
  /** Database engine. */
  databaseType: "SqlAzure" | "MySql" | "LocalMySql" | "PostgreSql";
  /** Name of the database in the backup. */
  name?: string;
  /** Name of a connection string of the app that points at the database. */
  connectionStringName?: string;
  /** Connection string of the database (instead of `connectionStringName`). */
  connectionString?: string | Redacted.Redacted<string>;
}

export interface WebAppBackupConfigurationProps {
  /** Resource group of the app. Changing it replaces the configuration. */
  resourceGroup: string;
  /** Name of the web app. Changing it replaces the configuration. */
  siteName: string;
  /**
   * SAS URL of the blob container backups are written to (needs read,
   * write, list and delete permissions).
   */
  storageAccountUrl: string | Redacted.Redacted<string>;
  /** Name prefix of the backup files. @default the app name */
  backupName?: string;
  /**
   * Whether scheduled backups run.
   * @default true
   */
  enabled?: boolean;
  /** Backup schedule. */
  backupSchedule: WebAppBackupSchedule;
  /** Databases to include in each backup. */
  databases?: WebAppBackupDatabase[];
}

export interface WebAppBackupConfiguration extends Resource<
  "Azure.Web.WebAppBackupConfiguration",
  WebAppBackupConfigurationProps,
  {
    /** Name of the app. */
    siteName: string;
    /** Resource group of the app. */
    resourceGroup: string;
    /** Name prefix of the backup files. */
    backupName: string | undefined;
    /** Whether scheduled backups run. */
    enabled: boolean;
    /** Backup interval. */
    frequencyInterval: number | undefined;
    /** Unit of the backup interval. */
    frequencyUnit: string | undefined;
    /** Days backups are kept. */
    retentionPeriodInDays: number | undefined;
    /** When the last scheduled backup ran (ISO 8601). */
    lastExecutionTime: string | undefined;
  },
  never,
  Providers
> {}

/**
 * The scheduled backup configuration of an App Service app
 * (`Microsoft.Web/sites/config/backup`). Each app has at most one.
 * Requires a Standard or higher plan.
 *
 * @see https://learn.microsoft.com/azure/app-service/manage-backup
 *
 * ### Scheduling Backups
 * **Example:** Daily backups kept for a week
 * ```typescript
 * yield* Azure.Web.WebAppBackupConfiguration("backups", {
 *   resourceGroup: group.resourceGroupName,
 *   siteName: app.siteName,
 *   storageAccountUrl: Redacted.make(containerSasUrl),
 *   backupSchedule: {
 *     frequencyInterval: 1,
 *     frequencyUnit: "Day",
 *     retentionPeriodInDays: 7,
 *   },
 * });
 * ```
 *
 * @resource
 */
export const WebAppBackupConfiguration = Resource<WebAppBackupConfiguration>(
  "Azure.Web.WebAppBackupConfiguration",
);

type ObservedBackup = web.GetWebAppBackupConfigurationResponse;

const getBackup = (
  subscriptionId: string,
  resourceGroup: string,
  siteName: string,
) =>
  orUndefinedIfNotFound(
    web.GetWebAppBackupConfiguration(
      siteWhere(subscriptionId, resourceGroup, siteName),
    ),
  ).pipe(
    // An app without a backup configuration may report an empty one.
    Effect.map((observed) =>
      observed?.properties?.backupSchedule ? observed : undefined,
    ),
  );

const toAttrs = (
  resourceGroup: string,
  siteName: string,
  observed: ObservedBackup,
): WebAppBackupConfiguration["Attributes"] => ({
  siteName,
  resourceGroup,
  backupName: observed.properties?.backupName,
  enabled: observed.properties?.enabled ?? false,
  frequencyInterval: observed.properties?.backupSchedule?.frequencyInterval,
  frequencyUnit: observed.properties?.backupSchedule?.frequencyUnit,
  retentionPeriodInDays:
    observed.properties?.backupSchedule?.retentionPeriodInDays,
  lastExecutionTime: observed.properties?.backupSchedule?.lastExecutionTime,
});

export const WebAppBackupConfigurationProvider = () =>
  Provider.succeed(WebAppBackupConfiguration, {
    stables: ["siteName", "resourceGroup"],

    // The configuration is removed with its app.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.siteName) !== lower(output.siteName)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const siteName = output?.siteName ?? olds?.siteName;
      if (resourceGroup === undefined || siteName === undefined) {
        return undefined;
      }
      const observed = yield* getBackup(
        subscriptionId,
        resourceGroup,
        siteName,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, siteName, observed);
      // A singleton without tags; only one this stack recorded is ours.
      return output !== undefined ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Web");
      const { resourceGroup, siteName } = news;
      const storageAccountUrl = reveal(news.storageAccountUrl) ?? "";
      const schedule = news.backupSchedule;
      const desired = {
        backupName: news.backupName,
        enabled: news.enabled ?? true,
        backupSchedule: {
          frequencyInterval: schedule.frequencyInterval,
          frequencyUnit: schedule.frequencyUnit,
          keepAtLeastOneBackup: schedule.keepAtLeastOneBackup ?? true,
          retentionPeriodInDays: schedule.retentionPeriodInDays ?? 30,
          startTime: schedule.startTime,
        },
      };
      const databases = news.databases?.map((db) => ({
        databaseType: db.databaseType,
        name: db.name,
        connectionStringName: db.connectionStringName,
        connectionString: reveal(db.connectionString),
      }));

      // Observe.
      const observed = yield* getBackup(
        subscriptionId,
        resourceGroup,
        siteName,
      );

      // Ensure + sync. The configuration is one document; it is re-sent
      // whenever any observed aspect drifts. Database connection strings
      // are secrets Azure does not echo back, so only their shape is compared.
      const drifted =
        observed === undefined ||
        !matchesDesired(desired, observed.properties) ||
        (typeof observed.properties?.storageAccountUrl === "string" &&
          observed.properties.storageAccountUrl !== storageAccountUrl) ||
        !matchesDesired(
          (databases ?? []).map(({ connectionString: _, ...db }) => db),
          (observed.properties?.databases ?? []).map(
            ({ connectionString: _, ...db }) => db,
          ),
        );
      if (drifted) {
        yield* web.UpdateWebAppBackupConfiguration({
          ...siteWhere(subscriptionId, resourceGroup, siteName),
          properties: { ...desired, storageAccountUrl, databases },
        });
      }

      const final = yield* getBackup(subscriptionId, resourceGroup, siteName);
      return final === undefined
        ? {
            siteName,
            resourceGroup,
            backupName: desired.backupName,
            enabled: desired.enabled,
            frequencyInterval: schedule.frequencyInterval,
            frequencyUnit: schedule.frequencyUnit,
            retentionPeriodInDays: desired.backupSchedule.retentionPeriodInDays,
            lastExecutionTime: undefined,
          }
        : toAttrs(resourceGroup, siteName, final);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        web.DeleteWebAppBackupConfiguration(
          siteWhere(subscriptionId, output.resourceGroup, output.siteName),
        ),
      );
      yield* waitUntilGone(
        `backup configuration of ${output.siteName}`,
        getBackup(subscriptionId, output.resourceGroup, output.siteName),
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.Resources.ResourceGroup",
        "Azure.Web.WebApp",
        "Azure.Web.FunctionApp",
      ],
    },
  });
