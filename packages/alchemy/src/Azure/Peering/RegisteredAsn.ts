import * as peering from "@distilled.cloud/azure/peering";
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
import { createPeeringName, peeringOwnedByStage } from "./Common.ts";

export interface RegisteredAsnProps {
  /** Resource group of the peering. Changing it replaces the registered ASN. */
  resourceGroup: string;
  /** Peering the ASN is registered on. Changing it replaces the registered ASN. */
  peering: string;
  /**
   * Name of the registered ASN. If omitted, a unique name is generated from
   * the app, stage, and logical ID. Changing it replaces the registered ASN.
   */
  name?: string;
  /** Customer ASN served over the peering. Changing it replaces the registered ASN. */
  asn: number;
}

export interface RegisteredAsn extends Resource<
  "Azure.Peering.RegisteredAsn",
  RegisteredAsnProps,
  {
    /** Name of the registered ASN. */
    registeredAsnName: string;
    /** Peering the ASN is registered on. */
    peering: string;
    /** Resource group of the peering. */
    resourceGroup: string;
    /** ARM resource ID of the registered ASN. */
    registeredAsnId: string;
    /** Customer ASN. */
    asn: number;
    /**
     * Peering Service prefix key Microsoft issued for the ASN; customers
     * use it to register prefixes on their peering service.
     */
    peeringServicePrefixKey: string | undefined;
    /** Provisioning state reported by Azure. */
    provisioningState: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A customer ASN registered on a Peering Service provider's peering.
 * Microsoft issues a `peeringServicePrefixKey` that the customer uses to
 * register prefixes on their own `Azure.Peering.PeeringService`.
 *
 * Registered ASNs have no tags; Alchemy treats one as owned when its
 * peering carries this stack's ownership tags.
 *
 * @see https://learn.microsoft.com/azure/internet-peering/howto-peering-service-portal
 *
 * ### Registering a Customer ASN
 * **Example:** Register a customer's ASN on a peering
 * ```typescript
 * const customer = yield* Azure.Peering.RegisteredAsn("customer-a", {
 *   resourceGroup: group.resourceGroupName,
 *   peering: exchange.peeringName,
 *   asn: 65010,
 * });
 * ```
 *
 * @resource
 */
export const RegisteredAsn = Resource<RegisteredAsn>(
  "Azure.Peering.RegisteredAsn",
);

const getRegisteredAsn = (
  subscriptionId: string,
  resourceGroupName: string,
  peeringName: string,
  registeredAsnName: string,
) =>
  orUndefinedIfNotFound(
    peering.GetRegisteredAsn({
      subscriptionId,
      resourceGroupName,
      peeringName,
      registeredAsnName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  peeringName: string,
  name: string,
  observed: peering.GetRegisteredAsnResponse,
): RegisteredAsn["Attributes"] => ({
  registeredAsnName: name,
  peering: peeringName,
  resourceGroup,
  registeredAsnId: observed.id ?? "",
  asn: observed.properties?.asn ?? 0,
  peeringServicePrefixKey: observed.properties?.peeringServicePrefixKey,
  provisioningState: observed.properties?.provisioningState,
});

export const RegisteredAsnProvider = () =>
  Provider.succeed(RegisteredAsn, {
    stables: ["registeredAsnName", "peering", "resourceGroup", "registeredAsnId"],

    // Registered ASNs live inside a peering; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        news.peering.toLowerCase() !== output.peering.toLowerCase() ||
        (news.name !== undefined &&
          news.name.toLowerCase() !== output.registeredAsnName.toLowerCase()) ||
        news.asn !== output.asn
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
      const name =
        output?.registeredAsnName ??
        olds?.name ??
        (yield* createPeeringName(id));
      const observed = yield* getRegisteredAsn(
        subscriptionId,
        resourceGroup,
        peeringName,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, peeringName, name, observed);
      return (yield* peeringOwnedByStage(
        subscriptionId,
        resourceGroup,
        peeringName,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Peering");
      const { resourceGroup } = news;
      const peeringName = news.peering;
      const name =
        news.name ??
        output?.registeredAsnName ??
        (yield* createPeeringName(id));
      const get = getRegisteredAsn(
        subscriptionId,
        resourceGroup,
        peeringName,
        name,
      );

      // Observe.
      const observed = yield* get;

      // Ensure: the ASN is the only property and it is immutable.
      if (observed === undefined) {
        yield* peering.RegisteredAsnsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          peeringName,
          registeredAsnName: name,
          properties: { asn: news.asn },
        });
      }

      const fresh = yield* waitForProvisioned(
        `registered ASN ${name}`,
        get,
        (item) => item.properties?.provisioningState,
      );
      return toAttrs(resourceGroup, peeringName, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        peering.DeleteRegisteredAsn({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          peeringName: output.peering,
          registeredAsnName: output.registeredAsnName,
        }),
      );
      yield* waitUntilGone(
        `registered ASN ${output.registeredAsnName}`,
        getRegisteredAsn(
          subscriptionId,
          output.resourceGroup,
          output.peering,
          output.registeredAsnName,
        ),
      );
    }),

    nuke: {
      dependsOn: ["Azure.Resources.ResourceGroup", "Azure.Peering.Peering"],
    },
  });
