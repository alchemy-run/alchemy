import * as dr from "@distilled.cloud/azure/recoveryservicesdatareplication";
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
  DATA_REPLICATION_NAMESPACE,
  ownedByVaultOrUnowned,
  sameName,
} from "./Shared.ts";

/** Name of the email configuration every vault uses. */
export const DEFAULT_EMAIL_CONFIGURATION = "default";

export interface AlertSettingProps {
  /** Resource group of the vault. Changing it replaces the setting. */
  resourceGroup: string;
  /** Name of the data replication vault. Changing it replaces the setting. */
  vault: string;
  /**
   * Email configuration name. Changing it replaces the setting.
   * @default "default"
   */
  name?: string;
  /**
   * Whether alert emails go to the subscription owners.
   * @default false
   */
  sendToOwners?: boolean;
  /**
   * Additional email addresses that receive replication alerts.
   * @default []
   */
  customEmailAddresses?: string[];
  /**
   * Locale of the alert emails, e.g. `en-US`.
   * @default unmanaged
   */
  locale?: string;
}

export interface AlertSetting extends Resource<
  "Azure.DataReplication.AlertSetting",
  AlertSettingProps,
  {
    /** Name of the email configuration. */
    alertSettingName: string;
    /** Name of the vault. */
    vault: string;
    /** Resource group of the vault. */
    resourceGroup: string;
    /** ARM resource ID of the email configuration. */
    alertSettingId: string;
    /** Whether alert emails go to the subscription owners. */
    sendToOwners: boolean;
    /** Additional alert email recipients. */
    customEmailAddresses: string[];
    /** Locale of the alert emails. */
    locale: string | undefined;
  },
  never,
  Providers
> {}

/**
 * Email notification settings of an Azure Site Recovery data replication
 * vault (`replicationVaults/alertSettings`): who is emailed about
 * replication health, failover, and job events.
 *
 * Email configurations cannot be tagged; Alchemy treats one as owned when
 * its vault is tagged for the current stack and stage. There is no delete
 * API: destroying the resource resets it to `sendToOwners: false` with no
 * recipients, and it disappears with the vault.
 *
 * @see https://learn.microsoft.com/rest/api/datareplication/email-configuration/create
 *
 * ### Notifications
 * **Example:** Email the owners and an on-call alias
 * ```typescript
 * const vault = yield* Azure.DataReplication.Vault("vault", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * yield* Azure.DataReplication.AlertSetting("alerts", {
 *   resourceGroup: group.resourceGroupName,
 *   vault: vault.vaultName,
 *   sendToOwners: true,
 *   customEmailAddresses: ["oncall@example.com"],
 *   locale: "en-US",
 * });
 * ```
 *
 * @resource
 */
export const AlertSetting = Resource<AlertSetting>(
  "Azure.DataReplication.AlertSetting",
);

type Observed = dr.GetEmailConfigurationResponse;

interface Where {
  subscriptionId: string;
  resourceGroupName: string;
  vaultName: string;
  emailConfigurationName: string;
}

const getSetting = (where: Where) =>
  orUndefinedIfNotFound(dr.GetEmailConfiguration(where));

const desiredOf = (news: AlertSettingProps) => ({
  sendToOwners: news.sendToOwners ?? false,
  customEmailAddresses: news.customEmailAddresses ?? [],
  locale: news.locale,
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
  (observed.properties?.sendToOwners ?? false) === desired.sendToOwners &&
  sameEmails(
    observed.properties?.customEmailAddresses ?? [],
    desired.customEmailAddresses,
  ) &&
  (desired.locale === undefined ||
    sameName(observed.properties?.locale, desired.locale));

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
  sendToOwners: observed.properties?.sendToOwners ?? false,
  customEmailAddresses: [...(observed.properties?.customEmailAddresses ?? [])],
  locale: observed.properties?.locale,
});

export const AlertSettingProvider = () =>
  Provider.succeed(AlertSetting, {
    stables: ["alertSettingName", "vault", "resourceGroup", "alertSettingId"],

    // A vault child that disappears with its vault.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.vault, output.vault) ||
        !sameName(
          news.name ?? DEFAULT_EMAIL_CONFIGURATION,
          output.alertSettingName,
        )
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
        output?.alertSettingName ?? olds?.name ?? DEFAULT_EMAIL_CONFIGURATION;
      const observed = yield* getSetting({
        subscriptionId,
        resourceGroupName: resourceGroup,
        vaultName: vault,
        emailConfigurationName: name,
      });
      if (observed === undefined) return undefined;
      return yield* ownedByVaultOrUnowned(
        toAttrs(resourceGroup, vault, name, observed),
        output !== undefined,
        subscriptionId,
        resourceGroup,
        vault,
      );
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, DATA_REPLICATION_NAMESPACE);
      const name = news.name ?? DEFAULT_EMAIL_CONFIGURATION;
      const where: Where = {
        subscriptionId,
        resourceGroupName: news.resourceGroup,
        vaultName: news.vault,
        emailConfigurationName: name,
      };
      const desired = desiredOf(news);

      // Observe; the PUT is a synchronous upsert, sent only on a delta.
      const observed = yield* getSetting(where);
      if (observed !== undefined && matches(observed, desired)) {
        return toAttrs(news.resourceGroup, news.vault, name, observed);
      }
      yield* dr.CreateEmailConfiguration({
        ...where,
        properties: {
          ...desired,
          locale: desired.locale ?? observed?.properties?.locale,
        },
      });
      const fresh = yield* waitForProvisioned(
        `data replication alert setting ${name}`,
        getSetting(where),
        (setting) =>
          matches(setting, desired)
            ? setting.properties?.provisioningState
            : "Updating",
        { interval: "3 seconds", times: 20 },
      );
      return toAttrs(news.resourceGroup, news.vault, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const where: Where = {
        subscriptionId,
        resourceGroupName: output.resourceGroup,
        vaultName: output.vault,
        emailConfigurationName: output.alertSettingName,
      };
      // No delete API: reset to no recipients (gone with the vault).
      const observed = yield* getSetting(where);
      if (observed === undefined) return;
      yield* ignoreNotFound(
        dr.CreateEmailConfiguration({
          ...where,
          properties: {
            sendToOwners: false,
            customEmailAddresses: [],
            locale: observed.properties?.locale,
          },
        }),
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
