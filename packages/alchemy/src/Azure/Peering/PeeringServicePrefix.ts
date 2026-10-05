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
import { createPeeringName, peeringServiceOwnedByStage } from "./Common.ts";

export interface PeeringServicePrefixProps {
  /** Resource group of the peering service. Changing it replaces the prefix. */
  resourceGroup: string;
  /** Peering service the prefix is registered on. Changing it replaces the prefix. */
  peeringService: string;
  /**
   * Name of the prefix resource. If omitted, a unique name is generated
   * from the app, stage, and logical ID. Changing it replaces the prefix.
   */
  name?: string;
  /** IP prefix in CIDR notation, e.g. `203.0.113.0/24`. Changing it replaces the prefix. */
  prefix: string;
  /**
   * Prefix key issued by the Peering Service provider for this prefix.
   * Changing it replaces the prefix.
   */
  peeringServicePrefixKey: string;
}

export interface PeeringServicePrefix extends Resource<
  "Azure.Peering.PeeringServicePrefix",
  PeeringServicePrefixProps,
  {
    /** Name of the prefix resource. */
    prefixName: string;
    /** Peering service the prefix is registered on. */
    peeringService: string;
    /** Resource group of the peering service. */
    resourceGroup: string;
    /** ARM resource ID of the prefix. */
    prefixId: string;
    /** IP prefix in CIDR notation. */
    prefix: string;
    /** Validation state of the prefix (`Verified`, `Pending`, `Failed`, ...). */
    prefixValidationState: string | undefined;
    /** How the prefix was learned (`ViaServiceProvider`, `ViaSession`, ...). */
    learnedType: string | undefined;
    /** Validation error reported by Azure, if any. */
    errorMessage: string | undefined;
    /** Provisioning state reported by Azure. */
    provisioningState: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An IP prefix registered on an Azure Peering Service. Azure validates the
 * prefix against the provider-issued prefix key; registration fails with
 * `PeeringServicePrefixKeyInvalid` or `PeeringServicePrefixValidationFailed`
 * when the provider has not provisioned the prefix for you.
 *
 * Prefixes have no tags; Alchemy treats a prefix as owned when its peering
 * service carries this stack's ownership tags.
 *
 * @see https://learn.microsoft.com/azure/peering-service/about
 *
 * ### Registering a Prefix
 * **Example:** Prefix with a provider key
 * ```typescript
 * const prefix = yield* Azure.Peering.PeeringServicePrefix("office-v4", {
 *   resourceGroup: group.resourceGroupName,
 *   peeringService: service.peeringServiceName,
 *   prefix: "203.0.113.0/24",
 *   peeringServicePrefixKey: providerPrefixKey,
 * });
 * ```
 *
 * @resource
 */
export const PeeringServicePrefix = Resource<PeeringServicePrefix>(
  "Azure.Peering.PeeringServicePrefix",
);

const getPrefix = (
  subscriptionId: string,
  resourceGroupName: string,
  peeringServiceName: string,
  prefixName: string,
) =>
  orUndefinedIfNotFound(
    peering.GetPrefix({
      subscriptionId,
      resourceGroupName,
      peeringServiceName,
      prefixName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  peeringService: string,
  name: string,
  observed: peering.GetPrefixResponse,
): PeeringServicePrefix["Attributes"] => ({
  prefixName: name,
  peeringService,
  resourceGroup,
  prefixId: observed.id ?? "",
  prefix: observed.properties?.prefix ?? "",
  prefixValidationState: observed.properties?.prefixValidationState,
  learnedType: observed.properties?.learnedType,
  errorMessage: observed.properties?.errorMessage,
  provisioningState: observed.properties?.provisioningState,
});

export const PeeringServicePrefixProvider = () =>
  Provider.succeed(PeeringServicePrefix, {
    stables: ["prefixName", "peeringService", "resourceGroup", "prefixId"],

    // Prefixes live inside a peering service; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        news.peeringService.toLowerCase() !==
          output.peeringService.toLowerCase() ||
        (news.name !== undefined &&
          news.name.toLowerCase() !== output.prefixName.toLowerCase()) ||
        news.prefix !== output.prefix ||
        (olds !== undefined &&
          news.peeringServicePrefixKey !== olds.peeringServicePrefixKey)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const peeringService = output?.peeringService ?? olds?.peeringService;
      if (resourceGroup === undefined || peeringService === undefined) {
        return undefined;
      }
      const name =
        output?.prefixName ?? olds?.name ?? (yield* createPeeringName(id));
      const observed = yield* getPrefix(
        subscriptionId,
        resourceGroup,
        peeringService,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, peeringService, name, observed);
      return (yield* peeringServiceOwnedByStage(
        subscriptionId,
        resourceGroup,
        peeringService,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Peering");
      const { resourceGroup, peeringService } = news;
      const name =
        news.name ?? output?.prefixName ?? (yield* createPeeringName(id));
      const get = getPrefix(subscriptionId, resourceGroup, peeringService, name);

      // Observe.
      const observed = yield* get;

      // Ensure: every property is immutable, so an existing prefix is only
      // re-registered when it is missing.
      if (observed === undefined) {
        yield* peering.PrefixesCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          peeringServiceName: peeringService,
          prefixName: name,
          properties: {
            prefix: news.prefix,
            peeringServicePrefixKey: news.peeringServicePrefixKey,
          },
        });
      }

      const fresh = yield* waitForProvisioned(
        `peering service prefix ${name}`,
        get,
        (prefix) => prefix.properties?.provisioningState,
      );
      return toAttrs(resourceGroup, peeringService, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        peering.DeletePrefix({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          peeringServiceName: output.peeringService,
          prefixName: output.prefixName,
        }),
      );
      yield* waitUntilGone(
        `peering service prefix ${output.prefixName}`,
        getPrefix(
          subscriptionId,
          output.resourceGroup,
          output.peeringService,
          output.prefixName,
        ),
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.Resources.ResourceGroup",
        "Azure.Peering.PeeringService",
      ],
    },
  });
