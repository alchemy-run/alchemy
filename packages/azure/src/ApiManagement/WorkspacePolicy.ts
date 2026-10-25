import * as apim from "@distilled.cloud/azure/apimanagement";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import { entityLifecycle, policyInSync } from "./Entity.ts";
import type { ServicePolicy, ServicePolicyProps } from "./ServicePolicy.ts";

export interface WorkspacePolicyProps extends ServicePolicyProps {
  /** Workspace that holds the policy (`Workspace.workspaceName`). Changing it replaces the policy. */
  workspaceName: string;
}

export interface WorkspacePolicy extends Resource<
  "Azure.ApiManagement.WorkspacePolicy",
  WorkspacePolicyProps,
  ServicePolicy["Attributes"] & {
    /** Workspace that holds the policy. */
    workspaceName: string;
  },
  never,
  Providers
> {}

/**
 * The workspace-scoped counterpart of {@link ServicePolicy}: the workspace-wide policy (applies to every API in the workspace) inside an API
 * Management {@link Workspace} (Premium and v2 tiers). Props and
 * attributes match {@link ServicePolicy} plus `workspaceName`.
 * The ARM type is `Microsoft.ApiManagement/service/workspaces/policies`.
 *
 * :::caution
 * Changing `workspaceName`, `serviceName`, or `resourceGroup` replaces the
 * policy.
 *
 * Workspaces need a BasicV2, StandardV2, or Premium service ("Method not
 * allowed in Consumption pricing tier").
 * :::
 *
 * @see https://learn.microsoft.com/azure/api-management/workspaces-overview
 *
 * ### Workspace Policy
 * **Example:** Add a header to every workspace API
 * ```typescript
 * const apim = yield* Azure.ApiManagement.Service("gateway", {
 *   sku: { name: "BasicV2", capacity: 1 },
 *   publisherEmail: "ops@example.com",
 *   publisherName: "Example Inc",
 * });
 * const workspace = yield* Azure.ApiManagement.Workspace("payments", {
 *   serviceName: apim.serviceName,
 * });
 * yield* Azure.ApiManagement.WorkspacePolicy("workspace-policy", {
 *   serviceName: apim.serviceName,
 *   workspaceName: workspace.workspaceName,
 *   value: `<policies>
 *   <inbound><base /></inbound>
 *   <backend><base /></backend>
 *   <outbound><base /><set-header name="x-team" exists-action="override"><value>payments</value></set-header></outbound>
 *   <on-error><base /></on-error>
 * </policies>`,
 * });
 * ```
 *
 * @resource
 */
export const WorkspacePolicy = GroupedResource<WorkspacePolicy>(
  "Azure.ApiManagement.WorkspacePolicy",
);

interface Key {
  resourceGroup: string;
  serviceName: string;
  workspaceName: string;
}

const where = (subscriptionId: string, key: Key) => ({
  subscriptionId,
  resourceGroupName: key.resourceGroup,
  serviceName: key.serviceName,
  workspaceId: key.workspaceName,
  policyId: "policy",
});

export const WorkspacePolicyProvider = () =>
  Provider.succeed(WorkspacePolicy, {
    stables: ["policyId", "serviceName", "workspaceName", "resourceGroup"],
    ...entityLifecycle<
      WorkspacePolicyProps,
      WorkspacePolicy["Attributes"],
      Key,
      apim.GetWorkspacePolicyResponse
    >({
      label: (key) => `API Management workspace policy ${key.workspaceName}`,
      keyOf: (props, id, output) =>
        Effect.gen(function* () {
          return {
            resourceGroup: props.resourceGroup,
            serviceName: props.serviceName,
            workspaceName: props.workspaceName,
          };
        }),
      keyOfAttrs: (attrs) => attrs,
      get: (subscriptionId, key) =>
        apim.GetWorkspacePolicy({
          ...where(subscriptionId, key),
        }),
      put: (subscriptionId, key, news) =>
        apim.WorkspacePolicyCreateOrUpdate({
          ...where(subscriptionId, key),
          properties: { value: news.value, format: news.format ?? "xml" },
        }),
      remove: (subscriptionId, key) =>
        apim.DeleteWorkspacePolicy({
          ...where(subscriptionId, key),
        }),
      inSync: (news, observed) => policyInSync(news, observed),
      toAttrs: (_subscriptionId, key, observed) => ({
        resourceGroup: key.resourceGroup,
        serviceName: key.serviceName,
        workspaceName: key.workspaceName,
        policyId: observed.id ?? "",
        value: observed.properties?.value ?? "",
      }),
    }),
  });
