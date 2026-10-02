import * as cognitiveservices from "@distilled.cloud/azure/cognitiveservices";
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
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { isAccountOwnedByStack } from "./Account.ts";
import { sameArm, whileAccountBusy } from "./Common.ts";
import type { WaitBudget } from "../Arm.ts";

/** An account has exactly one managed network, named `default`. */
export const MANAGED_NETWORK_NAME = "default";

/** Managed network changes provision a Microsoft-managed VNet: minutes. */
export const MANAGED_NETWORK_BUDGET: WaitBudget = {
  interval: "10 seconds",
  times: 60,
};

export interface ManagedNetworkProps {
  /** Resource group of the account. Changing it replaces the network. */
  resourceGroup: string;
  /**
   * Account that holds the network. It must have
   * `networkInjections: [{ scenario: "agent", useMicrosoftManagedNetwork: true }]`.
   * Changing it replaces the network.
   */
  account: string;
  /**
   * Outbound isolation. Isolation can only be tightened in place
   * (`Disabled` → `AllowInternetOutbound` → `AllowOnlyApprovedOutbound`).
   * `AllowOnlyApprovedOutbound` with FQDN rules deploys a billed Azure
   * Firewall.
   * @default "AllowInternetOutbound"
   */
  isolationMode?: "Disabled" | "AllowInternetOutbound" | "AllowOnlyApprovedOutbound";
  /**
   * Managed network generation (one-way upgrade from `V1` to `V2`).
   * @default Azure's default (`V2`)
   */
  managedNetworkKind?: "V1" | "V2";
  /**
   * SKU of the Azure Firewall deployed for `AllowOnlyApprovedOutbound`.
   * @default Azure's default (`Standard`)
   */
  firewallSku?: "Basic" | "Standard";
}

export interface ManagedNetwork extends Resource<
  "Azure.CognitiveServices.ManagedNetwork",
  ManagedNetworkProps,
  {
    /** ARM resource ID of the managed network settings. */
    managedNetworkId: string;
    /** Account that holds the network. */
    account: string;
    /** Resource group of the account. */
    resourceGroup: string;
    /** Name of the managed network (always `default`). */
    managedNetworkName: string;
    /** Service-assigned network ID. */
    networkId: string | undefined;
    /** Outbound isolation mode. */
    isolationMode: string | undefined;
    /** Managed network generation. */
    managedNetworkKind: string | undefined;
  },
  never,
  Providers
> {}

/**
 * The Microsoft-managed virtual network of an Azure AI Foundry account
 * (`Microsoft.CognitiveServices/accounts/managedNetworks/default`, preview)
 * that isolates agent compute. Add private-endpoint, FQDN, or service-tag
 * exceptions with `CognitiveServices.OutboundRule`.
 *
 * The account must opt in with
 * `networkInjections: [{ scenario: "agent", useMicrosoftManagedNetwork: true }]`.
 *
 * @see https://learn.microsoft.com/azure/ai-foundry/how-to/managed-network
 *
 * ### Isolating a Foundry Account
 * **Example:** Managed network that allows internet egress
 * ```typescript
 * const account = yield* Azure.CognitiveServices.Account("foundry", {
 *   resourceGroup: group.resourceGroupName,
 *   allowProjectManagement: true,
 *   identity: { type: "SystemAssigned" },
 *   networkInjections: [{ scenario: "agent", useMicrosoftManagedNetwork: true }],
 * });
 * const network = yield* Azure.CognitiveServices.ManagedNetwork("network", {
 *   resourceGroup: group.resourceGroupName,
 *   account: account.accountName,
 *   isolationMode: "AllowInternetOutbound",
 * });
 * ```
 *
 * @resource
 */
export const ManagedNetwork = Resource<ManagedNetwork>(
  "Azure.CognitiveServices.ManagedNetwork",
);

export const getManagedNetwork = (
  subscriptionId: string,
  resourceGroupName: string,
  accountName: string,
) =>
  orUndefinedIfNotFound(
    cognitiveservices.GetManagedNetworkSettings({
      subscriptionId,
      resourceGroupName,
      accountName,
      managedNetworkName: MANAGED_NETWORK_NAME,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  account: string,
  network: cognitiveservices.GetManagedNetworkSettingsResponse,
): ManagedNetwork["Attributes"] => ({
  managedNetworkId: network.id ?? "",
  account,
  resourceGroup,
  managedNetworkName: MANAGED_NETWORK_NAME,
  networkId: network.properties?.managedNetwork?.networkId,
  isolationMode: network.properties?.managedNetwork?.isolationMode,
  managedNetworkKind: network.properties?.managedNetwork?.managedNetworkKind,
});

export const ManagedNetworkProvider = () =>
  Provider.succeed(ManagedNetwork, {
    stables: [
      "managedNetworkId",
      "account",
      "resourceGroup",
      "managedNetworkName",
    ],

    // A per-account singleton; it disappears with the account.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameArm(news.resourceGroup, output.resourceGroup) ||
        !sameArm(news.account, output.account)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    // Managed network settings carry no tags; ownership follows the account.
    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const account = output?.account ?? olds?.account;
      if (resourceGroup === undefined || account === undefined) {
        return undefined;
      }
      const observed = yield* getManagedNetwork(
        subscriptionId,
        resourceGroup,
        account,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, account, observed);
      return (yield* isAccountOwnedByStack(
        subscriptionId,
        resourceGroup,
        account,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.CognitiveServices");
      const { resourceGroup, account } = news;
      const isolationMode = news.isolationMode ?? "AllowInternetOutbound";
      const get = getManagedNetwork(subscriptionId, resourceGroup, account);

      // Observe; PUT the settings (LRO) when missing or different.
      const observed = yield* get;
      const current = observed?.properties?.managedNetwork;
      if (
        observed === undefined ||
        current?.isolationMode !== isolationMode ||
        (news.managedNetworkKind !== undefined &&
          current?.managedNetworkKind !== news.managedNetworkKind) ||
        (news.firewallSku !== undefined &&
          current?.firewallSku !== news.firewallSku)
      ) {
        const where = {
          subscriptionId,
          resourceGroupName: resourceGroup,
          accountName: account,
          managedNetworkName: MANAGED_NETWORK_NAME,
        };
        const properties = {
          managedNetwork: {
            isolationMode,
            managedNetworkKind: news.managedNetworkKind,
            firewallSku: news.firewallSku,
          },
        };
        // PATCH an existing network so outbound rules (managed by
        // `CognitiveServices.OutboundRule`) are left alone.
        if (observed === undefined) {
          yield* cognitiveservices
            .PutManagedNetworkSettings({ ...where, properties })
            .pipe(Effect.retry(whileAccountBusy));
        } else {
          yield* cognitiveservices
            .PatchManagedNetworkSettings({ ...where, properties })
            .pipe(Effect.retry(whileAccountBusy));
        }
      }
      const fresh = yield* waitForProvisioned(
        `managed network of ${account}`,
        get,
        (network) => network.properties?.provisioningState,
        MANAGED_NETWORK_BUDGET,
      );
      return toAttrs(resourceGroup, account, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      // A network still provisioning rejects the delete; let it settle.
      yield* waitForProvisioned(
        `managed network of ${output.account}`,
        getManagedNetwork(subscriptionId, output.resourceGroup, output.account),
        (network) => network.properties?.provisioningState,
        MANAGED_NETWORK_BUDGET,
      ).pipe(Effect.ignore);
      yield* ignoreNotFound(
        cognitiveservices
          .DeleteManagedNetworkSettings({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            accountName: output.account,
            managedNetworkName: MANAGED_NETWORK_NAME,
          })
          .pipe(Effect.retry(whileAccountBusy)),
      );
      yield* waitUntilGone(
        `managed network of ${output.account}`,
        getManagedNetwork(subscriptionId, output.resourceGroup, output.account),
        MANAGED_NETWORK_BUDGET,
      );
    }),
  });
