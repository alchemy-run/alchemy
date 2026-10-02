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
import { isServerOwnedByStack, lower } from "./common.ts";
import { databasePath, type DatabaseScope, syncSetting } from "./setting.ts";

/** The setting is a singleton named `current`. */
const SETTING_NAME = "current";

export interface LedgerDigestUploadProps {
  /** Resource group of the server. Changing it replaces the setting. */
  resourceGroup: string;
  /** Name of the SQL server. Changing it replaces the setting. */
  server: string;
  /** Name of the database. Changing it replaces the setting. */
  database: string;
  /**
   * Where ledger digests are uploaded: an Azure Confidential Ledger
   * endpoint (`https://<ledger>.confidential-ledger.azure.com`) or a Blob
   * Storage endpoint (`https://<account>.blob.core.windows.net`). With
   * storage, grant the server's managed identity `Storage Blob Data
   * Contributor` and use an immutability policy on the container.
   */
  digestStorageEndpoint: string;
}

export interface LedgerDigestUpload extends Resource<
  "Azure.Sql.LedgerDigestUpload",
  LedgerDigestUploadProps,
  {
    /** ARM resource ID of the setting. */
    settingId: string;
    /** Resource group of the server. */
    resourceGroup: string;
    /** Name of the SQL server. */
    serverName: string;
    /** Name of the database. */
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
 * Automatic upload of ledger database digests from an Azure SQL database
 * to Azure Confidential Ledger or immutable Blob Storage, so the
 * integrity of ledger tables can be verified later.
 *
 * Destroying the resource disables digest uploads.
 *
 * @see https://learn.microsoft.com/sql/relational-databases/security/ledger/ledger-digest-management
 *
 * ### Uploading Digests
 * **Example:** Upload digests to Blob Storage
 * ```typescript
 * yield* Azure.Sql.LedgerDigestUpload("digests", {
 *   resourceGroup: group.resourceGroupName,
 *   server: server.serverName,
 *   database: database.databaseName,
 *   digestStorageEndpoint: account.primaryEndpoints.blob,
 * });
 * ```
 *
 * @resource
 */
export const LedgerDigestUpload = Resource<LedgerDigestUpload>(
  "Azure.Sql.LedgerDigestUpload",
);

type Observed = sql.GetLedgerDigestUploadResponse;

const getSetting = (subscriptionId: string, scope: DatabaseScope) =>
  orUndefinedIfNotFound(
    sql.GetLedgerDigestUpload({
      ...databasePath(subscriptionId, scope),
      ledgerDigestUploads: SETTING_NAME,
    }),
  );

const toAttrs = (
  scope: DatabaseScope,
  observed: Observed,
): LedgerDigestUpload["Attributes"] => ({
  settingId: observed.id ?? "",
  resourceGroup: scope.resourceGroup,
  serverName: scope.serverName,
  databaseName: scope.databaseName,
  state: observed.properties?.state ?? "Disabled",
  digestStorageEndpoint:
    observed.properties?.digestStorageEndpoint || undefined,
});

export const LedgerDigestUploadProvider = () =>
  Provider.succeed(LedgerDigestUpload, {
    stables: ["settingId", "resourceGroup", "serverName", "databaseName"],

    // A singleton setting of its database; it disappears with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.server) !== lower(output.serverName) ||
        lower(news.database) !== lower(output.databaseName)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const serverName = output?.serverName ?? olds?.server;
      const databaseName = output?.databaseName ?? olds?.database;
      if (
        resourceGroup === undefined ||
        serverName === undefined ||
        databaseName === undefined
      ) {
        return undefined;
      }
      const scope = { resourceGroup, serverName, databaseName };
      const observed = yield* getSetting(subscriptionId, scope);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(scope, observed);
      return output !== undefined ||
        (yield* isServerOwnedByStack(
          subscriptionId,
          scope.resourceGroup,
          scope.serverName,
        ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Sql");
      const scope: DatabaseScope = {
        resourceGroup: news.resourceGroup,
        serverName: news.server,
        databaseName: news.database,
      };
      const desired = { digestStorageEndpoint: news.digestStorageEndpoint };
      const fresh = yield* syncSetting({
        label: `sql ledger digest upload on ${scope.databaseName}`,
        get: getSetting(subscriptionId, scope),
        converged: (observed) =>
          lower(observed.properties?.state) === "enabled" &&
          lower(observed.properties?.digestStorageEndpoint)?.replace(
            /\/$/,
            "",
          ) === lower(desired.digestStorageEndpoint)?.replace(/\/$/, ""),
        put: sql.LedgerDigestUploadsCreateOrUpdate({
          ...databasePath(subscriptionId, scope),
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
        sql.DisableLedgerDigestUpload({
          ...databasePath(subscriptionId, output),
          ledgerDigestUploads: SETTING_NAME,
        }),
      );
    }),

    nuke: { singleton: true },
  });
