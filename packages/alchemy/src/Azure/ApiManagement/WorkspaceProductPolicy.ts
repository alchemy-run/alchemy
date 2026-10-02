import * as apim from "@distilled.cloud/azure/apimanagement";
import * as Effect from "effect/Effect";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { entityLifecycle, policyInSync } from "./Entity.ts";
import type { PolicyFormat } from "./ServicePolicy.ts";

export interface WorkspaceProductPolicyProps {
  /** Resource group of the API Management service. Changing it replaces the policy. */
  resourceGroup: string;
  /** API Management service that holds the product. Changing it replaces the policy. */
  serviceName: string;
  /** Workspace that holds the entity (`Workspace.workspaceName`). Changing it replaces the entity. */
  workspaceName: string;
  /** Identifier of the product the policy applies to. Changing it replaces the policy. */
  productName: string;
  /**
   * Policy document (or a URL to one when `format` is a `-link` format).
   * Use `<base />` to inherit the global policy.
   */
  value: string;
  /**
   * Format of `value`. `rawxml` skips XML escaping of policy expressions.
   * @default "xml"
   */
  format?: PolicyFormat;
}

export interface WorkspaceProductPolicy extends Resource<
  "Azure.ApiManagement.WorkspaceProductPolicy",
  WorkspaceProductPolicyProps,
  {
    /** ARM resource ID of the policy. */
    policyId: string;
    /** Identifier of the product the policy applies to. */
    productName: string;
    /** API Management service that holds the product. */
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
 * The workspace-scoped counterpart of {@link ProductPolicy}: the same entity inside
 * an API Management {@link Workspace} (Premium and v2 tiers).
 *
 * The policy of an API Management product. It applies to every API in
 * the product, between the global and the API policies. There is one per
 * product; deleting it reverts the product to the inherited behavior.
 *
 * @see https://learn.microsoft.com/azure/api-management/set-edit-policies
 *
 * ### Setting a Product Policy
 * **Example:** Rate-limit every subscription of a product
 * ```typescript
 * yield* Azure.ApiManagement.WorkspaceProductPolicy("starter-limits", {
 *   resourceGroup: group.resourceGroupName,
 *   serviceName: apim.serviceName,
 *   workspaceName: workspace.workspaceName,
 *   productName: product.productName,
 *   value: `<policies>
 *   <inbound>
 *     <base />
 *     <rate-limit calls="5" renewal-period="60" />
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
export const WorkspaceProductPolicy = Resource<WorkspaceProductPolicy>(
  "Azure.ApiManagement.WorkspaceProductPolicy",
);

interface Key {
  resourceGroup: string;
  serviceName: string;
  workspaceName: string;
  productName: string;
}

export const WorkspaceProductPolicyProvider = () =>
  Provider.succeed(WorkspaceProductPolicy, {
    stables: [
      "policyId",
      "productName",
      "serviceName",
      "workspaceName",
      "resourceGroup",
    ],
    ...entityLifecycle<
      WorkspaceProductPolicyProps,
      WorkspaceProductPolicy["Attributes"],
      Key,
      apim.GetWorkspaceProductPolicyResponse
    >({
      label: (key) => `API Management policy of product ${key.productName}`,
      keyOf: (props) =>
        Effect.succeed({
          resourceGroup: props.resourceGroup,
          serviceName: props.serviceName,
          workspaceName: props.workspaceName,
          productName: props.productName,
        }),
      keyOfAttrs: (attrs) => attrs,
      get: (subscriptionId, key) =>
        apim.GetWorkspaceProductPolicy({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          workspaceId: key.workspaceName,
          productId: key.productName,
          policyId: "policy",
        }),
      put: (subscriptionId, key, news) =>
        apim.WorkspaceProductPolicyCreateOrUpdate({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          workspaceId: key.workspaceName,
          productId: key.productName,
          policyId: "policy",
          properties: { value: news.value, format: news.format ?? "xml" },
        }),
      remove: (subscriptionId, key) =>
        apim.DeleteWorkspaceProductPolicy({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          workspaceId: key.workspaceName,
          productId: key.productName,
          policyId: "policy",
        }),
      inSync: (news, observed) => policyInSync(news, observed),
      toAttrs: (_subscriptionId, key, observed) => ({
        resourceGroup: key.resourceGroup,
        serviceName: key.serviceName,
        workspaceName: key.workspaceName,
        productName: key.productName,
        policyId: observed.id ?? "",
        value: observed.properties?.value ?? "",
      }),
    }),
  });
