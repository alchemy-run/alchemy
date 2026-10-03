import * as dr from "@distilled.cloud/azure/recoveryservicesdatareplication";
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
import { DATA_REPLICATION_NAMESPACE, sameName } from "./Shared.ts";

export class PrivateEndpointConnectionMissing extends Data.TaggedError(
  "Azure.DataReplication.PrivateEndpointConnectionMissing",
)<{
  readonly vault: string;
  readonly message: string;
}> {}

export interface PrivateEndpointConnectionProps {
  /** Resource group of the vault. Changing it replaces the resource. */
  resourceGroup: string;
  /** Data replication vault the private endpoint targets. Changing it replaces the resource. */
  vault: string;
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
  /** Reason shown to the private endpoint owner. */
  description?: string;
}

export interface PrivateEndpointConnection extends Resource<
  "Azure.DataReplication.PrivateEndpointConnection",
  PrivateEndpointConnectionProps,
  {
    /** Name of the connection. */
    privateEndpointConnectionName: string;
    /** ARM resource ID of the connection. */
    privateEndpointConnectionId: string;
    /** Vault the connection belongs to. */
    vault: string;
    /** Resource group of the vault. */
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
 * Approves (or rejects) a private endpoint connection to an Azure Site
 * Recovery data replication vault. The connection itself is created by
 * the private endpoint (`Azure.Network.PrivateEndpoint` with
 * `manualPrivateLinkServiceConnections` and group ID `DataReplication`);
 * this resource takes it over and drives its approval state. Deleting it
 * removes the connection, which disconnects the endpoint.
 *
 * The connection is identified by the private endpoint you reference, so
 * Alchemy treats it as owned without tags.
 *
 * @see https://learn.microsoft.com/rest/api/datareplication/private-endpoint-connections
 *
 * ### Approving a Private Endpoint
 * **Example:** Manual-approval endpoint, approved by the vault owner
 * ```typescript
 * const vault = yield* Azure.DataReplication.Vault("vault", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * const endpoint = yield* Azure.Network.PrivateEndpoint("vault-pe", {
 *   resourceGroup: group.resourceGroupName,
 *   subnetId: subnet.subnetId,
 *   manualPrivateLinkServiceConnections: [
 *     { privateLinkServiceId: vault.vaultId, groupIds: ["DataReplication"] },
 *   ],
 * });
 * yield* Azure.DataReplication.PrivateEndpointConnection("vault-pe-approval", {
 *   resourceGroup: group.resourceGroupName,
 *   vault: vault.vaultName,
 *   privateEndpointId: endpoint.privateEndpointId,
 *   description: "approved by platform team",
 * });
 * ```
 *
 * @resource
 */
export const PrivateEndpointConnection = Resource<PrivateEndpointConnection>(
  "Azure.DataReplication.PrivateEndpointConnection",
);

interface Parent {
  subscriptionId: string;
  resourceGroupName: string;
  vaultName: string;
}

const getConnection = (parent: Parent, name: string) =>
  orUndefinedIfNotFound(
    dr.GetPrivateEndpointConnection({
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
      dr
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
  connection: dr.GetPrivateEndpointConnectionResponse,
): PrivateEndpointConnection["Attributes"] => ({
  privateEndpointConnectionName: connection.name ?? "",
  privateEndpointConnectionId: connection.id ?? "",
  vault: parent.vaultName,
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
      "vault",
      "resourceGroup",
      "privateEndpointId",
    ],

    // Connections live inside a vault and disappear with their endpoint.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.vault, output.vault) ||
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
      const vaultName = output?.vault ?? olds?.vault;
      if (resourceGroupName === undefined || vaultName === undefined) {
        return undefined;
      }
      const parent = { subscriptionId, resourceGroupName, vaultName };
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
      yield* ensureRegistered(subscriptionId, DATA_REPLICATION_NAMESPACE);
      const parent = {
        subscriptionId,
        resourceGroupName: news.resourceGroup,
        vaultName: news.vault,
      };
      const status = news.status ?? "Approved";

      // Observe: the private endpoint creates the connection; it can take a
      // few seconds to appear on the vault.
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
                vault: news.vault,
                message: `no private endpoint connection ${news.name ?? news.privateEndpointId ?? ""} on vault ${news.vault}`,
              }),
            ),
        ),
      );
      const name = observed.name ?? "";

      // Sync the approval state against the observed state.
      const state = observed.properties?.privateLinkServiceConnectionState;
      const converged = (
        connection: dr.GetPrivateEndpointConnectionResponse,
      ) => {
        const current =
          connection.properties?.privateLinkServiceConnectionState;
        return (
          sameName(current?.status, status) &&
          (news.description === undefined ||
            current?.description === news.description)
        );
      };
      if (!converged(observed)) {
        yield* dr.UpdatePrivateEndpointConnection({
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
        `data replication private endpoint connection ${name}`,
        getConnection(parent, name),
        (connection) =>
          converged(connection)
            ? connection.properties?.provisioningState
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
        vaultName: output.vault,
      };
      yield* ignoreNotFound(
        dr.DeletePrivateEndpointConnection({
          ...parent,
          privateEndpointConnectionName: output.privateEndpointConnectionName,
        }),
      );
      yield* waitUntilGone(
        `data replication private endpoint connection ${output.privateEndpointConnectionName}`,
        getConnection(parent, output.privateEndpointConnectionName),
        { interval: "5 seconds", times: 60 },
      );
    }),

    nuke: { dependsOn: ["Azure.DataReplication.Vault"] },
  });
