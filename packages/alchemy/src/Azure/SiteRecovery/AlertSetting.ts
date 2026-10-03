import * as asr from "@distilled.cloud/azure/recoveryservicessiterecovery";
import * as Effect from "effect/Effect";
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
import {
  ignoreNoRegisteredServers,
  ownedOrUnowned,
  retryUntilServersRegistered,
  retryWhileVaultRegistering,
  sameName,
  SITE_RECOVERY_NAMESPACE,
} from "./Shared.ts";

/** The alert setting every vault has. */
export const DEFAULT_ALERT_SETTING = "defaultAlertSetting";

export interface AlertSettingProps {
  /** Resource group of the Recovery Services vault. Changing it replaces the setting. */
  resourceGroup: string;
  /** Name of the Recovery Services vault. Changing it replaces the setting. */
  vault: string;
  /**
   * Alert setting name. Changing it replaces the setting.
   * @default "defaultAlertSetting"
   */
  name?: string;
  /**
   * Whether Site Recovery alert emails go to the subscription owners.
   * @default "DoNotSend"
   */
  sendToOwners?: "Send" | "DoNotSend";
  /**
   * Additional email addresses that receive Site Recovery alerts.
   * @default []
   */
  customEmailAddresses?: string[];
  /**
   * Locale of the alert emails, e.g. `en-US`.
   * @default ""
   */
  locale?: string;
}

export interface AlertSetting extends Resource<
  "Azure.SiteRecovery.AlertSetting",
  AlertSettingProps,
  {
    /** Name of the alert setting. */
    alertSettingName: string;
    /** Name of the Recovery Services vault. */
    vault: string;
    /** Resource group of the vault. */
    resourceGroup: string;
    /** ARM resource ID of the alert setting. */
    alertSettingId: string;
    /** Whether alert emails go to the subscription owners. */
    sendToOwners: string | undefined;
    /** Additional alert email recipients. */
    customEmailAddresses: string[];
    /** Locale of the alert emails. */
    locale: string | undefined;
  },
  never,
  Providers
> {}

/**
 * Azure Site Recovery email notification settings of a Recovery Services
 * vault: who gets emailed about replication health, failover, and
 * configuration events.
 *
 * Every vault has exactly one alert setting (`defaultAlertSetting`), so
 * this resource manages that singleton; Alchemy treats it as owned when its
 * vault is tagged for the current stack and stage. There is no delete API:
 * destroying the resource resets it to `DoNotSend` with no recipients.
 *
 * Site Recovery only accepts alert settings once the vault has at least one
 * registered fabric (e.g. an Azure-to-Azure `Fabric`). A fabric deployed in
 * the same stack is waited for (up to ~5 minutes); without one the write
 * fails with `SiteRecoveryNoRegisteredServers`.
 *
 * @see https://learn.microsoft.com/rest/api/site-recovery/replication-alert-settings/create
 *
 * ### Notifications
 * **Example:** Email the owners and an on-call alias
 * ```typescript
 * yield* Azure.SiteRecovery.Fabric("primary", {
 *   resourceGroup: group.resourceGroupName,
 *   vault: vault.vaultName,
 *   location: "eastus",
 * });
 * yield* Azure.SiteRecovery.AlertSetting("dr-alerts", {
 *   resourceGroup: group.resourceGroupName,
 *   vault: vault.vaultName,
 *   sendToOwners: "Send",
 *   customEmailAddresses: ["oncall@example.com"],
 *   locale: "en-US",
 * });
 * ```
 *
 * @resource
 */
export const AlertSetting = Resource<AlertSetting>(
  "Azure.SiteRecovery.AlertSetting",
);

type Observed = asr.GetReplicationAlertSettingsResponse;

interface Where {
  subscriptionId: string;
  resourceGroupName: string;
  resourceName: string;
  alertSettingName: string;
}

const getAlertSetting = (where: Where) =>
  orUndefinedIfNotFound(
    retryWhileVaultRegistering(asr.GetReplicationAlertSettings(where)),
  );

const desiredOf = (news: AlertSettingProps) => ({
  sendToOwners: news.sendToOwners ?? "DoNotSend",
  customEmailAddresses: news.customEmailAddresses ?? [],
  locale: news.locale ?? "",
});

const sameEmails = (a: readonly string[], b: readonly string[]) => {
  const norm = (list: readonly string[]) =>
    [...list].map((e) => e.toLowerCase()).sort();
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
};

const matches = (
  observed: Observed | undefined,
  desired: ReturnType<typeof desiredOf>,
) =>
  observed !== undefined &&
  sameName(observed.properties?.sendToOwners, desired.sendToOwners) &&
  sameEmails(
    observed.properties?.customEmailAddresses ?? [],
    desired.customEmailAddresses,
  ) &&
  (observed.properties?.locale ?? "") === desired.locale;

const toAttrs = (
  resourceGroup: string,
  vault: string,
  name: string,
  observed: Observed,
): AlertSetting["Attributes"] => ({
  alertSettingName: name,
  vault,
  resourceGroup,
  alertSettingId: observed.id ?? "",
  sendToOwners: observed.properties?.sendToOwners,
  customEmailAddresses: [...(observed.properties?.customEmailAddresses ?? [])],
  locale: observed.properties?.locale,
});

export const AlertSettingProvider = () =>
  Provider.succeed(AlertSetting, {
    stables: ["alertSettingName", "vault", "resourceGroup", "alertSettingId"],

    // A vault singleton that disappears with its vault.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.vault, output.vault) ||
        !sameName(news.name ?? DEFAULT_ALERT_SETTING, output.alertSettingName)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const vault = output?.vault ?? olds?.vault;
      if (resourceGroup === undefined || vault === undefined) return undefined;
      const name =
        output?.alertSettingName ?? olds?.name ?? DEFAULT_ALERT_SETTING;
      const observed = yield* getAlertSetting({
        subscriptionId,
        resourceGroupName: resourceGroup,
        resourceName: vault,
        alertSettingName: name,
      });
      if (observed === undefined) return undefined;
      return yield* ownedOrUnowned(
        toAttrs(resourceGroup, vault, name, observed),
        output !== undefined,
        subscriptionId,
        resourceGroup,
        vault,
      );
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, SITE_RECOVERY_NAMESPACE);
      const name = news.name ?? DEFAULT_ALERT_SETTING;
      const where: Where = {
        subscriptionId,
        resourceGroupName: news.resourceGroup,
        resourceName: news.vault,
        alertSettingName: name,
      };
      const desired = desiredOf(news);

      // Observe; the PUT is a synchronous upsert, sent only on a delta.
      const observed = yield* getAlertSetting(where);
      if (observed !== undefined && matches(observed, desired)) {
        return toAttrs(news.resourceGroup, news.vault, name, observed);
      }
      yield* retryWhileVaultRegistering(
        asr.CreateReplicationAlertSettings({
          ...where,
          properties: desired,
        }),
      ).pipe(retryUntilServersRegistered);
      const fresh = yield* waitForProvisioned(
        `site recovery alert setting ${name}`,
        getAlertSetting(where),
        (setting) => (matches(setting, desired) ? undefined : "Updating"),
        { interval: "3 seconds", times: 20 },
      );
      return toAttrs(news.resourceGroup, news.vault, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const where: Where = {
        subscriptionId,
        resourceGroupName: output.resourceGroup,
        resourceName: output.vault,
        alertSettingName: output.alertSettingName,
      };
      // No delete API: reset to the vault default (gone with the vault).
      const observed = yield* getAlertSetting(where);
      if (observed === undefined) return;
      yield* ignoreNotFound(
        retryWhileVaultRegistering(
          asr.CreateReplicationAlertSettings({
            ...where,
            properties: desiredOf({
              resourceGroup: output.resourceGroup,
              vault: output.vault,
            }),
          }),
        ),
      ).pipe(
        // Once the vault's last fabric is unregistered the setting can no
        // longer be written, and no alerts can fire: nothing to reset.
        ignoreNoRegisteredServers,
      );
    }),

    nuke: {
      dependsOn: ["Azure.Resources.ResourceGroup"],
    },
  });
