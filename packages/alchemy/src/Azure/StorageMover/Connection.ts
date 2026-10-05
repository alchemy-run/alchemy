import * as storagemover from "@distilled.cloud/azure/storagemover";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
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
  createMoverName,
  DELETE_BUDGET,
  describe,
  isOwnedByDescription,
  userDescription,
} from "./Common.ts";

export interface ConnectionProps {
  /** Resource group of the Storage Mover. Changing it replaces the connection. */
  resourceGroup: string;
  /** Storage Mover that holds the connection. Changing it replaces the connection. */
  storageMover: string;
  /**
   * Name of the connection: 1-20 letters, digits, `-` and `_`, starting
   * with a letter or digit. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the connection.
   */
  name?: string;
  /**
   * ARM ID of the private link service the Storage Mover connects to
   * through a managed private endpoint. Changing it replaces the
   * connection.
   */
  privateLinkServiceId: string;
  /**
   * Description of the connection. Alchemy appends an ownership marker
   * (`[alchemy <stack>/<stage>/<id>]`) because connections have no tags.
   * Azure ignores description changes on an existing connection, so
   * changing it replaces the connection.
   */
  description?: string;
}

export interface Connection extends Resource<
  "Azure.StorageMover.Connection",
  ConnectionProps,
  {
    /** Name of the connection. */
    connectionName: string;
    /** Storage Mover that holds the connection. */
    storageMover: string;
    /** Resource group of the Storage Mover. */
    resourceGroup: string;
    /** ARM resource ID of the connection. */
    connectionId: string;
    /** ARM ID of the private link service. */
    privateLinkServiceId: string;
    /**
     * Approval status of the private endpoint connection: `Pending` until
     * the private link service owner approves it.
     */
    connectionStatus: string | undefined;
    /** Name of the managed private endpoint. */
    privateEndpointName: string | undefined;
    /** ARM ID of the managed private endpoint. */
    privateEndpointResourceId: string | undefined;
    /** Description of the connection (ownership marker stripped). */
    description: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A Storage Mover connection — a managed private endpoint from the Storage
 * Mover service to a private link service, used by agentless cloud-to-cloud
 * jobs to reach sources over a private network.
 *
 * The private link service owner must approve the connection before jobs can
 * use it; pass `privateEndpointResourceId` to a
 * `Network.PrivateLinkServiceConnectionApproval` to approve it in the same
 * stack. Connections have no tags, so Alchemy records ownership as a marker
 * at the end of the description.
 *
 * @see https://learn.microsoft.com/azure/storage-mover/service-overview
 *
 * ### Creating a Connection
 * **Example:** Connect to a private link service
 * ```typescript
 * const connection = yield* Azure.StorageMover.Connection("private", {
 *   resourceGroup: group.resourceGroupName,
 *   storageMover: mover.storageMoverName,
 *   privateLinkServiceId: service.privateLinkServiceId,
 *   description: "Reach the on-premises NAS",
 * });
 * ```
 *
 * @resource
 */
export const Connection = Resource<Connection>("Azure.StorageMover.Connection");

type ObservedConnection = storagemover.GetConnectionResponse;

const getConnection = (
  subscriptionId: string,
  resourceGroupName: string,
  storageMoverName: string,
  connectionName: string,
) =>
  orUndefinedIfNotFound(
    storagemover.GetConnection({
      subscriptionId,
      resourceGroupName,
      storageMoverName,
      connectionName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  storageMover: string,
  name: string,
  connection: ObservedConnection,
): Connection["Attributes"] => ({
  connectionName: name,
  storageMover,
  resourceGroup,
  connectionId: connection.id ?? "",
  privateLinkServiceId: connection.properties.privateLinkServiceId,
  connectionStatus: connection.properties.connectionStatus,
  privateEndpointName: connection.properties.privateEndpointName,
  privateEndpointResourceId: connection.properties.privateEndpointResourceId,
  description: userDescription(connection.properties.description),
});

export const ConnectionProvider = () =>
  Provider.succeed(Connection, {
    stables: [
      "connectionName",
      "storageMover",
      "resourceGroup",
      "connectionId",
      "privateLinkServiceId",
    ],

    // Connections are deleted with their Storage Mover.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        news.storageMover.toLowerCase() !== output.storageMover.toLowerCase() ||
        (news.name !== undefined &&
          news.name.toLowerCase() !== output.connectionName.toLowerCase()) ||
        news.privateLinkServiceId.toLowerCase() !==
          output.privateLinkServiceId.toLowerCase() ||
        (news.description || undefined) !== output.description
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const storageMover = output?.storageMover ?? olds?.storageMover;
      if (resourceGroup === undefined || storageMover === undefined) {
        return undefined;
      }
      const name =
        output?.connectionName ??
        olds?.name ??
        (yield* createMoverName(id, 20));
      const observed = yield* getConnection(
        subscriptionId,
        resourceGroup,
        storageMover,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, storageMover, name, observed);
      return (yield* isOwnedByDescription(id, observed.properties.description))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.StorageMover");
      const { resourceGroup, storageMover, privateLinkServiceId } = news;
      const name =
        news.name ?? output?.connectionName ?? (yield* createMoverName(id, 20));
      const description = yield* describe(id, news.description);
      const get = getConnection(
        subscriptionId,
        resourceGroup,
        storageMover,
        name,
      );

      // Observe.
      const observed = yield* get;

      // Ensure. Nothing is mutable: a PUT on an existing connection succeeds
      // but ignores the description (diff replaces instead).
      if (observed === undefined) {
        yield* storagemover.ConnectionsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          storageMoverName: storageMover,
          connectionName: name,
          properties: { description, privateLinkServiceId },
        });
      }

      const fresh = yield* waitForProvisioned(
        `storage mover connection ${name}`,
        get,
        (connection) => connection.properties.provisioningState,
        { interval: "5 seconds", times: 60 },
      );
      return toAttrs(resourceGroup, storageMover, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        storagemover.DeleteConnection({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          storageMoverName: output.storageMover,
          connectionName: output.connectionName,
        }),
      );
      yield* waitUntilGone(
        `storage mover connection ${output.connectionName}`,
        getConnection(
          subscriptionId,
          output.resourceGroup,
          output.storageMover,
          output.connectionName,
        ),
        DELETE_BUDGET,
      );
    }),
  });
