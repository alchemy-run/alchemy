import * as apim from "@distilled.cloud/azure/apimanagement";
import * as Effect from "effect/Effect";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { createEntityName } from "./Common.ts";
import { entityLifecycle, policyInSync } from "./Entity.ts";

export interface WorkspacePolicyFragmentProps {
  /** Resource group of the API Management service. Changing it replaces the fragment. */
  resourceGroup: string;
  /** API Management service that holds the fragment. Changing it replaces the fragment. */
  serviceName: string;
  /** Workspace that holds the entity (`Workspace.workspaceName`). Changing it replaces the entity. */
  workspaceName: string;
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

export interface WorkspacePolicyFragment extends Resource<
  "Azure.ApiManagement.WorkspacePolicyFragment",
  WorkspacePolicyFragmentProps,
  {
    /** Fragment identifier used by `<include-fragment>`. */
    fragmentName: string;
    /** ARM resource ID of the fragment. */
    fragmentId: string;
    /** API Management service that holds the fragment. */
    serviceName: string;
    /** Workspace that holds the entity. */
    workspaceName: string;
    /** Resource group of the service. */
    resourceGroup: string;
    /** Fragment XML as stored by Azure. */
    value: string;
  },
  never,
  Providers
> {}

/**
 * The workspace-scoped counterpart of {@link PolicyFragment}: the same entity inside
 * an API Management {@link Workspace} (Premium and v2 tiers).
 *
 * A reusable policy fragment of an API Management service. Policies at
 * any scope include it with `<include-fragment fragment-id="..." />`.
 * Azure refuses to delete a fragment while a policy still references it.
 *
 * @see https://learn.microsoft.com/azure/api-management/policy-fragments
 *
 * ### Sharing Policy Logic
 * **Example:** A fragment that stamps a response header
 * ```typescript
 * const fragment = yield* Azure.ApiManagement.WorkspacePolicyFragment("stamp", {
 *   resourceGroup: group.resourceGroupName,
 *   serviceName: apim.serviceName,
 *   workspaceName: workspace.workspaceName,
 *   description: "Adds x-served-by",
 *   value: `<fragment>
 *   <set-header name="x-served-by" exists-action="override">
 *     <value>alchemy</value>
 *   </set-header>
 * </fragment>`,
 * });
 * yield* Azure.ApiManagement.WorkspaceApiPolicy("policy", {
 *   resourceGroup: group.resourceGroupName,
 *   serviceName: apim.serviceName,
 *   workspaceName: workspace.workspaceName,
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
export const WorkspacePolicyFragment = Resource<WorkspacePolicyFragment>(
  "Azure.ApiManagement.WorkspacePolicyFragment",
);

interface Key {
  resourceGroup: string;
  serviceName: string;
  workspaceName: string;
  fragmentName: string;
}

export const WorkspacePolicyFragmentProvider = () =>
  Provider.succeed(WorkspacePolicyFragment, {
    stables: [
      "fragmentName",
      "fragmentId",
      "serviceName",
      "workspaceName",
      "resourceGroup",
    ],
    ...entityLifecycle<
      WorkspacePolicyFragmentProps,
      WorkspacePolicyFragment["Attributes"],
      Key,
      apim.GetWorkspacePolicyFragmentResponse
    >({
      label: (key) => `API Management policy fragment ${key.fragmentName}`,
      keyOf: (props, id, output) =>
        Effect.gen(function* () {
          return {
            resourceGroup: props.resourceGroup,
            serviceName: props.serviceName,
            workspaceName: props.workspaceName,
            fragmentName:
              props.name ??
              output?.fragmentName ??
              (yield* createEntityName(id)),
          };
        }),
      keyOfAttrs: (attrs) => attrs,
      get: (subscriptionId, key) =>
        apim.GetWorkspacePolicyFragment({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          workspaceId: key.workspaceName,
          id: key.fragmentName,
        }),
      put: (subscriptionId, key, news) =>
        apim.WorkspacePolicyFragmentCreateOrUpdate({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          workspaceId: key.workspaceName,
          id: key.fragmentName,
          properties: {
            value: news.value,
            description: news.description,
            format: news.format ?? "xml",
          },
        }),
      remove: (subscriptionId, key) =>
        apim.DeleteWorkspacePolicyFragment({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          workspaceId: key.workspaceName,
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
        workspaceName: key.workspaceName,
        fragmentName: key.fragmentName,
        fragmentId: observed.id ?? "",
        value: observed.properties?.value ?? "",
      }),
    }),
  });
