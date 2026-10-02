import * as apim from "@distilled.cloud/azure/apimanagement";
import * as Effect from "effect/Effect";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import type { NamedValue, NamedValueProps } from "./NamedValue.ts";
import { createEntityName } from "./Common.ts";
import { entityLifecycle, reveal } from "./Entity.ts";

export interface WorkspaceNamedValueProps extends NamedValueProps {
  /** Workspace that holds the named value (`Workspace.workspaceName`). Changing it replaces the named value. */
  workspaceName: string;
}

export interface WorkspaceNamedValue extends Resource<
  "Azure.ApiManagement.WorkspaceNamedValue",
  WorkspaceNamedValueProps,
  NamedValue["Attributes"] & {
    /** Workspace that holds the named value. */
    workspaceName: string;
  },
  never,
  Providers
> {}

/**
 * The workspace-scoped counterpart of {@link NamedValue}: a named value inside an API
 * Management {@link Workspace} (Premium and v2 tiers). Props and
 * attributes match {@link NamedValue} plus `workspaceName`.
 *
 * @see https://learn.microsoft.com/azure/api-management/workspaces-overview
 *
 * ### Workspace Named Values
 * **Example:** A secret named value
 * ```typescript
 * yield* Azure.ApiManagement.WorkspaceNamedValue("backend-key", {
 *   resourceGroup: group.resourceGroupName,
 *   serviceName: apim.serviceName,
 *   workspaceName: workspace.workspaceName,
 *   value: Redacted.make(backendKey),
 *   secret: true,
 * });
 * ```
 *
 * @resource
 */
export const WorkspaceNamedValue = Resource<WorkspaceNamedValue>(
  "Azure.ApiManagement.WorkspaceNamedValue",
);

interface Key {
  resourceGroup: string;
  serviceName: string;
  workspaceName: string;
  namedValueName: string;
}

const where = (subscriptionId: string, key: Key) => ({
  subscriptionId,
  resourceGroupName: key.resourceGroup,
  serviceName: key.serviceName,
  workspaceId: key.workspaceName,
  namedValueId: key.namedValueName,
});

const sameList = (a: readonly string[], b: readonly string[]) =>
  [...a].sort().join("\n") === [...b].sort().join("\n");

const secretOf = (news: WorkspaceNamedValueProps) =>
  news.keyVault !== undefined ? true : (news.secret ?? false);

export const WorkspaceNamedValueProvider = () =>
  Provider.succeed(WorkspaceNamedValue, {
    stables: [
      "namedValueName",
      "namedValueId",
      "serviceName",
      "workspaceName",
      "resourceGroup",
    ],
    ...entityLifecycle<
      WorkspaceNamedValueProps,
      WorkspaceNamedValue["Attributes"],
      Key,
      apim.GetWorkspaceNamedValueResponse
    >({
      label: (key) =>
        `API Management workspace named value ${key.namedValueName}`,
      keyOf: (props, id, output) =>
        Effect.gen(function* () {
          return {
            resourceGroup: props.resourceGroup,
            serviceName: props.serviceName,
            workspaceName: props.workspaceName,
            namedValueName:
              props.name ??
              output?.namedValueName ??
              (yield* createEntityName(id)),
          };
        }),
      keyOfAttrs: (attrs) => attrs,
      get: (subscriptionId, key) =>
        apim.GetWorkspaceNamedValue({
          ...where(subscriptionId, key),
        }),
      put: (subscriptionId, key, news) =>
        apim.WorkspaceNamedValueCreateOrUpdate({
          ...where(subscriptionId, key),
          properties: {
            displayName: news.displayName ?? key.namedValueName,
            value: news.keyVault !== undefined ? undefined : reveal(news.value),
            secret: secretOf(news),
            keyVault: news.keyVault,
            tags: news.tags ?? [],
          },
        }),
      remove: (subscriptionId, key) =>
        apim.DeleteWorkspaceNamedValue({
          ...where(subscriptionId, key),
        }),
      // Secret values are not returned by GET; plain values are compared
      // directly, secret ones against the previous props.
      inSync: (news, observed, olds) => {
        const props = observed.properties;
        if (props === undefined) return false;
        const value = reveal(news.value);
        return (
          props.displayName === (news.displayName ?? observed.name) &&
          (props.secret ?? false) === secretOf(news) &&
          sameList(props.tags ?? [], news.tags ?? []) &&
          (news.keyVault !== undefined
            ? props.keyVault?.secretIdentifier ===
              news.keyVault.secretIdentifier
            : props.secret
              ? olds !== undefined && reveal(olds.value) === value
              : props.value === value)
        );
      },
      stateOf: (observed) => observed.properties?.provisioningState,
      toAttrs: (_subscriptionId, key, observed) => ({
        resourceGroup: key.resourceGroup,
        serviceName: key.serviceName,
        workspaceName: key.workspaceName,
        namedValueName: key.namedValueName,
        namedValueId: observed.id ?? "",
        displayName: observed.properties?.displayName ?? key.namedValueName,
        secret: observed.properties?.secret ?? false,
        tags: [...(observed.properties?.tags ?? [])],
      }),
    }),
  });
