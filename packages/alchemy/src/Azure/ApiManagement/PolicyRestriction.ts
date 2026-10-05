import * as apim from "@distilled.cloud/azure/apimanagement";
import * as Effect from "effect/Effect";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { createEntityName } from "./Common.ts";
import { entityLifecycle } from "./Entity.ts";

export interface PolicyRestrictionProps {
  /** Resource group of the API Management service. Changing it replaces the restriction. */
  resourceGroup: string;
  /** API Management service that holds the restriction. Changing it replaces the restriction. */
  serviceName: string;
  /**
   * Restriction identifier, unique within the service. Changing it
   * replaces the restriction.
   * @default a name generated from the stack, stage, and logical ID
   */
  name?: string;
  /** Path of the policy document the restriction applies to, e.g. `/apis/{apiId}`. */
  scope: string;
  /**
   * Whether policies at that scope must include `<base />`.
   * @default true
   */
  requireBase?: boolean;
}

export interface PolicyRestriction extends Resource<
  "Azure.ApiManagement.PolicyRestriction",
  PolicyRestrictionProps,
  {
    /** Restriction identifier within the service. */
    policyRestrictionName: string;
    /** ARM resource ID of the restriction. */
    policyRestrictionId: string;
    /** API Management service that holds the restriction. */
    serviceName: string;
    /** Resource group of the service. */
    resourceGroup: string;
    /** Policy document path the restriction applies to. */
    scope: string;
  },
  never,
  Providers
> {}

/**
 * A policy restriction of an API Management service: it constrains the
 * policy document at a scope, e.g. requiring it to keep `<base />` so the
 * inherited policies always run.
 *
 * @see https://learn.microsoft.com/rest/api/apimanagement/policy-restriction
 *
 * ### Restricting Policies
 * **Example:** Require `<base />` in the orders API policy
 * ```typescript
 * yield* Azure.ApiManagement.PolicyRestriction("orders-base", {
 *   resourceGroup: group.resourceGroupName,
 *   serviceName: apim.serviceName,
 *   scope: `/apis/${orders.apiName}`,
 *   requireBase: true,
 * });
 * ```
 *
 * @resource
 */
export const PolicyRestriction = Resource<PolicyRestriction>(
  "Azure.ApiManagement.PolicyRestriction",
);

interface Key {
  resourceGroup: string;
  serviceName: string;
  policyRestrictionName: string;
}

const requireBaseOf = (news: PolicyRestrictionProps) =>
  (news.requireBase ?? true) ? "true" : "false";

export const PolicyRestrictionProvider = () =>
  Provider.succeed(PolicyRestriction, {
    stables: [
      "policyRestrictionName",
      "policyRestrictionId",
      "serviceName",
      "resourceGroup",
    ],
    ...entityLifecycle<
      PolicyRestrictionProps,
      PolicyRestriction["Attributes"],
      Key,
      apim.GetPolicyRestrictionResponse
    >({
      label: (key) =>
        `API Management policy restriction ${key.policyRestrictionName}`,
      keyOf: (props, id, output) =>
        Effect.gen(function* () {
          return {
            resourceGroup: props.resourceGroup,
            serviceName: props.serviceName,
            policyRestrictionName:
              props.name ??
              output?.policyRestrictionName ??
              (yield* createEntityName(id)),
          };
        }),
      keyOfAttrs: (attrs) => attrs,
      get: (subscriptionId, key) =>
        apim.GetPolicyRestriction({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          policyRestrictionId: key.policyRestrictionName,
        }),
      put: (subscriptionId, key, news) =>
        apim.PolicyRestrictionCreateOrUpdate({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          policyRestrictionId: key.policyRestrictionName,
          properties: { scope: news.scope, requireBase: requireBaseOf(news) },
        }),
      remove: (subscriptionId, key) =>
        apim.DeletePolicyRestriction({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          policyRestrictionId: key.policyRestrictionName,
        }),
      inSync: (news, observed) =>
        observed.properties?.scope === news.scope &&
        observed.properties.requireBase === requireBaseOf(news),
      toAttrs: (_subscriptionId, key, observed) => ({
        resourceGroup: key.resourceGroup,
        serviceName: key.serviceName,
        policyRestrictionName: key.policyRestrictionName,
        policyRestrictionId: observed.id ?? "",
        scope: observed.properties?.scope ?? "",
      }),
    }),
  });
