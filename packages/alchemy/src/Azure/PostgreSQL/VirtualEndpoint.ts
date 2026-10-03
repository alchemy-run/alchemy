import * as postgresql from "@distilled.cloud/azure/postgresql";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
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
  POSTGRES_NAMESPACE,
  serverOwnedByStack,
  type ServerRef,
  whileServerBusy,
} from "./common.ts";

export interface VirtualEndpointProps {
  /** Resource group of the primary server. Changing it replaces the endpoint. */
  resourceGroup: string;
  /** Name of the primary flexible server. Changing it replaces the endpoint. */
  server: string;
  /**
   * Base name of the endpoint pair: lowercase letters, digits, and
   * hyphens. If omitted, a unique name is generated from the app, stage,
   * and logical ID. Changing it replaces the endpoint.
   */
  name?: string;
  /**
   * Endpoint type. Changing it replaces the endpoint.
   * @default "ReadWrite"
   */
  endpointType?: "ReadWrite";
  /**
   * Names of the servers the endpoints point to — typically the read
   * replica that the read-only endpoint targets.
   */
  members: string[];
}

export interface VirtualEndpoint extends Resource<
  "Azure.PostgreSQL.VirtualEndpoint",
  VirtualEndpointProps,
  {
    /** Base name of the endpoint pair. */
    virtualEndpointName: string;
    /** ARM resource ID of the endpoint pair. */
    virtualEndpointId: string;
    /** Name of the primary flexible server. */
    server: string;
    /** Resource group of the primary server. */
    resourceGroup: string;
    /** Endpoint type. */
    endpointType: string;
    /** Servers the endpoints point to. */
    members: string[];
    /** Host names of the writer and reader endpoints. */
    virtualEndpoints: string[];
  },
  never,
  Providers
> {}

/**
 * A pair of virtual endpoints (read-write and read-only) for an Azure
 * Database for PostgreSQL flexible server with read replicas. The
 * endpoints keep their host names across replica promotion, so clients do
 * not need reconfiguring after a failover.
 *
 * Requires a General Purpose or Memory Optimized primary with at least one
 * read replica.
 *
 * @see https://learn.microsoft.com/azure/postgresql/flexible-server/concepts-read-replicas-virtual-endpoints
 *
 * ### Creating Virtual Endpoints
 * **Example:** Endpoints over a primary and its replica
 * ```typescript
 * const replica = yield* Azure.PostgreSQL.FlexibleServer("replica", {
 *   resourceGroup: group.resourceGroupName,
 *   createMode: "Replica",
 *   sourceServerResourceId: primary.serverId,
 *   sku: { name: "Standard_D2ds_v5", tier: "GeneralPurpose" },
 * });
 * const endpoints = yield* Azure.PostgreSQL.VirtualEndpoint("endpoints", {
 *   resourceGroup: group.resourceGroupName,
 *   server: primary.serverName,
 *   members: [replica.serverName],
 * });
 * ```
 *
 * @resource
 */
export const VirtualEndpoint = Resource<VirtualEndpoint>(
  "Azure.PostgreSQL.VirtualEndpoint",
);

const createEndpointName = Effect.fn(function* (id: string) {
  const name = yield* createPhysicalName({
    id,
    maxLength: 50,
    lowercase: true,
  });
  return name
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
});

interface EndpointRef extends ServerRef {
  readonly virtualEndpointName: string;
}

const getEndpoint = (ref: EndpointRef) =>
  orUndefinedIfNotFound(postgresql.GetVirtualEndpoint(ref));

const toAttrs = (
  ref: EndpointRef,
  endpoint: postgresql.GetVirtualEndpointResponse,
): VirtualEndpoint["Attributes"] => ({
  virtualEndpointName: ref.virtualEndpointName,
  virtualEndpointId: endpoint.id ?? "",
  server: ref.serverName,
  resourceGroup: ref.resourceGroupName,
  endpointType: endpoint.properties?.endpointType ?? "ReadWrite",
  members: [...(endpoint.properties?.members ?? [])],
  virtualEndpoints: [...(endpoint.properties?.virtualEndpoints ?? [])],
});

const sameText = (a: string | undefined, b: string | undefined) =>
  a?.toLowerCase() === b?.toLowerCase();

/** Whether `observed` members contain every desired member. */
const hasMembers = (
  observed: ReadonlyArray<string> | undefined,
  desired: ReadonlyArray<string>,
) => {
  const have = new Set((observed ?? []).map((m) => m.toLowerCase()));
  return desired.every((member) => have.has(member.toLowerCase()));
};

export const VirtualEndpointProvider = () =>
  Provider.succeed(VirtualEndpoint, {
    stables: [
      "virtualEndpointName",
      "virtualEndpointId",
      "server",
      "resourceGroup",
      "endpointType",
    ],

    // Endpoints live inside a server; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameText(news.resourceGroup, output.resourceGroup) ||
        !sameText(news.server, output.server) ||
        (news.name !== undefined && news.name !== output.virtualEndpointName) ||
        (news.endpointType ?? "ReadWrite") !== output.endpointType
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroupName = output?.resourceGroup ?? olds?.resourceGroup;
      const serverName = output?.server ?? olds?.server;
      if (resourceGroupName === undefined || serverName === undefined) {
        return undefined;
      }
      const ref: EndpointRef = {
        subscriptionId,
        resourceGroupName,
        serverName,
        virtualEndpointName:
          output?.virtualEndpointName ??
          olds?.name ??
          (yield* createEndpointName(id)),
      };
      const observed = yield* getEndpoint(ref);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(ref, observed);
      return (yield* serverOwnedByStack(ref)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, POSTGRES_NAMESPACE);
      const ref: EndpointRef = {
        subscriptionId,
        resourceGroupName: news.resourceGroup,
        serverName: news.server,
        virtualEndpointName:
          news.name ??
          output?.virtualEndpointName ??
          (yield* createEndpointName(id)),
      };
      const properties = {
        endpointType: news.endpointType ?? "ReadWrite",
        members: news.members,
      };

      // Observe.
      const observed = yield* getEndpoint(ref);

      // Ensure, then sync members against the observed endpoint. The
      // service lists the primary among the members, so only check that
      // every desired member is present.
      if (observed === undefined) {
        yield* postgresql
          .CreateVirtualEndpoint({ ...ref, properties })
          .pipe(Effect.retry(whileServerBusy));
      } else if (!hasMembers(observed.properties?.members, news.members)) {
        yield* postgresql
          .UpdateVirtualEndpoint({ ...ref, properties })
          .pipe(Effect.retry(whileServerBusy));
      }
      const fresh = yield* waitForProvisioned(
        `PostgreSQL virtual endpoint ${ref.virtualEndpointName}`,
        getEndpoint(ref),
        (endpoint) =>
          hasMembers(endpoint.properties?.members, news.members)
            ? undefined
            : "Updating",
        { interval: "10 seconds", times: 60 },
      );
      return toAttrs(ref, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const ref: EndpointRef = {
        subscriptionId,
        resourceGroupName: output.resourceGroup,
        serverName: output.server,
        virtualEndpointName: output.virtualEndpointName,
      };
      yield* ignoreNotFound(
        postgresql
          .DeleteVirtualEndpoint(ref)
          .pipe(Effect.retry(whileServerBusy)),
      );
      yield* waitUntilGone(
        `PostgreSQL virtual endpoint ${output.virtualEndpointName}`,
        getEndpoint(ref),
        { interval: "10 seconds", times: 60 },
      );
    }),

    nuke: { dependsOn: ["Azure.PostgreSQL.FlexibleServer"] },
  });
