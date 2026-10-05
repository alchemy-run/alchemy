import * as attestation from "@distilled.cloud/azure/attestation";
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

export class PrivateEndpointConnectionMissing extends Data.TaggedError(
  "Azure.Attestation.PrivateEndpointConnectionMissing",
)<{
  readonly provider: string;
  readonly message: string;
}> {}

/** Approval decision for a private endpoint connection. */
export type PrivateEndpointConnectionStatus = "Approved" | "Rejected";

export interface PrivateEndpointConnectionProps {
  /** Resource group of the attestation provider. Changing it replaces the resource. */
  resourceGroup: string;
  /**
   * Name of the attestation provider the private endpoint targets — typically
   * `Azure.Attestation.Provider(...).providerName`. Changing it replaces the
   * resource.
   */
  provider: string;
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
  /**
   * Reason shown to the private endpoint owner. Azure Attestation only
   * accepts it together with a status change (e.g. `Pending` → `Approved`,
   * `Approved` → `Rejected`); changing only the description is not applied.
   */
  description?: string;
}

export interface PrivateEndpointConnection extends Resource<
  "Azure.Attestation.PrivateEndpointConnection",
  PrivateEndpointConnectionProps,
  {
    /** Name of the connection. */
    privateEndpointConnectionName: string;
    /** ARM resource ID of the connection. */
    privateEndpointConnectionId: string;
    /** Attestation provider the connection belongs to. */
    providerName: string;
    /** Resource group of the attestation provider. */
    resourceGroup: string;
    /** ARM resource ID of the connected private endpoint. */
    privateEndpointId: string | undefined;
    /** Connection status: `Pending`, `Approved`, or `Rejected`. */
    status: string | undefined;
    /** Status description. */
    description: string | undefined;
  },
  never,
  Providers
> {}

/**
 * Approves (or rejects) a private endpoint connection to an Azure
 * Attestation provider. The connection itself is created by the private
 * endpoint (`Azure.Network.PrivateEndpoint` targeting the provider with
 * group ID `standard`); this resource takes it over and drives its
 * approval state. Deleting it removes the connection, which disconnects the
 * endpoint.
 *
 * The connection is identified by the private endpoint you reference, so
 * Alchemy treats it as owned without tags.
 *
 * @see https://learn.microsoft.com/azure/attestation/private-endpoint-powershell
 *
 * ### Approving a Private Endpoint
 * **Example:** Manual-approval endpoint, approved by the provider owner
 * ```typescript
 * const attest = yield* Azure.Attestation.Provider("attest", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * const endpoint = yield* Azure.Network.PrivateEndpoint("attest-pe", {
 *   resourceGroup: group.resourceGroupName,
 *   subnetId: subnet.subnetId,
 *   manualPrivateLinkServiceConnections: [
 *     { privateLinkServiceId: attest.providerId, groupIds: ["standard"] },
 *   ],
 * });
 * yield* Azure.Attestation.PrivateEndpointConnection("attest-pe-approval", {
 *   resourceGroup: group.resourceGroupName,
 *   provider: attest.providerName,
 *   privateEndpointId: endpoint.privateEndpointId,
 *   description: "approved by platform team",
 * });
 * ```
 *
 * @resource
 */
export const PrivateEndpointConnection = Resource<PrivateEndpointConnection>(
  "Azure.Attestation.PrivateEndpointConnection",
);

interface Parent {
  subscriptionId: string;
  resourceGroupName: string;
  providerName: string;
}

type ObservedConnection = attestation.StatusResultPrivateEndpointConnectionsItem;

const same = (a: string | undefined, b: string | undefined) =>
  (a ?? "").toLowerCase() === (b ?? "").toLowerCase();

const getConnection = (parent: Parent, name: string) =>
  orUndefinedIfNotFound(
    attestation.GetPrivateEndpointConnection({
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
      attestation
        .ListPrivateEndpointConnections(parent)
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListPrivateEndpointConnections", page),
          ),
        ),
    );
    return (page?.value ?? []).find((connection) =>
      same(connection.properties?.privateEndpoint?.id, privateEndpointId),
    );
  });

const toAttrs = (
  parent: Parent,
  connection: ObservedConnection,
): PrivateEndpointConnection["Attributes"] => ({
  privateEndpointConnectionName: connection.name ?? "",
  privateEndpointConnectionId: connection.id ?? "",
  providerName: parent.providerName,
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
      "providerName",
      "resourceGroup",
      "privateEndpointId",
    ],

    // Connections live inside a provider and disappear with their endpoint.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !same(news.resourceGroup, output.resourceGroup) ||
        !same(news.provider, output.providerName) ||
        (news.name !== undefined &&
          !same(news.name, output.privateEndpointConnectionName)) ||
        (news.privateEndpointId !== undefined &&
          output.privateEndpointId !== undefined &&
          !same(news.privateEndpointId, output.privateEndpointId))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroupName = output?.resourceGroup ?? olds?.resourceGroup;
      const providerName = output?.providerName ?? olds?.provider;
      if (resourceGroupName === undefined || providerName === undefined) {
        return undefined;
      }
      const parent = { subscriptionId, resourceGroupName, providerName };
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
      yield* ensureRegistered(subscriptionId, "Microsoft.Attestation");
      const parent = {
        subscriptionId,
        resourceGroupName: news.resourceGroup,
        providerName: news.provider,
      };
      const status = news.status ?? "Approved";

      // Observe: the private endpoint creates the connection; it can take a
      // few seconds to appear on the provider.
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
                provider: news.provider,
                message: `no private endpoint connection ${news.name ?? news.privateEndpointId ?? ""} on attestation provider ${news.provider}`,
              }),
            ),
        ),
      );
      const name = observed.name ?? "";

      // Sync the approval state against the observed state. The service
      // only accepts a PUT that changes the status ("Status Approved is not
      // supported for Put operation" when already Approved), so the
      // description is written with status transitions only.
      const state = observed.properties?.privateLinkServiceConnectionState;
      if (!same(state?.status, status)) {
        yield* attestation.CreatePrivateEndpointConnection({
          ...parent,
          privateEndpointConnectionName: name,
          // The service rejects a PUT without the connection's ARM id.
          id: observed.id,
          properties: {
            privateEndpoint: { id: observed.properties?.privateEndpoint?.id },
            privateLinkServiceConnectionState: {
              status,
              description: news.description ?? state?.description,
            },
          },
        });
      }

      const fresh = yield* waitForProvisioned(
        `attestation private endpoint connection ${name}`,
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
        providerName: output.providerName,
      };
      yield* ignoreNotFound(
        attestation.DeletePrivateEndpointConnection({
          ...parent,
          privateEndpointConnectionName: output.privateEndpointConnectionName,
        }),
      );
      yield* waitUntilGone(
        `attestation private endpoint connection ${output.privateEndpointConnectionName}`,
        getConnection(parent, output.privateEndpointConnectionName),
        { interval: "5 seconds", times: 36 },
      );
    }),

    nuke: { dependsOn: ["Azure.Attestation.Provider"] },
  });
