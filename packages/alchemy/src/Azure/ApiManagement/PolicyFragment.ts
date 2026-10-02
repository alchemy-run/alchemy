import * as apim from "@distilled.cloud/azure/apimanagement";
import * as Effect from "effect/Effect";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { createEntityName } from "./Common.ts";
import { entityLifecycle, policyInSync } from "./Entity.ts";

export interface PolicyFragmentProps {
  /** Resource group of the API Management service. Changing it replaces the fragment. */
  resourceGroup: string;
  /** API Management service that holds the fragment. Changing it replaces the fragment. */
  serviceName: string;
  /**
   * Fragment identifier, referenced from policies as
   * `<include-fragment fragment-id="..." />`. Changing it replaces the
   * fragment.
   * @default a name generated from the stack, stage, and logical ID
   */
  name?: string;
  /** Policy XML of the fragment, wrapped in a `<fragment>` element. */
  value: string;
  /** Description of the fragment. */
  description?: string;
  /**
   * Format of `value`. `rawxml` skips XML escaping of policy expressions.
   * @default "xml"
   */
  format?: "xml" | "rawxml";
}

export interface PolicyFragment extends Resource<
  "Azure.ApiManagement.PolicyFragment",
  PolicyFragmentProps,
  {
    /** Fragment identifier used by `<include-fragment>`. */
    fragmentName: string;
    /** ARM resource ID of the fragment. */
    fragmentId: string;
    /** API Management service that holds the fragment. */
    serviceName: string;
    /** Resource group of the service. */
    resourceGroup: string;
    /** Fragment XML as stored by Azure. */
    value: string;
  },
  never,
  Providers
> {}

/**
 * A reusable policy fragment of an API Management service. Policies at
 * any scope include it with `<include-fragment fragment-id="..." />`.
 * Azure refuses to delete a fragment while a policy still references it.
 *
 * @see https://learn.microsoft.com/azure/api-management/policy-fragments
 *
 * ### Sharing Policy Logic
 * **Example:** A fragment that stamps a response header
 * ```typescript
 * const fragment = yield* Azure.ApiManagement.PolicyFragment("stamp", {
 *   resourceGroup: group.resourceGroupName,
 *   serviceName: apim.serviceName,
 *   description: "Adds x-served-by",
 *   value: `<fragment>
 *   <set-header name="x-served-by" exists-action="override">
 *     <value>alchemy</value>
 *   </set-header>
 * </fragment>`,
 * });
 * yield* Azure.ApiManagement.ApiPolicy("policy", {
 *   resourceGroup: group.resourceGroupName,
 *   serviceName: apim.serviceName,
 *   apiName: api.apiName,
 *   value: `<policies>
 *   <inbound><base /></inbound>
 *   <backend><base /></backend>
 *   <outbound>
 *     <base />
 *     <include-fragment fragment-id="${fragment.fragmentName}" />
 *   </outbound>
 *   <on-error><base /></on-error>
 * </policies>`,
 * });
 * ```
 *
 * @resource
 */
export const PolicyFragment = Resource<PolicyFragment>(
  "Azure.ApiManagement.PolicyFragment",
);

interface Key {
  resourceGroup: string;
  serviceName: string;
  fragmentName: string;
}

export const PolicyFragmentProvider = () =>
  Provider.succeed(PolicyFragment, {
    stables: ["fragmentName", "fragmentId", "serviceName", "resourceGroup"],
    ...entityLifecycle<
      PolicyFragmentProps,
      PolicyFragment["Attributes"],
      Key,
      apim.GetPolicyFragmentResponse
    >({
      label: (key) => `API Management policy fragment ${key.fragmentName}`,
      keyOf: (props, id, output) =>
        Effect.gen(function* () {
          return {
            resourceGroup: props.resourceGroup,
            serviceName: props.serviceName,
            fragmentName:
              props.name ??
              output?.fragmentName ??
              (yield* createEntityName(id)),
          };
        }),
      keyOfAttrs: (attrs) => attrs,
      get: (subscriptionId, key) =>
        apim.GetPolicyFragment({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          id: key.fragmentName,
        }),
      put: (subscriptionId, key, news) =>
        apim.PolicyFragmentCreateOrUpdate({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          id: key.fragmentName,
          properties: {
            value: news.value,
            description: news.description,
            format: news.format ?? "xml",
          },
        }),
      remove: (subscriptionId, key) =>
        apim.DeletePolicyFragment({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          id: key.fragmentName,
        }),
      inSync: (news, observed) =>
        policyInSync(news, observed) &&
        (news.description === undefined ||
          observed.properties?.description === news.description),
      stateOf: (observed) => observed.properties?.provisioningState,
      toAttrs: (_subscriptionId, key, observed) => ({
        resourceGroup: key.resourceGroup,
        serviceName: key.serviceName,
        fragmentName: key.fragmentName,
        fragmentId: observed.id ?? "",
        value: observed.properties?.value ?? "",
      }),
    }),
  });
