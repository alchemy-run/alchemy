import * as sql from "@distilled.cloud/azure/sql";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
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
import {
  fieldsMatch,
  isServerOwnedByStack,
  lower,
  sameSecret,
} from "./common.ts";
import {
  secretsFingerprint,
  serverPath,
  type ServerScope,
  syncSetting,
} from "./setting.ts";

/** The setting is a singleton named `Default`. */
const SETTING_NAME = "Default";

export interface ServerDevOpsAuditSettingsProps {
  /** Resource group of the server. Changing it replaces the setting. */
  resourceGroup: string;
  /** Name of the SQL server. Changing it replaces the setting. */
  server: string;
  /**
   * Whether Microsoft support (DevOps) operations on the server are
   * audited. When `Enabled`, set `storageEndpoint` or
   * `isAzureMonitorTargetEnabled`.
   */
  state: "Enabled" | "Disabled";
  /**
   * Send DevOps audit events to Azure Monitor (route them with a
   * diagnostic setting on the `master` database, category `DevOpsOperationsAudit`).
   */
  isAzureMonitorTargetEnabled?: boolean;
  /** Authenticate to the storage account with the server's managed identity. */
  isManagedIdentityInUse?: boolean;
  /** Blob endpoint of the storage account audit logs are written to. */
  storageEndpoint?: string;
  /** Subscription of the audit storage account. */
  storageAccountSubscriptionId?: string;
  /**
   * Access key of the storage account. Omit it when the managed identity is used. Write-only: Alchemy stores a salted fingerprint and only
   * re-sends it when it changes.
   */
  storageAccountAccessKey?: Redacted.Redacted<string>;
}

export interface ServerDevOpsAuditSettings extends Resource<
  "Azure.Sql.ServerDevOpsAuditSettings",
  ServerDevOpsAuditSettingsProps,
  {
    /** ARM resource ID of the setting. */
    settingId: string;
    /** Resource group of the server. */
    resourceGroup: string;
    /** Name of the SQL server. */
    serverName: string;
    /** Whether DevOps auditing is enabled. */
    state: string;
    /** Whether events go to Azure Monitor. */
    isAzureMonitorTargetEnabled: boolean | undefined;
    /** Storage endpoint audit logs are written to. */
    storageEndpoint: string | undefined;
    /** Salted fingerprint of the write-only secrets Alchemy last set. */
    secretFingerprint: Redacted.Redacted<string> | undefined;
  },
  never,
  Providers
> {}

/**
 * Auditing of Microsoft support engineers' (DevOps) operations on an
 * Azure SQL server, written to Azure Monitor and/or a storage account.
 *
 * This is a singleton setting that always exists on a server. Destroying
 * the resource disables DevOps auditing again.
 *
 * @see https://learn.microsoft.com/azure/azure-sql/database/auditing-microsoft-support-operations
 *
 * ### Auditing Support Operations
 * **Example:** Audit support operations to Azure Monitor
 * ```typescript
 * yield* Azure.Sql.ServerDevOpsAuditSettings("devops-audit", {
 *   resourceGroup: group.resourceGroupName,
 *   server: server.serverName,
 *   state: "Enabled",
 *   isAzureMonitorTargetEnabled: true,
 * });
 * ```
 *
 * @resource
 */
export const ServerDevOpsAuditSettings = Resource<ServerDevOpsAuditSettings>(
  "Azure.Sql.ServerDevOpsAuditSettings",
);

type Observed = sql.GetServerDevOpsAuditSettingsResponse;

const getSetting = (subscriptionId: string, scope: ServerScope) =>
  orUndefinedIfNotFound(
    sql.GetServerDevOpsAuditSettings({
      ...serverPath(subscriptionId, scope),
      devOpsAuditingSettingsName: SETTING_NAME,
    }),
  );

const toAttrs = (
  scope: ServerScope,
  observed: Observed,
  fingerprint: Redacted.Redacted<string> | undefined,
): ServerDevOpsAuditSettings["Attributes"] => ({
  settingId: observed.id ?? "",
  resourceGroup: scope.resourceGroup,
  serverName: scope.serverName,
  state: observed.properties?.state ?? "Disabled",
  isAzureMonitorTargetEnabled: observed.properties?.isAzureMonitorTargetEnabled,
  storageEndpoint: observed.properties?.storageEndpoint || undefined,
  secretFingerprint: fingerprint,
});

export const ServerDevOpsAuditSettingsProvider = () =>
  Provider.succeed(ServerDevOpsAuditSettings, {
    stables: ["settingId", "resourceGroup", "serverName"],

    // A singleton setting of its server; it disappears with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.server) !== lower(output.serverName)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const serverName = output?.serverName ?? olds?.server;
      if (resourceGroup === undefined || serverName === undefined) {
        return undefined;
      }
      const scope = { resourceGroup, serverName };
      const observed = yield* getSetting(subscriptionId, scope);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(scope, observed, output?.secretFingerprint);
      return output !== undefined ||
        (yield* isServerOwnedByStack(
          subscriptionId,
          scope.resourceGroup,
          scope.serverName,
        ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Sql");
      const scope: ServerScope = {
        resourceGroup: news.resourceGroup,
        serverName: news.server,
      };
      const fingerprint = yield* secretsFingerprint(
        `${scope.resourceGroup}/${scope.serverName}/ServerDevOpsAuditSettings`,
        [news.storageAccountAccessKey],
      );
      const desired = {
        state: news.state,
        isAzureMonitorTargetEnabled: news.isAzureMonitorTargetEnabled,
        isManagedIdentityInUse: news.isManagedIdentityInUse,
        storageEndpoint: news.storageEndpoint,
        storageAccountSubscriptionId: news.storageAccountSubscriptionId,
      };
      const fresh = yield* syncSetting({
        label: `sql server devops audit settings on ${scope.serverName}`,
        get: getSetting(subscriptionId, scope),
        converged: (observed) => fieldsMatch(observed.properties, desired),
        put: sql.ServerDevOpsAuditSettingsCreateOrUpdate({
          ...serverPath(subscriptionId, scope),
          devOpsAuditingSettingsName: SETTING_NAME,
          properties: {
            ...desired,
            storageAccountAccessKey:
              news.storageAccountAccessKey === undefined
                ? undefined
                : Redacted.value(news.storageAccountAccessKey),
          },
        }),
        force:
          [news.storageAccountAccessKey].some(
            (secret) => secret !== undefined,
          ) && !sameSecret(fingerprint, output?.secretFingerprint),
      });
      return toAttrs(scope, fresh, fingerprint);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const label = `sql server devops audit settings on ${output.serverName}`;
      if ((yield* getSetting(subscriptionId, output)) === undefined) return;
      // The setting cannot be removed; disable it.
      yield* ignoreNotFound(
        syncSetting({
          label,
          get: getSetting(subscriptionId, output),
          converged: (observed) =>
            fieldsMatch(observed.properties, { state: "Disabled" }),
          put: sql.ServerDevOpsAuditSettingsCreateOrUpdate({
            ...serverPath(subscriptionId, output),
            devOpsAuditingSettingsName: SETTING_NAME,
            properties: { state: "Disabled" },
          }),
        }),
      );
    }),

    nuke: { singleton: true },
  });
