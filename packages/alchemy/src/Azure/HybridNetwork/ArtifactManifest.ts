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
  createHybridNetworkName,
  FAST_BUDGET,
  NAMESPACE,
  retryInProgress,
  sameArm,
} from "./Common.ts";

export type ManifestArtifactType =
  | "OCIArtifact"
  | "VhdImageFile"
  | "ArmTemplate"
  | "ImageFile";

export interface ManifestArtifact {
  /** Name of the artifact (repository name in the backing registry). */
  artifactName: string;
  /** Kind of artifact. */
  artifactType: ManifestArtifactType;
  /** Version (tag) of the artifact, e.g. `1.0.0`. */
  artifactVersion: string;
}

export interface ArtifactManifestProps {
  /** Resource group of the publisher. Changing it replaces the manifest. */
  resourceGroup: string;
  /** Name of the publisher. Changing it replaces the manifest. */
  publisher: string;
  /** Name of the artifact store that holds the manifest. Changing it replaces the manifest. */
  artifactStore: string;
  /**
   * Manifest name: 1-64 letters, digits, `_`, and `-`. If omitted, a
   * unique name is generated from the app, stage, and logical ID. Changing
   * it replaces the manifest.
   */
  name?: string;
  /**
   * Azure location; must match the artifact store's location. Changing it
   * replaces the manifest.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Artifacts the manifest declares. Manifests are immutable: changing the
   * list replaces the manifest.
   */
  artifacts: ManifestArtifact[];
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface ArtifactManifest extends Resource<
  "Azure.HybridNetwork.ArtifactManifest",
  ArtifactManifestProps,
  {
    /** Name of the manifest. */
    artifactManifestName: string;
    /** ARM resource ID of the manifest. */
    artifactManifestId: string;
    /** Name of the artifact store that holds the manifest. */
    artifactStore: string;
    /** Name of the publisher. */
    publisher: string;
    /** Resource group of the publisher. */
    resourceGroup: string;
    /** Location of the manifest. */
    location: string;
    /** Artifacts the manifest declares. */
    artifacts: ManifestArtifact[];
    /**
     * Upload state: `Uploading` until the declared artifacts are pushed to
     * the store, then `Uploaded` / `Succeeded`.
     */
    artifactManifestState: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Operator Service Manager artifact manifest — declares the
 * artifacts (Helm charts, container images, ARM templates, VHDs) a
 * publisher uploads to an artifact store. After the manifest is created,
 * push the artifacts to the store's backing registry with the manifest's
 * credential.
 *
 * Manifests are free; the backing artifact store is billed.
 *
 * @see https://learn.microsoft.com/azure/operator-service-manager/artifact-manifest-overview
 *
 * ### Declaring Artifacts
 * **Example:** Manifest for an ARM template
 * ```typescript
 * const manifest = yield* Azure.HybridNetwork.ArtifactManifest("templates", {
 *   resourceGroup: group.resourceGroupName,
 *   publisher: publisher.publisherName,
 *   artifactStore: store.artifactStoreName,
 *   artifacts: [
 *     {
 *       artifactName: "vnet-template",
 *       artifactType: "ArmTemplate",
 *       artifactVersion: "1.0.0",
 *     },
 *   ],
 * });
 * ```
 *
 * **Example:** Manifest for a Helm chart and its image
 * ```typescript
 * const manifest = yield* Azure.HybridNetwork.ArtifactManifest("cnf", {
 *   resourceGroup: group.resourceGroupName,
 *   publisher: publisher.publisherName,
 *   artifactStore: store.artifactStoreName,
 *   artifacts: [
 *     { artifactName: "nginx", artifactType: "OCIArtifact", artifactVersion: "1.0.0" },
 *     { artifactName: "nginx-image", artifactType: "OCIArtifact", artifactVersion: "1.25" },
 *   ],
 * });
 * ```
 *
 * @resource
 */
export const ArtifactManifest = Resource<ArtifactManifest>(
  "Azure.HybridNetwork.ArtifactManifest",
);

const getManifest = (
  subscriptionId: string,
  resourceGroupName: string,
  publisherName: string,
  artifactStoreName: string,
  artifactManifestName: string,
) =>
  orUndefinedIfNotFound(
    hybridnetwork.GetArtifactManifest({
      subscriptionId,
      resourceGroupName,
      publisherName,
      artifactStoreName,
      artifactManifestName,
    }),
  );

const normalize = (
  artifacts: ReadonlyArray<hybridnetwork.ManifestArtifactFormat>,
): ManifestArtifact[] =>
  artifacts.map((a) => ({
    artifactName: a.artifactName ?? "",
    artifactType: a.artifactType as ManifestArtifactType,
    artifactVersion: a.artifactVersion ?? "",
  }));

const artifactsKey = (artifacts: ReadonlyArray<ManifestArtifact>) =>
  canonical(
    [...artifacts]
      .map((a) => ({ ...a }))
      .sort((x, y) =>
        `${x.artifactName}:${x.artifactVersion}`.localeCompare(
          `${y.artifactName}:${y.artifactVersion}`,
        ),
      ),
  );

const toAttrs = (
  resourceGroup: string,
  publisher: string,
  store: string,
  name: string,
  manifest:
    | hybridnetwork.GetArtifactManifestResponse
    | hybridnetwork.ArtifactManifest,
): ArtifactManifest["Attributes"] => ({
  artifactManifestName: name,
  artifactManifestId: manifest.id ?? "",
  artifactStore: store,
  publisher,
  resourceGroup,
  location: manifest.location,
  artifacts: normalize(manifest.properties?.artifacts ?? []),
  artifactManifestState: manifest.properties?.artifactManifestState,
  tags: userTags(manifest.tags),
});

export const ArtifactManifestProvider = () =>
  Provider.succeed(ArtifactManifest, {
    stables: [
      "artifactManifestName",
      "artifactManifestId",
      "artifactStore",
      "publisher",
      "resourceGroup",
      "location",
      "artifacts",
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
      const found: ArtifactManifest["Attributes"][] = [];
      for (const publisher of publishers.value ?? []) {
        const group = resourceGroupOf(publisher.id);
        if (group === undefined || publisher.name === undefined) continue;
        const stores = yield* orUndefinedIfNotFound(
          hybridnetwork.ListArtifactStoreByPublisher({
            subscriptionId,
            resourceGroupName: group,
            publisherName: publisher.name,
          }),
        );
        if (stores !== undefined) {
          yield* requireSinglePage("ListArtifactStoreByPublisher", stores);
        }
        for (const store of stores?.value ?? []) {
          if (store.name === undefined) continue;
          const page = yield* orUndefinedIfNotFound(
            hybridnetwork.ListArtifactManifestByArtifactStore({
              subscriptionId,
              resourceGroupName: group,
              publisherName: publisher.name,
              artifactStoreName: store.name,
            }),
          );
          if (page !== undefined) {
            yield* requireSinglePage(
              "ListArtifactManifestByArtifactStore",
              page,
            );
          }
          for (const manifest of page?.value ?? []) {
            if (hasAnyAlchemyTag(manifest.tags) && manifest.name !== undefined) {
              found.push(
                toAttrs(group, publisher.name, store.name, manifest.name, manifest),
              );
            }
          }
        }
      }
      return found;
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      const sameName =
        news.name === undefined || news.name === output.artifactManifestName;
      if (
        !sameArm(news.resourceGroup, output.resourceGroup) ||
        !sameArm(news.publisher, output.publisher) ||
        !sameArm(news.artifactStore, output.artifactStore) ||
        !sameName ||
        (news.location !== undefined &&
          !sameArm(news.location, output.location)) ||
        artifactsKey(news.artifacts) !== artifactsKey(output.artifacts)
      ) {
        return {
          action: "replace",
          deleteFirst: news.name !== undefined && sameName,
        } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const publisher = output?.publisher ?? olds?.publisher;
      const store = output?.artifactStore ?? olds?.artifactStore;
      if (
        resourceGroup === undefined ||
        publisher === undefined ||
        store === undefined
      ) {
        return undefined;
      }
      const name =
        output?.artifactManifestName ??
        olds?.name ??
        (yield* createHybridNetworkName(id));
      const observed = yield* getManifest(
        subscriptionId,
        resourceGroup,
        publisher,
        store,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, publisher, store, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, NAMESPACE);
      const { resourceGroup, publisher, artifactStore } = news;
      const name =
        news.name ??
        output?.artifactManifestName ??
        (yield* createHybridNetworkName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        publisherName: publisher,
        artifactStoreName: artifactStore,
        artifactManifestName: name,
      };
      const get = getManifest(
        subscriptionId,
        resourceGroup,
        publisher,
        artifactStore,
        name,
      );
      const label = `AOSM artifact manifest ${name}`;

      // Observe.
      let observed = yield* get;

      // Ensure. Creation is a long-running operation.
      if (observed === undefined) {
        yield* retryInProgress(
          hybridnetwork.ArtifactManifestsCreateOrUpdate({
            ...where,
            location,
            tags,
            properties: { artifacts: news.artifacts },
          }),
        );
      }
      observed = yield* waitForProvisioned(
        label,
        get,
        (manifest) => manifest.properties?.provisioningState,
        FAST_BUDGET,
      );

      // Sync tags against observed state.
      if (tagsDiffer(observed.tags, tags)) {
        yield* retryInProgress(
          hybridnetwork.UpdateArtifactManifest({ ...where, tags }),
        );
        observed = yield* waitForProvisioned(
          label,
          get,
          (manifest) =>
            tagsDiffer(manifest.tags, tags)
              ? "Updating"
              : manifest.properties?.provisioningState,
          FAST_BUDGET,
        );
      }

      return toAttrs(resourceGroup, publisher, artifactStore, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        hybridnetwork
          .DeleteArtifactManifest({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            publisherName: output.publisher,
            artifactStoreName: output.artifactStore,
            artifactManifestName: output.artifactManifestName,
          })
          .pipe(retryInProgress),
      );
      yield* waitUntilGone(
        `AOSM artifact manifest ${output.artifactManifestName}`,
        getManifest(
          subscriptionId,
          output.resourceGroup,
          output.publisher,
          output.artifactStore,
          output.artifactManifestName,
        ),
        FAST_BUDGET,
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.HybridNetwork.ArtifactStore",
        "Azure.HybridNetwork.Publisher",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
