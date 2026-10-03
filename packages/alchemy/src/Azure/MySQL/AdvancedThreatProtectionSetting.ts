import * as mysql from "@distilled.cloud/azure/mysql";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  NOT_FOUND_TAGS,
  orUndefinedIfNotFound,
  waitForProvisioned,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { MYSQL_NAMESPACE, type ServerRef, whileServerBusy } from "./common.ts";

export interface AdvancedThreatProtectionSettingProps {
  /** Resource group of the server. Changing it replaces the settings. */
  resourceGroup: string;
  /** Name of the flexible server. Changing it replaces the settings. */
  server: string;
  /**
   * Whether Microsoft Defender for open-source relational databases
   * protects the server. Enabling it is billed per server.
   * @default "Enabled"
   */
  state?: "Enabled" | "Disabled";
}

export interface AdvancedThreatProtectionSetting extends Resource<
  "Azure.MySQL.AdvancedThreatProtectionSetting",
  AdvancedThreatProtectionSettingProps,
  {
    /** ARM resource ID of the settings. */
    settingsId: string;
    /** Name of the flexible server. */
    server: string;
    /** Resource group of the server. */
    resourceGroup: string;
    /** Current protection state. */
    state: string;
    /** When the current policy was created (UTC, ISO 8601). */
    creationTime: string | undefined;
  },
  never,
  Providers
> {}

/**
 * Advanced Threat Protection (Microsoft Defender for open-source
 * relational databases) for an Azure Database for MySQL flexible
 * server. A server has exactly one settings object; deleting this resource
 * disables protection.
 *
 * @see https://learn.microsoft.com/azure/defender-for-cloud/defender-for-databases-introduction
 *
 * ### Enabling Threat Protection
 * **Example:** Protect a server
 * ```typescript
 * const protection = yield* Azure.MySQL.AdvancedThreatProtectionSetting(
 *   "protection",
 *   {
 *     resourceGroup: group.resourceGroupName,
 *     server: server.serverName,
 *   },
 * );
 * ```
 *
 * @resource
 */
export const AdvancedThreatProtectionSetting =
  Resource<AdvancedThreatProtectionSetting>(
    "Azure.MySQL.AdvancedThreatProtectionSetting",
  );

const SETTINGS_NAME = "Default";

const getSettings = (ref: ServerRef) =>
  orUndefinedIfNotFound(
    mysql.GetAdvancedThreatProtectionSettings({
      ...ref,
      advancedThreatProtectionName: SETTINGS_NAME,
    }),
  );

const toAttrs = (
  ref: ServerRef,
  settings: mysql.GetAdvancedThreatProtectionSettingsResponse,
): AdvancedThreatProtectionSetting["Attributes"] => ({
  settingsId: settings.id ?? "",
  server: ref.serverName,
  resourceGroup: ref.resourceGroupName,
  state: settings.properties?.state ?? "Disabled",
  creationTime: settings.properties?.creationTime,
});

/** Put the protection state and wait until the server reports it. */
const putState = (ref: ServerRef, state: "Enabled" | "Disabled") =>
  Effect.gen(function* () {
    yield* mysql
      .AdvancedThreatProtectionSettingsUpdatePut({
        ...ref,
        advancedThreatProtectionName: SETTINGS_NAME,
        properties: { state },
      })
      .pipe(Effect.retry(whileServerBusy));
    return yield* waitForProvisioned(
      `MySQL threat protection on ${ref.serverName}`,
      getSettings(ref),
      (settings) =>
        settings.properties?.state === state ? undefined : "Updating",
      { interval: "5 seconds", times: 60 },
    );
  });

const sameText = (a: string | undefined, b: string | undefined) =>
  a?.toLowerCase() === b?.toLowerCase();

export const AdvancedThreatProtectionSettingProvider = () =>
  Provider.succeed(AdvancedThreatProtectionSetting, {
    stables: ["settingsId", "server", "resourceGroup"],

    // A per-server singleton; nothing to enumerate for nuke.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameText(news.resourceGroup, output.resourceGroup) ||
        !sameText(news.server, output.server)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    // The settings always exist with the server, so they are adopted
    // implicitly.
    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroupName = output?.resourceGroup ?? olds?.resourceGroup;
      const serverName = output?.server ?? olds?.server;
      if (resourceGroupName === undefined || serverName === undefined) {
        return undefined;
      }
      const ref = { subscriptionId, resourceGroupName, serverName };
      const observed = yield* getSettings(ref);
      return observed === undefined ? undefined : toAttrs(ref, observed);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, MYSQL_NAMESPACE);
      const ref: ServerRef = {
        subscriptionId,
        resourceGroupName: news.resourceGroup,
        serverName: news.server,
      };
      const state = news.state ?? "Enabled";

      // Observe, then sync the state.
      const observed = yield* getSettings(ref);
      const fresh =
        observed !== undefined && observed.properties?.state === state
          ? observed
          : yield* putState(ref, state);
      return toAttrs(ref, fresh);
    }),

    // Disable protection; a missing server means nothing to disable.
    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const ref: ServerRef = {
        subscriptionId,
        resourceGroupName: output.resourceGroup,
        serverName: output.server,
      };
      const observed = yield* getSettings(ref);
      if (observed === undefined || observed.properties?.state === "Disabled") {
        return;
      }
      yield* putState(ref, "Disabled").pipe(
        Effect.catchTag([...NOT_FOUND_TAGS], () => Effect.void),
      );
    }),

    nuke: { singleton: true },
  });
