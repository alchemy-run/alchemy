import * as servicebus from "@distilled.cloud/azure/servicebus";
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
  requireSinglePage,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { sameName } from "./internal.ts";

export class PrivateEndpointConnectionMissing extends Data.TaggedError(
  "Azure.ServiceBus.PrivateEndpointConnectionMissing",
)<{
  readonly namespace: string;
  readonly message: string;
}> {}

/** Approval decision for a private endpoint connection. */
export type PrivateEndpointConnectionStatus = "Approved" | "Rejected";

export interface PrivateEndpointConnectionProps {
  /** Resource group of the namespace. Changing it replaces the resource. */
  resourceGroup: string;
  /** Premium namespace the private endpoint targets. Changing it replaces the resource. */
  namespace: string;
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
  status?: PrivateEndpointConnectionStatus;
  /**
   * Reason shown to the private endpoint owner. Service Bus records it only
   * with a status transition (it rejects same-state updates), so changing
   * only the description leaves the recorded one in place until the status
   * next changes.
   */
  description?: string;
}

export interface PrivateEndpointConnection extends Resource<
  "Azure.ServiceBus.PrivateEndpointConnection",
  PrivateEndpointConnectionProps,
  {
    /** Name of the connection. */
    privateEndpointConnectionName: string;
    /** ARM resource ID of the connection. */
    privateEndpointConnectionId: string;
    /** Namespace the connection belongs to. */
    namespaceName: string;
    /** Resource group of the namespace. */
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
 * Approves (or rejects) a private endpoint connection to a Premium Service
 * Bus namespace. The connection itself is created by the private endpoint
 * (`Azure.Network.PrivateEndpoint` with
 * `manualPrivateLinkServiceConnections`); this resource takes it over and
 * drives its approval state. Deleting it removes the connection, which
 * disconnects the endpoint.
 *
 * The connection is identified by the private endpoint you reference, so
 * Alchemy treats it as owned without tags.
 *
 * @see https://learn.microsoft.com/azure/service-bus-messaging/private-link-service
 *
 * ### Approving a Private Endpoint
 * **Example:** Manual-approval endpoint, approved by the namespace owner
 * ```typescript
 * const bus = yield* Azure.ServiceBus.Namespace("bus", {
 *   resourceGroup: group.resourceGroupName,
 *   sku: "Premium",
 * });
 * const endpoint = yield* Azure.Network.PrivateEndpoint("bus-pe", {
 *   resourceGroup: group.resourceGroupName,
 *   subnetId: subnet.subnetId,
 *   manualPrivateLinkServiceConnections: [
 *     { privateLinkServiceId: bus.namespaceId, groupIds: ["namespace"] },
 *   ],
 * });
 * yield* Azure.ServiceBus.PrivateEndpointConnection("bus-pe-approval", {
 *   resourceGroup: group.resourceGroupName,
 *   namespace: bus.namespaceName,
 *   privateEndpointId: endpoint.privateEndpointId,
 *   description: "approved by platform team",
 * });
 * ```
 *
 * @resource
 */
export const PrivateEndpointConnection = Resource<PrivateEndpointConnection>(
  "Azure.ServiceBus.PrivateEndpointConnection",
);

interface Parent {
  subscriptionId: string;
  resourceGroupName: string;
  namespaceName: string;
}

const getConnection = (parent: Parent, name: string) =>
  orUndefinedIfNotFound(
    servicebus.GetPrivateEndpointConnection({
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
    const page = yield* orUndefinedIfNotFound(
      servicebus
        .ListPrivateEndpointConnections(parent)
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListPrivateEndpointConnections", page),
          ),
        ),
    );
    return (page?.value ?? []).find((connection) =>
      sameName(
        connection.properties?.privateEndpoint?.id,
        privateEndpointId,
      ),
    );
  });

const toAttrs = (
  parent: Parent,
  connection: servicebus.PrivateEndpointConnection,
): PrivateEndpointConnection["Attributes"] => ({
  privateEndpointConnectionName: connection.name ?? "",
  privateEndpointConnectionId: connection.id ?? "",
  namespaceName: parent.namespaceName,
  resourceGroup: parent.resourceGroupName,
  privateEndpointId: connection.properties?.privateEndpoint?.id,
  status: connection.properties?.privateLinkServiceConnectionState?.status,
  description:
    connection.properties?.privateLinkServiceConnectionState?.description,
});

export const PrivateEndpointConnectionProvider = () =>
  Provider.succeed(PrivateEndpointConnection, {
    stables: [
      "privateEndpointConnectionName",
      "privateEndpointConnectionId",
      "namespaceName",
      "resourceGroup",
      "privateEndpointId",
    ],

    // Connections live inside a namespace and disappear with their endpoint.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.namespace, output.namespaceName) ||
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
      const namespaceName = output?.namespaceName ?? olds?.namespace;
      if (resourceGroupName === undefined || namespaceName === undefined) {
        return undefined;
      }
      const parent = { subscriptionId, resourceGroupName, namespaceName };
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
      yield* ensureRegistered(subscriptionId, "Microsoft.ServiceBus");
      const parent = {
        subscriptionId,
        resourceGroupName: news.resourceGroup,
        namespaceName: news.namespace,
      };
      const status = news.status ?? "Approved";

      // Observe: the private endpoint creates the connection; it can take a
      // few seconds to appear on the namespace.
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
              new PrivateEndpointConnectionMissing({
                namespace: news.namespace,
                message: `no private endpoint connection ${news.name ?? news.privateEndpointId ?? ""} on namespace ${news.namespace}`,
              }),
            ),
        ),
      );
      const name = observed.name ?? "";

      // Sync the approval state against the observed state.
      const state = observed.properties?.privateLinkServiceConnectionState;
      // Service Bus rejects same-state transitions ("A state change from
      // Approved to Approved is not valid") and treats an omitted status as
      // `Disconnected`, so the description is only written with a status
      // transition.
      if (!sameName(state?.status, status)) {
        yield* servicebus.PrivateEndpointConnectionsCreateOrUpdate({
          ...parent,
          privateEndpointConnectionName: name,
          properties: {
            privateEndpoint: observed.properties?.privateEndpoint,
            privateLinkServiceConnectionState: {
              status,
              description: news.description ?? state?.description,
            },
          },
        });
      }

      const fresh = yield* waitForProvisioned(
        `service bus private endpoint connection ${name}`,
        getConnection(parent, name),
        (connection) => connection.properties?.provisioningState,
        { interval: "5 seconds", times: 36 },
      );
      return toAttrs(parent, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const parent = {
        subscriptionId,
        resourceGroupName: output.resourceGroup,
        namespaceName: output.namespaceName,
      };
      yield* ignoreNotFound(
        servicebus.DeletePrivateEndpointConnection({
          ...parent,
          privateEndpointConnectionName: output.privateEndpointConnectionName,
        }),
      );
      yield* waitUntilGone(
        `service bus private endpoint connection ${output.privateEndpointConnectionName}`,
        getConnection(parent, output.privateEndpointConnectionName),
        { interval: "5 seconds", times: 36 },
      );
    }),

    nuke: { dependsOn: ["Azure.ServiceBus.Namespace"] },
  });
