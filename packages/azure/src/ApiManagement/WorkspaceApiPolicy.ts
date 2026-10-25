import * as apim from "@distilled.cloud/azure/apimanagement";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import type { ApiPolicy, ApiPolicyProps } from "./ApiPolicy.ts";
import { entityLifecycle, policyInSync } from "./Entity.ts";

export interface WorkspaceApiPolicyProps extends ApiPolicyProps {
  /** Workspace that holds the API policy (`Workspace.workspaceName`). Changing it replaces the API policy. */
  workspaceName: string;
}

export interface WorkspaceApiPolicy extends Resource<
  "Azure.ApiManagement.WorkspaceApiPolicy",
  WorkspaceApiPolicyProps,
  ApiPolicy["Attributes"] & {
    /** Workspace that holds the API policy. */
    workspaceName: string;
  },
  never,
  Providers
> {}

/**
 * The workspace-scoped counterpart of {@link ApiPolicy}: the policy of an API inside an API
 * Management {@link Workspace} (Premium and v2 tiers). Props and
 * attributes match {@link ApiPolicy} plus `workspaceName`.
 * The ARM type is
 * `Microsoft.ApiManagement/service/workspaces/apis/policies`.
 *
 * :::caution
 * Changing `workspaceName`, `serviceName`, `apiName`, or `resourceGroup`
 * replaces the policy.
 *
 * Workspaces need a BasicV2, StandardV2, or Premium service ("Method not
 * allowed in Consumption pricing tier").
 * :::
 *
 * @see https://learn.microsoft.com/azure/api-management/workspaces-overview
 *
 * ### Workspace API Policies
 * **Example:** Return a fixed response
 * ```typescript
 * const apim = yield* Azure.ApiManagement.Service("gateway", {
 *   sku: { name: "BasicV2", capacity: 1 },
 *   publisherEmail: "ops@example.com",
 *   publisherName: "Example Inc",
 * });
 * const workspace = yield* Azure.ApiManagement.Workspace("payments", {
 *   serviceName: apim.serviceName,
 * });
 * const api = yield* Azure.ApiManagement.WorkspaceApi("orders", {
 *   serviceName: apim.serviceName,
 *   workspaceName: workspace.workspaceName,
 *   path: "orders",
 *   serviceUrl: "https://orders.example.com",
 * });
 * yield* Azure.ApiManagement.WorkspaceApiPolicy("hello-policy", {
 *   serviceName: apim.serviceName,
 *   workspaceName: workspace.workspaceName,
 *   apiName: api.apiName,
 *   value: `<policies>
 *   <inbound><base /><return-response><set-body>hello</set-body></return-response></inbound>
 *   <backend><base /></backend>
 *   <outbound><base /></outbound>
 *   <on-error><base /></on-error>
 * </policies>`,
 * });
 * ```
 *
 * @resource
 */
export const WorkspaceApiPolicy = GroupedResource<WorkspaceApiPolicy>(
  "Azure.ApiManagement.WorkspaceApiPolicy",
);

interface Key {
  resourceGroup: string;
  serviceName: string;
  workspaceName: string;
  apiName: string;
}

const where = (subscriptionId: string, key: Key) => ({
  subscriptionId,
  resourceGroupName: key.resourceGroup,
  serviceName: key.serviceName,
  workspaceId: key.workspaceName,
  apiId: key.apiName,
  policyId: "policy",
});

export const WorkspaceApiPolicyProvider = () =>
  Provider.succeed(WorkspaceApiPolicy, {
    stables: ["policyId", "apiName", "serviceName", "workspaceName", "resourceGroup"],
    ...entityLifecycle<
      WorkspaceApiPolicyProps,
      WorkspaceApiPolicy["Attributes"],
      Key,
      apim.GetWorkspaceApiPolicyResponse
    >({
      label: (key) => `API Management workspace API policy ${key.apiName}`,
      keyOf: (props, id, output) =>
        Effect.gen(function* () {
          return {
            resourceGroup: props.resourceGroup,
            serviceName: props.serviceName,
            workspaceName: props.workspaceName,
            apiName: props.apiName,
          };
        }),
      keyOfAttrs: (attrs) => attrs,
      get: (subscriptionId, key) =>
        apim.GetWorkspaceApiPolicy({
          ...where(subscriptionId, key),
        }),
      put: (subscriptionId, key, news) =>
        apim.WorkspaceApiPolicyCreateOrUpdate({
          ...where(subscriptionId, key),
          properties: { value: news.value, format: news.format ?? "xml" },
        }),
      remove: (subscriptionId, key) =>
        apim.DeleteWorkspaceApiPolicy({
          ...where(subscriptionId, key),
        }),
      inSync: (news, observed) => policyInSync(news, observed),
      toAttrs: (_subscriptionId, key, observed) => ({
        resourceGroup: key.resourceGroup,
        serviceName: key.serviceName,
        workspaceName: key.workspaceName,
        apiName: key.apiName,
        policyId: observed.id ?? "",
        value: observed.properties?.value ?? "",
      }),
    }),
  });
