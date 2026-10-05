import * as sql from "@distilled.cloud/azure/sql";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { isManagedInstanceOwnedByStack, lower } from "./common.ts";
import {
  managedDatabasePath,
  type ManagedDatabaseScope,
  syncSetting,
} from "./setting.ts";

/** The setting is a singleton named `current`. */
const SETTING_NAME = "current";

export interface ManagedLedgerDigestUploadProps {
  /** Resource group of the managed instance. Changing it replaces the setting. */
  resourceGroup: string;
  /** Name of the SQL managed instance. Changing it replaces the setting. */
  managedInstance: string;
  /** Name of the managed database. Changing it replaces the setting. */
  database: string;
  /**
   * Where ledger digests are uploaded: an Azure Confidential Ledger
   * endpoint or a Blob Storage endpoint (grant the instance's managed
   * identity `Storage Blob Data Contributor`).
   */
  digestStorageEndpoint: string;
}

export interface ManagedLedgerDigestUpload extends Resource<
  "Azure.Sql.ManagedLedgerDigestUpload",
  ManagedLedgerDigestUploadProps,
  {
    /** ARM resource ID of the setting. */
    settingId: string;
    /** Resource group of the managed instance. */
    resourceGroup: string;
    /** Name of the SQL managed instance. */
    managedInstanceName: string;
    /** Name of the managed database. */
    databaseName: string;
    /** Whether digest upload is enabled. */
    state: string;
    /** Endpoint digests are uploaded to. */
    digestStorageEndpoint: string | undefined;
  },
  never,
  Providers
> {}

/**
 * Automatic upload of ledger digests from a database on an Azure SQL
 * Managed Instance to Azure Confidential Ledger or immutable Blob
 * Storage. Destroying the resource disables digest uploads.
 *
 * @see https://learn.microsoft.com/sql/relational-databases/security/ledger/ledger-digest-management
 *
 * ### Uploading Digests
 * **Example:** Upload digests to Blob Storage
 * ```typescript
 * yield* Azure.Sql.ManagedLedgerDigestUpload("digests", {
 *   resourceGroup: group.resourceGroupName,
 *   managedInstance: instance.managedInstanceName,
 *   database: database.databaseName,
 *   digestStorageEndpoint: account.primaryEndpoints.blob,
 * });
 * ```
 *
 * @resource
 */
export const ManagedLedgerDigestUpload = Resource<ManagedLedgerDigestUpload>(
  "Azure.Sql.ManagedLedgerDigestUpload",
);

type Observed = sql.GetManagedLedgerDigestUploadResponse;

const getSetting = (subscriptionId: string, scope: ManagedDatabaseScope) =>
  orUndefinedIfNotFound(
    sql.GetManagedLedgerDigestUpload({
      ...managedDatabasePath(subscriptionId, scope),
      ledgerDigestUploads: SETTING_NAME,
    }),
  );

const toAttrs = (
  scope: ManagedDatabaseScope,
  observed: Observed,
): ManagedLedgerDigestUpload["Attributes"] => ({
  settingId: observed.id ?? "",
  resourceGroup: scope.resourceGroup,
  managedInstanceName: scope.managedInstanceName,
  databaseName: scope.databaseName,
  state: observed.properties?.state ?? "Disabled",
  digestStorageEndpoint:
    observed.properties?.digestStorageEndpoint || undefined,
});

export const ManagedLedgerDigestUploadProvider = () =>
  Provider.succeed(ManagedLedgerDigestUpload, {
    stables: [
      "settingId",
      "resourceGroup",
      "managedInstanceName",
      "databaseName",
    ],

    // A singleton setting of its managed database; it disappears with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.managedInstance) !== lower(output.managedInstanceName) ||
        lower(news.database) !== lower(output.databaseName)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const managedInstanceName =
        output?.managedInstanceName ?? olds?.managedInstance;
      const databaseName = output?.databaseName ?? olds?.database;
      if (
        resourceGroup === undefined ||
        managedInstanceName === undefined ||
        databaseName === undefined
      ) {
        return undefined;
      }
      const scope = { resourceGroup, managedInstanceName, databaseName };
      const observed = yield* getSetting(subscriptionId, scope);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(scope, observed);
      return output !== undefined ||
        (yield* isManagedInstanceOwnedByStack(
          subscriptionId,
          scope.resourceGroup,
          scope.managedInstanceName,
        ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Sql");
      const scope: ManagedDatabaseScope = {
        resourceGroup: news.resourceGroup,
        managedInstanceName: news.managedInstance,
        databaseName: news.database,
      };
      const desired = { digestStorageEndpoint: news.digestStorageEndpoint };
      const fresh = yield* syncSetting({
        label: `sql managed ledger digest upload on ${scope.databaseName}`,
        get: getSetting(subscriptionId, scope),
        converged: (observed) =>
          lower(observed.properties?.state) === "enabled" &&
          lower(observed.properties?.digestStorageEndpoint)?.replace(
            /\/$/,
            "",
          ) === lower(desired.digestStorageEndpoint)?.replace(/\/$/, ""),
        put: sql.ManagedLedgerDigestUploadsCreateOrUpdate({
          ...managedDatabasePath(subscriptionId, scope),
          ledgerDigestUploads: SETTING_NAME,
          properties: desired,
        }),
      });
      return toAttrs(scope, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      // Disabling is the only way to remove the upload configuration.
      yield* ignoreNotFound(
        sql.DisableManagedLedgerDigestUpload({
          ...managedDatabasePath(subscriptionId, output),
          ledgerDigestUploads: SETTING_NAME,
        }),
      );
    }),

    nuke: { singleton: true },
  });
