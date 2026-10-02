import type { AzureOpContext } from "@distilled.cloud/azure";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import type { ResourceLike } from "../../Resource.ts";
import { ensureRegistered, ignoreNotFound } from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import {
  parentOwned,
  sameId,
  waitNetworkGone,
  waitNetworkProvisioned,
  whileNetworkBusy,
} from "./common.ts";

// Shared lifecycle of private-endpoint connection approvals on a private
// link service or application gateway. Internal: not exported from index.ts.

type Op<A> = Effect.Effect<A, any, AzureOpContext>;

export interface ObservedConnection {
  readonly id?: string;
  readonly name?: string;
  readonly properties?: {
    readonly provisioningState?: string;
    readonly privateEndpoint?: { readonly id?: string };
    readonly privateLinkServiceConnectionState?: {
      readonly status?: string;
      readonly description?: string;
    };
  };
}

export interface ConnectionApprovalProps {
  resourceGroup: string;
  privateEndpointId: string;
  status?: "Approved" | "Rejected";
  description?: string;
}

export interface ConnectionApprovalAttrs {
  connectionName: string;
  connectionId: string;
  resourceGroup: string;
  privateEndpointId: string;
  status: string | undefined;
  description: string | undefined;
}

export class PrivateEndpointConnectionNotFound extends Data.TaggedError(
  "Azure.PrivateEndpointConnectionNotFound",
)<{ readonly privateEndpointId: string; readonly message: string }> {}

export const connectionApprovalProvider = <
  Res extends ResourceLike,
  C extends ObservedConnection,
>(spec: {
  readonly label: string;
  /** Prop/attribute holding the parent's name. */
  readonly parent: string;
  readonly list: (
    subscriptionId: string,
    resourceGroup: string,
    parent: string,
  ) => Op<{ readonly value?: ReadonlyArray<C> }>;
  /** GET one connection (undefined when gone). */
  readonly get: (
    subscriptionId: string,
    resourceGroup: string,
    parent: string,
    connectionName: string,
  ) => Op<C | undefined>;
  readonly update: (
    subscriptionId: string,
    resourceGroup: string,
    parent: string,
    connectionName: string,
    state: { status: string; description: string; actionsRequired: string },
  ) => Op<unknown>;
  readonly del: (
    subscriptionId: string,
    resourceGroup: string,
    parent: string,
    connectionName: string,
  ) => Op<unknown>;
  readonly parentTags: (
    subscriptionId: string,
    resourceGroup: string,
    parent: string,
  ) => Op<Record<string, string | undefined> | undefined>;
  readonly dependsOn: ReadonlyArray<string>;
}) => {
  const toAttrs = (
    resourceGroup: string,
    parent: string,
    connection: C,
  ): Res["Attributes"] =>
    ({
      connectionName: connection.name ?? "",
      connectionId: connection.id ?? "",
      resourceGroup,
      [spec.parent]: parent,
      privateEndpointId: connection.properties?.privateEndpoint?.id ?? "",
      status: connection.properties?.privateLinkServiceConnectionState?.status,
      description:
        connection.properties?.privateLinkServiceConnectionState?.description,
    }) as Res["Attributes"];

  /** The connection from the given private endpoint (polls ~2 minutes). */
  const findConnection = (
    subscriptionId: string,
    resourceGroup: string,
    parent: string,
    privateEndpointId: string,
  ) =>
    spec.list(subscriptionId, resourceGroup, parent).pipe(
      Effect.flatMap((page) => {
        const match = (page.value ?? []).find((c) =>
          sameId(c.properties?.privateEndpoint?.id, privateEndpointId),
        );
        return match
          ? Effect.succeed(match)
          : Effect.fail(
              new PrivateEndpointConnectionNotFound({
                privateEndpointId,
                message: `No connection from private endpoint ${privateEndpointId} on ${spec.label} ${parent}`,
              }),
            );
      }),
      Effect.retry({
        while: (e: { readonly _tag?: string }) =>
          e._tag === "Azure.PrivateEndpointConnectionNotFound",
        schedule: Schedule.spaced("5 seconds"),
        times: 24,
      }),
    );

  return {
    stables: [
      "connectionName",
      "connectionId",
      "resourceGroup",
      spec.parent,
    ] as Array<Extract<keyof Res["Attributes"], string>>,

    // Connections vanish with their parent or private endpoint.
    list: Effect.fn(function* () {
      return [] as Array<Res["Attributes"]>;
    }),

    diff: Effect.fn(function* ({
      news,
      output,
    }: {
      news: unknown;
      output: Res["Attributes"] | undefined;
    }) {
      if (!isResolved(news) || output === undefined) return undefined;
      const n = news as Record<string, string>;
      const o = output as Record<string, string>;
      if (
        !sameId(n.resourceGroup, o.resourceGroup) ||
        !sameId(n[spec.parent], o[spec.parent]) ||
        !sameId(n.privateEndpointId, o.privateEndpointId)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({
      olds,
      output,
    }: {
      olds: Res["Props"] | undefined;
      output: Res["Attributes"] | undefined;
    }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const o = output as Record<string, string> | undefined;
      const p = olds as Record<string, string> | undefined;
      const resourceGroup = o?.resourceGroup ?? p?.resourceGroup;
      const parent = o?.[spec.parent] ?? p?.[spec.parent];
      if (resourceGroup === undefined || parent === undefined) return undefined;
      const observed =
        o?.connectionName !== undefined
          ? yield* spec.get(
              subscriptionId,
              resourceGroup,
              parent,
              o.connectionName,
            )
          : (yield* spec.list(
              subscriptionId,
              resourceGroup,
              parent,
            )).value?.find((c) =>
              sameId(c.properties?.privateEndpoint?.id, p?.privateEndpointId),
            );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, parent, observed);
      const tags = yield* spec.parentTags(
        subscriptionId,
        resourceGroup,
        parent,
      );
      return (yield* parentOwned(tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news }: { news: Res["Props"] }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Network");
      const n = news as unknown as ConnectionApprovalProps &
        Record<string, string>;
      const parent = n[spec.parent]!;
      const status = n.status ?? "Approved";
      const description = n.description ?? `${status} by Alchemy`;

      // Observe: the connection appears once the private endpoint exists.
      const observed = yield* findConnection(
        subscriptionId,
        n.resourceGroup,
        parent,
        n.privateEndpointId,
      );
      const name = observed.name!;
      const get = spec.get(subscriptionId, n.resourceGroup, parent, name);
      const state = observed.properties?.privateLinkServiceConnectionState;

      // Sync the approval state.
      if (state?.status !== status || state?.description !== description) {
        yield* spec
          .update(subscriptionId, n.resourceGroup, parent, name, {
            status,
            description,
            actionsRequired: "None",
          })
          .pipe(Effect.retry(whileNetworkBusy));
      }
      const final = yield* waitNetworkProvisioned(
        `${spec.label} connection ${parent}/${name}`,
        get,
      );
      return toAttrs(n.resourceGroup, parent, final);
    }),

    delete: Effect.fn(function* ({ output }: { output: Res["Attributes"] }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const o = output as Record<string, string>;
      const parent = o[spec.parent]!;
      // Removing the approval removes the connection (the endpoint shows
      // it as Disconnected).
      yield* ignoreNotFound(
        spec.del(subscriptionId, o.resourceGroup!, parent, o.connectionName!),
      ).pipe(Effect.retry(whileNetworkBusy));
      yield* waitNetworkGone(
        `${spec.label} connection ${parent}/${o.connectionName}`,
        spec.get(subscriptionId, o.resourceGroup!, parent, o.connectionName!),
      );
    }),

    nuke: {
      dependsOn: [...spec.dependsOn, "Azure.Resources.ResourceGroup"],
    },
  };
};
