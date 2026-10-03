import * as vi from "@distilled.cloud/azure/vi";
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

export interface PrivateEndpointConnectionProps {
  /**
   * Resource group of the Video Indexer account. Changing it replaces the
   * connection.
   */
  resourceGroup: string;
  /**
   * Video Indexer account the private endpoint connects to. Changing it
   * replaces the connection.
   */
  account: string;
  /**
   * ARM ID of the private endpoint whose connection request is managed.
   * Changing it replaces the connection.
   */
  privateEndpointId: string;
  /**
   * Decision on the connection request. Video Indexer accepts only the
   * first decision on a pending request; changing it later fails with
   * `HttpResponsePayloadAPISpecValidationFailed`.
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
  "Azure.VideoIndexer.PrivateEndpointConnection",
  PrivateEndpointConnectionProps,
  {
    /** Name of the connection (assigned by Azure). */
    privateEndpointConnectionName: string;
    /** ARM resource ID of the connection. */
    privateEndpointConnectionId: string;
    /** Video Indexer account the private endpoint connects to. */
    account: string;
    /** Resource group of the Video Indexer account. */
    resourceGroup: string;
    /** ARM ID of the private endpoint. */
    privateEndpointId: string;
    /** Observed status: `Pending`, `Approved`, or `Rejected`. */
    status: string | undefined;
    /** Observed reason for the decision. */
    description: string | undefined;
  },
  never,
  Providers
> {}

/**
 * Approval of a private endpoint's connection to a Video Indexer account.
 *
 * A private endpoint that targets the account (group `account`) with a
 * *manual* connection leaves a `Pending` request on the account. This
 * resource approves or rejects that request. Destroying it removes the
 * connection, which disconnects the private endpoint.
 *
 * The decision is made once: Video Indexer fails any later change to an
 * approved or rejected connection with
 * `HttpResponsePayloadAPISpecValidationFailed` and keeps the old state.
 * To change it, recreate the private endpoint.
 *
 * @see https://learn.microsoft.com/azure/azure-video-indexer/network-security
 *
 * ### Approving Connections
 * **Example:** Approve a manual private endpoint request
 * ```typescript
 * const endpoint = yield* Azure.Network.PrivateEndpoint("indexer-pe", {
 *   resourceGroup: group.resourceGroupName,
 *   subnetId: subnet.subnetId,
 *   manualPrivateLinkServiceConnections: [
 *     {
 *       privateLinkServiceId: indexer.videoIndexerAccountId,
 *       groupIds: ["account"],
 *     },
 *   ],
 * });
 * yield* Azure.VideoIndexer.PrivateEndpointConnection("indexer-pe-approval", {
 *   resourceGroup: group.resourceGroupName,
 *   account: indexer.accountName,
 *   privateEndpointId: endpoint.privateEndpointId,
 *   description: "Approved for the media VNet",
 * });
 * ```
 *
 * **Example:** Reject a request
 * ```typescript
 * yield* Azure.VideoIndexer.PrivateEndpointConnection("indexer-pe-approval", {
 *   resourceGroup: group.resourceGroupName,
 *   account: indexer.accountName,
 *   privateEndpointId: endpoint.privateEndpointId,
 *   status: "Rejected",
 *   description: "Use the shared endpoint instead",
 * });
 * ```
 *
 * @resource
 */
export const PrivateEndpointConnection = Resource<PrivateEndpointConnection>(
  "Azure.VideoIndexer.PrivateEndpointConnection",
);

export class VideoIndexerPrivateEndpointConnectionRequestMissing extends Data.TaggedError(
  "Azure.VideoIndexer.PrivateEndpointConnectionRequestMissing",
)<{ readonly message: string }> {}

type Observed = vi.GetPrivateEndpointConnectionResponse;

const sameId = (a: string | undefined, b: string) =>
  (a ?? "").toLowerCase() === b.toLowerCase();

const getConnection = (
  subscriptionId: string,
  resourceGroupName: string,
  accountName: string,
  privateEndpointConnectionName: string,
) =>
  orUndefinedIfNotFound(
    vi.GetPrivateEndpointConnection({
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
    vi
      .ListPrivateEndpointConnectionByAccount({
        subscriptionId,
        resourceGroupName,
        accountName,
      })
      .pipe(
        Effect.flatMap((page) =>
          requireSinglePage("ListPrivateEndpointConnectionByAccount", page),
        ),
      ),
  );
  return (page?.value ?? []).find((connection) =>
    sameId(connection.properties?.privateEndpoint?.id, privateEndpointId),
  );
});

/** Connections carry no tags; ownership follows the account's tags. */
const isAccountOwnedByStack = Effect.fn(function* (
  subscriptionId: string,
  resourceGroupName: string,
  accountName: string,
) {
  const account = yield* orUndefinedIfNotFound(
    vi.GetAccount({ subscriptionId, resourceGroupName, accountName }),
  );
  if (account === undefined) return false;
  const { stack, stage } = yield* stackAndStage;
  const tags = tagRecord(account.tags);
  return tags["alchemy::stack"] === stack && tags["alchemy::stage"] === stage;
});

const toAttrs = (
  resourceGroup: string,
  account: string,
  privateEndpointId: string,
  connection: Observed,
): PrivateEndpointConnection["Attributes"] => ({
  privateEndpointConnectionName: connection.name ?? "",
  privateEndpointConnectionId: connection.id ?? "",
  account,
  resourceGroup,
  privateEndpointId,
  status: connection.properties?.privateLinkServiceConnectionState.status,
  description:
    connection.properties?.privateLinkServiceConnectionState.description,
});

export const PrivateEndpointConnectionProvider = () =>
  Provider.succeed(PrivateEndpointConnection, {
    stables: [
      "privateEndpointConnectionName",
      "privateEndpointConnectionId",
      "account",
      "resourceGroup",
      "privateEndpointId",
    ],

    // Connections disappear with their account or endpoint.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        news.account.toLowerCase() !== output.account.toLowerCase() ||
        !sameId(news.privateEndpointId, output.privateEndpointId)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const account = output?.account ?? olds?.account;
      const privateEndpointId =
        output?.privateEndpointId ?? olds?.privateEndpointId;
      if (
        resourceGroup === undefined ||
        account === undefined ||
        privateEndpointId === undefined
      ) {
        return undefined;
      }
      const observed = yield* findConnection(
        subscriptionId,
        resourceGroup,
        account,
        privateEndpointId,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(
        resourceGroup,
        account,
        privateEndpointId,
        observed,
      );
      return (yield* isAccountOwnedByStack(
        subscriptionId,
        resourceGroup,
        account,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.VideoIndexer");
      const { resourceGroup, account, privateEndpointId } = news;
      const status = news.status ?? "Approved";

      // Observe. The request appears on the account shortly after the
      // private endpoint is created; it cannot be created from this side.
      const observed = yield* findConnection(
        subscriptionId,
        resourceGroup,
        account,
        privateEndpointId,
      ).pipe(
        Effect.flatMap((found) =>
          found === undefined
            ? Effect.fail(
                new VideoIndexerPrivateEndpointConnectionRequestMissing({
                  message: `no connection from private endpoint ${privateEndpointId} on video indexer account ${account}`,
                }),
              )
            : Effect.succeed(found),
        ),
        Effect.retry({
          while: (e) =>
            e._tag ===
            "Azure.VideoIndexer.PrivateEndpointConnectionRequestMissing",
          schedule: Schedule.spaced("5 seconds"),
          times: 12,
        }),
      );
      const name = observed.name ?? "";
      const get = getConnection(subscriptionId, resourceGroup, account, name);

      // Sync the decision against observed state.
      const state = observed.properties?.privateLinkServiceConnectionState;
      if (
        state?.status !== status ||
        (news.description !== undefined &&
          state?.description !== news.description)
      ) {
        yield* vi.PrivateEndpointConnectionsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          accountName: account,
          privateEndpointConnectionName: name,
          properties: {
            privateLinkServiceConnectionState: {
              status,
              description: news.description ?? state?.description,
            },
          },
        });
      }
      const fresh = yield* waitForProvisioned(
        `private endpoint connection ${name}`,
        get,
        (connection) =>
          connection.properties?.privateLinkServiceConnectionState.status ===
          status
            ? connection.properties.provisioningState
            : "Updating",
        { interval: "3 seconds", times: 40 },
      );
      return toAttrs(resourceGroup, account, privateEndpointId, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        vi.DeletePrivateEndpointConnection({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          accountName: output.account,
          privateEndpointConnectionName: output.privateEndpointConnectionName,
        }),
      );
      yield* waitUntilGone(
        `private endpoint connection ${output.privateEndpointConnectionName}`,
        getConnection(
          subscriptionId,
          output.resourceGroup,
          output.account,
          output.privateEndpointConnectionName,
        ),
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.VideoIndexer.Account",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
