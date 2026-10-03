import * as hybridnetwork from "@distilled.cloud/azure/hybridnetwork";
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
  canonical,
  FAST_BUDGET,
  NAMESPACE,
  retryInProgress,
  sameArm,
  sameJson,
} from "./Common.ts";

export type NetworkFunctionType =
  | "VirtualNetworkFunction"
  | "ContainerizedNetworkFunction";

/** Version states a publisher can set on a definition version. */
export type NetworkFunctionDefinitionVersionState =
  | "Preview"
  | "Active"
  | "Deprecated";

export interface NetworkFunctionDefinitionVersionProps {
  /** Resource group of the publisher. Changing it replaces the version. */
  resourceGroup: string;
  /** Name of the publisher. Changing it replaces the version. */
  publisher: string;
  /**
   * Name of the parent `NetworkFunctionDefinitionGroup`. Changing it
   * replaces the version.
   */
  networkFunctionDefinitionGroup: string;
  /**
   * Version name; must be a SemVer 2.0.0 version such as `1.0.0`. Changing
   * it replaces the version.
   */
  version: string;
  /**
   * Azure location; must match the publisher's location. Changing it
   * replaces the version.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /** Kind of network function the version describes. Changing it replaces the version. */
  networkFunctionType: NetworkFunctionType;
  /** Description of the version. Versions are immutable; changing it replaces the version. */
  description?: string;
  /**
   * JSON schema (as a string) of the deployment parameters operators supply.
   * Changing it replaces the version.
   */
  deployParameters?: string;
  /**
   * Network function template as ARM JSON: `{ nfviType, networkFunctionApplications }`
   * (applications reference artifacts in an `ArtifactStore`; AOSM rejects a
   * version without one). Changing it replaces the version.
   */
  networkFunctionTemplate: Record<string, unknown>;
  /**
   * Version state. New versions start in `Preview`; set `Active` to publish
   * the version or `Deprecated` to retire it. Updated in place.
   */
  versionState?: NetworkFunctionDefinitionVersionState;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface NetworkFunctionDefinitionVersion extends Resource<
  "Azure.HybridNetwork.NetworkFunctionDefinitionVersion",
  NetworkFunctionDefinitionVersionProps,
  {
    /** Version name (SemVer). */
    networkFunctionDefinitionVersionName: string;
    /** ARM resource ID of the version. */
    networkFunctionDefinitionVersionId: string;
    /** Name of the parent network function definition group. */
    networkFunctionDefinitionGroup: string;
    /** Name of the publisher. */
    publisher: string;
    /** Resource group of the publisher. */
    resourceGroup: string;
    /** Location of the version. */
    location: string;
    /** Kind of network function. */
    networkFunctionType: string;
    /** Current version state (`Preview`, `Active`, `Deprecated`, ...). */
    versionState: string | undefined;
    /** Description of the version. */
    description: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Operator Service Manager network function definition version —
 * an immutable, versioned description of how to deploy one network function
 * (its applications, artifacts and deployment parameters).
 *
 * Versions are immutable once created: changing any definition property
 * replaces the version. Only the version state and tags update in place.
 *
 * @see https://learn.microsoft.com/azure/operator-service-manager/network-function-definition-version-overview
 *
 * ### Creating a Version
 * **Example:** Virtual network function definition version
 * ```typescript
 * const nfdv = yield* Azure.HybridNetwork.NetworkFunctionDefinitionVersion(
 *   "firewall-1-0-0",
 *   {
 *     resourceGroup: group.resourceGroupName,
 *     publisher: publisher.publisherName,
 *     networkFunctionDefinitionGroup: nfdg.networkFunctionDefinitionGroupName,
 *     version: "1.0.0",
 *     networkFunctionType: "VirtualNetworkFunction",
 *     deployParameters: JSON.stringify({ type: "object", properties: {} }),
 *     networkFunctionTemplate: {
 *       nfviType: "AzureCore",
 *       networkFunctionApplications: [
 *         {
 *           artifactType: "ArmTemplate",
 *           name: "firewall",
 *           artifactProfile: {
 *             artifactStore: { id: store.artifactStoreId },
 *             templateArtifactProfile: {
 *               templateName: "firewall",
 *               templateVersion: "1.0.0",
 *             },
 *           },
 *         },
 *       ],
 *     },
 *   },
 * );
 * ```
 *
 * ### Publishing a Version
 * **Example:** Mark the version Active
 * ```typescript
 * const nfdv = yield* Azure.HybridNetwork.NetworkFunctionDefinitionVersion(
 *   "firewall-1-0-0",
 *   { ...props, versionState: "Active" },
 * );
 * ```
 *
 * @resource
 */
export const NetworkFunctionDefinitionVersion =
  Resource<NetworkFunctionDefinitionVersion>(
    "Azure.HybridNetwork.NetworkFunctionDefinitionVersion",
  );

const getVersion = (
  subscriptionId: string,
  resourceGroupName: string,
  publisherName: string,
  networkFunctionDefinitionGroupName: string,
  networkFunctionDefinitionVersionName: string,
) =>
  orUndefinedIfNotFound(
    hybridnetwork.GetNetworkFunctionDefinitionVersion({
      subscriptionId,
      resourceGroupName,
      publisherName,
      networkFunctionDefinitionGroupName,
      networkFunctionDefinitionVersionName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  publisher: string,
  group: string,
  name: string,
  version:
    | hybridnetwork.GetNetworkFunctionDefinitionVersionResponse
    | hybridnetwork.NetworkFunctionDefinitionVersion,
): NetworkFunctionDefinitionVersion["Attributes"] => ({
  networkFunctionDefinitionVersionName: name,
  networkFunctionDefinitionVersionId: version.id ?? "",
  networkFunctionDefinitionGroup: group,
  publisher,
  resourceGroup,
  location: version.location,
  networkFunctionType: version.properties?.networkFunctionType ?? "Unknown",
  versionState: version.properties?.versionState,
  description: version.properties?.description,
  tags: userTags(version.tags),
});

/** Whether the immutable definition of a version changed between props. */
const definitionChanged = (
  a: NetworkFunctionDefinitionVersionProps,
  b: NetworkFunctionDefinitionVersionProps,
) =>
  a.networkFunctionType !== b.networkFunctionType ||
  (a.description ?? undefined) !== (b.description ?? undefined) ||
  !sameJson(a.deployParameters ?? "{}", b.deployParameters ?? "{}") ||
  canonical(a.networkFunctionTemplate) !==
    canonical(b.networkFunctionTemplate);

export const NetworkFunctionDefinitionVersionProvider = () =>
  Provider.succeed(NetworkFunctionDefinitionVersion, {
    stables: [
      "networkFunctionDefinitionVersionName",
      "networkFunctionDefinitionVersionId",
      "networkFunctionDefinitionGroup",
      "publisher",
      "resourceGroup",
      "location",
      "networkFunctionType",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const publishers = yield* hybridnetwork
        .ListPublisherBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListPublisherBySubscription", page),
          ),
        );
      const found: NetworkFunctionDefinitionVersion["Attributes"][] = [];
      for (const publisher of publishers.value ?? []) {
        const resourceGroup = resourceGroupOf(publisher.id);
        if (resourceGroup === undefined || publisher.name === undefined) {
          continue;
        }
        const groups = yield* orUndefinedIfNotFound(
          hybridnetwork.ListNetworkFunctionDefinitionGroupByPublisher({
            subscriptionId,
            resourceGroupName: resourceGroup,
            publisherName: publisher.name,
          }),
        );
        if (groups !== undefined) {
          yield* requireSinglePage(
            "ListNetworkFunctionDefinitionGroupByPublisher",
            groups,
          );
        }
        for (const group of groups?.value ?? []) {
          if (group.name === undefined) continue;
          const page = yield* orUndefinedIfNotFound(
            hybridnetwork.ListNetworkFunctionDefinitionVersionByNetworkFunctionDefinitionGroup(
              {
                subscriptionId,
                resourceGroupName: resourceGroup,
                publisherName: publisher.name,
                networkFunctionDefinitionGroupName: group.name,
              },
            ),
          );
          if (page !== undefined) {
            yield* requireSinglePage(
              "ListNetworkFunctionDefinitionVersionByNetworkFunctionDefinitionGroup",
              page,
            );
          }
          for (const item of page?.value ?? []) {
            if (hasAnyAlchemyTag(item.tags) && item.name !== undefined) {
              found.push(
                toAttrs(
                  resourceGroup,
                  publisher.name,
                  group.name,
                  item.name,
                  item,
                ),
              );
            }
          }
        }
      }
      return found;
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      const sameVersion =
        news.version === output.networkFunctionDefinitionVersionName;
      if (
        !sameArm(news.resourceGroup, output.resourceGroup) ||
        !sameArm(news.publisher, output.publisher) ||
        !sameArm(
          news.networkFunctionDefinitionGroup,
          output.networkFunctionDefinitionGroup,
        ) ||
        !sameVersion ||
        (news.location !== undefined &&
          !sameArm(news.location, output.location)) ||
        news.networkFunctionType !== output.networkFunctionType ||
        (olds !== undefined && definitionChanged(news, olds))
      ) {
        // The same version name can only be reused once the old one is gone.
        return { action: "replace", deleteFirst: sameVersion } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output, id }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const publisher = output?.publisher ?? olds?.publisher;
      const group =
        output?.networkFunctionDefinitionGroup ??
        olds?.networkFunctionDefinitionGroup;
      const name = output?.networkFunctionDefinitionVersionName ?? olds?.version;
      if (
        resourceGroup === undefined ||
        publisher === undefined ||
        group === undefined ||
        name === undefined
      ) {
        return undefined;
      }
      const observed = yield* getVersion(
        subscriptionId,
        resourceGroup,
        publisher,
        group,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, publisher, group, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, NAMESPACE);
      const { resourceGroup, publisher, networkFunctionDefinitionGroup } =
        news;
      const name = news.version;
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        publisherName: publisher,
        networkFunctionDefinitionGroupName: networkFunctionDefinitionGroup,
        networkFunctionDefinitionVersionName: name,
      };
      const get = getVersion(
        subscriptionId,
        resourceGroup,
        publisher,
        networkFunctionDefinitionGroup,
        name,
      );
      const label = `AOSM network function definition version ${networkFunctionDefinitionGroup}/${name}`;

      // Observe.
      let observed = yield* get;

      // Ensure. The definition is immutable, so it is only sent on create.
      if (observed === undefined) {
        yield* retryInProgress(
          hybridnetwork.NetworkFunctionDefinitionVersionsCreateOrUpdate({
            ...where,
            location,
            tags,
            properties: {
              networkFunctionType: news.networkFunctionType,
              description: news.description,
              deployParameters: news.deployParameters,
              networkFunctionTemplate: news.networkFunctionTemplate,
            },
          }),
        );
      }
      observed = yield* waitForProvisioned(
        label,
        get,
        (version) => version.properties?.provisioningState,
        FAST_BUDGET,
      );

      // Sync the version state against observed state.
      const versionState = news.versionState;
      if (
        versionState !== undefined &&
        observed.properties?.versionState !== versionState
      ) {
        yield* retryInProgress(
          hybridnetwork.UpdateNetworkFunctionDefinitionVersionState({
            ...where,
            versionState,
          }),
        );
        observed = yield* waitForProvisioned(
          label,
          get,
          (version) =>
            version.properties?.provisioningState === "Succeeded" &&
            version.properties?.versionState !== versionState
              ? "Updating"
              : version.properties?.provisioningState,
          FAST_BUDGET,
        );
      }

      // Sync tags against observed state.
      if (tagsDiffer(observed.tags, tags)) {
        yield* retryInProgress(
          hybridnetwork.UpdateNetworkFunctionDefinitionVersion({
            ...where,
            tags,
          }),
        );
        observed = yield* waitForProvisioned(
          label,
          get,
          (version) =>
            tagsDiffer(version.tags, tags)
              ? "Updating"
              : version.properties?.provisioningState,
          FAST_BUDGET,
        );
      }

      return toAttrs(
        resourceGroup,
        publisher,
        networkFunctionDefinitionGroup,
        name,
        observed,
      );
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        hybridnetwork
          .DeleteNetworkFunctionDefinitionVersion({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            publisherName: output.publisher,
            networkFunctionDefinitionGroupName:
              output.networkFunctionDefinitionGroup,
            networkFunctionDefinitionVersionName:
              output.networkFunctionDefinitionVersionName,
          })
          .pipe(retryInProgress),
      );
      yield* waitUntilGone(
        `AOSM network function definition version ${output.networkFunctionDefinitionGroup}/${output.networkFunctionDefinitionVersionName}`,
        getVersion(
          subscriptionId,
          output.resourceGroup,
          output.publisher,
          output.networkFunctionDefinitionGroup,
          output.networkFunctionDefinitionVersionName,
        ),
        FAST_BUDGET,
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.HybridNetwork.NetworkFunctionDefinitionGroup",
        "Azure.HybridNetwork.Publisher",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
