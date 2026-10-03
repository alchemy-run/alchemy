import * as network from "@distilled.cloud/azure/network";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { orUndefinedIfNotFound, userTags } from "../Arm.ts";
import type { Providers } from "../Providers.ts";
import { sameSet } from "./common.ts";
import { idsOf, networkProvider } from "./generic.ts";

export interface ServiceEndpointPolicyProps {
  /** Resource group of the policy. Changing it replaces the policy. */
  resourceGroup: string;
  /**
   * Name of the policy: 1-80 letters, digits, `_`, `.`, and `-`. If
   * omitted, a unique name is generated from the app, stage, and logical
   * ID. Changing it replaces the policy.
   */
  name?: string;
  /**
   * Azure location. Must match the location of the subnets it is applied
   * to. Changing it replaces the policy.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /** Alias of the service the policy applies to (e.g. a `/services/Azure/...` alias). */
  serviceAlias?: string;
  /** ARM IDs of contextual service endpoint policies. */
  contextualServiceEndpointPolicies?: string[];
  /** User tags. Alchemy ownership tags are merged in automatically. */
  tags?: Record<string, string>;
}

export interface ServiceEndpointPolicy extends Resource<
  "Azure.Network.ServiceEndpointPolicy",
  ServiceEndpointPolicyProps,
  {
    /** Name of the policy. */
    serviceEndpointPolicyName: string;
    /** ARM resource ID of the policy. */
    serviceEndpointPolicyId: string;
    /** Resource group of the policy. */
    resourceGroup: string;
    /** Location of the policy. */
    location: string;
    /** Immutable GUID Azure assigned to the policy. */
    resourceGuid: string | undefined;
    /** Names of the policy's definitions. */
    definitionNames: string[];
    /** IDs of the subnets the policy is applied to. */
    subnetIds: string[];
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure service endpoint policy — restricts which Azure Storage
 * accounts (or other service resources) a subnet's service endpoint may
 * reach, preventing data exfiltration. Add definitions with
 * {@link ServiceEndpointPolicyDefinition} and apply the policy to a
 * subnet. Policies are free.
 *
 * @see https://learn.microsoft.com/azure/virtual-network/virtual-network-service-endpoint-policies-overview
 *
 * ### Creating a Policy
 * **Example:** Allow one storage account
 * ```typescript
 * const policy = yield* Azure.Network.ServiceEndpointPolicy("storage", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * yield* Azure.Network.ServiceEndpointPolicyDefinition("account", {
 *   resourceGroup: group.resourceGroupName,
 *   serviceEndpointPolicy: policy.serviceEndpointPolicyName,
 *   service: "Microsoft.Storage",
 *   serviceResources: [account.storageAccountId],
 * });
 * ```
 *
 * @resource
 */
export const ServiceEndpointPolicy = Resource<ServiceEndpointPolicy>(
  "Azure.Network.ServiceEndpointPolicy",
);

export const ServiceEndpointPolicyProvider = () =>
  Provider.succeed(
    ServiceEndpointPolicy,
    networkProvider<ServiceEndpointPolicy>()({
      label: "service endpoint policy",
      nameAttr: "serviceEndpointPolicyName",
      tracked: true,
      get: (subscriptionId, path) =>
        orUndefinedIfNotFound(
          network.GetServiceEndpointPolicy({
            subscriptionId,
            resourceGroupName: path.resourceGroup,
            serviceEndpointPolicyName: path.name,
          }),
        ),
      put: (subscriptionId, path, body) =>
        network.ServiceEndpointPoliciesCreateOrUpdate({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          serviceEndpointPolicyName: path.name,
          ...body,
        }),
      del: (subscriptionId, path) =>
        network.DeleteServiceEndpointPolicy({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          serviceEndpointPolicyName: path.name,
        }),
      updateTags: (subscriptionId, path, tags) =>
        network.UpdateServiceEndpointPolicyTags({
          subscriptionId,
          resourceGroupName: path.resourceGroup,
          serviceEndpointPolicyName: path.name,
          tags,
        }),
      listAll: (subscriptionId) =>
        network.ListServiceEndpointPolicies({ subscriptionId }),
      // The PUT replaces the definition collection: carry the observed
      // definitions (managed by ServiceEndpointPolicyDefinition).
      body: (news, { location, tags, observed }) => ({
        location,
        tags,
        properties: {
          serviceAlias: news.serviceAlias,
          contextualServiceEndpointPolicies:
            news.contextualServiceEndpointPolicies,
          serviceEndpointPolicyDefinitions: (
            observed?.properties?.serviceEndpointPolicyDefinitions ?? []
          ).map((definition) => ({
            name: definition.name,
            properties: definition.properties && {
              description: definition.properties.description,
              service: definition.properties.service,
              serviceResources: definition.properties.serviceResources,
            },
          })),
        },
      }),
      drifted: (observed, _body, news) =>
        (news.serviceAlias !== undefined &&
          news.serviceAlias !== observed.properties?.serviceAlias) ||
        (news.contextualServiceEndpointPolicies !== undefined &&
          !sameSet(
            observed.properties?.contextualServiceEndpointPolicies,
            news.contextualServiceEndpointPolicies,
          )),
      toAttrs: (path, observed) => ({
        serviceEndpointPolicyName: path.name,
        serviceEndpointPolicyId: observed.id ?? "",
        resourceGroup: path.resourceGroup,
        location: observed.location ?? "",
        resourceGuid: observed.properties?.resourceGuid,
        definitionNames: (
          observed.properties?.serviceEndpointPolicyDefinitions ?? []
        ).flatMap((definition) =>
          definition.name === undefined ? [] : [definition.name],
        ),
        subnetIds: idsOf(observed.properties?.subnets),
        tags: userTags(observed.tags),
      }),
    }),
  );
