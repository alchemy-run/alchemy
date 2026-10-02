import * as apim from "@distilled.cloud/azure/apimanagement";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitForProvisioned,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { isParentOwned, sameName } from "./Common.ts";
import { normalizePolicy, type PolicyFormat } from "./ServicePolicy.ts";

export interface ApiPolicyProps {
  /** Resource group of the API Management service. Changing it replaces the policy. */
  resourceGroup: string;
  /** API Management service that holds the API. Changing it replaces the policy. */
  serviceName: string;
  /** Identifier of the API the policy applies to. Changing it replaces the policy. */
  apiName: string;
  /**
   * Policy document (or a URL to one when `format` is a `-link` format).
   * Use `<base />` to inherit the global and product policies.
   */
  value: string;
  /**
   * Format of `value`. `rawxml` skips XML escaping of policy expressions.
   * @default "xml"
   */
  format?: PolicyFormat;
}

export interface ApiPolicy extends Resource<
  "Azure.ApiManagement.ApiPolicy",
  ApiPolicyProps,
  {
    /** ARM resource ID of the policy. */
    policyId: string;
    /** Identifier of the API the policy applies to. */
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
 * The policy of a single API in an API Management service. There is one
 * per API; deleting it reverts the API to the inherited (`<base />`)
 * behavior.
 *
 * @see https://learn.microsoft.com/azure/api-management/set-edit-policies
 *
 * ### Setting an API Policy
 * **Example:** Return a fixed response without calling the backend
 * ```typescript
 * yield* Azure.ApiManagement.ApiPolicy("hello-policy", {
 *   resourceGroup: group.resourceGroupName,
 *   serviceName: apim.serviceName,
 *   apiName: api.apiName,
 *   value: `<policies>
 *   <inbound>
 *     <base />
 *     <return-response>
 *       <set-status code="200" reason="OK" />
 *       <set-body>hello</set-body>
 *     </return-response>
 *   </inbound>
 *   <backend><base /></backend>
 *   <outbound><base /></outbound>
 *   <on-error><base /></on-error>
 * </policies>`,
 * });
 * ```
 *
 * **Example:** Route the API to a named backend
 * ```typescript
 * yield* Azure.ApiManagement.ApiPolicy("route", {
 *   resourceGroup: group.resourceGroupName,
 *   serviceName: apim.serviceName,
 *   apiName: api.apiName,
 *   value: `<policies>
 *   <inbound>
 *     <base />
 *     <set-backend-service backend-id="${backend.backendName}" />
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
export const ApiPolicy = Resource<ApiPolicy>("Azure.ApiManagement.ApiPolicy");

const POLICY_ID = "policy";

const getApiPolicy = (
  subscriptionId: string,
  resourceGroupName: string,
  serviceName: string,
  apiId: string,
) =>
  orUndefinedIfNotFound(
    apim.GetApiPolicy({
      subscriptionId,
      resourceGroupName,
      serviceName,
      apiId,
      policyId: POLICY_ID,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  serviceName: string,
  apiName: string,
  policy: apim.GetApiPolicyResponse,
): ApiPolicy["Attributes"] => ({
  policyId: policy.id ?? "",
  apiName,
  serviceName,
  resourceGroup,
  value: policy.properties?.value ?? "",
});

export const ApiPolicyProvider = () =>
  Provider.succeed(ApiPolicy, {
    stables: ["policyId", "apiName", "serviceName", "resourceGroup"],

    // The policy is a singleton of its API; nuke removes it with the service.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.serviceName, output.serviceName) ||
        !sameName(news.apiName, output.apiName)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const serviceName = output?.serviceName ?? olds?.serviceName;
      const apiName = output?.apiName ?? olds?.apiName;
      if (
        resourceGroup === undefined ||
        serviceName === undefined ||
        apiName === undefined
      ) {
        return undefined;
      }
      const observed = yield* getApiPolicy(
        subscriptionId,
        resourceGroup,
        serviceName,
        apiName,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, serviceName, apiName, observed);
      return (yield* isParentOwned(subscriptionId, resourceGroup, serviceName))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.ApiManagement");
      const { resourceGroup, serviceName, apiName } = news;
      const format = news.format ?? "xml";
      const get = getApiPolicy(
        subscriptionId,
        resourceGroup,
        serviceName,
        apiName,
      );

      // Observe. Linked policies cannot be compared, so they are always sent.
      const observed = yield* get;
      const inSync =
        !format.endsWith("-link") &&
        observed?.properties?.value !== undefined &&
        normalizePolicy(observed.properties.value) ===
          normalizePolicy(news.value);

      if (!inSync) {
        yield* apim.ApiPolicyCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          serviceName,
          apiId: apiName,
          policyId: POLICY_ID,
          properties: { value: news.value, format },
        });
      }
      const current = yield* waitForProvisioned(
        `API Management policy of API ${apiName}`,
        get,
        () => undefined,
        { interval: "2 seconds", times: 15 },
      );
      return toAttrs(resourceGroup, serviceName, apiName, current);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      // Deleting the API policy reverts the API to the inherited behavior.
      yield* ignoreNotFound(
        apim.DeleteApiPolicy({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          serviceName: output.serviceName,
          apiId: output.apiName,
          policyId: POLICY_ID,
        }),
      );
    }),
  });
