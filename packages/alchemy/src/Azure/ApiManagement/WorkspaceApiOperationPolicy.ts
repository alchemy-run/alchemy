import * as apim from "@distilled.cloud/azure/apimanagement";
import * as Effect from "effect/Effect";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { entityLifecycle, policyInSync } from "./Entity.ts";
import type { PolicyFormat } from "./ServicePolicy.ts";

export interface WorkspaceApiOperationPolicyProps {
  /** Resource group of the API Management service. Changing it replaces the policy. */
  resourceGroup: string;
  /** API Management service that holds the API. Changing it replaces the policy. */
  serviceName: string;
  /** Workspace that holds the entity (`Workspace.workspaceName`). Changing it replaces the entity. */
  workspaceName: string;
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

export interface WorkspaceApiOperationPolicy extends Resource<
  "Azure.ApiManagement.WorkspaceApiOperationPolicy",
  WorkspaceApiOperationPolicyProps,
  {
    /** ARM resource ID of the policy. */
    policyId: string;
    /** Identifier of the operation the policy applies to. */
    operationName: string;
    /** Identifier of the API that holds the operation. */
    apiName: string;
    /** API Management service that holds the API. */
    serviceName: string;
    /** Workspace that holds the entity. */
    workspaceName: string;
    /** Resource group of the service. */
    resourceGroup: string;
    /** Policy document as stored by Azure (XML). */
    value: string;
  },
  never,
  Providers
> {}

/**
 * The workspace-scoped counterpart of {@link ApiOperationPolicy}: the same entity inside
 * an API Management {@link Workspace} (Premium and v2 tiers).
 *
 * The policy of a single API operation in an API Management service.
 * There is one per operation; deleting it reverts the operation to the
 * inherited (`<base />`) behavior.
 *
 * @see https://learn.microsoft.com/azure/api-management/set-edit-policies
 *
 * ### Setting an Operation Policy
 * **Example:** Mock the response of one operation
 * ```typescript
 * yield* Azure.ApiManagement.WorkspaceApiOperationPolicy("get-order-mock", {
 *   resourceGroup: group.resourceGroupName,
 *   serviceName: apim.serviceName,
 *   workspaceName: workspace.workspaceName,
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
export const WorkspaceApiOperationPolicy =
  Resource<WorkspaceApiOperationPolicy>(
    "Azure.ApiManagement.WorkspaceApiOperationPolicy",
  );

interface Key {
  resourceGroup: string;
  serviceName: string;
  workspaceName: string;
  apiName: string;
  operationName: string;
}

export const WorkspaceApiOperationPolicyProvider = () =>
  Provider.succeed(WorkspaceApiOperationPolicy, {
    stables: [
      "policyId",
      "operationName",
      "apiName",
      "serviceName",
      "workspaceName",
      "resourceGroup",
    ],
    ...entityLifecycle<
      WorkspaceApiOperationPolicyProps,
      WorkspaceApiOperationPolicy["Attributes"],
      Key,
      apim.GetWorkspaceApiOperationPolicyResponse
    >({
      label: (key) =>
        `API Management policy of operation ${key.operationName} in API ${key.apiName}`,
      keyOf: (props) =>
        Effect.succeed({
          resourceGroup: props.resourceGroup,
          serviceName: props.serviceName,
          workspaceName: props.workspaceName,
          apiName: props.apiName,
          operationName: props.operationName,
        }),
      keyOfAttrs: (attrs) => attrs,
      get: (subscriptionId, key) =>
        apim.GetWorkspaceApiOperationPolicy({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          workspaceId: key.workspaceName,
          apiId: key.apiName,
          operationId: key.operationName,
          policyId: "policy",
        }),
      put: (subscriptionId, key, news) =>
        apim.WorkspaceApiOperationPolicyCreateOrUpdate({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          workspaceId: key.workspaceName,
          apiId: key.apiName,
          operationId: key.operationName,
          policyId: "policy",
          properties: { value: news.value, format: news.format ?? "xml" },
        }),
      remove: (subscriptionId, key) =>
        apim.DeleteWorkspaceApiOperationPolicy({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          workspaceId: key.workspaceName,
          apiId: key.apiName,
          operationId: key.operationName,
          policyId: "policy",
        }),
      inSync: (news, observed) => policyInSync(news, observed),
      toAttrs: (_subscriptionId, key, observed) => ({
        resourceGroup: key.resourceGroup,
        serviceName: key.serviceName,
        workspaceName: key.workspaceName,
        apiName: key.apiName,
        operationName: key.operationName,
        policyId: observed.id ?? "",
        value: observed.properties?.value ?? "",
      }),
    }),
  });
