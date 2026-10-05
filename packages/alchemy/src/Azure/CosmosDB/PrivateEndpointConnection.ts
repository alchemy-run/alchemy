import * as cosmos from "@distilled.cloud/azure/cosmos_db";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  requireSinglePage,
  stackAndStage,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { whileAccountBusy } from "./Shared.ts";

export interface PrivateEndpointConnectionProps {
  /**
   * Resource group of the Cosmos DB account. Changing it replaces the
   * connection.
   */
  resourceGroup: string;
  /**
   * Name of the Cosmos DB account the private endpoint connects to, e.g.
   * `account.accountName`. Changing it replaces the connection.
   */
  databaseAccount: string;
  /**
   * ARM ID of the private endpoint whose connection request is managed.
   * Changing it replaces the connection.
   */
  privateEndpointId: string;
  /**
   * Decision on the connection request. A rejected connection cannot be
   * approved again; the private endpoint must be recreated.
   * @default "Approved"
   */
  status?: "Approved" | "Rejected";
  /**
   * Reason for the decision, shown to the private endpoint's owner. It is
   * sent together with a status change; changing only the description of
   * an existing decision has no effect.
   * @default unmanaged
   */
  description?: string;
}

export interface PrivateEndpointConnection extends Resource<
  "Azure.CosmosDB.PrivateEndpointConnection",
  PrivateEndpointConnectionProps,
  {
    /** Name of the connection (assigned by Azure). */
    privateEndpointConnectionName: string;
    /** ARM resource ID of the connection. */
    privateEndpointConnectionId: string;
    /** Name of the Cosmos DB account. */
    databaseAccount: string;
    /** Resource group of the Cosmos DB account. */
    resourceGroup: string;
    /** ARM ID of the private endpoint. */
    privateEndpointId: string;
    /** Sub-resource the endpoint connects to, e.g. `Sql` or `MongoDB`. */
    groupId: string | undefined;
    /** Observed status: `Pending`, `Approved`, `Rejected`, or `Disconnected`. */
    status: string | undefined;
    /** Observed reason for the decision. */
    description: string | undefined;
  },
  never,
  Providers
> {}

/**
 * Approval of a private endpoint's connection to an Azure Cosmos DB
 * account.
 *
 * Connections are not created directly: a private endpoint that targets the
 * account with a *manual* connection (for example from another team's
 * subscription) leaves a `Pending` request on the account. This resource
 * approves or rejects that request. Destroying it removes the connection,
 * which disconnects the private endpoint.
 *
 * @see https://learn.microsoft.com/azure/cosmos-db/how-to-configure-private-endpoints
 *
 * ### Approving Connections
 * **Example:** Approve a manual private endpoint request
 * ```typescript
 * const endpoint = yield* Azure.Network.PrivateEndpoint("orders-sql", {
 *   resourceGroup: group.resourceGroupName,
 *   subnetId: subnet.subnetId,
 *   manualPrivateLinkServiceConnections: [
 *     { privateLinkServiceId: account.accountId, groupIds: ["Sql"] },
 *   ],
 * });
 * yield* Azure.CosmosDB.PrivateEndpointConnection("orders-sql-approval", {
 *   resourceGroup: group.resourceGroupName,
 *   databaseAccount: account.accountName,
 *   privateEndpointId: endpoint.privateEndpointId,
 *   description: "Approved for the analytics VNet",
 * });
 * ```
 *
 * **Example:** Reject a request
 * ```typescript
 * yield* Azure.CosmosDB.PrivateEndpointConnection("orders-sql-approval", {
 *   resourceGroup: group.resourceGroupName,
 *   databaseAccount: account.accountName,
 *   privateEndpointId: endpoint.privateEndpointId,
 *   status: "Rejected",
 *   description: "Use the shared endpoint instead",
 * });
 * ```
 *
 * @resource
 */
export const PrivateEndpointConnection = Resource<PrivateEndpointConnection>(
  "Azure.CosmosDB.PrivateEndpointConnection",
);

export class CosmosPrivateEndpointConnectionRequestMissing extends Data.TaggedError(
  "Azure.CosmosDB.PrivateEndpointConnectionRequestMissing",
)<{ readonly message: string }> {}

type Observed = cosmos.GetPrivateEndpointConnectionResponse;

const sameId = (a: string | undefined, b: string) =>
  (a ?? "").toLowerCase() === b.toLowerCase();

const getConnection = (
  subscriptionId: string,
  resourceGroupName: string,
  accountName: string,
  privateEndpointConnectionName: string,
) =>
  orUndefinedIfNotFound(
    cosmos.GetPrivateEndpointConnection({
      subscriptionId,
      resourceGroupName,
      accountName,
      privateEndpointConnectionName,
    }),
  );

/** The account's connection for the given private endpoint. */
const findConnection = Effect.fn(function* (
  subscriptionId: string,
  resourceGroupName: string,
  accountName: string,
  privateEndpointId: string,
) {
  const page = yield* orUndefinedIfNotFound(
    cosmos
      .ListPrivateEndpointConnectionByDatabaseAccount({
        subscriptionId,
        resourceGroupName,
        accountName,
      })
      .pipe(
        Effect.flatMap((page) =>
          requireSinglePage(
            "ListPrivateEndpointConnectionByDatabaseAccount",
            page,
          ),
        ),
      ),
  );
  return (page?.value ?? []).find((connection) =>
    sameId(connection.properties?.privateEndpoint?.id, privateEndpointId),
  );
});

/**
 * Connections carry no tags; they inherit ownership from the account being
 * tagged by the current stack and stage.
 */
const isAccountOwnedByStack = Effect.fn(function* (
  subscriptionId: string,
  resourceGroupName: string,
  accountName: string,
) {
  const account = yield* orUndefinedIfNotFound(
    cosmos.GetDatabaseAccount({
      subscriptionId,
      resourceGroupName,
      accountName,
    }),
  );
  if (account === undefined) return false;
  const { stack, stage } = yield* stackAndStage;
  const tags = tagRecord(account.tags);
  return tags["alchemy::stack"] === stack && tags["alchemy::stage"] === stage;
});

const toAttrs = (
  resourceGroup: string,
  databaseAccount: string,
  privateEndpointId: string,
  connection: Observed,
): PrivateEndpointConnection["Attributes"] => ({
  privateEndpointConnectionName: connection.name ?? "",
  privateEndpointConnectionId: connection.id ?? "",
  databaseAccount,
  resourceGroup,
  privateEndpointId,
  groupId: connection.properties?.groupId,
  status: connection.properties?.privateLinkServiceConnectionState?.status,
  description:
    connection.properties?.privateLinkServiceConnectionState?.description,
});

export const PrivateEndpointConnectionProvider = () =>
  Provider.succeed(PrivateEndpointConnection, {
    stables: [
      "privateEndpointConnectionName",
      "privateEndpointConnectionId",
      "databaseAccount",
      "resourceGroup",
      "privateEndpointId",
      "groupId",
    ],

    // Connections disappear with their account or private endpoint.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        news.databaseAccount !== output.databaseAccount ||
        !sameId(news.privateEndpointId, output.privateEndpointId)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const databaseAccount = output?.databaseAccount ?? olds?.databaseAccount;
      const privateEndpointId =
        output?.privateEndpointId ?? olds?.privateEndpointId;
      if (
        resourceGroup === undefined ||
        databaseAccount === undefined ||
        privateEndpointId === undefined
      ) {
        return undefined;
      }
      const observed = yield* findConnection(
        subscriptionId,
        resourceGroup,
        databaseAccount,
        privateEndpointId,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(
        resourceGroup,
        databaseAccount,
        privateEndpointId,
        observed,
      );
      return (yield* isAccountOwnedByStack(
        subscriptionId,
        resourceGroup,
        databaseAccount,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.DocumentDB");
      const { resourceGroup, databaseAccount, privateEndpointId } = news;
      const status = news.status ?? "Approved";

      // Observe. The request appears on the account shortly after the
      // private endpoint is created; it cannot be created from this side.
      const observed = yield* findConnection(
        subscriptionId,
        resourceGroup,
        databaseAccount,
        privateEndpointId,
      ).pipe(
        Effect.flatMap((found) =>
          found === undefined
            ? Effect.fail(
                new CosmosPrivateEndpointConnectionRequestMissing({
                  message: `no connection from private endpoint ${privateEndpointId} on Cosmos DB account ${databaseAccount}`,
                }),
              )
            : Effect.succeed(found),
        ),
        Effect.retry({
          while: (e) =>
            e._tag === "Azure.CosmosDB.PrivateEndpointConnectionRequestMissing",
          schedule: Schedule.spaced("5 seconds"),
          times: 24,
        }),
      );
      const name = observed.name ?? "";
      const get = getConnection(
        subscriptionId,
        resourceGroup,
        databaseAccount,
        name,
      );

      // Sync the decision against the observed state.
      const state = observed.properties?.privateLinkServiceConnectionState;
      if (state?.status !== status) {
        yield* cosmos
          .PrivateEndpointConnectionsCreateOrUpdate({
            subscriptionId,
            resourceGroupName: resourceGroup,
            accountName: databaseAccount,
            privateEndpointConnectionName: name,
            properties: {
              groupId: observed.properties?.groupId,
              privateLinkServiceConnectionState: {
                status,
                description: news.description ?? state?.description,
              },
            },
          })
          .pipe(Effect.retry(whileAccountBusy));
      }
      const fresh = yield* waitForProvisioned(
        `Cosmos DB private endpoint connection ${name}`,
        get,
        (connection) =>
          connection.properties?.privateLinkServiceConnectionState?.status ===
          status
            ? connection.properties.provisioningState
            : "Updating",
        { interval: "5 seconds", times: 60 },
      );
      return toAttrs(resourceGroup, databaseAccount, privateEndpointId, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        cosmos
          .DeletePrivateEndpointConnection({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            accountName: output.databaseAccount,
            privateEndpointConnectionName: output.privateEndpointConnectionName,
          })
          .pipe(Effect.retry(whileAccountBusy)),
      );
      yield* waitUntilGone(
        `Cosmos DB private endpoint connection ${output.privateEndpointConnectionName}`,
        getConnection(
          subscriptionId,
          output.resourceGroup,
          output.databaseAccount,
          output.privateEndpointConnectionName,
        ),
        { interval: "5 seconds", times: 60 },
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.CosmosDB.DatabaseAccount",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
