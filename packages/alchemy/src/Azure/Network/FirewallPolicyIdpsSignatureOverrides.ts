import * as network from "@distilled.cloud/azure/network";
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
import {
  parentOwned,
  sameId,
  waitNetworkProvisioned,
  whileNetworkBusy,
} from "./common.ts";

/** IDPS mode of one signature override. */
export type IdpsSignatureMode = "Off" | "Alert" | "Deny";

export interface FirewallPolicyIdpsSignatureOverridesProps {
  /**
   * Resource group of the firewall policy. Changing it replaces the
   * overrides.
   */
  resourceGroup: string;
  /**
   * Name of the parent Premium firewall policy. Changing it replaces the
   * overrides.
   */
  firewallPolicy: string;
  /**
   * Signature ID → mode, e.g. `{ "2024897": "Deny", "2024898": "Off" }`.
   * The map is authoritative: signatures not listed fall back to the
   * policy's IDPS mode.
   */
  signatures: Record<string, IdpsSignatureMode>;
}

export interface FirewallPolicyIdpsSignatureOverrides extends Resource<
  "Azure.Network.FirewallPolicyIdpsSignatureOverrides",
  FirewallPolicyIdpsSignatureOverridesProps,
  {
    /** ARM resource ID of the overrides (`.../signatureOverrides/default`). */
    signatureOverridesId: string;
    /** Name of the parent firewall policy. */
    firewallPolicy: string;
    /** Resource group of the firewall policy. */
    resourceGroup: string;
    /** Signature ID → mode currently applied. */
    signatures: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * The IDPS signature overrides of an Azure Firewall Premium policy — the
 * singleton `default` map that switches individual intrusion-detection
 * signatures to `Off`, `Alert`, or `Deny` regardless of the policy's IDPS
 * mode. The overrides carry no tags: ownership follows the parent policy.
 * Destroying the resource clears every override (the singleton itself
 * cannot be deleted).
 *
 * @see https://learn.microsoft.com/azure/firewall/premium-features#idps-signature-rules
 *
 * ### Overriding Signatures
 * **Example:** Deny one signature and silence another
 * ```typescript
 * const policy = yield* Azure.Network.FirewallPolicy("premium", {
 *   resourceGroup: group.resourceGroupName,
 *   tier: "Premium",
 * });
 * yield* Azure.Network.FirewallPolicyIdpsSignatureOverrides("idps", {
 *   resourceGroup: group.resourceGroupName,
 *   firewallPolicy: policy.firewallPolicyName,
 *   signatures: { "2024897": "Deny", "2024898": "Off" },
 * });
 * ```
 *
 * @resource
 */
export const FirewallPolicyIdpsSignatureOverrides =
  Resource<FirewallPolicyIdpsSignatureOverrides>(
    "Azure.Network.FirewallPolicyIdpsSignatureOverrides",
  );

const definedEntries = (
  map: Record<string, string | undefined> | undefined,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(map ?? {}).flatMap(([k, v]) =>
      v === undefined ? [] : [[k, v]],
    ),
  );

const sameSignatures = (a: Record<string, string>, b: Record<string, string>) =>
  Object.keys(a).length === Object.keys(b).length &&
  Object.entries(a).every(([k, v]) => b[k]?.toLowerCase() === v.toLowerCase());

export const FirewallPolicyIdpsSignatureOverridesProvider = () =>
  Provider.succeed(FirewallPolicyIdpsSignatureOverrides, {
    stables: ["signatureOverridesId", "firewallPolicy", "resourceGroup"],

    // The singleton vanishes with its policy.
    list: Effect.fn(function* () {
      return [] as Array<FirewallPolicyIdpsSignatureOverrides["Attributes"]>;
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameId(news.resourceGroup, output.resourceGroup) ||
        !sameId(news.firewallPolicy, output.firewallPolicy)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const firewallPolicy = output?.firewallPolicy ?? olds?.firewallPolicy;
      if (resourceGroup === undefined || firewallPolicy === undefined) {
        return undefined;
      }
      const policy = yield* orUndefinedIfNotFound(
        network.GetFirewallPolicy({
          subscriptionId,
          resourceGroupName: resourceGroup,
          firewallPolicyName: firewallPolicy,
        }),
      );
      if (policy === undefined) return undefined;
      const observed = yield* orUndefinedIfNotFound(
        network.GetFirewallPolicyIdpsSignaturesOverride({
          subscriptionId,
          resourceGroupName: resourceGroup,
          firewallPolicyName: firewallPolicy,
        }),
      );
      if (observed === undefined) return undefined;
      const attrs = {
        signatureOverridesId: observed.id ?? "",
        firewallPolicy,
        resourceGroup,
        signatures: definedEntries(observed.properties?.signatures),
      };
      return (yield* parentOwned(policy.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Network");
      const path = {
        subscriptionId,
        resourceGroupName: news.resourceGroup,
        firewallPolicyName: news.firewallPolicy,
      };

      // The singleton exists once the Premium policy finished provisioning.
      yield* waitNetworkProvisioned(
        `firewall policy ${news.firewallPolicy}`,
        orUndefinedIfNotFound(network.GetFirewallPolicy(path)),
      );

      // Observe (404 until the first override is written).
      const observed = (yield* orUndefinedIfNotFound(
        network.GetFirewallPolicyIdpsSignaturesOverride(path),
      )) ?? { id: undefined, properties: { signatures: {} } };
      const desired: Record<string, string> = { ...news.signatures };

      // Sync: PUT the full map only when it drifted.
      const final = sameSignatures(
        desired,
        definedEntries(observed.properties?.signatures),
      )
        ? observed
        : yield* network
            .PutFirewallPolicyIdpsSignaturesOverride({
              ...path,
              properties: { signatures: desired },
            })
            .pipe(Effect.retry(whileNetworkBusy));
      return {
        signatureOverridesId: final.id ?? observed.id ?? "",
        firewallPolicy: news.firewallPolicy,
        resourceGroup: news.resourceGroup,
        signatures: definedEntries(final.properties?.signatures),
      };
    }),

    // No DELETE API: clear every override (gone with the policy is fine).
    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        network.PutFirewallPolicyIdpsSignaturesOverride({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          firewallPolicyName: output.firewallPolicy,
          properties: { signatures: {} },
        }),
      ).pipe(Effect.retry(whileNetworkBusy));
    }),

    nuke: {
      dependsOn: [
        "Azure.Network.FirewallPolicy",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
