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

export type PolicyFormat = apim.PolicyContractPropertiesFormat;

export interface ServicePolicyProps {
  /** Resource group of the API Management service. Changing it replaces the policy. */
  resourceGroup: string;
  /** API Management service the policy applies to. Changing it replaces the policy. */
  serviceName: string;
  /**
   * Policy document (or a URL to one when `format` is a `-link` format).
   * The global policy applies to every API in the service.
   */
  value: string;
  /**
   * Format of `value`. `rawxml` skips XML escaping of policy expressions.
   * @default "xml"
   */
  format?: PolicyFormat;
}

export interface ServicePolicy extends Resource<
  "Azure.ApiManagement.ServicePolicy",
  ServicePolicyProps,
  {
    /** ARM resource ID of the policy. */
    policyId: string;
    /** API Management service the policy applies to. */
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
 * The global (all APIs) policy of an API Management service. There is one
 * per service; deleting it restores the default policy.
 *
 * @see https://learn.microsoft.com/azure/api-management/set-edit-policies
 *
 * ### Setting the Global Policy
 * **Example:** Add a response header to every API
 * ```typescript
 * yield* Azure.ApiManagement.ServicePolicy("global", {
 *   resourceGroup: group.resourceGroupName,
 *   serviceName: apim.serviceName,
 *   value: `<policies>
 *   <inbound />
 *   <backend><forward-request /></backend>
 *   <outbound>
 *     <set-header name="x-powered-by" exists-action="override">
 *       <value>alchemy</value>
 *     </set-header>
 *   </outbound>
 *   <on-error />
 * </policies>`,
 * });
 * ```
 *
 * @resource
 */
export const ServicePolicy = Resource<ServicePolicy>(
  "Azure.ApiManagement.ServicePolicy",
);

const POLICY_ID = "policy";

/** Collapse formatting differences APIM introduces when storing XML. */
export const normalizePolicy = (value: string) =>
  value
    .replace(/\r\n/g, "\n")
    .replace(/>\s+</g, "><")
    .replace(/\s*\/>/g, "/>")
    .replace(/\t/g, " ")
    .trim();

/**
 * GET the policy as a JSON envelope. Passing `format` makes APIM return the
 * bare XML document instead, which has no id.
 */
const getPolicy = (
  subscriptionId: string,
  resourceGroupName: string,
  serviceName: string,
) =>
  orUndefinedIfNotFound(
    apim.GetPolicy({
      subscriptionId,
      resourceGroupName,
      serviceName,
      policyId: POLICY_ID,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  serviceName: string,
  policy: apim.GetPolicyResponse,
): ServicePolicy["Attributes"] => ({
  policyId: policy.id ?? "",
  serviceName,
  resourceGroup,
  value: policy.properties?.value ?? "",
});

export const ServicePolicyProvider = () =>
  Provider.succeed(ServicePolicy, {
    stables: ["policyId", "serviceName", "resourceGroup"],

    // The policy is a singleton of its service; nuke removes it with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.serviceName, output.serviceName)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const serviceName = output?.serviceName ?? olds?.serviceName;
      if (resourceGroup === undefined || serviceName === undefined) {
        return undefined;
      }
      const observed = yield* getPolicy(
        subscriptionId,
        resourceGroup,
        serviceName,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, serviceName, observed);
      return (yield* isParentOwned(subscriptionId, resourceGroup, serviceName))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.ApiManagement");
      const { resourceGroup, serviceName } = news;
      const format = news.format ?? "xml";
      const get = getPolicy(subscriptionId, resourceGroup, serviceName);

      // Observe. Linked policies cannot be compared, so they are always sent.
      const observed = yield* get;
      const inSync =
        !format.endsWith("-link") &&
        observed?.properties?.value !== undefined &&
        normalizePolicy(observed.properties.value) ===
          normalizePolicy(news.value);

      if (!inSync) {
        yield* apim.PolicyCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          serviceName,
          policyId: POLICY_ID,
          properties: { value: news.value, format },
        });
      }
      const current = yield* waitForProvisioned(
        `API Management policy of ${serviceName}`,
        get,
        () => undefined,
        { interval: "2 seconds", times: 15 },
      );
      return toAttrs(resourceGroup, serviceName, current);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      // Deleting the global policy restores the service default.
      yield* ignoreNotFound(
        apim.DeletePolicy({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          serviceName: output.serviceName,
          policyId: POLICY_ID,
        }),
      );
    }),
  });
