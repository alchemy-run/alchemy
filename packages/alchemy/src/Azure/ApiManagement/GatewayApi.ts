import * as apim from "@distilled.cloud/azure/apimanagement";
import * as Effect from "effect/Effect";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { sameName } from "./Common.ts";
import { entityLifecycle, serviceEntityId } from "./Entity.ts";

export interface GatewayApiProps {
  /** Resource group of the API Management service. Changing it replaces the association. */
  resourceGroup: string;
  /** API Management service that holds the gateway and API. Changing it replaces the association. */
  serviceName: string;
  /** Identifier of the self-hosted {@link Gateway}. Changing it replaces the association. */
  gatewayName: string;
  /** Identifier of the API served by the gateway. Changing it replaces the association. */
  apiName: string;
}

export interface GatewayApi extends Resource<
  "Azure.ApiManagement.GatewayApi",
  GatewayApiProps,
  {
    /** ARM resource ID of the gateway/API association. */
    gatewayApiId: string;
    /** Identifier of the gateway. */
    gatewayName: string;
    /** Identifier of the API. */
    apiName: string;
    /** API Management service that holds the gateway and API. */
    serviceName: string;
    /** Resource group of the service. */
    resourceGroup: string;
  },
  never,
  Providers
> {}

/**
 * Serves an API from a self-hosted API Management {@link Gateway}. The
 * association has no settings; changing the gateway or API replaces it.
 * Self-hosted gateways require the Developer or Premium tier.
 *
 * @see https://learn.microsoft.com/azure/api-management/how-to-deploy-self-hosted-gateway-azure-kubernetes-service
 *
 * ### Publishing APIs on a Self-Hosted Gateway
 * **Example:** Serve the orders API on-premises
 * ```typescript
 * yield* Azure.ApiManagement.GatewayApi("onprem-orders", {
 *   resourceGroup: group.resourceGroupName,
 *   serviceName: apim.serviceName,
 *   gatewayName: gateway.gatewayName,
 *   apiName: api.apiName,
 * });
 * ```
 *
 * @resource
 */
export const GatewayApi = Resource<GatewayApi>(
  "Azure.ApiManagement.GatewayApi",
);

interface Key {
  resourceGroup: string;
  serviceName: string;
  gatewayName: string;
  apiName: string;
}

export const GatewayApiProvider = () =>
  Provider.succeed(GatewayApi, {
    stables: [
      "gatewayApiId",
      "gatewayName",
      "apiName",
      "serviceName",
      "resourceGroup",
    ],
    ...entityLifecycle<
      GatewayApiProps,
      GatewayApi["Attributes"],
      Key,
      apim.ApiContract
    >({
      label: (key) =>
        `API ${key.apiName} on API Management gateway ${key.gatewayName}`,
      keyOf: (props) =>
        Effect.succeed({
          resourceGroup: props.resourceGroup,
          serviceName: props.serviceName,
          gatewayName: props.gatewayName,
          apiName: props.apiName,
        }),
      keyOfAttrs: (attrs) => attrs,
      // There is no GET for one association; the exact-name filter matches
      // at most one API, so the first page is authoritative.
      get: (subscriptionId, key) =>
        apim
          .ListGatewayApiByService({
            subscriptionId,
            resourceGroupName: key.resourceGroup,
            serviceName: key.serviceName,
            gatewayId: key.gatewayName,
            _filter: `name eq '${key.apiName}'`,
          })
          .pipe(
            Effect.map((page) =>
              page.value?.find((api) => sameName(api.name, key.apiName)),
            ),
          ),
      put: (subscriptionId, key) =>
        apim.GatewayApiCreateOrUpdate({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          gatewayId: key.gatewayName,
          apiId: key.apiName,
          properties: { provisioningState: "created" },
        }),
      remove: (subscriptionId, key) =>
        apim.DeleteGatewayApi({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          gatewayId: key.gatewayName,
          apiId: key.apiName,
        }),
      toAttrs: (subscriptionId, key) => ({
        resourceGroup: key.resourceGroup,
        serviceName: key.serviceName,
        gatewayName: key.gatewayName,
        apiName: key.apiName,
        gatewayApiId: serviceEntityId(
          subscriptionId,
          key,
          `gateways/${key.gatewayName}/apis/${key.apiName}`,
        ),
      }),
    }),
  });
