import * as signalr from "@distilled.cloud/azure/signalr";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  desiredTags,
  ensureRegistered,
  ignoreNotFound,
  isOwned,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  boolString,
  createSignalRName,
  enabledString,
  getReplica,
  lower,
  sameLocation,
  SIGNALR_NAMESPACE,
  WAIT,
  whileSignalRBusy,
} from "./internal.ts";
import type { SignalRSkuName } from "./SignalR.ts";

export interface ReplicaProps {
  /** Resource group of the SignalR service. Changing it replaces the replica. */
  resourceGroup: string;
  /**
   * SignalR service the replica belongs to. The service must use the
   * `Premium_P1` or `Premium_P2` tier. Changing it replaces the replica.
   */
  signalR: string;
  /**
   * Replica name: 3-63 letters, digits, and hyphens, starting with a
   * letter. If omitted, a unique name is generated from the app, stage, and
   * logical ID. Changing it replaces the replica.
   */
  name?: string;
  /**
   * Azure location of the replica. Must differ from the service's location
   * and from every other replica. Changing it replaces the replica.
   */
  location: string;
  /**
   * Pricing tier of the replica; must match the tier of the service.
   * @default "Premium_P1"
   */
  sku?: SignalRSkuName;
  /**
   * Unit count of the replica (1-10, 20, 30, ..., 100 for `Premium_P1`;
   * 100, 200, ..., 1000 for `Premium_P2`).
   * @default Azure's default for the tier
   */
  capacity?: number;
  /**
   * Whether new connections are routed to the replica's regional endpoint.
   * Existing connections are not affected when it is disabled.
   * @default Azure's default (`true`)
   */
  regionEndpointEnabled?: boolean;
  /**
   * Stop (`true`) or start (`false`) the replica's data plane.
   * @default Azure's default (`false`)
   */
  resourceStopped?: boolean;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Replica extends Resource<
  "Azure.SignalR.Replica",
  ReplicaProps,
  {
    /** Name of the replica. */
    replicaName: string;
    /** ARM resource ID of the replica. */
    replicaId: string;
    /** SignalR service that owns the replica. */
    signalR: string;
    /** Resource group of the SignalR service. */
    resourceGroup: string;
    /** Location of the replica. */
    location: string;
    /** Pricing tier of the replica. */
    sku: string;
    /** Unit count of the replica. */
    capacity: number | undefined;
    /** Whether the replica's regional endpoint accepts new connections. */
    regionEndpointEnabled: boolean;
    /** Whether the replica's data plane is stopped. */
    resourceStopped: boolean;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A geo-replica of a Premium Azure SignalR Service. Clients connecting to
 * the service's endpoint are routed to the nearest healthy replica, and the
 * replica keeps serving if the primary region fails.
 *
 * @see https://learn.microsoft.com/azure/azure-signalr/howto-enable-geo-replication
 *
 * ### Creating a Replica
 * **Example:** Premium service with a replica in another region
 * ```typescript
 * const signalR = yield* Azure.SignalR.SignalR("realtime", {
 *   resourceGroup: group.resourceGroupName,
 *   location: "eastus",
 *   sku: "Premium_P1",
 * });
 * const replica = yield* Azure.SignalR.Replica("west", {
 *   resourceGroup: group.resourceGroupName,
 *   signalR: signalR.signalRName,
 *   location: "westus2",
 * });
 * ```
 *
 * ### Draining a Region
 * **Example:** Stop routing new connections to a replica
 * ```typescript
 * const replica = yield* Azure.SignalR.Replica("west", {
 *   resourceGroup: group.resourceGroupName,
 *   signalR: signalR.signalRName,
 *   location: "westus2",
 *   regionEndpointEnabled: false,
 * });
 * ```
 *
 * @resource
 */
export const Replica = Resource<Replica>("Azure.SignalR.Replica");

type Observed = signalr.GetSignalRReplicasResponse;

const toAttrs = (
  resourceGroup: string,
  signalR: string,
  name: string,
  replica: Observed,
): Replica["Attributes"] => ({
  replicaName: name,
  replicaId: replica.id ?? "",
  signalR,
  resourceGroup,
  location: replica.location,
  sku: replica.sku?.name ?? "",
  capacity: replica.sku?.capacity,
  regionEndpointEnabled:
    lower(replica.properties?.regionEndpointEnabled ?? "Enabled") === "enabled",
  resourceStopped:
    lower(replica.properties?.resourceStopped ?? "false") === "true",
  tags: userTags(replica.tags),
});

/** Replica properties whose observed value differs from the desired value. */
const propertyDelta = (
  news: ReplicaProps,
  observed: { regionEndpointEnabled?: string; resourceStopped?: string },
): signalr.ReplicaPropertiesInput => {
  const delta: signalr.ReplicaPropertiesInput = {};
  if (
    news.regionEndpointEnabled !== undefined &&
    lower(enabledString(news.regionEndpointEnabled)) !==
      lower(observed.regionEndpointEnabled ?? "Enabled")
  ) {
    delta.regionEndpointEnabled = enabledString(news.regionEndpointEnabled);
  }
  if (
    news.resourceStopped !== undefined &&
    boolString(news.resourceStopped) !==
      lower(observed.resourceStopped ?? "false")
  ) {
    delta.resourceStopped = boolString(news.resourceStopped);
  }
  return delta;
};

export const ReplicaProvider = () =>
  Provider.succeed(Replica, {
    stables: [
      "replicaName",
      "replicaId",
      "signalR",
      "resourceGroup",
      "location",
    ],

    // Replicas are deleted with their SignalR service.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.signalR) !== lower(output.signalR) ||
        (news.name !== undefined &&
          lower(news.name) !== lower(output.replicaName)) ||
        !sameLocation(news.location, output.location)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const signalR = output?.signalR ?? olds?.signalR;
      if (resourceGroup === undefined || signalR === undefined) {
        return undefined;
      }
      const name =
        output?.replicaName ?? olds?.name ?? (yield* createSignalRName(id));
      const observed = yield* getReplica(
        subscriptionId,
        resourceGroup,
        signalR,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, signalR, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, SIGNALR_NAMESPACE);
      const { resourceGroup, signalR } = news;
      const name =
        news.name ?? output?.replicaName ?? (yield* createSignalRName(id));
      const sku = news.sku ?? "Premium_P1";
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        resourceName: signalR,
        replicaName: name,
      };
      const get = getReplica(subscriptionId, resourceGroup, signalR, name);
      const label = `signalr replica ${name}`;

      // Observe.
      let observed = yield* get;

      // Ensure. Creating a replica is a long-running operation (2-5 minutes).
      if (observed === undefined) {
        const properties = propertyDelta(news, {});
        yield* signalr
          .SignalRReplicasCreateOrUpdate({
            ...where,
            location: news.location,
            sku: { name: sku, capacity: news.capacity },
            tags,
            properties:
              Object.keys(properties).length > 0 ? properties : undefined,
          })
          .pipe(Effect.retry(whileSignalRBusy));
      }
      observed = yield* waitForProvisioned(
        label,
        get,
        (r) => r.properties?.provisioningState,
        WAIT,
      );

      // Sync SKU, properties, and tags against the observed replica.
      const delta = propertyDelta(news, observed.properties ?? {});
      const skuChanged =
        lower(observed.sku?.name) !== lower(sku) ||
        (news.capacity !== undefined &&
          news.capacity !== observed.sku?.capacity);
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (Object.keys(delta).length > 0 || skuChanged || tagsChanged) {
        yield* signalr
          .UpdateSignalRReplicas({
            ...where,
            location: observed.location,
            sku: skuChanged
              ? { name: sku, capacity: news.capacity }
              : undefined,
            properties: Object.keys(delta).length > 0 ? delta : undefined,
            tags: tagsChanged ? tags : undefined,
          })
          .pipe(Effect.retry(whileSignalRBusy));
        observed = yield* waitForProvisioned(
          label,
          get,
          // The PATCH returns before the GET reports `Updating`; keep
          // polling until the desired state is visible.
          (r) => {
            const state = r.properties?.provisioningState;
            if (state !== "Succeeded") return state;
            const pending =
              Object.keys(propertyDelta(news, r.properties ?? {})).length > 0 ||
              lower(r.sku?.name) !== lower(sku) ||
              tagsDiffer(r.tags, tags);
            return pending ? "Updating" : state;
          },
          WAIT,
        );
      }

      return toAttrs(resourceGroup, signalR, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        signalr
          .DeleteSignalRReplicas({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            resourceName: output.signalR,
            replicaName: output.replicaName,
          })
          .pipe(Effect.retry(whileSignalRBusy)),
      );
      yield* waitUntilGone(
        `signalr replica ${output.replicaName}`,
        getReplica(
          subscriptionId,
          output.resourceGroup,
          output.signalR,
          output.replicaName,
        ),
        WAIT,
      );
    }),

    nuke: {
      dependsOn: ["Azure.SignalR.SignalR", "Azure.Resources.ResourceGroup"],
    },
  });
