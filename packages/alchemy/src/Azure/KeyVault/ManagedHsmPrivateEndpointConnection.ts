import * as keyvault from "@distilled.cloud/azure/keyvault";
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
import { isManagedHsmOwnedByStack, lower, sameId } from "./common.ts";

export interface ManagedHsmPrivateEndpointConnectionProps {
  /** Resource group of the managed HSM. Changing it replaces the connection. */
  resourceGroup: string;
  /** Managed HSM the private endpoint connects to. Changing it replaces the connection. */
  managedHsm: string;
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

export interface ManagedHsmPrivateEndpointConnection extends Resource<
  "Azure.KeyVault.ManagedHsmPrivateEndpointConnection",
  ManagedHsmPrivateEndpointConnectionProps,
  {
    /** Name of the connection (assigned by Azure). */
    privateEndpointConnectionName: string;
    /** ARM resource ID of the connection. */
    privateEndpointConnectionId: string;
    /** Managed HSM the private endpoint connects to. */
    managedHsm: string;
    /** Resource group of the managed HSM. */
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
 * Approval of a private endpoint's connection to an Azure Key Vault Managed HSM.
 *
 * Connections are not created directly: a private endpoint that targets
 * the managed HSM with a *manual* connection leaves a `Pending` request on the
 * managed HSM. This resource approves or rejects that request. Destroying it
 * removes the connection, which disconnects the private endpoint.
 *
 * @see https://learn.microsoft.com/azure/key-vault/managed-hsm/private-link
 *
 * ### Approving Connections
 * **Example:** Approve a manual private endpoint request
 * ```typescript
 * const endpoint = yield* Azure.Network.PrivateEndpoint("hsm-pe", {
 *   resourceGroup: group.resourceGroupName,
 *   subnetId: subnet.subnetId,
 *   manualPrivateLinkServiceConnections: [
 *     { privateLinkServiceId: hsm.managedHsmId, groupIds: ["managedhsm"] },
 *   ],
 * });
 * yield* Azure.KeyVault.ManagedHsmPrivateEndpointConnection("hsm-pe-approval", {
 *   resourceGroup: group.resourceGroupName,
 *   managedHsm: hsm.managedHsmName,
 *   privateEndpointId: endpoint.privateEndpointId,
 *   description: "Approved for the app VNet",
 * });
 * ```
 *
 * **Example:** Reject a request
 * ```typescript
 * yield* Azure.KeyVault.ManagedHsmPrivateEndpointConnection("hsm-pe-approval", {
 *   resourceGroup: group.resourceGroupName,
 *   managedHsm: hsm.managedHsmName,
 *   privateEndpointId: endpoint.privateEndpointId,
 *   status: "Rejected",
 *   description: "Use the shared endpoint instead",
 * });
 * ```
 *
 * @resource
 */
export const ManagedHsmPrivateEndpointConnection =
  Resource<ManagedHsmPrivateEndpointConnection>(
    "Azure.KeyVault.ManagedHsmPrivateEndpointConnection",
  );

export class ManagedHsmPrivateEndpointConnectionRequestMissing extends Data.TaggedError(
  "Azure.KeyVault.ManagedHsmPrivateEndpointConnectionRequestMissing",
)<{ readonly message: string }> {}

type Observed = keyvault.GetMHSMPrivateEndpointConnectionResponse;

const getConnection = (
  subscriptionId: string,
  resourceGroupName: string,
  managedHsmName: string,
  privateEndpointConnectionName: string,
) =>
  orUndefinedIfNotFound(
    keyvault.GetMHSMPrivateEndpointConnection({
      subscriptionId,
      resourceGroupName,
      name: managedHsmName,
      privateEndpointConnectionName,
    }),
  );

const findConnection = Effect.fn(function* (
  subscriptionId: string,
  resourceGroupName: string,
  managedHsmName: string,
  privateEndpointId: string,
) {
  const page = yield* orUndefinedIfNotFound(
    keyvault
      .ListMHSMPrivateEndpointConnectionByResource({
        subscriptionId,
        resourceGroupName,
        name: managedHsmName,
      })
      .pipe(
        Effect.flatMap((page) =>
          requireSinglePage(
            "ListMHSMPrivateEndpointConnectionByResource",
            page,
          ),
        ),
      ),
  );
  return (page?.value ?? []).find((connection) =>
    sameId(connection.properties?.privateEndpoint?.id, privateEndpointId),
  );
});

// List responses omit `name`; the connection name is the last ID segment.
const connectionName = (connection: { name?: string; id?: string }): string =>
  connection.name ?? connection.id?.split("/").pop() ?? "";

const toAttrs = (
  resourceGroup: string,
  managedHsm: string,
  privateEndpointId: string,
  connection: Observed,
): ManagedHsmPrivateEndpointConnection["Attributes"] => ({
  privateEndpointConnectionName: connectionName(connection),
  privateEndpointConnectionId: connection.id ?? "",
  managedHsm,
  resourceGroup,
  privateEndpointId,
  status: connection.properties?.privateLinkServiceConnectionState?.status,
  description:
    connection.properties?.privateLinkServiceConnectionState?.description,
});

/** The pool rejects connection changes while it applies the previous one. */
const whilePoolUpdating = {
  while: (e: { readonly _tag: string }) => e._tag === "ManagedHsmPoolUpdating",
  schedule: Schedule.spaced("10 seconds"),
  times: 30,
} as const;

export const ManagedHsmPrivateEndpointConnectionProvider = () =>
  Provider.succeed(ManagedHsmPrivateEndpointConnection, {
    stables: [
      "privateEndpointConnectionName",
      "privateEndpointConnectionId",
      "managedHsm",
      "resourceGroup",
      "privateEndpointId",
    ],

    // Connections disappear with their managed HSM or endpoint.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.managedHsm) !== lower(output.managedHsm) ||
        !sameId(news.privateEndpointId, output.privateEndpointId)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const managedHsm = output?.managedHsm ?? olds?.managedHsm;
      const privateEndpointId =
        output?.privateEndpointId ?? olds?.privateEndpointId;
      if (
        resourceGroup === undefined ||
        managedHsm === undefined ||
        privateEndpointId === undefined
      ) {
        return undefined;
      }
      const observed = yield* findConnection(
        subscriptionId,
        resourceGroup,
        managedHsm,
        privateEndpointId,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(
        resourceGroup,
        managedHsm,
        privateEndpointId,
        observed,
      );
      return (yield* isManagedHsmOwnedByStack(
        subscriptionId,
        resourceGroup,
        managedHsm,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.KeyVault");
      const { resourceGroup, managedHsm, privateEndpointId } = news;
      const status = news.status ?? "Approved";

      // Observe. The request appears on the managed HSM shortly after the
      // private endpoint is created; it cannot be created from this side.
      const observed = yield* findConnection(
        subscriptionId,
        resourceGroup,
        managedHsm,
        privateEndpointId,
      ).pipe(
        Effect.flatMap((found) =>
          found === undefined
            ? Effect.fail(
                new ManagedHsmPrivateEndpointConnectionRequestMissing({
                  message: `no connection from private endpoint ${privateEndpointId} on managed HSM ${managedHsm}`,
                }),
              )
            : Effect.succeed(found),
        ),
        Effect.retry({
          while: (e) =>
            e._tag ===
            "Azure.KeyVault.ManagedHsmPrivateEndpointConnectionRequestMissing",
          schedule: Schedule.spaced("5 seconds"),
          times: 12,
        }),
      );
      const name = connectionName(observed);
      const get = getConnection(
        subscriptionId,
        resourceGroup,
        managedHsm,
        name,
      );

      // Sync the decision and its description.
      const state = observed.properties?.privateLinkServiceConnectionState;
      if (
        state?.status !== status ||
        (news.description !== undefined &&
          state?.description !== news.description)
      ) {
        yield* keyvault
          .PutMHSMPrivateEndpointConnection({
            subscriptionId,
            resourceGroupName: resourceGroup,
            name: managedHsm,
            privateEndpointConnectionName: name,
            properties: {
              privateLinkServiceConnectionState: {
                status,
                description: news.description ?? state?.description,
              },
            },
          })
          .pipe(Effect.retry(whilePoolUpdating));
      }
      const fresh = yield* waitForProvisioned(
        `private endpoint connection ${name}`,
        get,
        (connection) =>
          connection.properties?.privateLinkServiceConnectionState?.status ===
          status
            ? connection.properties.provisioningState
            : "Updating",
        { interval: "3 seconds", times: 40 },
      );
      return toAttrs(resourceGroup, managedHsm, privateEndpointId, fresh);
    }),

    delete: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      // A create that failed mid-flight may persist no connection name;
      // resolve it from the private endpoint instead.
      const resourceGroup = output?.resourceGroup ?? olds.resourceGroup;
      const managedHsm = output?.managedHsm ?? olds.managedHsm;
      const privateEndpointId =
        output?.privateEndpointId ?? olds.privateEndpointId;
      const name =
        output?.privateEndpointConnectionName ||
        (yield* findConnection(
          subscriptionId,
          resourceGroup,
          managedHsm,
          privateEndpointId,
        ).pipe(Effect.map((found) => (found ? connectionName(found) : ""))));
      if (name === "") return;
      yield* ignoreNotFound(
        keyvault
          .DeleteMHSMPrivateEndpointConnection({
            subscriptionId,
            resourceGroupName: resourceGroup,
            name: managedHsm,
            privateEndpointConnectionName: name,
          })
          .pipe(Effect.retry(whilePoolUpdating)),
      );
      yield* waitUntilGone(
        `private endpoint connection ${name}`,
        getConnection(subscriptionId, resourceGroup, managedHsm, name),
      );
    }),

    nuke: {
      dependsOn: ["Azure.KeyVault.ManagedHsm", "Azure.Resources.ResourceGroup"],
    },
  });
