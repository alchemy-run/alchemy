import * as dps from "@distilled.cloud/azure/deviceprovisioningservices";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
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
import {
  getProvisioningService,
  retryWhileTransitioning,
  sameName,
} from "./Common.ts";

export class ProvisioningServicePrivateEndpointConnectionMissing extends Data.TaggedError(
  "Azure.IoT.ProvisioningServicePrivateEndpointConnectionMissing",
)<{
  readonly provisioningService: string;
  readonly message: string;
}> {}

export interface ProvisioningServicePrivateEndpointConnectionProps {
  /** Resource group of the provisioning service. Changing it replaces the resource. */
  resourceGroup: string;
  /** Provisioning service the private endpoint targets. Changing it replaces the resource. */
  provisioningService: string;
  /**
   * ARM resource ID of the private endpoint whose connection is managed —
   * typically `Azure.Network.PrivateEndpoint(...).privateEndpointId`. The
   * connection is looked up by this ID. Changing it replaces the resource.
   */
  privateEndpointId?: string;
  /**
   * Name of the connection, when known (Azure generates it when the
   * private endpoint is created). Either `name` or `privateEndpointId` is
   * required. Changing it replaces the resource.
   */
  name?: string;
  /**
   * Approval decision.
   * @default "Approved"
   */
  status?: "Approved" | "Rejected";
  /**
   * Reason shown to the private endpoint owner. DPS only records it when
   * the status changes; a description-only change is not applied.
   */
  description?: string;
}

export interface ProvisioningServicePrivateEndpointConnection extends Resource<
  "Azure.IoT.ProvisioningServicePrivateEndpointConnection",
  ProvisioningServicePrivateEndpointConnectionProps,
  {
    /** Name of the connection. */
    privateEndpointConnectionName: string;
    /** ARM resource ID of the connection. */
    privateEndpointConnectionId: string;
    /** Provisioning service the connection belongs to. */
    provisioningService: string;
    /** Resource group of the provisioning service. */
    resourceGroup: string;
    /** ARM resource ID of the connected private endpoint. */
    privateEndpointId: string | undefined;
    /** Connection status: `Pending`, `Approved`, `Rejected`, or `Disconnected`. */
    status: string | undefined;
    /** Status description. */
    description: string | undefined;
  },
  never,
  Providers
> {}

/**
 * Approves (or rejects) a private endpoint connection to a Device
 * Provisioning Service. The connection itself is created by the private
 * endpoint (`Azure.Network.PrivateEndpoint` with
 * `manualPrivateLinkServiceConnections` and group ID `iotDps`); this
 * resource takes it over and drives its approval state. Deleting it removes
 * the connection, which disconnects the endpoint.
 *
 * The connection is identified by the private endpoint you reference, so
 * Alchemy treats it as owned without tags.
 *
 * @see https://learn.microsoft.com/azure/iot-dps/virtual-network-support
 *
 * ### Approving a Private Endpoint
 * **Example:** Manual-approval endpoint, approved by the service owner
 * ```typescript
 * const dps = yield* Azure.IoT.ProvisioningService("dps", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * const endpoint = yield* Azure.Network.PrivateEndpoint("dps-pe", {
 *   resourceGroup: group.resourceGroupName,
 *   subnetId: subnet.subnetId,
 *   manualPrivateLinkServiceConnections: [
 *     { privateLinkServiceId: dps.provisioningServiceId, groupIds: ["iotDps"] },
 *   ],
 * });
 * yield* Azure.IoT.ProvisioningServicePrivateEndpointConnection("dps-pe-approval", {
 *   resourceGroup: group.resourceGroupName,
 *   provisioningService: dps.provisioningServiceName,
 *   privateEndpointId: endpoint.privateEndpointId,
 *   description: "approved by platform team",
 * });
 * ```
 *
 * ### Rejecting a Private Endpoint
 * **Example:** Reject a connection request
 * ```typescript
 * yield* Azure.IoT.ProvisioningServicePrivateEndpointConnection("dps-pe-reject", {
 *   resourceGroup: group.resourceGroupName,
 *   provisioningService: dps.provisioningServiceName,
 *   privateEndpointId: endpoint.privateEndpointId,
 *   status: "Rejected",
 *   description: "not an approved network",
 * });
 * ```
 *
 * @resource
 */
export const ProvisioningServicePrivateEndpointConnection =
  Resource<ProvisioningServicePrivateEndpointConnection>(
    "Azure.IoT.ProvisioningServicePrivateEndpointConnection",
  );

interface Parent {
  subscriptionId: string;
  resourceGroupName: string;
  resourceName: string;
}

const getConnection = (parent: Parent, name: string) =>
  orUndefinedIfNotFound(
    dps.GetIotDpsResourcePrivateEndpointConnection({
      ...parent,
      privateEndpointConnectionName: name,
    }),
  );

/** Find the connection by name, or by the private endpoint it links. */
const findConnection = (
  parent: Parent,
  name: string | undefined,
  privateEndpointId: string | undefined,
) =>
  Effect.gen(function* () {
    if (name !== undefined) return yield* getConnection(parent, name);
    if (privateEndpointId === undefined) return undefined;
    // The list operation answers 404 with an empty body even when
    // connections exist; the service document embeds them instead.
    const service = yield* getProvisioningService(
      parent.subscriptionId,
      parent.resourceGroupName,
      parent.resourceName,
    );
    const connections = service?.properties?.privateEndpointConnections;
    return (connections ?? []).find((connection) =>
      sameName(connection.properties?.privateEndpoint?.id, privateEndpointId),
    );
  });

const toAttrs = (
  parent: Parent,
  connection: dps.PrivateEndpointConnection,
): ProvisioningServicePrivateEndpointConnection["Attributes"] => ({
  privateEndpointConnectionName: connection.name ?? "",
  privateEndpointConnectionId: connection.id ?? "",
  provisioningService: parent.resourceName,
  resourceGroup: parent.resourceGroupName,
  privateEndpointId: connection.properties?.privateEndpoint?.id,
  status: connection.properties?.privateLinkServiceConnectionState?.status,
  description:
    connection.properties?.privateLinkServiceConnectionState?.description,
});

export const ProvisioningServicePrivateEndpointConnectionProvider = () =>
  Provider.succeed(ProvisioningServicePrivateEndpointConnection, {
    stables: [
      "privateEndpointConnectionName",
      "privateEndpointConnectionId",
      "provisioningService",
      "resourceGroup",
      "privateEndpointId",
    ],

    // Connections live inside a provisioning service and disappear with
    // their endpoint.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.provisioningService, output.provisioningService) ||
        (news.name !== undefined &&
          !sameName(news.name, output.privateEndpointConnectionName)) ||
        (news.privateEndpointId !== undefined &&
          output.privateEndpointId !== undefined &&
          !sameName(news.privateEndpointId, output.privateEndpointId))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroupName = output?.resourceGroup ?? olds?.resourceGroup;
      const resourceName =
        output?.provisioningService ?? olds?.provisioningService;
      if (resourceGroupName === undefined || resourceName === undefined) {
        return undefined;
      }
      const parent = { subscriptionId, resourceGroupName, resourceName };
      const observed = yield* findConnection(
        parent,
        output?.privateEndpointConnectionName ?? olds?.name,
        olds?.privateEndpointId,
      );
      // The connection is created by the referenced private endpoint, so a
      // connection found for it is the one this resource manages.
      return observed === undefined ? undefined : toAttrs(parent, observed);
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Devices");
      const parent = {
        subscriptionId,
        resourceGroupName: news.resourceGroup,
        resourceName: news.provisioningService,
      };
      const status = news.status ?? "Approved";

      // Observe: the private endpoint creates the connection; it can take a
      // few seconds to appear on the service.
      const observed = yield* findConnection(
        parent,
        news.name ?? output?.privateEndpointConnectionName,
        news.privateEndpointId,
      ).pipe(
        Effect.flatMap((connection) =>
          connection === undefined
            ? Effect.fail("missing" as const)
            : Effect.succeed(connection),
        ),
        Effect.retry({
          while: (e) => e === "missing",
          schedule: Schedule.spaced("5 seconds"),
          times: 24,
        }),
        Effect.catchIf(
          (e): e is "missing" => e === "missing",
          () =>
            Effect.fail(
              new ProvisioningServicePrivateEndpointConnectionMissing({
                provisioningService: news.provisioningService,
                message: `no private endpoint connection ${news.name ?? news.privateEndpointId ?? ""} on provisioning service ${news.provisioningService}`,
              }),
            ),
        ),
      );
      const name = observed.name ?? "";

      // Sync the approval state against the observed state. DPS accepts
      // but never applies a description-only change, so the description is
      // only written together with a status change.
      const state = observed.properties?.privateLinkServiceConnectionState;
      if (!sameName(state?.status, status)) {
        yield* retryWhileTransitioning(
          dps.IotDpsResourceCreateOrUpdatePrivateEndpointConnection({
            ...parent,
            privateEndpointConnectionName: name,
            properties: {
              privateLinkServiceConnectionState: {
                status,
                description: news.description ?? state?.description ?? "",
              },
            },
          }),
        );
      }

      // The update is applied asynchronously and the connection reports no
      // provisioning state; wait until the desired state is observed.
      const fresh = yield* waitForProvisioned(
        `dps private endpoint connection ${name}`,
        getConnection(parent, name),
        (connection) =>
          sameName(
            connection.properties?.privateLinkServiceConnectionState?.status,
            status,
          )
            ? "Succeeded"
            : "Updating",
        { interval: "5 seconds", times: 36 },
      );
      // The service stays `Transitioning` while it applies the change and
      // rejects other writes until it is `Active` again.
      yield* waitForProvisioned(
        `provisioning service ${parent.resourceName}`,
        getProvisioningService(
          parent.subscriptionId,
          parent.resourceGroupName,
          parent.resourceName,
        ),
        (service) =>
          service.properties?.state === undefined ||
          service.properties.state === "Active"
            ? "Succeeded"
            : "Updating",
        { interval: "5 seconds", times: 60 },
      );
      return toAttrs(parent, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const parent = {
        subscriptionId,
        resourceGroupName: output.resourceGroup,
        resourceName: output.provisioningService,
      };
      yield* ignoreNotFound(
        retryWhileTransitioning(
          dps.DeleteIotDpsResourcePrivateEndpointConnection({
            ...parent,
            privateEndpointConnectionName: output.privateEndpointConnectionName,
          }),
        ),
      );
      yield* waitUntilGone(
        `dps private endpoint connection ${output.privateEndpointConnectionName}`,
        getConnection(parent, output.privateEndpointConnectionName),
        { interval: "5 seconds", times: 36 },
      );
    }),

    nuke: { dependsOn: ["Azure.IoT.ProvisioningService"] },
  });
