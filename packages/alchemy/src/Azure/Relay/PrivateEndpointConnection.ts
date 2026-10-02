import * as relay from "@distilled.cloud/azure/relay";
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
  "Azure.Relay.PrivateEndpointConnectionMissing",
)<{
  readonly namespace: string;
  readonly message: string;
}> {}

/** Approval decision for a private endpoint connection. */
export type PrivateEndpointConnectionStatus = "Approved" | "Rejected";

export interface PrivateEndpointConnectionProps {
  /** Resource group of the namespace. Changing it replaces the resource. */
  resourceGroup: string;
  /** Relay namespace the private endpoint targets. Changing it replaces the resource. */
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
  /** Reason shown to the private endpoint owner. */
  description?: string;
}

export interface PrivateEndpointConnection extends Resource<
  "Azure.Relay.PrivateEndpointConnection",
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
 * Approves (or rejects) a private endpoint connection to an Azure Relay
 * namespace. The connection itself is created by the private endpoint
 * (`Azure.Network.PrivateEndpoint` with
 * `manualPrivateLinkServiceConnections`); this resource takes it over and
 * drives its approval state. Deleting it removes the connection, which
 * disconnects the endpoint.
 *
 * The connection is identified by the private endpoint you reference, so
 * Alchemy treats it as owned without tags.
 *
 * @see https://learn.microsoft.com/azure/azure-relay/private-link-service
 *
 * ### Approving a Private Endpoint
 * **Example:** Manual-approval endpoint, approved by the namespace owner
 * ```typescript
 * const ns = yield* Azure.Relay.Namespace("relay", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * const endpoint = yield* Azure.Network.PrivateEndpoint("relay-pe", {
 *   resourceGroup: group.resourceGroupName,
 *   subnetId: subnet.subnetId,
 *   manualPrivateLinkServiceConnections: [
 *     { privateLinkServiceId: ns.namespaceId, groupIds: ["namespace"] },
 *   ],
 * });
 * yield* Azure.Relay.PrivateEndpointConnection("relay-pe-approval", {
 *   resourceGroup: group.resourceGroupName,
 *   namespace: ns.namespaceName,
 *   privateEndpointId: endpoint.privateEndpointId,
 *   description: "approved by platform team",
 * });
 * ```
 *
 * @resource
 */
export const PrivateEndpointConnection = Resource<PrivateEndpointConnection>(
  "Azure.Relay.PrivateEndpointConnection",
);

interface Parent {
  subscriptionId: string;
  resourceGroupName: string;
  namespaceName: string;
}

const getConnection = (parent: Parent, name: string) =>
  orUndefinedIfNotFound(
    relay.GetPrivateEndpointConnection({
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
      relay
        .ListPrivateEndpointConnections(parent)
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListPrivateEndpointConnections", page),
          ),
        ),
    );
    return (page?.value ?? []).find((connection) =>
      sameName(connection.properties?.privateEndpoint?.id, privateEndpointId),
    );
  });

const toAttrs = (
  parent: Parent,
  connection: relay.PrivateEndpointConnection,
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
      yield* ensureRegistered(subscriptionId, "Microsoft.Relay");
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
      if (
        !sameName(state?.status, status) ||
        (news.description !== undefined &&
          state?.description !== news.description)
      ) {
        yield* relay.PrivateEndpointConnectionsCreateOrUpdate({
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
        `relay private endpoint connection ${name}`,
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
        relay.DeletePrivateEndpointConnection({
          ...parent,
          privateEndpointConnectionName: output.privateEndpointConnectionName,
        }),
      );
      yield* waitUntilGone(
        `relay private endpoint connection ${output.privateEndpointConnectionName}`,
        getConnection(parent, output.privateEndpointConnectionName),
        { interval: "5 seconds", times: 36 },
      );
    }),

    nuke: { dependsOn: ["Azure.Relay.Namespace"] },
  });
