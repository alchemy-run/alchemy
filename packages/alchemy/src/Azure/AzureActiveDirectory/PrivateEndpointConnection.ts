import * as aad from "@distilled.cloud/azure/azureactivedirectory";
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
import { getAadPrivateLinkPolicy } from "./PrivateLinkPolicy.ts";

export interface PrivateEndpointConnectionProps {
  /**
   * Resource group of the private link policy. Changing it replaces the
   * connection.
   */
  resourceGroup: string;
  /**
   * Name of the Microsoft Entra private link policy the private endpoint
   * connects to. Changing it replaces the connection.
   */
  policy: string;
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
  "Azure.AzureActiveDirectory.PrivateEndpointConnection",
  PrivateEndpointConnectionProps,
  {
    /** Name of the connection (assigned by Azure). */
    privateEndpointConnectionName: string;
    /** ARM resource ID of the connection. */
    privateEndpointConnectionId: string;
    /** Private link policy the endpoint connects to. */
    policy: string;
    /** Resource group of the private link policy. */
    resourceGroup: string;
    /** ARM ID of the private endpoint. */
    privateEndpointId: string;
    /** Observed status: `Pending`, `Approved`, `Rejected`, or `Disconnected`. */
    status: string | undefined;
    /** Observed reason for the decision. */
    description: string | undefined;
    /** Observed actions required of the endpoint's owner. */
    actionsRequired: string | undefined;
    /** Observed provisioning state of the connection. */
    provisioningState: string | undefined;
  },
  never,
  Providers
> {}

/**
 * Approval of a private endpoint's connection to a Private Link for
 * Microsoft Entra ID policy.
 *
 * Connections are not created directly: a private endpoint that targets the
 * policy (group `azuread`) with a *manual* connection leaves a `Pending`
 * request on it. This resource approves or rejects that request. Destroying
 * it removes the connection, which disconnects the private endpoint.
 *
 * @see https://learn.microsoft.com/entra/identity/devices/howto-manage-private-link
 *
 * ### Approving Connections
 * **Example:** Approve a manual private endpoint request
 * ```typescript
 * const policy = yield* Azure.AzureActiveDirectory.PrivateLinkPolicy("entra", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * const endpoint = yield* Azure.Network.PrivateEndpoint("entra", {
 *   resourceGroup: group.resourceGroupName,
 *   subnetId: subnet.subnetId,
 *   manualPrivateLinkServiceConnections: [
 *     { privateLinkServiceId: policy.policyId, groupIds: ["azuread"] },
 *   ],
 * });
 * yield* Azure.AzureActiveDirectory.PrivateEndpointConnection("entra-approval", {
 *   resourceGroup: group.resourceGroupName,
 *   policy: policy.policyName,
 *   privateEndpointId: endpoint.privateEndpointId,
 *   description: "Approved for the corporate VNet",
 * });
 * ```
 *
 * **Example:** Reject a request
 * ```typescript
 * yield* Azure.AzureActiveDirectory.PrivateEndpointConnection("entra-approval", {
 *   resourceGroup: group.resourceGroupName,
 *   policy: policy.policyName,
 *   privateEndpointId: endpoint.privateEndpointId,
 *   status: "Rejected",
 *   description: "Use the hub endpoint instead",
 * });
 * ```
 *
 * @resource
 */
export const PrivateEndpointConnection = Resource<PrivateEndpointConnection>(
  "Azure.AzureActiveDirectory.PrivateEndpointConnection",
);

export class AadPrivateEndpointConnectionRequestMissing extends Data.TaggedError(
  "Azure.AzureActiveDirectory.PrivateEndpointConnectionRequestMissing",
)<{ readonly message: string }> {}

type Observed = aad.PrivateEndpointConnection;

const sameId = (a: string | undefined, b: string) =>
  (a ?? "").toLowerCase() === b.toLowerCase();

const getConnection = (
  subscriptionId: string,
  resourceGroupName: string,
  policyName: string,
  privateEndpointConnectionName: string,
) =>
  orUndefinedIfNotFound(
    aad.GetPrivateEndpointConnection({
      subscriptionId,
      resourceGroupName,
      policyName,
      privateEndpointConnectionName,
    }),
  );

/** The policy's connection for the given private endpoint. */
const findConnection = Effect.fn(function* (
  subscriptionId: string,
  resourceGroupName: string,
  policyName: string,
  privateEndpointId: string,
) {
  const page = yield* orUndefinedIfNotFound(
    aad
      .ListPrivateEndpointConnectionByPolicyName({
        subscriptionId,
        resourceGroupName,
        policyName,
      })
      .pipe(
        Effect.flatMap((page) =>
          requireSinglePage("ListPrivateEndpointConnectionByPolicyName", page),
        ),
      ),
  );
  return (page?.value ?? []).find((connection) =>
    sameId(connection.properties?.privateEndpoint?.id, privateEndpointId),
  );
});

/** Whether the parent policy is tagged as owned by this stack and stage. */
const isPolicyOwnedByStack = Effect.fn(function* (
  subscriptionId: string,
  resourceGroupName: string,
  policyName: string,
) {
  const policy = yield* getAadPrivateLinkPolicy(
    subscriptionId,
    resourceGroupName,
    policyName,
  );
  if (policy === undefined) return false;
  const { stack, stage } = yield* stackAndStage;
  const tags = tagRecord(policy.tags);
  return tags["alchemy::stack"] === stack && tags["alchemy::stage"] === stage;
});

const toAttrs = (
  resourceGroup: string,
  policy: string,
  privateEndpointId: string,
  connection: Observed,
): PrivateEndpointConnection["Attributes"] => {
  const state = connection.properties?.privateLinkServiceConnectionState;
  return {
    privateEndpointConnectionName: connection.name ?? "",
    privateEndpointConnectionId: connection.id ?? "",
    policy,
    resourceGroup,
    privateEndpointId,
    status: state?.status,
    description: state?.description,
    actionsRequired: state?.actionsRequired,
    provisioningState: connection.properties?.provisioningState,
  };
};

export const PrivateEndpointConnectionProvider = () =>
  Provider.succeed(PrivateEndpointConnection, {
    stables: [
      "privateEndpointConnectionName",
      "privateEndpointConnectionId",
      "policy",
      "resourceGroup",
      "privateEndpointId",
    ],

    // Connections disappear with their policy or endpoint.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        news.policy.toLowerCase() !== output.policy.toLowerCase() ||
        !sameId(news.privateEndpointId, output.privateEndpointId)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const policy = output?.policy ?? olds?.policy;
      const privateEndpointId =
        output?.privateEndpointId ?? olds?.privateEndpointId;
      if (
        resourceGroup === undefined ||
        policy === undefined ||
        privateEndpointId === undefined
      ) {
        return undefined;
      }
      const observed = yield* findConnection(
        subscriptionId,
        resourceGroup,
        policy,
        privateEndpointId,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, policy, privateEndpointId, observed);
      return (yield* isPolicyOwnedByStack(
        subscriptionId,
        resourceGroup,
        policy,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "microsoft.aadiam");
      const { resourceGroup, policy, privateEndpointId } = news;
      const status = news.status ?? "Approved";

      // Observe. The request appears on the policy shortly after the
      // private endpoint is created; it cannot be created from this side.
      const observed = yield* findConnection(
        subscriptionId,
        resourceGroup,
        policy,
        privateEndpointId,
      ).pipe(
        Effect.flatMap((found) =>
          found === undefined
            ? Effect.fail(
                new AadPrivateEndpointConnectionRequestMissing({
                  message: `no connection from private endpoint ${privateEndpointId} on Entra private link policy ${policy}`,
                }),
              )
            : Effect.succeed(found),
        ),
        Effect.retry({
          while: (e) =>
            e._tag ===
            "Azure.AzureActiveDirectory.PrivateEndpointConnectionRequestMissing",
          schedule: Schedule.spaced("5 seconds"),
          times: 12,
        }),
      );
      const name = observed.name ?? "";
      const get = getConnection(subscriptionId, resourceGroup, policy, name);

      // Sync the decision against the observed state; send only on a delta.
      const state = observed.properties?.privateLinkServiceConnectionState;
      const description = news.description ?? state?.description;
      const actionsRequired = news.actionsRequired ?? state?.actionsRequired;
      if (
        state?.status !== status ||
        state?.description !== description ||
        state?.actionsRequired !== actionsRequired
      ) {
        yield* aad.CreatePrivateEndpointConnection({
          subscriptionId,
          resourceGroupName: resourceGroup,
          policyName: policy,
          privateEndpointConnectionName: name,
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
        `Entra private endpoint connection ${name}`,
        get,
        (connection) =>
          connection.properties?.privateLinkServiceConnectionState?.status ===
          status
            ? connection.properties.provisioningState
            : "Updating",
        { interval: "3 seconds", times: 40 },
      );
      return toAttrs(resourceGroup, policy, privateEndpointId, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        aad.DeletePrivateEndpointConnection({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          policyName: output.policy,
          privateEndpointConnectionName: output.privateEndpointConnectionName,
        }),
      );
      yield* waitUntilGone(
        `Entra private endpoint connection ${output.privateEndpointConnectionName}`,
        getConnection(
          subscriptionId,
          output.resourceGroup,
          output.policy,
          output.privateEndpointConnectionName,
        ),
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.AzureActiveDirectory.PrivateLinkPolicy",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
