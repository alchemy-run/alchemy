import * as apim from "@distilled.cloud/azure/apimanagement";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import type { Subscription, SubscriptionProps } from "./Subscription.ts";
import { createEntityName, sameName } from "./Common.ts";
import { entityLifecycle, reveal } from "./Entity.ts";

export interface WorkspaceSubscriptionProps extends SubscriptionProps {
  /** Workspace that holds the subscription (`Workspace.workspaceName`). Changing it replaces the subscription. */
  workspaceName: string;
}

export interface WorkspaceSubscription extends Resource<
  "Azure.ApiManagement.WorkspaceSubscription",
  WorkspaceSubscriptionProps,
  Subscription["Attributes"] & {
    /** Workspace that holds the subscription. */
    workspaceName: string;
  },
  never,
  Providers
> {}

/**
 * The workspace-scoped counterpart of {@link Subscription}: a subscription (API keys) inside an API
 * Management {@link Workspace} (Premium and v2 tiers). Props and
 * attributes match {@link Subscription} plus `workspaceName`.
 *
 * @see https://learn.microsoft.com/azure/api-management/workspaces-overview
 *
 * ### Workspace Subscriptions
 * **Example:** Keys for a workspace product
 * ```typescript
 * yield* Azure.ApiManagement.WorkspaceSubscription("partner-keys", {
 *   resourceGroup: group.resourceGroupName,
 *   serviceName: apim.serviceName,
 *   workspaceName: workspace.workspaceName,
 *   scope: `/products/${product.productName}`,
 *   displayName: "Partner",
 * });
 * ```
 *
 * @resource
 */
export const WorkspaceSubscription = Resource<WorkspaceSubscription>(
  "Azure.ApiManagement.WorkspaceSubscription",
);

interface Key {
  resourceGroup: string;
  serviceName: string;
  workspaceName: string;
  subscriptionName: string;
}

const where = (subscriptionId: string, key: Key) => ({
  subscriptionId,
  resourceGroupName: key.resourceGroup,
  serviceName: key.serviceName,
  workspaceId: key.workspaceName,
  sid: key.subscriptionName,
});

/** Service-relative scope (`/products/{id}`, `/apis/{id}`, `/apis`). */
const normalizeScope = (scope: string) => {
  const lower = scope.toLowerCase();
  const index = Math.max(
    lower.lastIndexOf("/products/"),
    lower.lastIndexOf("/apis"),
  );
  return index >= 0 ? scope.slice(index) : scope;
};

export const WorkspaceSubscriptionProvider = () =>
  Provider.succeed(WorkspaceSubscription, {
    stables: [
      "subscriptionName",
      "subscriptionResourceId",
      "serviceName",
      "workspaceName",
      "resourceGroup",
    ],
    ...entityLifecycle<
      WorkspaceSubscriptionProps,
      WorkspaceSubscription["Attributes"],
      Key,
      apim.GetWorkspaceSubscriptionResponse
    >({
      label: (key) =>
        `API Management workspace subscription ${key.subscriptionName}`,
      keyOf: (props, id, output) =>
        Effect.gen(function* () {
          return {
            resourceGroup: props.resourceGroup,
            serviceName: props.serviceName,
            workspaceName: props.workspaceName,
            subscriptionName:
              props.name ??
              output?.subscriptionName ??
              (yield* createEntityName(id)),
          };
        }),
      keyOfAttrs: (attrs) => attrs,
      get: (subscriptionId, key) =>
        apim.GetWorkspaceSubscription({
          ...where(subscriptionId, key),
        }),
      put: (subscriptionId, key, news) =>
        apim.WorkspaceSubscriptionCreateOrUpdate({
          ...where(subscriptionId, key),
          // Never email the owner.
          notify: false,
          properties: {
            scope: news.scope,
            displayName: news.displayName ?? key.subscriptionName,
            state: news.state ?? "active",
            allowTracing: news.allowTracing,
            primaryKey: reveal(news.primaryKey),
            secondaryKey: reveal(news.secondaryKey),
          },
        }),
      remove: (subscriptionId, key) =>
        apim.DeleteWorkspaceSubscription({
          ...where(subscriptionId, key),
        }),
      // GET omits the keys; explicit keys are compared to the last deploy.
      inSync: (news, observed, olds) => {
        const props = observed.properties;
        return (
          props !== undefined &&
          sameName(normalizeScope(props.scope), normalizeScope(news.scope)) &&
          props.displayName === (news.displayName ?? observed.name) &&
          props.state === (news.state ?? "active") &&
          (news.allowTracing === undefined ||
            (props.allowTracing ?? false) === news.allowTracing) &&
          ((news.primaryKey === undefined && news.secondaryKey === undefined) ||
            (olds !== undefined &&
              reveal(olds.primaryKey) === reveal(news.primaryKey) &&
              reveal(olds.secondaryKey) === reveal(news.secondaryKey)))
        );
      },
      toAttrs: (_subscriptionId, key, observed) => ({
        resourceGroup: key.resourceGroup,
        serviceName: key.serviceName,
        workspaceName: key.workspaceName,
        subscriptionName: key.subscriptionName,
        subscriptionResourceId: observed.id ?? "",
        scope: observed.properties?.scope ?? "",
        displayName: observed.properties?.displayName,
        state: observed.properties?.state ?? "active",
        primaryKey: undefined,
        secondaryKey: undefined,
      }),
      finalize: (subscriptionId, key, attrs) =>
        apim.ListWorkspaceSubscriptionSecrets(where(subscriptionId, key)).pipe(
          Effect.map((secrets) => ({
            ...attrs,
            primaryKey: secrets.primaryKey
              ? Redacted.make(secrets.primaryKey)
              : undefined,
            secondaryKey: secrets.secondaryKey
              ? Redacted.make(secrets.secondaryKey)
              : undefined,
          })),
        ),
    }),
  });
