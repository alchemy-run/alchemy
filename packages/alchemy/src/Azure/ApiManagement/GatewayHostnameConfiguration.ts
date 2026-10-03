import * as apim from "@distilled.cloud/azure/apimanagement";
import * as Effect from "effect/Effect";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { createEntityName, subsetMatches } from "./Common.ts";
import { entityLifecycle } from "./Entity.ts";

export interface GatewayHostnameConfigurationProps {
  /** Resource group of the API Management service. Changing it replaces the configuration. */
  resourceGroup: string;
  /** API Management service that holds the gateway. Changing it replaces the configuration. */
  serviceName: string;
  /** Identifier of the self-hosted {@link Gateway}. Changing it replaces the configuration. */
  gatewayName: string;
  /**
   * Configuration identifier, unique within the gateway. Changing it
   * replaces the configuration.
   * @default a name generated from the stack, stage, and logical ID
   */
  name?: string;
  /** Hostname the gateway serves, e.g. `api.contoso.com` (`*` for any). */
  hostname: string;
  /** ARM resource ID of the TLS {@link Certificate} (`Certificate.certificateId`). */
  certificateId?: string;
  /**
   * Whether the gateway asks clients for a certificate.
   * @default false
   */
  negotiateClientCertificate?: boolean;
  /**
   * Whether TLS 1.0 is accepted.
   * @default false
   */
  tls10Enabled?: boolean;
  /**
   * Whether TLS 1.1 is accepted.
   * @default false
   */
  tls11Enabled?: boolean;
  /**
   * Whether HTTP/2 is enabled.
   * @default false
   */
  http2Enabled?: boolean;
}

export interface GatewayHostnameConfiguration extends Resource<
  "Azure.ApiManagement.GatewayHostnameConfiguration",
  GatewayHostnameConfigurationProps,
  {
    /** Configuration identifier within the gateway. */
    hostnameConfigurationName: string;
    /** ARM resource ID of the configuration. */
    hostnameConfigurationId: string;
    /** Identifier of the gateway. */
    gatewayName: string;
    /** API Management service that holds the gateway. */
    serviceName: string;
    /** Resource group of the service. */
    resourceGroup: string;
    /** Hostname the gateway serves. */
    hostname: string;
  },
  never,
  Providers
> {}

/**
 * A hostname (and its TLS certificate and protocol settings) served by a
 * self-hosted API Management {@link Gateway}. Self-hosted gateways require
 * the Developer or Premium tier.
 *
 * @see https://learn.microsoft.com/rest/api/apimanagement/gateway-hostname-configuration
 *
 * ### Serving a Custom Hostname
 * **Example:** Serve api.contoso.com with HTTP/2
 * ```typescript
 * yield* Azure.ApiManagement.GatewayHostnameConfiguration("contoso", {
 *   resourceGroup: group.resourceGroupName,
 *   serviceName: apim.serviceName,
 *   gatewayName: gateway.gatewayName,
 *   hostname: "api.contoso.com",
 *   certificateId: tlsCert.certificateId,
 *   http2Enabled: true,
 * });
 * ```
 *
 * @resource
 */
export const GatewayHostnameConfiguration =
  Resource<GatewayHostnameConfiguration>(
    "Azure.ApiManagement.GatewayHostnameConfiguration",
  );

interface Key {
  resourceGroup: string;
  serviceName: string;
  gatewayName: string;
  hostnameConfigurationName: string;
}

const desiredOf = (news: GatewayHostnameConfigurationProps) => ({
  hostname: news.hostname,
  certificateId: news.certificateId,
  negotiateClientCertificate: news.negotiateClientCertificate ?? false,
  tls10Enabled: news.tls10Enabled ?? false,
  tls11Enabled: news.tls11Enabled ?? false,
  http2Enabled: news.http2Enabled ?? false,
});

export const GatewayHostnameConfigurationProvider = () =>
  Provider.succeed(GatewayHostnameConfiguration, {
    stables: [
      "hostnameConfigurationName",
      "hostnameConfigurationId",
      "gatewayName",
      "serviceName",
      "resourceGroup",
    ],
    ...entityLifecycle<
      GatewayHostnameConfigurationProps,
      GatewayHostnameConfiguration["Attributes"],
      Key,
      apim.GetGatewayHostnameConfigurationResponse
    >({
      label: (key) =>
        `API Management hostname configuration ${key.hostnameConfigurationName} of gateway ${key.gatewayName}`,
      keyOf: (props, id, output) =>
        Effect.gen(function* () {
          return {
            resourceGroup: props.resourceGroup,
            serviceName: props.serviceName,
            gatewayName: props.gatewayName,
            hostnameConfigurationName:
              props.name ??
              output?.hostnameConfigurationName ??
              (yield* createEntityName(id)),
          };
        }),
      keyOfAttrs: (attrs) => attrs,
      get: (subscriptionId, key) =>
        apim.GetGatewayHostnameConfiguration({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          gatewayId: key.gatewayName,
          hcId: key.hostnameConfigurationName,
        }),
      put: (subscriptionId, key, news) =>
        apim.GatewayHostnameConfigurationCreateOrUpdate({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          gatewayId: key.gatewayName,
          hcId: key.hostnameConfigurationName,
          properties: desiredOf(news),
        }),
      remove: (subscriptionId, key) =>
        apim.DeleteGatewayHostnameConfiguration({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          gatewayId: key.gatewayName,
          hcId: key.hostnameConfigurationName,
        }),
      inSync: (news, observed) =>
        subsetMatches(
          { ...desiredOf(news), certificateId: undefined },
          observed.properties,
        ) &&
        (news.certificateId === undefined ||
          observed.properties?.certificateId?.toLowerCase() ===
            news.certificateId.toLowerCase()),
      toAttrs: (_subscriptionId, key, observed) => ({
        resourceGroup: key.resourceGroup,
        serviceName: key.serviceName,
        gatewayName: key.gatewayName,
        hostnameConfigurationName: key.hostnameConfigurationName,
        hostnameConfigurationId: observed.id ?? "",
        hostname: observed.properties?.hostname ?? "",
      }),
    }),
  });
