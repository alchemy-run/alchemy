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
import { fieldsMatch, isManagedInstanceOwnedByStack, lower } from "./common.ts";
import {
  managedDatabasePath,
  type ManagedDatabaseScope,
  syncSetting,
} from "./setting.ts";

/** The setting is a singleton named `current`. */
const SETTING_NAME = "current";

export interface ManagedTransparentDataEncryptionProps {
  /** Resource group of the managed instance. Changing it replaces the setting. */
  resourceGroup: string;
  /** Name of the SQL managed instance. Changing it replaces the setting. */
  managedInstance: string;
  /** Name of the managed database. Changing it replaces the setting. */
  database: string;
  /** Whether Transparent Data Encryption is enabled. New databases are encrypted by default. */
  state: "Enabled" | "Disabled";
}

export interface ManagedTransparentDataEncryption extends Resource<
  "Azure.Sql.ManagedTransparentDataEncryption",
  ManagedTransparentDataEncryptionProps,
  {
    /** ARM resource ID of the setting. */
    settingId: string;
    /** Resource group of the managed instance. */
    resourceGroup: string;
    /** Name of the SQL managed instance. */
    managedInstanceName: string;
    /** Name of the managed database. */
    databaseName: string;
    /** Observed TDE state. */
    state: string;
  },
  never,
  Providers
> {}

/**
 * Transparent Data Encryption (TDE) of a database on an Azure SQL Managed
 * Instance — encrypts data, backups, and logs at rest.
 *
 * This is a singleton setting that always exists on a database.
 * Destroying the resource re-enables encryption (Azure's default).
 *
 * @see https://learn.microsoft.com/azure/azure-sql/database/transparent-data-encryption-tde-overview
 *
 * ### Configuring Encryption
 * **Example:** Make encryption explicit
 * ```typescript
 * yield* Azure.Sql.ManagedTransparentDataEncryption("tde", {
 *   resourceGroup: group.resourceGroupName,
 *   managedInstance: instance.managedInstanceName,
 *   database: database.databaseName,
 *   state: "Enabled",
 * });
 * ```
 *
 * @resource
 */
export const ManagedTransparentDataEncryption =
  Resource<ManagedTransparentDataEncryption>(
    "Azure.Sql.ManagedTransparentDataEncryption",
  );

type Observed = sql.GetManagedDatabaseTransparentDataEncryptionResponse;

const getSetting = (subscriptionId: string, scope: ManagedDatabaseScope) =>
  orUndefinedIfNotFound(
    sql.GetManagedDatabaseTransparentDataEncryption({
      ...managedDatabasePath(subscriptionId, scope),
      tdeName: SETTING_NAME,
    }),
  );

const toAttrs = (
  scope: ManagedDatabaseScope,
  observed: Observed,
): ManagedTransparentDataEncryption["Attributes"] => ({
  settingId: observed.id ?? "",
  resourceGroup: scope.resourceGroup,
  managedInstanceName: scope.managedInstanceName,
  databaseName: scope.databaseName,
  state: observed.properties?.state ?? "Enabled",
});

export const ManagedTransparentDataEncryptionProvider = () =>
  Provider.succeed(ManagedTransparentDataEncryption, {
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
      const desired = { state: news.state };
      const fresh = yield* syncSetting({
        label: `sql managed database transparent data encryption on ${scope.databaseName}`,
        get: getSetting(subscriptionId, scope),
        converged: (observed) =>
          lower(observed.properties?.state) === lower(desired.state),
        put: sql.ManagedDatabaseTransparentDataEncryptionCreateOrUpdate({
          ...managedDatabasePath(subscriptionId, scope),
          tdeName: SETTING_NAME,
          properties: desired,
        }),
      });
      return toAttrs(scope, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const label = `sql managed database transparent data encryption on ${output.databaseName}`;
      if ((yield* getSetting(subscriptionId, output)) === undefined) return;
      // The setting cannot be removed; re-enable encryption (Azure's default).
      yield* ignoreNotFound(
        syncSetting({
          label,
          get: getSetting(subscriptionId, output),
          converged: (observed) =>
            fieldsMatch(observed.properties, { state: "Enabled" }),
          put: sql.ManagedDatabaseTransparentDataEncryptionCreateOrUpdate({
            ...managedDatabasePath(subscriptionId, output),
            tdeName: SETTING_NAME,
            properties: { state: "Enabled" },
          }),
        }),
      );
    }),

    nuke: { singleton: true },
  });
