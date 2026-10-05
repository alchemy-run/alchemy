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
  sameIdMap,
} from "./Common.ts";

/** Version states a publisher can set on a design version. */
export type NetworkServiceDesignVersionState =
  | "Preview"
  | "Active"
  | "Deprecated";

/** An NFVI placeholder that operators map onto a site's NFVI. */
export interface NetworkServiceDesignNfvi {
  /** Name of the NFVI (matches the NFVI name on the `Site`). */
  name: string;
  /** NFVI type, e.g. `AzureCore`, `AzureArcKubernetes`, `AzureOperatorNexus`. */
  type: string;
}

/**
 * A resource element template: `{ name, type, dependsOnProfile?, configuration }`
 * where `type` is `ArmResourceDefinition` or `NetworkFunctionDefinition`.
 */
export interface NetworkServiceDesignResourceElementTemplate {
  /** Name of the resource element template. */
  name: string;
  /** `ArmResourceDefinition` or `NetworkFunctionDefinition`. */
  type: "ArmResourceDefinition" | "NetworkFunctionDefinition";
  /** Install / uninstall / update ordering between templates. */
  dependsOnProfile?: {
    installDependsOn?: string[];
    uninstallDependsOn?: string[];
    updateDependsOn?: string[];
  };
  /** Type-specific configuration as ARM JSON. */
  configuration?: Record<string, unknown>;
}

export interface NetworkServiceDesignVersionProps {
  /** Resource group of the publisher. Changing it replaces the version. */
  resourceGroup: string;
  /** Name of the publisher. Changing it replaces the version. */
  publisher: string;
  /**
   * Name of the parent `NetworkServiceDesignGroup`. Changing it replaces
   * the version.
   */
  networkServiceDesignGroup: string;
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
  /** Description of the version. Versions are immutable; changing it replaces the version. */
  description?: string;
  /**
   * Configuration group schemas the design consumes, as
   * `{ referenceName: configurationGroupSchemaId }`. Changing it replaces
   * the version.
   */
  configurationGroupSchemaReferences?: Record<string, string>;
  /**
   * NFVI placeholders of the design, keyed by reference name. Changing it
   * replaces the version.
   */
  nfvisFromSite?: Record<string, NetworkServiceDesignNfvi>;
  /**
   * Resource element templates deployed by the design (at least one).
   * Changing them replaces the version.
   */
  resourceElementTemplates: NetworkServiceDesignResourceElementTemplate[];
  /**
   * Version state. New versions start in `Preview`; set `Active` to publish
   * the version or `Deprecated` to retire it. Updated in place.
   */
  versionState?: NetworkServiceDesignVersionState;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface NetworkServiceDesignVersion extends Resource<
  "Azure.HybridNetwork.NetworkServiceDesignVersion",
  NetworkServiceDesignVersionProps,
  {
    /** Version name (SemVer). */
    networkServiceDesignVersionName: string;
    /** ARM resource ID of the version. */
    networkServiceDesignVersionId: string;
    /** Name of the parent network service design group. */
    networkServiceDesignGroup: string;
    /** Name of the publisher. */
    publisher: string;
    /** Resource group of the publisher. */
    resourceGroup: string;
    /** Location of the version. */
    location: string;
    /** Current version state (`Preview`, `Active`, `Deprecated`). */
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
 * An Azure Operator Service Manager network service design version — an
 * immutable, versioned design that composes network functions and ARM
 * resources into a network service operators deploy onto a `Site`.
 *
 * Versions are immutable once created: changing any design property
 * replaces the version. Only the version state and tags update in place.
 *
 * @see https://learn.microsoft.com/azure/operator-service-manager/network-service-design-version-overview
 *
 * ### Creating a Version
 * **Example:** Design version consuming a configuration group schema
 * ```typescript
 * const nsdv = yield* Azure.HybridNetwork.NetworkServiceDesignVersion(
 *   "service-1-0-0",
 *   {
 *     resourceGroup: group.resourceGroupName,
 *     publisher: publisher.publisherName,
 *     networkServiceDesignGroup: nsdg.networkServiceDesignGroupName,
 *     version: "1.0.0",
 *     configurationGroupSchemaReferences: {
 *       config: schema.configurationGroupSchemaId,
 *     },
 *     nfvisFromSite: { core: { name: "core", type: "AzureCore" } },
 *     resourceElementTemplates: [
 *       {
 *         name: "network",
 *         type: "ArmResourceDefinition",
 *         configuration: {
 *           templateType: "ArmTemplate",
 *           parameterValues: JSON.stringify({ region: "{configurationparameters('config').region}" }),
 *           artifactProfile: {
 *             artifactStoreReference: { id: store.artifactStoreId },
 *             artifactName: "network-template",
 *             artifactVersion: "1.0.0",
 *           },
 *         },
 *       },
 *     ],
 *   },
 * );
 * ```
 *
 * ### Publishing a Version
 * **Example:** Mark the version Active
 * ```typescript
 * const nsdv = yield* Azure.HybridNetwork.NetworkServiceDesignVersion(
 *   "service-1-0-0",
 *   { ...props, versionState: "Active" },
 * );
 * ```
 *
 * @resource
 */
export const NetworkServiceDesignVersion =
  Resource<NetworkServiceDesignVersion>(
    "Azure.HybridNetwork.NetworkServiceDesignVersion",
  );

const getVersion = (
  subscriptionId: string,
  resourceGroupName: string,
  publisherName: string,
  networkServiceDesignGroupName: string,
  networkServiceDesignVersionName: string,
) =>
  orUndefinedIfNotFound(
    hybridnetwork.GetNetworkServiceDesignVersion({
      subscriptionId,
      resourceGroupName,
      publisherName,
      networkServiceDesignGroupName,
      networkServiceDesignVersionName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  publisher: string,
  group: string,
  name: string,
  version:
    | hybridnetwork.GetNetworkServiceDesignVersionResponse
    | hybridnetwork.NetworkServiceDesignVersion,
): NetworkServiceDesignVersion["Attributes"] => ({
  networkServiceDesignVersionName: name,
  networkServiceDesignVersionId: version.id ?? "",
  networkServiceDesignGroup: group,
  publisher,
  resourceGroup,
  location: version.location,
  versionState: version.properties?.versionState,
  description: version.properties?.description,
  tags: userTags(version.tags),
});

/** Whether the immutable design of a version changed between props. */
const designChanged = (
  a: NetworkServiceDesignVersionProps,
  b: NetworkServiceDesignVersionProps,
) =>
  (a.description ?? undefined) !== (b.description ?? undefined) ||
  !sameIdMap(
    a.configurationGroupSchemaReferences,
    b.configurationGroupSchemaReferences,
  ) ||
  canonical(a.nfvisFromSite ?? {}) !== canonical(b.nfvisFromSite ?? {}) ||
  canonical(a.resourceElementTemplates) !==
    canonical(b.resourceElementTemplates);

const idRefs = (refs: Record<string, string> | undefined) =>
  refs === undefined
    ? undefined
    : Object.fromEntries(Object.entries(refs).map(([k, id]) => [k, { id }]));

export const NetworkServiceDesignVersionProvider = () =>
  Provider.succeed(NetworkServiceDesignVersion, {
    stables: [
      "networkServiceDesignVersionName",
      "networkServiceDesignVersionId",
      "networkServiceDesignGroup",
      "publisher",
      "resourceGroup",
      "location",
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
      const found: NetworkServiceDesignVersion["Attributes"][] = [];
      for (const publisher of publishers.value ?? []) {
        const resourceGroup = resourceGroupOf(publisher.id);
        if (resourceGroup === undefined || publisher.name === undefined) {
          continue;
        }
        const groups = yield* orUndefinedIfNotFound(
          hybridnetwork.ListNetworkServiceDesignGroupByPublisher({
            subscriptionId,
            resourceGroupName: resourceGroup,
            publisherName: publisher.name,
          }),
        );
        if (groups !== undefined) {
          yield* requireSinglePage(
            "ListNetworkServiceDesignGroupByPublisher",
            groups,
          );
        }
        for (const group of groups?.value ?? []) {
          if (group.name === undefined) continue;
          const page = yield* orUndefinedIfNotFound(
            hybridnetwork.ListNetworkServiceDesignVersionByNetworkServiceDesignGroup(
              {
                subscriptionId,
                resourceGroupName: resourceGroup,
                publisherName: publisher.name,
                networkServiceDesignGroupName: group.name,
              },
            ),
          );
          if (page !== undefined) {
            yield* requireSinglePage(
              "ListNetworkServiceDesignVersionByNetworkServiceDesignGroup",
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
      const sameVersion = news.version === output.networkServiceDesignVersionName;
      if (
        !sameArm(news.resourceGroup, output.resourceGroup) ||
        !sameArm(news.publisher, output.publisher) ||
        !sameArm(
          news.networkServiceDesignGroup,
          output.networkServiceDesignGroup,
        ) ||
        !sameVersion ||
        (news.location !== undefined &&
          !sameArm(news.location, output.location)) ||
        (olds !== undefined && designChanged(news, olds))
      ) {
        // The same version name can only be reused once the old one is gone.
        return { action: "replace", deleteFirst: sameVersion } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const publisher = output?.publisher ?? olds?.publisher;
      const group =
        output?.networkServiceDesignGroup ?? olds?.networkServiceDesignGroup;
      const name = output?.networkServiceDesignVersionName ?? olds?.version;
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
      const { resourceGroup, publisher, networkServiceDesignGroup } = news;
      const name = news.version;
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        publisherName: publisher,
        networkServiceDesignGroupName: networkServiceDesignGroup,
        networkServiceDesignVersionName: name,
      };
      const get = getVersion(
        subscriptionId,
        resourceGroup,
        publisher,
        networkServiceDesignGroup,
        name,
      );
      const label = `AOSM network service design version ${networkServiceDesignGroup}/${name}`;

      // Observe.
      let observed = yield* get;

      // Ensure. The design is immutable, so it is only sent on create.
      if (observed === undefined) {
        yield* retryInProgress(
          hybridnetwork.NetworkServiceDesignVersionsCreateOrUpdate({
            ...where,
            location,
            tags,
            properties: {
              description: news.description,
              // AOSM rejects a design without these maps
              // (`LinkedAuthorizationFailed`), so send empty maps by default.
              configurationGroupSchemaReferences:
                idRefs(news.configurationGroupSchemaReferences) ?? {},
              nfvisFromSite: news.nfvisFromSite ?? {},
              resourceElementTemplates: news.resourceElementTemplates,
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
          hybridnetwork.UpdateNetworkServiceDesignVersionState({
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
          hybridnetwork.UpdateNetworkServiceDesignVersion({ ...where, tags }),
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
        networkServiceDesignGroup,
        name,
        observed,
      );
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        hybridnetwork
          .DeleteNetworkServiceDesignVersion({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            publisherName: output.publisher,
            networkServiceDesignGroupName: output.networkServiceDesignGroup,
            networkServiceDesignVersionName:
              output.networkServiceDesignVersionName,
          })
          .pipe(retryInProgress),
      );
      yield* waitUntilGone(
        `AOSM network service design version ${output.networkServiceDesignGroup}/${output.networkServiceDesignVersionName}`,
        getVersion(
          subscriptionId,
          output.resourceGroup,
          output.publisher,
          output.networkServiceDesignGroup,
          output.networkServiceDesignVersionName,
        ),
        FAST_BUDGET,
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.HybridNetwork.NetworkServiceDesignGroup",
        "Azure.HybridNetwork.Publisher",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
