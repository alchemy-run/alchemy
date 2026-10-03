import * as iot from "@distilled.cloud/azure/iotoperations";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { childLifecycle, childStatus, type InstanceScope } from "./Common.ts";

export interface RegistryEndpointProps {
  /** Resource group of the IoT Operations instance. Changing it replaces the endpoint. */
  resourceGroup: string;
  /** IoT Operations instance that holds the endpoint. Changing it replaces the endpoint. */
  instanceName: string;
  /**
   * Endpoint name (lowercase letters, digits, and hyphens). If omitted, a
   * unique name is generated from the app, stage, and logical ID. Changing
   * it replaces the endpoint.
   */
  name?: string;
  /** Container registry host name, e.g. `myregistry.azurecr.io`. */
  host: string;
  /**
   * How the cluster authenticates to the registry. `method` is one of
   * `SystemAssignedManagedIdentity` (with
   * `systemAssignedManagedIdentitySettings: { audience? }`),
   * `UserAssignedManagedIdentity` (with
   * `userAssignedManagedIdentitySettings: { clientId, tenantId, scope? }`),
   * `ArtifactPullSecret` (with `artifactPullSecretSettings: { secretRef }`),
   * or `Anonymous` (with `anonymousSettings: {}`).
   */
  authentication: iot.RegistryEndpointAuthentication;
  /**
   * Certificate authorities that sign artifacts in the registry, each a
   * `Secret` (`secretRef`) or `ConfigMap` (`configMapRef`).
   */
  codeSigningCas?: iot.RegistryEndpointTrustedSigningKey[];
}

export interface RegistryEndpoint extends Resource<
  "Azure.IoTOperations.RegistryEndpoint",
  RegistryEndpointProps,
  {
    /** Name of the endpoint. */
    registryEndpointName: string;
    /** IoT Operations instance that holds the endpoint. */
    instanceName: string;
    /** Resource group of the instance. */
    resourceGroup: string;
    /** ARM resource ID of the endpoint. */
    registryEndpointId: string;
    /** Provisioning state of the endpoint. */
    provisioningState: string | undefined;
    /** Health of the endpoint as reported by the edge cluster. */
    healthState: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A container registry endpoint of an Azure IoT Operations instance, from
 * which dataflow graphs pull WebAssembly modules and Akri connector
 * templates pull images.
 *
 * @see https://learn.microsoft.com/azure/iot-operations/connect-to-cloud/howto-configure-registry-endpoint
 *
 * ### Connecting a Registry
 * **Example:** Azure Container Registry with the instance's managed identity
 * ```typescript
 * const registry = yield* Azure.IoTOperations.RegistryEndpoint("acr", {
 *   resourceGroup: group.resourceGroupName,
 *   instanceName: instance.instanceName,
 *   host: `${acr.registryName}.azurecr.io`,
 *   authentication: {
 *     method: "SystemAssignedManagedIdentity",
 *     systemAssignedManagedIdentitySettings: {},
 *   },
 * });
 * ```
 *
 * **Example:** Public registry
 * ```typescript
 * const registry = yield* Azure.IoTOperations.RegistryEndpoint("public", {
 *   resourceGroup: group.resourceGroupName,
 *   instanceName: instance.instanceName,
 *   host: "ghcr.io",
 *   authentication: { method: "Anonymous", anonymousSettings: {} },
 * });
 * ```
 *
 * @resource
 */
export const RegistryEndpoint = Resource<RegistryEndpoint>(
  "Azure.IoTOperations.RegistryEndpoint",
);

export const RegistryEndpointProvider = () =>
  Provider.succeed(RegistryEndpoint, {
    stables: [
      "registryEndpointName",
      "instanceName",
      "resourceGroup",
      "registryEndpointId",
    ],
    ...childLifecycle<
      RegistryEndpointProps,
      RegistryEndpoint["Attributes"],
      InstanceScope,
      iot.GetRegistryEndpointResponse,
      iot.RegistryEndpointPropertiesInput
    >({
      kind: "registry endpoint",
      scopeOf: (props) => ({
        resourceGroup: props.resourceGroup,
        instanceName: props.instanceName,
      }),
      keyOfAttrs: (attrs) => ({
        resourceGroup: attrs.resourceGroup,
        instanceName: attrs.instanceName,
        name: attrs.registryEndpointName,
      }),
      get: (subscriptionId, key) =>
        iot.GetRegistryEndpoint({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          instanceName: key.instanceName,
          registryEndpointName: key.name,
        }),
      put: (subscriptionId, key, properties, extendedLocation) =>
        iot.RegistryEndpointCreateOrUpdate({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          instanceName: key.instanceName,
          registryEndpointName: key.name,
          properties,
          ...(extendedLocation !== undefined ? { extendedLocation } : {}),
        }),
      remove: (subscriptionId, key) =>
        iot.DeleteRegistryEndpoint({
          subscriptionId,
          resourceGroupName: key.resourceGroup,
          instanceName: key.instanceName,
          registryEndpointName: key.name,
        }),
      bodyOf: (props) => ({
        host: props.host,
        authentication: props.authentication,
        codeSigningCas: props.codeSigningCas,
      }),
      toAttrs: (key, observed) => ({
        registryEndpointName: key.name,
        instanceName: key.instanceName,
        resourceGroup: key.resourceGroup,
        registryEndpointId: observed.id ?? "",
        ...childStatus(observed),
      }),
    }),
  });
