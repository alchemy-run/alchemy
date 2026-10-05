import * as mission from "@distilled.cloud/azure/mission";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  desiredTags,
  ensureRegistered,
  hasAnyAlchemyTag,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  requireSinglePage,
  resourceGroupOf,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  createMissionName,
  FAST,
  getCommunity,
  getVirtualEnclave,
  lastSegment,
  NAMESPACE,
  sameName,
} from "./Common.ts";

export interface EnclaveConnectionProps {
  /** Resource group the connection is created in. Changing it replaces the connection. */
  resourceGroup: string;
  /**
   * Connection name. If omitted, a unique name is generated from the app,
   * stage, and logical ID. Changing it replaces the connection.
   */
  name?: string;
  /**
   * Azure location of the connection. Changing it replaces the connection.
   * @default the community's location
   */
  location?: string;
  /** ARM ID of the community both sides belong to. Changing it replaces the connection. */
  communityId: string;
  /**
   * ARM ID of the source (a virtual enclave or community). Changing it
   * replaces the connection.
   */
  sourceId: string;
  /**
   * ARM ID of the destination enclave or community endpoint. Changing it
   * replaces the connection.
   */
  destinationEndpointId: string;
  /**
   * CIDR within the source allowed to reach the destination. Azure
   * requires one.
   * @default the address space of the source enclave
   */
  sourceCidr?: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface EnclaveConnection extends Resource<
  "Azure.VirtualEnclaves.EnclaveConnection",
  EnclaveConnectionProps,
  {
    /** Name of the connection. */
    enclaveConnectionName: string;
    /** ARM resource ID of the connection. */
    enclaveConnectionId: string;
    /** Resource group that holds the connection. */
    resourceGroup: string;
    /** Location of the connection. */
    location: string;
    /** ARM ID of the community. */
    communityId: string;
    /** ARM ID of the source. */
    sourceId: string;
    /** ARM ID of the destination endpoint. */
    destinationEndpointId: string;
    /** CIDR within the source allowed to reach the destination. */
    sourceCidr: string | undefined;
    /**
     * Connection state, e.g. `PendingApproval`, `Approved`, `Active`,
     * `Connected`.
     */
    state: string | undefined;
    /** ARM IDs of the resources the connection manages. */
    resourceCollection: string[];
    /** Last provisioning state. */
    provisioningState: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An enclave connection — firewall rules that let a source enclave reach
 * an {@link EnclaveEndpoint} (or {@link CommunityEndpoint}) through the
 * community. The destination owner may need to approve it, depending on
 * the community's and enclave's approval settings.
 *
 * @see https://learn.microsoft.com/azure/virtual-enclaves/overview
 *
 * ### Connecting Enclaves
 * **Example:** Let one enclave reach another enclave's endpoint
 * ```typescript
 * const connection = yield* Azure.VirtualEnclaves.EnclaveConnection("a-to-b", {
 *   resourceGroup: group.resourceGroupName,
 *   communityId: community.communityId,
 *   sourceId: enclaveA.virtualEnclaveId,
 *   destinationEndpointId: endpointB.enclaveEndpointId,
 *   sourceCidr: "10.1.0.0/26",
 * });
 * ```
 *
 * @resource
 */
export const EnclaveConnection = Resource<EnclaveConnection>(
  "Azure.VirtualEnclaves.EnclaveConnection",
);

type Observed =
  | mission.GetEnclaveConnectionResponse
  | mission.EnclaveConnectionResource;

const getConnection = (
  subscriptionId: string,
  resourceGroupName: string,
  enclaveConnectionName: string,
) =>
  orUndefinedIfNotFound(
    mission.GetEnclaveConnection({
      subscriptionId,
      resourceGroupName,
      enclaveConnectionName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  observed: Observed,
): EnclaveConnection["Attributes"] => ({
  enclaveConnectionName: name,
  enclaveConnectionId: observed.id ?? "",
  resourceGroup,
  location: observed.location,
  communityId: observed.properties?.communityResourceId ?? "",
  sourceId: observed.properties?.sourceResourceId ?? "",
  destinationEndpointId: observed.properties?.destinationEndpointId ?? "",
  sourceCidr: observed.properties?.sourceCidr,
  state: observed.properties?.state,
  resourceCollection: observed.properties?.resourceCollection ?? [],
  provisioningState: observed.properties?.provisioningState,
  tags: userTags(observed.tags),
});

export const EnclaveConnectionProvider = () =>
  Provider.succeed(EnclaveConnection, {
    stables: [
      "enclaveConnectionName",
      "enclaveConnectionId",
      "resourceGroup",
      "location",
      "communityId",
      "sourceId",
      "destinationEndpointId",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* mission
        .ListEnclaveConnectionBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListEnclaveConnectionBySubscription", page),
          ),
        );
      return page.value.flatMap((connection) => {
        const group = resourceGroupOf(connection.id);
        return hasAnyAlchemyTag(connection.tags) &&
          group !== undefined &&
          connection.name !== undefined
          ? [toAttrs(group, connection.name, connection)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        (news.name !== undefined &&
          !sameName(news.name, output.enclaveConnectionName)) ||
        (news.location !== undefined &&
          !sameName(news.location, output.location)) ||
        !sameName(news.communityId, output.communityId) ||
        !sameName(news.sourceId, output.sourceId) ||
        !sameName(news.destinationEndpointId, output.destinationEndpointId)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name =
        output?.enclaveConnectionName ??
        olds?.name ??
        (yield* createMissionName(id));
      const observed = yield* getConnection(
        subscriptionId,
        resourceGroup,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, NAMESPACE);
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ??
        output?.enclaveConnectionName ??
        (yield* createMissionName(id));
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        enclaveConnectionName: name,
      };
      const get = getConnection(subscriptionId, resourceGroup, name);
      const waitReady = waitForProvisioned(
        `enclave connection ${name}`,
        get,
        (connection) => connection.properties?.provisioningState,
        FAST,
      );

      // Azure rejects a connection without a source CIDR; default to the
      // address space of a source enclave.
      const sourceCidr =
        news.sourceCidr ??
        (/\/providers\/microsoft\.mission\/virtualenclaves\//i.test(
          news.sourceId,
        )
          ? (yield* getVirtualEnclave(
              subscriptionId,
              resourceGroupOf(news.sourceId) ?? resourceGroup,
              lastSegment(news.sourceId) ?? "",
            ))?.properties?.enclaveAddressSpaces?.enclaveAddressSpace
          : undefined);

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        const community = news.location
          ? undefined
          : yield* getCommunity(
              subscriptionId,
              resourceGroupOf(news.communityId) ?? resourceGroup,
              lastSegment(news.communityId) ?? "",
            );
        yield* mission.EnclaveConnectionCreateOrUpdate({
          ...where,
          location:
            news.location ??
            output?.location ??
            community?.location ??
            env.location,
          tags,
          properties: {
            communityResourceId: news.communityId,
            sourceResourceId: news.sourceId,
            destinationEndpointId: news.destinationEndpointId,
            sourceCidr,
          },
        });
      }
      observed = yield* waitReady;

      // Sync the source CIDR and tags; PATCH only the deltas.
      const cidrChanged =
        sourceCidr !== undefined &&
        sourceCidr !== observed.properties?.sourceCidr;
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (cidrChanged || tagsChanged) {
        yield* mission.UpdateEnclaveConnection({
          ...where,
          properties: cidrChanged ? { sourceCidr } : undefined,
          tags: tagsChanged ? tags : undefined,
        });
        observed = yield* waitReady;
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        mission.DeleteEnclaveConnection({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          enclaveConnectionName: output.enclaveConnectionName,
        }),
      );
      yield* waitUntilGone(
        `enclave connection ${output.enclaveConnectionName}`,
        getConnection(
          subscriptionId,
          output.resourceGroup,
          output.enclaveConnectionName,
        ),
        FAST,
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.VirtualEnclaves.Community",
        "Azure.VirtualEnclaves.VirtualEnclave",
        "Azure.VirtualEnclaves.EnclaveEndpoint",
        "Azure.VirtualEnclaves.CommunityEndpoint",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
