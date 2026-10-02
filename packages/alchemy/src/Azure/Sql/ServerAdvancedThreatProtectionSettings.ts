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
import { retryInProgress, syncSetting } from "./setting.ts";

/** The setting is a singleton named `Default`. */
const SETTING_NAME = "Default";

export interface ServerAdvancedThreatProtectionSettingsProps {
  /** Resource group of the server. Changing it replaces the setting. */
  resourceGroup: string;
  /** Name of the SQL server. Changing it replaces the setting. */
  server: string;
  /**
   * Whether Microsoft Defender for SQL Advanced Threat Protection is
   * enabled for every database on the server. Enabling it is billed per
   * server (Microsoft Defender for SQL pricing).
   */
  state: "Enabled" | "Disabled";
}

export interface ServerAdvancedThreatProtectionSettings extends Resource<
  "Azure.Sql.ServerAdvancedThreatProtectionSettings",
  ServerAdvancedThreatProtectionSettingsProps,
  {
    /** ARM resource ID of the setting. */
    settingId: string;
    /** Name of the SQL server. */
    serverName: string;
    /** Resource group of the server. */
    resourceGroup: string;
    /** Observed state: `New`, `Enabled`, or `Disabled`. */
    state: string;
    /** When the setting was first enabled, if ever. */
    creationTime: string | undefined;
  },
  never,
  Providers
> {}

/**
 * Advanced Threat Protection (Microsoft Defender for SQL) on an Azure SQL
 * server — detects anomalous activity such as SQL injection and
 * brute-force logins on every database of the server.
 *
 * This is a singleton setting that always exists on a server. Destroying
 * the resource disables protection again.
 *
 * @see https://learn.microsoft.com/azure/azure-sql/database/threat-detection-overview
 *
 * ### Enabling Threat Protection
 * **Example:** Enable Advanced Threat Protection on a server
 * ```typescript
 * yield* Azure.Sql.ServerAdvancedThreatProtectionSettings("atp", {
 *   resourceGroup: group.resourceGroupName,
 *   server: server.serverName,
 *   state: "Enabled",
 * });
 * ```
 *
 * @resource
 */
export const ServerAdvancedThreatProtectionSettings =
  Resource<ServerAdvancedThreatProtectionSettings>(
    "Azure.Sql.ServerAdvancedThreatProtectionSettings",
  );

const getSetting = (
  subscriptionId: string,
  resourceGroupName: string,
  serverName: string,
) =>
  orUndefinedIfNotFound(
    sql.GetServerAdvancedThreatProtectionSettings({
      subscriptionId,
      resourceGroupName,
      serverName,
      advancedThreatProtectionName: SETTING_NAME,
    }),
  );

const putSetting = (
  subscriptionId: string,
  resourceGroupName: string,
  serverName: string,
  state: string,
) =>
  sql.ServerAdvancedThreatProtectionSettingsCreateOrUpdate({
    subscriptionId,
    resourceGroupName,
    serverName,
    advancedThreatProtectionName: SETTING_NAME,
    properties: { state },
  });

const toAttrs = (
  resourceGroup: string,
  serverName: string,
  setting: sql.GetServerAdvancedThreatProtectionSettingsResponse,
): ServerAdvancedThreatProtectionSettings["Attributes"] => ({
  settingId: setting.id ?? "",
  serverName,
  resourceGroup,
  state: setting.properties?.state ?? "New",
  creationTime: setting.properties?.creationTime,
});

export const ServerAdvancedThreatProtectionSettingsProvider = () =>
  Provider.succeed(ServerAdvancedThreatProtectionSettings, {
    stables: ["settingId", "serverName", "resourceGroup"],

    // A per-server singleton setting; it disappears with its server.
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
      const observed = yield* getSetting(
        subscriptionId,
        resourceGroup,
        serverName,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, serverName, observed);
      return output !== undefined ||
        (yield* isServerOwnedByStack(subscriptionId, resourceGroup, serverName))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Sql");
      const { resourceGroup, server } = news;
      const fresh = yield* syncSetting({
        label: `sql threat protection on ${server}`,
        get: getSetting(subscriptionId, resourceGroup, server),
        converged: (setting) =>
          lower(setting.properties?.state) === lower(news.state),
        put: putSetting(subscriptionId, resourceGroup, server, news.state),
      });
      return toAttrs(resourceGroup, server, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      // The setting cannot be removed; disable it.
      yield* ignoreNotFound(
        retryInProgress(
          putSetting(
            subscriptionId,
            output.resourceGroup,
            output.serverName,
            "Disabled",
          ),
        ),
      );
    }),

    nuke: { singleton: true },
  });
