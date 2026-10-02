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
import {
  isManagedInstanceOwnedByStack,
  lower,
  readyState,
  sameId,
} from "./common.ts";

export interface ManagedInstancePrivateEndpointConnectionProps {
  /** Resource group of the managed instance. Changing it replaces the connection. */
  resourceGroup: string;
  /** Name of the SQL managed instance the private endpoint connects to. Changing it replaces the connection. */
  managedInstance: string;
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

export interface ManagedInstancePrivateEndpointConnection extends Resource<
  "Azure.Sql.ManagedInstancePrivateEndpointConnection",
  ManagedInstancePrivateEndpointConnectionProps,
  {
    /** Name of the connection (assigned by Azure). */
    privateEndpointConnectionName: string;
    /** ARM resource ID of the connection. */
    privateEndpointConnectionId: string;
    /** Name of the SQL managed instance the private endpoint connects to. */
    managedInstance: string;
    /** Resource group of the managed instance. */
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
 * Approval of a private endpoint's connection to an Azure SQL Managed Instance.
 *
 * Connections are not created directly: a private endpoint that targets
 * the instance with a *manual* connection leaves a `Pending` request on the
 * instance. This resource approves or rejects that request. Azure SQL
 * treats the decision as final: changing `status` later fails, and
 * `description` is only sent with the decision. Destroying the resource
 * removes the connection, which disconnects the private endpoint.
 *
 * @see https://learn.microsoft.com/azure/azure-sql/managed-instance/private-endpoint-overview
 *
 * ### Approving Connections
 * **Example:** Approve a manual private endpoint request
 * ```typescript
 * const endpoint = yield* Azure.Network.PrivateEndpoint("managedInstance-pe", {
 *   resourceGroup: group.resourceGroupName,
 *   subnetId: subnet.subnetId,
 *   manualPrivateLinkServiceConnections: [
 *     { privateLinkServiceId: instance.managedInstanceId, groupIds: ["managedInstance"] },
 *   ],
 * });
 * yield* Azure.Sql.ManagedInstancePrivateEndpointConnection("managedInstance-pe-approval", {
 *   resourceGroup: group.resourceGroupName,
 *   managedInstance: instance.managedInstanceName,
 *   privateEndpointId: endpoint.privateEndpointId,
 *   description: "Approved for the app VNet",
 * });
 * ```
 *
 * **Example:** Reject a request
 * ```typescript
 * yield* Azure.Sql.ManagedInstancePrivateEndpointConnection("managedInstance-pe-approval", {
 *   resourceGroup: group.resourceGroupName,
 *   managedInstance: instance.managedInstanceName,
 *   privateEndpointId: endpoint.privateEndpointId,
 *   status: "Rejected",
 *   description: "Use the shared endpoint instead",
 * });
 * ```
 *
 * @resource
 */
export const ManagedInstancePrivateEndpointConnection =
  Resource<ManagedInstancePrivateEndpointConnection>(
    "Azure.Sql.ManagedInstancePrivateEndpointConnection",
  );

export class ManagedInstancePrivateEndpointConnectionDecided extends Data.TaggedError(
  "Azure.Sql.ManagedInstancePrivateEndpointConnectionDecided",
)<{ readonly message: string }> {}

export class ManagedInstancePrivateEndpointConnectionRequestMissing extends Data.TaggedError(
  "Azure.Sql.ManagedInstancePrivateEndpointConnectionRequestMissing",
)<{ readonly message: string }> {}

type Observed = sql.GetManagedInstancePrivateEndpointConnectionResponse;

const getConnection = (
  subscriptionId: string,
  resourceGroupName: string,
  managedInstanceName: string,
  privateEndpointConnectionName: string,
) =>
  orUndefinedIfNotFound(
    sql.GetManagedInstancePrivateEndpointConnection({
      subscriptionId,
      resourceGroupName,
      managedInstanceName,
      privateEndpointConnectionName,
    }),
  );

const findConnection = Effect.fn(function* (
  subscriptionId: string,
  resourceGroupName: string,
  managedInstanceName: string,
  privateEndpointId: string,
) {
  const page = yield* orUndefinedIfNotFound(
    sql
      .ListManagedInstancePrivateEndpointConnectionByManagedInstance({
        subscriptionId,
        resourceGroupName,
        managedInstanceName,
      })
      .pipe(
        Effect.flatMap((page) =>
          requireSinglePage(
            "ListManagedInstancePrivateEndpointConnectionByManagedInstance",
            page,
          ),
        ),
      ),
  );
  return (page?.value ?? []).find((connection) =>
    sameId(connection.properties?.privateEndpoint?.id, privateEndpointId),
  );
});

const toAttrs = (
  resourceGroup: string,
  managedInstance: string,
  privateEndpointId: string,
  connection: Observed,
): ManagedInstancePrivateEndpointConnection["Attributes"] => ({
  privateEndpointConnectionName: connection.name ?? "",
  privateEndpointConnectionId: connection.id ?? "",
  managedInstance,
  resourceGroup,
  privateEndpointId,
  status: connection.properties?.privateLinkServiceConnectionState?.status,
  description:
    connection.properties?.privateLinkServiceConnectionState?.description,
});

export const ManagedInstancePrivateEndpointConnectionProvider = () =>
  Provider.succeed(ManagedInstancePrivateEndpointConnection, {
    stables: [
      "privateEndpointConnectionName",
      "privateEndpointConnectionId",
      "managedInstance",
      "resourceGroup",
      "privateEndpointId",
    ],

    // Connections disappear with their managed instance or endpoint.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.managedInstance) !== lower(output.managedInstance) ||
        !sameId(news.privateEndpointId, output.privateEndpointId)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const managedInstance = output?.managedInstance ?? olds?.managedInstance;
      const privateEndpointId =
        output?.privateEndpointId ?? olds?.privateEndpointId;
      if (
        resourceGroup === undefined ||
        managedInstance === undefined ||
        privateEndpointId === undefined
      ) {
        return undefined;
      }
      const observed = yield* findConnection(
        subscriptionId,
        resourceGroup,
        managedInstance,
        privateEndpointId,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(
        resourceGroup,
        managedInstance,
        privateEndpointId,
        observed,
      );
      return (yield* isManagedInstanceOwnedByStack(
        subscriptionId,
        resourceGroup,
        managedInstance,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Sql");
      const { resourceGroup, managedInstance, privateEndpointId } = news;
      const status = news.status ?? "Approved";

      // Observe. The request appears on the instance shortly after the
      // private endpoint is created; it cannot be created from this side.
      const observed = yield* findConnection(
        subscriptionId,
        resourceGroup,
        managedInstance,
        privateEndpointId,
      ).pipe(
        Effect.flatMap((found) =>
          found === undefined
            ? Effect.fail(
                new ManagedInstancePrivateEndpointConnectionRequestMissing({
                  message: `no connection from private endpoint ${privateEndpointId} on managed instance ${managedInstance}`,
                }),
              )
            : Effect.succeed(found),
        ),
        Effect.retry({
          while: (e) =>
            e._tag ===
            "Azure.Sql.ManagedInstancePrivateEndpointConnectionRequestMissing",
          schedule: Schedule.spaced("5 seconds"),
          times: 12,
        }),
      );
      const name = observed.name ?? "";
      const get = getConnection(
        subscriptionId,
        resourceGroup,
        managedInstance,
        name,
      );

      // Sync the decision. Azure SQL only accepts decisions on `Pending`
      // requests: an approval or rejection is final, so a later change
      // surfaces Azure's error and a description-only change is skipped.
      const state = observed.properties?.privateLinkServiceConnectionState;
      if (
        state?.status !== status &&
        (state?.status === "Pending" || state?.status === undefined)
      ) {
        yield* sql.ManagedInstancePrivateEndpointConnectionsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          managedInstanceName: managedInstance,
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
          new ManagedInstancePrivateEndpointConnectionDecided({
            message: `private endpoint connection ${name} on ${managedInstance} is already ${state?.status}; Azure SQL decisions are final (delete the private endpoint to start over)`,
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
      return toAttrs(resourceGroup, managedInstance, privateEndpointId, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        sql.DeleteManagedInstancePrivateEndpointConnection({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          managedInstanceName: output.managedInstance,
          privateEndpointConnectionName: output.privateEndpointConnectionName,
        }),
      );
      yield* waitUntilGone(
        `private endpoint connection ${output.privateEndpointConnectionName}`,
        getConnection(
          subscriptionId,
          output.resourceGroup,
          output.managedInstance,
          output.privateEndpointConnectionName,
        ),
      );
    }),

    nuke: {
      dependsOn: ["Azure.Sql.ManagedInstance", "Azure.Resources.ResourceGroup"],
    },
  });
