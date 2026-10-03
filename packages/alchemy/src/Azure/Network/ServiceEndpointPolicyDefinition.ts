import * as network from "@distilled.cloud/azure/network";
import * as Effect from "effect/Effect";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { orUndefinedIfNotFound } from "../Arm.ts";
import type { Providers } from "../Providers.ts";
import { sameSet } from "./common.ts";
import { networkProvider } from "./generic.ts";

export interface ServiceEndpointPolicyDefinitionProps {
  /** Resource group of the policy. Changing it replaces the definition. */
  resourceGroup: string;
  /**
   * Name of the parent service endpoint policy. Changing it replaces the
   * definition.
   */
  serviceEndpointPolicy: string;
  /**
   * Name of the definition. If omitted, a unique name is generated from
   * the app, stage, and logical ID. Changing it replaces the definition.
   */
  name?: string;
  /** Description of the definition. */
  description?: string;
  /**
   * Service the definition applies to.
   * @default "Microsoft.Storage"
   */
  service?: string;
  /**
   * Allowed scopes: storage account, resource group, or subscription ARM
   * IDs (e.g. `/subscriptions/<id>/resourceGroups/<rg>`).
   */
  serviceResources: string[];
}

export interface ServiceEndpointPolicyDefinition extends Resource<
  "Azure.Network.ServiceEndpointPolicyDefinition",
  ServiceEndpointPolicyDefinitionProps,
  {
    /** Name of the definition. */
    definitionName: string;
    /** ARM resource ID of the definition. */
    definitionId: string;
    /** Name of the parent policy. */
    serviceEndpointPolicy: string;
    /** Resource group of the policy. */
    resourceGroup: string;
    /** Service the definition applies to. */
    service: string | undefined;
    /** Allowed scopes. */
    serviceResources: string[];
    /** Description of the definition. */
    description: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A definition in an Azure service endpoint policy — the storage accounts,
 * resource groups, or subscriptions a subnet's service endpoint may reach.
 * Definitions carry no tags: ownership follows the parent policy.
 *
 * @see https://learn.microsoft.com/azure/virtual-network/virtual-network-service-endpoint-policies-overview
 *
 * ### Creating a Definition
 * **Example:** Allow every storage account in a resource group
 * ```typescript
 * yield* Azure.Network.ServiceEndpointPolicyDefinition("group", {
 *   resourceGroup: group.resourceGroupName,
 *   serviceEndpointPolicy: policy.serviceEndpointPolicyName,
 *   serviceResources: [group.resourceGroupId],
 * });
 * ```
 *
 * @resource
 */
export const ServiceEndpointPolicyDefinition =
  Resource<ServiceEndpointPolicyDefinition>(
    "Azure.Network.ServiceEndpointPolicyDefinition",
  );

export const ServiceEndpointPolicyDefinitionProvider = () =>
  Provider.succeed(
    ServiceEndpointPolicyDefinition,
    networkProvider<ServiceEndpointPolicyDefinition>()({
      label: "service endpoint policy definition",
      nameAttr: "definitionName",
      parents: ["serviceEndpointPolicy"],
      tracked: false,
      get: (subscriptionId, path) =>
        orUndefinedIfNotFound(
          network.GetServiceEndpointPolicyDefinition({
            subscriptionId,
            resourceGroupName: path.resourceGroup,
            serviceEndpointPolicyName: path.serviceEndpointPolicy!,
            serviceEndpointPolicyDefinitionName: path.name,
          }),
        ),
      put: (subscriptionId, path, body) =>
        network.ServiceEndpointPolicyDefinitionsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          serviceEndpointPolicyName: path.serviceEndpointPolicy!,
          serviceEndpointPolicyDefinitionName: path.name,
          ...body,
        }),
      del: (subscriptionId, path) =>
        network.DeleteServiceEndpointPolicyDefinition({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          serviceEndpointPolicyName: path.serviceEndpointPolicy!,
          serviceEndpointPolicyDefinitionName: path.name,
        }),
      ownerTags: (subscriptionId, path) =>
        orUndefinedIfNotFound(
          network.GetServiceEndpointPolicy({
            subscriptionId,
            resourceGroupName: path.resourceGroup,
            serviceEndpointPolicyName: path.serviceEndpointPolicy!,
          }),
        ).pipe(Effect.map((policy) => policy?.tags)),
      body: (news) => ({
        properties: {
          description: news.description,
          service: news.service ?? "Microsoft.Storage",
          serviceResources: news.serviceResources,
        },
      }),
      drifted: (observed, _body, news) =>
        (observed.properties?.description ?? undefined) !== news.description ||
        (observed.properties?.service ?? "").toLowerCase() !==
          (news.service ?? "Microsoft.Storage").toLowerCase() ||
        !sameSet(observed.properties?.serviceResources, news.serviceResources),
      toAttrs: (path, observed) => ({
        definitionName: path.name,
        definitionId: observed.id ?? "",
        serviceEndpointPolicy: path.serviceEndpointPolicy!,
        resourceGroup: path.resourceGroup,
        service: observed.properties?.service,
        serviceResources: [...(observed.properties?.serviceResources ?? [])],
        description: observed.properties?.description,
      }),
      dependsOn: ["Azure.Network.ServiceEndpointPolicy"],
    }),
  );
