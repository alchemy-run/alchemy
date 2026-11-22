import * as peering from "@distilled.cloud/azure/peering";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import { createPeeringName, peeringOwnedByStage } from "./Common.ts";

export interface RegisteredPrefixProps {
  /**
   * Resource group of the peering.
   *
   * :::caution
   * Changing it replaces the registered prefix.
   * :::
   * @default the stack's resource group (`<stack>-<stage>`)
   */
  resourceGroup: string;
  /**
   * Name of the peering the prefix is registered on.
   *
   * :::caution
   * Changing it replaces the registered prefix.
   * :::
   */
  peering: string;
  /**
   * Name of the registered prefix.
   *
   * :::caution
   * Changing it replaces the registered prefix.
   * :::
   * @default a unique name generated from the app, stage, and logical ID
   */
  name?: string;
  /**
   * Customer IP prefix in CIDR notation, e.g. `203.0.113.0/24`.
   *
   * :::caution
   * Changing it replaces the registered prefix.
   * :::
   */
  prefix: string;
}

export interface RegisteredPrefix extends Resource<
  "Azure.Peering.RegisteredPrefix",
  RegisteredPrefixProps,
  {
    /** Name of the registered prefix. */
    registeredPrefixName: string;
    /** Peering the prefix is registered on. */
    peering: string;
    /** Resource group of the peering. */
    resourceGroup: string;
    /** ARM resource ID of the registered prefix. */
    registeredPrefixId: string;
    /** Customer IP prefix. */
    prefix: string;
    /** Validation state of the prefix (`Verified`, `Pending`, `Failed`, ...). */
    prefixValidationState: string | undefined;
    /**
     * Peering Service prefix key Microsoft issued for the prefix; customers
     * use it to register the prefix on their peering service.
     */
    peeringServicePrefixKey: string | undefined;
    /** Validation error reported by Azure, if any. */
    errorMessage: string | undefined;
    /** Provisioning state reported by Azure. */
    provisioningState: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A customer IP prefix registered on a Peering Service provider's peering
 * (`Microsoft.Peering/peerings/registeredPrefixes`). Microsoft validates
 * that the prefix is announced over the peering and issues a
 * `peeringServicePrefixKey` the customer uses on their own
 * `Azure.Peering.PeeringServicePrefix`.
 *
 * Registered prefixes have no tags; Alchemy treats one as owned when its
 * peering carries this stack's ownership tags.
 *
 * @see https://learn.microsoft.com/azure/internet-peering/howto-peering-service-portal
 *
 * ### Registering a Customer Prefix
 * **Example:** Register a customer's prefix on a peering
 * ```typescript
 * const asn = yield* Azure.Peering.PeerAsn("provider", {
 *   peerAsn: 65000,
 *   peerName: "Contoso Networks",
 *   peerContactDetail: [{ role: "Noc", email: "noc@contoso.com" }],
 * });
 * const exchange = yield* Azure.Peering.Peering("seattle-ix", {
 *   kind: "Exchange",
 *   sku: "Basic_Exchange_Free",
 *   peeringLocation: "Seattle",
 *   exchange: {
 *     peerAsnId: asn.peerAsnId,
 *     connections: [
 *       {
 *         peeringDBFacilityId: 26,
 *         bgpSession: { peerSessionIPv4Address: "198.32.134.10" },
 *       },
 *     ],
 *   },
 * });
 * const prefix = yield* Azure.Peering.RegisteredPrefix("customer-a-v4", {
 *   peering: exchange.peeringName,
 *   prefix: "203.0.113.0/24",
 * });
 * ```
 *
 * @resource
 */
export const RegisteredPrefix = GroupedResource<RegisteredPrefix>("Azure.Peering.RegisteredPrefix");

const getRegisteredPrefix = (
  subscriptionId: string,
  resourceGroupName: string,
  peeringName: string,
  registeredPrefixName: string,
) =>
  orUndefinedIfNotFound(
    peering.GetRegisteredPrefix({
      subscriptionId,
      resourceGroupName,
      peeringName,
      registeredPrefixName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  peeringName: string,
  name: string,
  observed: peering.GetRegisteredPrefixResponse,
): RegisteredPrefix["Attributes"] => ({
  registeredPrefixName: name,
  peering: peeringName,
  resourceGroup,
  registeredPrefixId: observed.id ?? "",
  prefix: observed.properties?.prefix ?? "",
  prefixValidationState: observed.properties?.prefixValidationState,
  peeringServicePrefixKey: observed.properties?.peeringServicePrefixKey,
  errorMessage: observed.properties?.errorMessage,
  provisioningState: observed.properties?.provisioningState,
});

export const RegisteredPrefixProvider = () =>
  Provider.succeed(RegisteredPrefix, {
    stables: ["registeredPrefixName", "peering", "resourceGroup", "registeredPrefixId"],

    // Registered prefixes live inside a peering; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !== output.resourceGroup.toLowerCase() ||
        news.peering.toLowerCase() !== output.peering.toLowerCase() ||
        (news.name !== undefined &&
          news.name.toLowerCase() !== output.registeredPrefixName.toLowerCase()) ||
        news.prefix !== output.prefix
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const peeringName = output?.peering ?? olds?.peering;
      if (resourceGroup === undefined || peeringName === undefined) {
        return undefined;
      }
      const name = output?.registeredPrefixName ?? olds?.name ?? (yield* createPeeringName(id));
      const observed = yield* getRegisteredPrefix(subscriptionId, resourceGroup, peeringName, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, peeringName, name, observed);
      return (yield* peeringOwnedByStage(subscriptionId, resourceGroup, peeringName))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Peering");
      const { resourceGroup } = news;
      const peeringName = news.peering;
      const name = news.name ?? output?.registeredPrefixName ?? (yield* createPeeringName(id));
      const get = getRegisteredPrefix(subscriptionId, resourceGroup, peeringName, name);

      // Observe.
      const observed = yield* get;

      // Ensure: the prefix is the only property and it is immutable.
      if (observed === undefined) {
        yield* peering.RegisteredPrefixesCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          peeringName,
          registeredPrefixName: name,
          properties: { prefix: news.prefix },
        });
      }

      const fresh = yield* waitForProvisioned(
        `registered prefix ${name}`,
        get,
        (item) => item.properties?.provisioningState,
      );
      return toAttrs(resourceGroup, peeringName, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        peering.DeleteRegisteredPrefix({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          peeringName: output.peering,
          registeredPrefixName: output.registeredPrefixName,
        }),
      );
      yield* waitUntilGone(
        `registered prefix ${output.registeredPrefixName}`,
        getRegisteredPrefix(
          subscriptionId,
          output.resourceGroup,
          output.peering,
          output.registeredPrefixName,
        ),
      );
    }),

    nuke: {
      dependsOn: ["Azure.Resources.ResourceGroup", "Azure.Peering.Peering"],
    },
  });
