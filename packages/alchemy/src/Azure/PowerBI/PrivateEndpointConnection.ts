import * as powerbi from "@distilled.cloud/azure/powerbiprivatelinks";
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
import { getPowerBIPrivateLinkService } from "./PrivateLinkService.ts";

export interface PrivateEndpointConnectionProps {
  /**
   * Resource group of the Power BI private link service. Changing it
   * replaces the connection.
   */
  resourceGroup: string;
  /**
   * Name of the Power BI private link service the private endpoint connects
   * to. Changing it replaces the connection.
   */
  privateLinkService: string;
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
  /**
   * Actions the private endpoint's owner must take, if any.
   * @default unmanaged
   */
  actionsRequired?: string;
}

export interface PrivateEndpointConnection extends Resource<
  "Azure.PowerBI.PrivateEndpointConnection",
  PrivateEndpointConnectionProps,
  {
    /** Name of the connection (assigned by Azure). */
    privateEndpointConnectionName: string;
    /** ARM resource ID of the connection. */
    privateEndpointConnectionId: string;
    /** Power BI private link service the endpoint connects to. */
    privateLinkService: string;
    /** Resource group of the private link service. */
    resourceGroup: string;
    /** ARM ID of the private endpoint. */
    privateEndpointId: string;
    /** Observed status: `Pending`, `Approved`, `Rejected`, or `Disconnected`. */
    status: string | undefined;
    /** Observed reason for the decision. */
    description: string | undefined;
    /** Observed actions required of the endpoint's owner. */
    actionsRequired: string | undefined;
  },
  never,
  Providers
> {}

/**
 * Approval of a private endpoint's connection to a Power BI private link
 * service.
 *
 * Connections are not created directly: a private endpoint that targets the
 * service (group `tenant`) with a *manual* connection leaves a `Pending`
 * request on it. This resource approves or rejects that request. Destroying
 * it removes the connection, which disconnects the private endpoint.
 *
 * Requires a Power BI / Fabric tenant with *Azure Private Link* enabled by
 * a tenant administrator.
 *
 * @see https://learn.microsoft.com/fabric/security/security-private-links-use
 *
 * ### Approving Connections
 * **Example:** Approve a manual private endpoint request
 * ```typescript
 * const service = yield* Azure.PowerBI.PrivateLinkService("tenant", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * const endpoint = yield* Azure.Network.PrivateEndpoint("powerbi", {
 *   resourceGroup: group.resourceGroupName,
 *   subnetId: subnet.subnetId,
 *   manualPrivateLinkServiceConnections: [
 *     { privateLinkServiceId: service.privateLinkServiceId, groupIds: ["tenant"] },
 *   ],
 * });
 * yield* Azure.PowerBI.PrivateEndpointConnection("powerbi-approval", {
 *   resourceGroup: group.resourceGroupName,
 *   privateLinkService: service.privateLinkServiceName,
 *   privateEndpointId: endpoint.privateEndpointId,
 *   description: "Approved for the analytics VNet",
 * });
 * ```
 *
 * **Example:** Reject a request
 * ```typescript
 * yield* Azure.PowerBI.PrivateEndpointConnection("powerbi-approval", {
 *   resourceGroup: group.resourceGroupName,
 *   privateLinkService: service.privateLinkServiceName,
 *   privateEndpointId: endpoint.privateEndpointId,
 *   status: "Rejected",
 *   description: "Use the shared endpoint instead",
 * });
 * ```
 *
 * @resource
 */
export const PrivateEndpointConnection = Resource<PrivateEndpointConnection>(
  "Azure.PowerBI.PrivateEndpointConnection",
);

export class PowerBIPrivateEndpointConnectionRequestMissing extends Data.TaggedError(
  "Azure.PowerBI.PrivateEndpointConnectionRequestMissing",
)<{ readonly message: string }> {}

type Observed = powerbi.PrivateEndpointConnection;

const sameId = (a: string | undefined, b: string) =>
  (a ?? "").toLowerCase() === b.toLowerCase();

const getConnection = (
  subscriptionId: string,
  resourceGroupName: string,
  azureResourceName: string,
  privateEndpointName: string,
) =>
  orUndefinedIfNotFound(
    powerbi.GetPrivateEndpointConnection({
      subscriptionId,
      resourceGroupName,
      azureResourceName,
      privateEndpointName,
    }),
  );

/** The service's connection for the given private endpoint. */
const findConnection = Effect.fn(function* (
  subscriptionId: string,
  resourceGroupName: string,
  azureResourceName: string,
  privateEndpointId: string,
) {
  const page = yield* orUndefinedIfNotFound(
    powerbi
      .ListPrivateEndpointConnectionByResource({
        subscriptionId,
        resourceGroupName,
        azureResourceName,
      })
      .pipe(
        Effect.flatMap((page) =>
          requireSinglePage("ListPrivateEndpointConnectionByResource", page),
        ),
      ),
  );
  return (page?.value ?? []).find((connection) =>
    sameId(connection.properties?.privateEndpoint?.id, privateEndpointId),
  );
});

/** Whether the parent service is tagged as owned by this stack and stage. */
const isServiceOwnedByStack = Effect.fn(function* (
  subscriptionId: string,
  resourceGroupName: string,
  azureResourceName: string,
) {
  const service = yield* getPowerBIPrivateLinkService(
    subscriptionId,
    resourceGroupName,
    azureResourceName,
  );
  if (service === undefined) return false;
  const { stack, stage } = yield* stackAndStage;
  const tags = tagRecord(service.tags);
  return tags["alchemy::stack"] === stack && tags["alchemy::stage"] === stage;
});

const toAttrs = (
  resourceGroup: string,
  privateLinkService: string,
  privateEndpointId: string,
  connection: Observed,
): PrivateEndpointConnection["Attributes"] => {
  const state = connection.properties?.privateLinkServiceConnectionState;
  return {
    privateEndpointConnectionName: connection.name ?? "",
    privateEndpointConnectionId: connection.id ?? "",
    privateLinkService,
    resourceGroup,
    privateEndpointId,
    status: state?.status,
    description: state?.description,
    actionsRequired: state?.actionsRequired,
  };
};

export const PrivateEndpointConnectionProvider = () =>
  Provider.succeed(PrivateEndpointConnection, {
    stables: [
      "privateEndpointConnectionName",
      "privateEndpointConnectionId",
      "privateLinkService",
      "resourceGroup",
      "privateEndpointId",
    ],

    // Connections disappear with their service or endpoint.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        news.privateLinkService.toLowerCase() !==
          output.privateLinkService.toLowerCase() ||
        !sameId(news.privateEndpointId, output.privateEndpointId)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const privateLinkService =
        output?.privateLinkService ?? olds?.privateLinkService;
      const privateEndpointId =
        output?.privateEndpointId ?? olds?.privateEndpointId;
      if (
        resourceGroup === undefined ||
        privateLinkService === undefined ||
        privateEndpointId === undefined
      ) {
        return undefined;
      }
      const observed = yield* findConnection(
        subscriptionId,
        resourceGroup,
        privateLinkService,
        privateEndpointId,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(
        resourceGroup,
        privateLinkService,
        privateEndpointId,
        observed,
      );
      return (yield* isServiceOwnedByStack(
        subscriptionId,
        resourceGroup,
        privateLinkService,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.PowerBI");
      const { resourceGroup, privateLinkService, privateEndpointId } = news;
      const status = news.status ?? "Approved";

      // Observe. The request appears on the service shortly after the
      // private endpoint is created; it cannot be created from this side.
      const observed = yield* findConnection(
        subscriptionId,
        resourceGroup,
        privateLinkService,
        privateEndpointId,
      ).pipe(
        Effect.flatMap((found) =>
          found === undefined
            ? Effect.fail(
                new PowerBIPrivateEndpointConnectionRequestMissing({
                  message: `no connection from private endpoint ${privateEndpointId} on Power BI private link service ${privateLinkService}`,
                }),
              )
            : Effect.succeed(found),
        ),
        Effect.retry({
          while: (e) =>
            e._tag === "Azure.PowerBI.PrivateEndpointConnectionRequestMissing",
          schedule: Schedule.spaced("5 seconds"),
          times: 12,
        }),
      );
      const name = observed.name ?? "";
      const get = getConnection(
        subscriptionId,
        resourceGroup,
        privateLinkService,
        name,
      );

      // Sync the decision against the observed state; send only on a delta.
      const state = observed.properties?.privateLinkServiceConnectionState;
      const description = news.description ?? state?.description;
      const actionsRequired = news.actionsRequired ?? state?.actionsRequired;
      if (
        state?.status !== status ||
        state?.description !== description ||
        state?.actionsRequired !== actionsRequired
      ) {
        yield* powerbi.CreatePrivateEndpointConnection({
          subscriptionId,
          resourceGroupName: resourceGroup,
          azureResourceName: privateLinkService,
          privateEndpointName: name,
          properties: {
            privateEndpoint: observed.properties?.privateEndpoint,
            privateLinkServiceConnectionState: {
              status,
              description,
              actionsRequired,
            },
          },
        });
      }
      const fresh = yield* waitForProvisioned(
        `Power BI private endpoint connection ${name}`,
        get,
        (connection) =>
          connection.properties?.privateLinkServiceConnectionState?.status ===
          status
            ? connection.properties.provisioningState
            : "Updating",
        { interval: "3 seconds", times: 40 },
      );
      return toAttrs(
        resourceGroup,
        privateLinkService,
        privateEndpointId,
        fresh,
      );
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        powerbi.DeletePrivateEndpointConnection({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          azureResourceName: output.privateLinkService,
          privateEndpointName: output.privateEndpointConnectionName,
        }),
      );
      yield* waitUntilGone(
        `Power BI private endpoint connection ${output.privateEndpointConnectionName}`,
        getConnection(
          subscriptionId,
          output.resourceGroup,
          output.privateLinkService,
          output.privateEndpointConnectionName,
        ),
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.PowerBI.PrivateLinkService",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
