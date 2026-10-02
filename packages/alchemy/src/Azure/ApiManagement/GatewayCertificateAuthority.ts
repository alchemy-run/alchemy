import * as apim from "@distilled.cloud/azure/apimanagement";
import * as Effect from "effect/Effect";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { entityLifecycle } from "./Entity.ts";

export interface GatewayCertificateAuthorityProps {
  /** Resource group of the API Management service. Changing it replaces the authority. */
  resourceGroup: string;
  /** API Management service that holds the gateway. Changing it replaces the authority. */
  serviceName: string;
  /** Identifier of the self-hosted {@link Gateway}. Changing it replaces the authority. */
  gatewayName: string;
  /** Identifier of the CA {@link Certificate} (`Certificate.certificateName`). Changing it replaces the authority. */
  certificateName: string;
  /**
   * Whether the CA is trusted (otherwise only used to build chains).
   * @default false
   */
  isTrusted?: boolean;
}

export interface GatewayCertificateAuthority extends Resource<
  "Azure.ApiManagement.GatewayCertificateAuthority",
  GatewayCertificateAuthorityProps,
  {
    /** ARM resource ID of the gateway certificate authority. */
    certificateAuthorityId: string;
    /** Identifier of the gateway. */
    gatewayName: string;
    /** Identifier of the CA certificate. */
    certificateName: string;
    /** API Management service that holds the gateway. */
    serviceName: string;
    /** Resource group of the service. */
    resourceGroup: string;
    /** Whether the CA is trusted. */
    isTrusted: boolean;
  },
  never,
  Providers
> {}

/**
 * Adds a CA certificate to a self-hosted API Management {@link Gateway}
 * so it can validate client and backend certificates issued by that CA.
 * Self-hosted gateways require the Developer or Premium tier.
 *
 * @see https://learn.microsoft.com/azure/api-management/api-management-howto-ca-certificates
 *
 * ### Trusting a CA
 * **Example:** Trust an internal CA on a self-hosted gateway
 * ```typescript
 * yield* Azure.ApiManagement.GatewayCertificateAuthority("internal-ca", {
 *   resourceGroup: group.resourceGroupName,
 *   serviceName: apim.serviceName,
 *   gatewayName: gateway.gatewayName,
 *   certificateName: caCert.certificateName,
 *   isTrusted: true,
 * });
 * ```
 *
 * @resource
 */
export const GatewayCertificateAuthority =
  Resource<GatewayCertificateAuthority>(
    "Azure.ApiManagement.GatewayCertificateAuthority",
  );

interface Key {
  resourceGroup: string;
  serviceName: string;
  gatewayName: string;
  certificateName: string;
}

export const GatewayCertificateAuthorityProvider = () =>
  Provider.succeed(GatewayCertificateAuthority, {
    stables: [
      "certificateAuthorityId",
      "gatewayName",
      "certificateName",
      "serviceName",
      "resourceGroup",
    ],
    ...entityLifecycle<
      GatewayCertificateAuthorityProps,
      GatewayCertificateAuthority["Attributes"],
      Key,
      apim.GetGatewayCertificateAuthorityResponse
    >({
      label: (key) =>
        `API Management CA ${key.certificateName} on gateway ${key.gatewayName}`,
      keyOf: (props) =>
        Effect.succeed({
          resourceGroup: props.resourceGroup,
          serviceName: props.serviceName,
          gatewayName: props.gatewayName,
          certificateName: props.certificateName,
        }),
      keyOfAttrs: (attrs) => attrs,
      get: (subscriptionId, key) =>
        apim.GetGatewayCertificateAuthority({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          gatewayId: key.gatewayName,
          certificateId: key.certificateName,
        }),
      put: (subscriptionId, key, news) =>
        apim.GatewayCertificateAuthorityCreateOrUpdate({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          gatewayId: key.gatewayName,
          certificateId: key.certificateName,
          properties: { isTrusted: news.isTrusted ?? false },
        }),
      remove: (subscriptionId, key) =>
        apim.DeleteGatewayCertificateAuthority({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          serviceName: key.serviceName,
          gatewayId: key.gatewayName,
          certificateId: key.certificateName,
        }),
      inSync: (news, observed) =>
        (observed.properties?.isTrusted ?? false) === (news.isTrusted ?? false),
      toAttrs: (_subscriptionId, key, observed) => ({
        resourceGroup: key.resourceGroup,
        serviceName: key.serviceName,
        gatewayName: key.gatewayName,
        certificateName: key.certificateName,
        certificateAuthorityId: observed.id ?? "",
        isTrusted: observed.properties?.isTrusted ?? false,
      }),
    }),
  });
