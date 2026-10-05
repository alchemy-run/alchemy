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
  waitForProvisioned,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { fieldsMatch, isServerOwnedByStack, lower } from "./common.ts";
import { databasePath, type DatabaseScope, syncSetting } from "./setting.ts";

/** The setting is a singleton named `current`. */
const SETTING_NAME = "current";

export interface TransparentDataEncryptionProps {
  /** Resource group of the server. Changing it replaces the setting. */
  resourceGroup: string;
  /** Name of the SQL server. Changing it replaces the setting. */
  server: string;
  /** Name of the database. Changing it replaces the setting. */
  database: string;
  /**
   * Whether Transparent Data Encryption is enabled. New databases are
   * encrypted by default.
   */
  state: "Enabled" | "Disabled";
}

export interface TransparentDataEncryption extends Resource<
  "Azure.Sql.TransparentDataEncryption",
  TransparentDataEncryptionProps,
  {
    /** ARM resource ID of the setting. */
    settingId: string;
    /** Resource group of the server. */
    resourceGroup: string;
    /** Name of the SQL server. */
    serverName: string;
    /** Name of the database. */
    databaseName: string;
    /** Observed TDE state. */
    state: string;
  },
  never,
  Providers
> {}

/**
 * Transparent Data Encryption (TDE) of an Azure SQL database — encrypts
 * data, backups, and logs at rest. New databases are encrypted by
 * default; this resource lets you turn it off or pin it on.
 *
 * This is a singleton setting that always exists on a database.
 * Destroying the resource re-enables encryption (Azure's default).
 *
 * @see https://learn.microsoft.com/azure/azure-sql/database/transparent-data-encryption-tde-overview
 *
 * ### Configuring Encryption
 * **Example:** Make encryption explicit
 * ```typescript
 * yield* Azure.Sql.TransparentDataEncryption("tde", {
 *   resourceGroup: group.resourceGroupName,
 *   server: server.serverName,
 *   database: database.databaseName,
 *   state: "Enabled",
 * });
 * ```
 *
 * @resource
 */
export const TransparentDataEncryption = Resource<TransparentDataEncryption>(
  "Azure.Sql.TransparentDataEncryption",
);

type Observed = sql.GetTransparentDataEncryptionResponse;

const getSetting = (subscriptionId: string, scope: DatabaseScope) =>
  orUndefinedIfNotFound(
    sql.GetTransparentDataEncryption({
      ...databasePath(subscriptionId, scope),
      tdeName: SETTING_NAME,
    }),
  );

/**
 * Azure accepts a state change while an encryption/decryption scan is
 * running (e.g. the initial scan of a new database) but silently drops
 * it, so wait for the scan to finish before writing.
 */
const waitForScanIdle = (
  subscriptionId: string,
  scope: DatabaseScope,
  label: string,
) =>
  waitForProvisioned(
    label,
    getSetting(subscriptionId, scope),
    (observed) =>
      lower(observed.properties?.scanState) === "running"
        ? "Updating"
        : "Succeeded",
    { interval: "5 seconds", times: 60 },
  );

const toAttrs = (
  scope: DatabaseScope,
  observed: Observed,
): TransparentDataEncryption["Attributes"] => ({
  settingId: observed.id ?? "",
  resourceGroup: scope.resourceGroup,
  serverName: scope.serverName,
  databaseName: scope.databaseName,
  state: observed.properties?.state ?? "Enabled",
});

export const TransparentDataEncryptionProvider = () =>
  Provider.succeed(TransparentDataEncryption, {
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
      const desired = { state: news.state };
      const label = `sql transparent data encryption on ${scope.databaseName}`;
      yield* waitForScanIdle(subscriptionId, scope, label);
      const fresh = yield* syncSetting({
        label,
        get: getSetting(subscriptionId, scope),
        converged: (observed) =>
          lower(observed.properties?.state) === lower(desired.state),
        put: sql.TransparentDataEncryptionsCreateOrUpdate({
          ...databasePath(subscriptionId, scope),
          tdeName: SETTING_NAME,
          properties: desired,
        }),
      });
      return toAttrs(scope, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const label = `sql transparent data encryption on ${output.databaseName}`;
      if ((yield* getSetting(subscriptionId, output)) === undefined) return;
      // The setting cannot be removed; re-enable encryption (Azure's default).
      yield* ignoreNotFound(waitForScanIdle(subscriptionId, output, label));
      yield* ignoreNotFound(
        syncSetting({
          label,
          get: getSetting(subscriptionId, output),
          converged: (observed) =>
            fieldsMatch(observed.properties, { state: "Enabled" }),
          put: sql.TransparentDataEncryptionsCreateOrUpdate({
            ...databasePath(subscriptionId, output),
            tdeName: SETTING_NAME,
            properties: { state: "Enabled" },
          }),
        }),
      );
    }),

    nuke: { singleton: true },
  });
