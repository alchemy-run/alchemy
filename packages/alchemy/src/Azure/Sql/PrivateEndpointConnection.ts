import * as sql from "@distilled.cloud/azure/sql";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
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
import { isServerOwnedByStack, lower, readyState, sameId } from "./common.ts";

export interface PrivateEndpointConnectionProps {
  /** Resource group of the SQL server. Changing it replaces the connection. */
  resourceGroup: string;
  /** Name of the SQL server the private endpoint connects to. Changing it replaces the connection. */
  server: string;
  /**
   * ARM ID of the private endpoint whose connection request is managed.
   * Changing it replaces the connection.
   */
  privateEndpointId: string;
  /**
   * Decision on the connection request.
   * @default "Approved"
   */
  status?: "Approved" | "Rejected";
  /**
   * Reason for the decision, shown to the private endpoint's owner.
   * @default unmanaged
   */
  description?: string;
}

export interface PrivateEndpointConnection extends Resource<
  "Azure.Sql.PrivateEndpointConnection",
  PrivateEndpointConnectionProps,
  {
    /** Name of the connection (assigned by Azure). */
    privateEndpointConnectionName: string;
    /** ARM resource ID of the connection. */
    privateEndpointConnectionId: string;
    /** Name of the SQL server the private endpoint connects to. */
    server: string;
    /** Resource group of the SQL server. */
    resourceGroup: string;
    /** ARM ID of the private endpoint. */
    privateEndpointId: string;
    /** Observed status: `Pending`, `Approved`, `Rejected`, or `Disconnected`. */
    status: string | undefined;
    /** Observed reason for the decision. */
    description: string | undefined;
  },
  never,
  Providers
> {}

/**
 * Approval of a private endpoint's connection to an Azure SQL server.
 *
 * Connections are not created directly: a private endpoint that targets
 * the server with a *manual* connection leaves a `Pending` request on the
 * server. This resource approves or rejects that request. Azure SQL
 * treats the decision as final: changing `status` later fails, and
 * `description` is only sent with the decision. Destroying the resource
 * removes the connection, which disconnects the private endpoint.
 *
 * @see https://learn.microsoft.com/azure/azure-sql/database/private-endpoint-overview
 *
 * ### Approving Connections
 * **Example:** Approve a manual private endpoint request
 * ```typescript
 * const endpoint = yield* Azure.Network.PrivateEndpoint("server-pe", {
 *   resourceGroup: group.resourceGroupName,
 *   subnetId: subnet.subnetId,
 *   manualPrivateLinkServiceConnections: [
 *     { privateLinkServiceId: server.serverId, groupIds: ["sqlServer"] },
 *   ],
 * });
 * yield* Azure.Sql.PrivateEndpointConnection("server-pe-approval", {
 *   resourceGroup: group.resourceGroupName,
 *   server: server.serverName,
 *   privateEndpointId: endpoint.privateEndpointId,
 *   description: "Approved for the app VNet",
 * });
 * ```
 *
 * **Example:** Reject a request
 * ```typescript
 * yield* Azure.Sql.PrivateEndpointConnection("server-pe-approval", {
 *   resourceGroup: group.resourceGroupName,
 *   server: server.serverName,
 *   privateEndpointId: endpoint.privateEndpointId,
 *   status: "Rejected",
 *   description: "Use the shared endpoint instead",
 * });
 * ```
 *
 * @resource
 */
export const PrivateEndpointConnection = Resource<PrivateEndpointConnection>(
  "Azure.Sql.PrivateEndpointConnection",
);

export class PrivateEndpointConnectionDecided extends Data.TaggedError(
  "Azure.Sql.PrivateEndpointConnectionDecided",
)<{ readonly message: string }> {}

export class PrivateEndpointConnectionRequestMissing extends Data.TaggedError(
  "Azure.Sql.PrivateEndpointConnectionRequestMissing",
)<{ readonly message: string }> {}

type Observed = sql.GetPrivateEndpointConnectionResponse;

const getConnection = (
  subscriptionId: string,
  resourceGroupName: string,
  serverName: string,
  privateEndpointConnectionName: string,
) =>
  orUndefinedIfNotFound(
    sql.GetPrivateEndpointConnection({
      subscriptionId,
      resourceGroupName,
      serverName,
      privateEndpointConnectionName,
    }),
  );

const findConnection = Effect.fn(function* (
  subscriptionId: string,
  resourceGroupName: string,
  serverName: string,
  privateEndpointId: string,
) {
  const page = yield* orUndefinedIfNotFound(
    sql
      .ListPrivateEndpointConnectionByServer({
        subscriptionId,
        resourceGroupName,
        serverName,
      })
      .pipe(
        Effect.flatMap((page) =>
          requireSinglePage("ListPrivateEndpointConnectionByServer", page),
        ),
      ),
  );
  return (page?.value ?? []).find((connection) =>
    sameId(connection.properties?.privateEndpoint?.id, privateEndpointId),
  );
});

const toAttrs = (
  resourceGroup: string,
  server: string,
  privateEndpointId: string,
  connection: Observed,
): PrivateEndpointConnection["Attributes"] => ({
  privateEndpointConnectionName: connection.name ?? "",
  privateEndpointConnectionId: connection.id ?? "",
  server,
  resourceGroup,
  privateEndpointId,
  status: connection.properties?.privateLinkServiceConnectionState?.status,
  description:
    connection.properties?.privateLinkServiceConnectionState?.description,
});

export const PrivateEndpointConnectionProvider = () =>
  Provider.succeed(PrivateEndpointConnection, {
    stables: [
      "privateEndpointConnectionName",
      "privateEndpointConnectionId",
      "server",
      "resourceGroup",
      "privateEndpointId",
    ],

    // Connections disappear with their server or endpoint.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.server) !== lower(output.server) ||
        !sameId(news.privateEndpointId, output.privateEndpointId)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const server = output?.server ?? olds?.server;
      const privateEndpointId =
        output?.privateEndpointId ?? olds?.privateEndpointId;
      if (
        resourceGroup === undefined ||
        server === undefined ||
        privateEndpointId === undefined
      ) {
        return undefined;
      }
      const observed = yield* findConnection(
        subscriptionId,
        resourceGroup,
        server,
        privateEndpointId,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, server, privateEndpointId, observed);
      return (yield* isServerOwnedByStack(
        subscriptionId,
        resourceGroup,
        server,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Sql");
      const { resourceGroup, server, privateEndpointId } = news;
      const status = news.status ?? "Approved";

      // Observe. The request appears on the server shortly after the
      // private endpoint is created; it cannot be created from this side.
      const observed = yield* findConnection(
        subscriptionId,
        resourceGroup,
        server,
        privateEndpointId,
      ).pipe(
        Effect.flatMap((found) =>
          found === undefined
            ? Effect.fail(
                new PrivateEndpointConnectionRequestMissing({
                  message: `no connection from private endpoint ${privateEndpointId} on sql server ${server}`,
                }),
              )
            : Effect.succeed(found),
        ),
        Effect.retry({
          while: (e) =>
            e._tag === "Azure.Sql.PrivateEndpointConnectionRequestMissing",
          schedule: Schedule.spaced("5 seconds"),
          times: 12,
        }),
      );
      const name = observed.name ?? "";
      const get = getConnection(subscriptionId, resourceGroup, server, name);

      // Sync the decision. Azure SQL only accepts decisions on `Pending`
      // requests: an approval or rejection is final, so a later change
      // surfaces Azure's error and a description-only change is skipped.
      const state = observed.properties?.privateLinkServiceConnectionState;
      if (
        state?.status !== status &&
        (state?.status === "Pending" || state?.status === undefined)
      ) {
        yield* sql.PrivateEndpointConnectionsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          serverName: server,
          privateEndpointConnectionName: name,
          properties: {
            privateLinkServiceConnectionState: {
              status,
              description: news.description ?? state?.description ?? "",
            },
          },
        });
      } else if (state?.status !== status) {
        return yield* Effect.fail(
          new PrivateEndpointConnectionDecided({
            message: `private endpoint connection ${name} on ${server} is already ${state?.status}; Azure SQL decisions are final (delete the private endpoint to start over)`,
          }),
        );
      }
      const fresh = yield* waitForProvisioned(
        `private endpoint connection ${name}`,
        get,
        (connection) =>
          connection.properties?.privateLinkServiceConnectionState?.status ===
          status
            ? readyState(connection.properties.provisioningState)
            : "Updating",
        { interval: "3 seconds", times: 40 },
      );
      return toAttrs(resourceGroup, server, privateEndpointId, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        sql.DeletePrivateEndpointConnection({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          serverName: output.server,
          privateEndpointConnectionName: output.privateEndpointConnectionName,
        }),
      );
      yield* waitUntilGone(
        `private endpoint connection ${output.privateEndpointConnectionName}`,
        getConnection(
          subscriptionId,
          output.resourceGroup,
          output.server,
          output.privateEndpointConnectionName,
        ),
      );
    }),

    nuke: {
      dependsOn: ["Azure.Sql.Server", "Azure.Resources.ResourceGroup"],
    },
  });
