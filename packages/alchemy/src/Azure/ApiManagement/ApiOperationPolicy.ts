import * as apim from "@distilled.cloud/azure/apimanagement";
import * as Effect from "effect/Effect";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { entityLifecycle, policyInSync } from "./Entity.ts";
import type { PolicyFormat } from "./ServicePolicy.ts";

export interface ApiOperationPolicyProps {
  /** Resource group of the API Management service. Changing it replaces the policy. */
  resourceGroup: string;
  /** API Management service that holds the API. Changing it replaces the policy. */
  serviceName: string;
  /** Identifier of the API that holds the operation. Changing it replaces the policy. */
  apiName: string;
  /** Identifier of the operation the policy applies to. Changing it replaces the policy. */
  operationName: string;
  /**
   * Policy document (or a URL to one when `format` is a `-link` format).
   * Use `<base />` to inherit the API, product, and global policies.
   */
  value: string;
  /**
   * Format of `value`. `rawxml` skips XML escaping of policy expressions.
   * @default "xml"
   */
  format?: PolicyFormat;
}

export interface ApiOperationPolicy extends Resource<
  "Azure.ApiManagement.ApiOperationPolicy",
  ApiOperationPolicyProps,
  {
    /** ARM resource ID of the policy. */
    policyId: string;
    /** Identifier of the operation the policy applies to. */
    operationName: string;
    /** Identifier of the API that holds the operation. */
    apiName: string;
    /** API Management service that holds the API. */
    serviceName: string;
    /** Resource group of the service. */
    resourceGroup: string;
    /** Policy document as stored by Azure (XML). */
    value: string;
  },
  never,
  Providers
> {}

/**
 * The policy of a single API operation in an API Management service.
 * There is one per operation; deleting it reverts the operation to the
 * inherited (`<base />`) behavior.
 *
 * @see https://learn.microsoft.com/azure/api-management/set-edit-policies
 *
 * ### Setting an Operation Policy
 * **Example:** Mock the response of one operation
 * ```typescript
 * yield* Azure.ApiManagement.ApiOperationPolicy("get-order-mock", {
 *   resourceGroup: group.resourceGroupName,
 *   serviceName: apim.serviceName,
 *   apiName: api.apiName,
 *   operationName: getOrder.operationName,
 *   value: `<policies>
 *   <inbound>
 *     <base />
 *     <return-response>
 *       <set-status code="200" reason="OK" />
 *       <set-body>{"id": 1}</set-body>
 *     </return-response>
 *   </inbound>
 *   <backend><base /></backend>
 *   <outbound><base /></outbound>
 *   <on-error><base /></on-error>
 * </policies>`,
 * });
 * ```
 *
 * @resource
 */
export const ApiOperationPolicy = Resource<ApiOperationPolicy>(
  "Azure.ApiManagement.ApiOperationPolicy",
);

interface Key {
  resourceGroup: string;
  serviceName: string;
  apiName: string;
  operationName: string;
}

export const ApiOperationPolicyProvider = () =>
  Provider.succeed(ApiOperationPolicy, {
    stables: [
      "policyId",
      "operationName",
      "apiName",
      "serviceName",
      "resourceGroup",
    ],
    ...entityLifecycle<
      ApiOperationPolicyProps,
      ApiOperationPolicy["Attributes"],
      Key,
      apim.GetApiOperationPolicyResponse
    >({
      label: (key) =>
        `API Management policy of operation ${key.operationName} in API ${key.apiName}`,
      keyOf: (props) =>
        Effect.succeed({
          resourceGroup: props.resourceGroup,
          serviceName: props.serviceName,
          apiName: props.apiName,
          operationName: props.operationName,
        }),
      keyOfAttrs: (attrs) => attrs,
      get: (subscriptionId, key) =>
        apim.GetApiOperationPolicy({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          apiId: key.apiName,
          operationId: key.operationName,
          policyId: "policy",
        }),
      put: (subscriptionId, key, news) =>
        apim.ApiOperationPolicyCreateOrUpdate({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          apiId: key.apiName,
          operationId: key.operationName,
          policyId: "policy",
          properties: { value: news.value, format: news.format ?? "xml" },
        }),
      remove: (subscriptionId, key) =>
        apim.DeleteApiOperationPolicy({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          apiId: key.apiName,
          operationId: key.operationName,
          policyId: "policy",
        }),
      inSync: (news, observed) => policyInSync(news, observed),
      toAttrs: (_subscriptionId, key, observed) => ({
        resourceGroup: key.resourceGroup,
        serviceName: key.serviceName,
        apiName: key.apiName,
        operationName: key.operationName,
        policyId: observed.id ?? "",
        value: observed.properties?.value ?? "",
      }),
    }),
  });
