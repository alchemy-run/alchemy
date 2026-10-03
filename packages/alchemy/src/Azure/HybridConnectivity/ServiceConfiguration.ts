import * as hybridconnectivity from "@distilled.cloud/azure/hybridconnectivity";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";

export interface ServiceConfigurationProps {
  /**
   * ARM resource ID of the resource the parent endpoint is attached to
   * (the endpoint's `resourceUri`). Changing it replaces the configuration.
   */
  resourceUri: string;
  /**
   * Name of the parent `Azure.HybridConnectivity.Endpoint`. Changing it
   * replaces the configuration.
   * @default "default"
   */
  endpointName?: string;
  /**
   * Service exposed through the endpoint: `SSH` or `WAC` (Windows Admin
   * Center). Changing it replaces the configuration.
   */
  serviceName: "SSH" | "WAC";
  /**
   * Name of the service configuration. Azure expects it to match
   * `serviceName`. Changing it replaces the configuration.
   * @default serviceName
   */
  name?: string;
  /**
   * ARM resource ID of the connectivity endpoint target. Changing it
   * replaces the configuration.
   */
  resourceId?: string;
  /**
   * Port on the machine the service listens on (e.g. `22` for SSH,
   * `6516` for WAC).
   */
  port?: number;
}

export interface ServiceConfiguration extends Resource<
  "Azure.HybridConnectivity.ServiceConfiguration",
  ServiceConfigurationProps,
  {
    /** Name of the service configuration. */
    serviceConfigurationName: string;
    /** Name of the parent endpoint. */
    endpointName: string;
    /** ARM resource ID of the resource the parent endpoint is attached to. */
    resourceUri: string;
    /** ARM resource ID of the service configuration. */
    serviceConfigurationId: string;
    /** Service exposed through the endpoint (`SSH` or `WAC`). */
    serviceName: string;
    /** ARM resource ID of the connectivity endpoint target, if any. */
    resourceId: string | undefined;
    /** Port the service listens on. */
    port: number | undefined;
    /** ARM provisioning state of the service configuration. */
    provisioningState: string | undefined;
  },
  never,
  Providers
> {}

/**
 * Enables a service (SSH or Windows Admin Center) on an Azure Arc hybrid
 * connectivity endpoint, so clients can reach that port on an Arc-enabled
 * server through Azure Relay.
 *
 * Service configurations carry no tags or free-form fields, so Alchemy
 * cannot mark them; one found at the expected scope is treated as this
 * resource.
 *
 * @see https://learn.microsoft.com/azure/azure-arc/servers/ssh-arc-overview
 *
 * ### Enabling SSH
 * **Example:** SSH on port 22
 * ```typescript
 * const endpoint = yield* Azure.HybridConnectivity.Endpoint("Endpoint", {
 *   resourceUri: machine.machineId,
 * });
 * yield* Azure.HybridConnectivity.ServiceConfiguration("Ssh", {
 *   resourceUri: endpoint.resourceUri,
 *   endpointName: endpoint.endpointName,
 *   serviceName: "SSH",
 *   port: 22,
 * });
 * ```
 *
 * ### Enabling Windows Admin Center
 * **Example:** WAC on port 6516
 * ```typescript
 * yield* Azure.HybridConnectivity.ServiceConfiguration("Wac", {
 *   resourceUri: endpoint.resourceUri,
 *   endpointName: endpoint.endpointName,
 *   serviceName: "WAC",
 *   port: 6516,
 * });
 * ```
 *
 * @resource
 */
export const ServiceConfiguration = Resource<ServiceConfiguration>(
  "Azure.HybridConnectivity.ServiceConfiguration",
);

/** Lowercased ARM id comparison (ARM echoes ids with mixed casing). */
const sameId = (a: string | undefined, b: string | undefined) =>
  (a ?? "").toLowerCase() === (b ?? "").toLowerCase();

const getConfiguration = (
  resourceUri: string,
  endpointName: string,
  serviceConfigurationName: string,
) =>
  orUndefinedIfNotFound(
    hybridconnectivity.GetServiceConfiguration({
      resourceUri,
      endpointName,
      serviceConfigurationName,
    }),
  );

const toAttrs = (
  resourceUri: string,
  endpointName: string,
  name: string,
  observed: hybridconnectivity.GetServiceConfigurationResponse,
): ServiceConfiguration["Attributes"] => ({
  serviceConfigurationName: name,
  endpointName,
  resourceUri,
  serviceConfigurationId: observed.id ?? "",
  serviceName: observed.properties?.serviceName ?? name,
  resourceId: observed.properties?.resourceId,
  port: observed.properties?.port,
  provisioningState: observed.properties?.provisioningState,
});

export const ServiceConfigurationProvider = () =>
  Provider.succeed(ServiceConfiguration, {
    stables: [
      "serviceConfigurationName",
      "endpointName",
      "resourceUri",
      "serviceConfigurationId",
    ],

    // Extension resources vanish with the endpoint they extend.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      const sameScope =
        sameId(news.resourceUri, output.resourceUri) &&
        (news.endpointName ?? "default").toLowerCase() ===
          output.endpointName.toLowerCase() &&
        (news.name ?? news.serviceName).toLowerCase() ===
          output.serviceConfigurationName.toLowerCase();
      if (!sameScope) return { action: "replace" } as const;
      // Immutable fields at the same ARM id: delete before recreating.
      if (
        news.serviceName.toLowerCase() !== output.serviceName.toLowerCase() ||
        (news.resourceId !== undefined &&
          !sameId(news.resourceId, output.resourceId))
      ) {
        return { action: "replace", deleteFirst: true } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const resourceUri = output?.resourceUri ?? olds?.resourceUri;
      const name = output?.serviceConfigurationName ?? olds?.name ?? olds?.serviceName;
      if (resourceUri === undefined || name === undefined) return undefined;
      const endpointName =
        output?.endpointName ?? olds?.endpointName ?? "default";
      const observed = yield* getConfiguration(resourceUri, endpointName, name);
      return observed === undefined
        ? undefined
        : toAttrs(resourceUri, endpointName, name, observed);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.HybridConnectivity");
      const { resourceUri } = news;
      const endpointName = news.endpointName ?? "default";
      const name = news.name ?? news.serviceName;
      const get = getConfiguration(resourceUri, endpointName, name);

      // Observe.
      const observed = yield* get;

      // Ensure, then sync the port against observed state.
      if (observed === undefined) {
        yield* hybridconnectivity.CreateServiceConfigurationOrupdate({
          resourceUri,
          endpointName,
          serviceConfigurationName: name,
          properties: {
            serviceName: news.serviceName,
            resourceId: news.resourceId,
            port: news.port,
          },
        });
      } else if (
        news.port !== undefined &&
        observed.properties?.port !== news.port
      ) {
        yield* hybridconnectivity.UpdateServiceConfiguration({
          resourceUri,
          endpointName,
          serviceConfigurationName: name,
          properties: { port: news.port },
        });
      }

      const fresh = yield* waitForProvisioned(
        `hybrid connectivity service configuration ${resourceUri}/${endpointName}/${name}`,
        get,
        (value) => value.properties?.provisioningState,
      );
      return toAttrs(resourceUri, endpointName, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* ignoreNotFound(
        hybridconnectivity.DeleteServiceConfiguration({
          resourceUri: output.resourceUri,
          endpointName: output.endpointName,
          serviceConfigurationName: output.serviceConfigurationName,
        }),
      );
      yield* waitUntilGone(
        `hybrid connectivity service configuration ${output.resourceUri}/${output.endpointName}/${output.serviceConfigurationName}`,
        getConfiguration(
          output.resourceUri,
          output.endpointName,
          output.serviceConfigurationName,
        ),
      );
    }),
  });
