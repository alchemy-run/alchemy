import * as devtestlabs from "@distilled.cloud/azure/devtestlabs";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  desiredTags,
  ensureRegistered,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  tagsDiffer,
  userTags,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  createLabResourceName,
  DEVTESTLAB_NAMESPACE,
  diverges,
  labLocation,
} from "./Common.ts";

export interface ArtifactSourceProps {
  /** Resource group of the lab. Changing it replaces the source. */
  resourceGroup: string;
  /** Name of the lab. Changing it replaces the source. */
  lab: string;
  /**
   * Source name. If omitted, a unique name is generated from the app,
   * stage, and logical ID. Changing it replaces the source.
   */
  name?: string;
  /** Display name shown in the lab. */
  displayName?: string;
  /** Clone URI of the Git repository. */
  uri: string;
  /** Repository host. */
  sourceType: "GitHub" | "VsoGit" | "StorageAccount";
  /** Folder of artifact definitions, e.g. `"/Artifacts"`. */
  folderPath?: string;
  /** Folder of ARM environment templates, e.g. `"/Environments"`. */
  armTemplateFolderPath?: string;
  /** Branch to read. */
  branchRef?: string;
  /**
   * Personal access token for the repository. Write-only: Azure never
   * returns it, so a change is detected against the previous deploy.
   */
  securityToken?: Redacted.Redacted<string>;
  /**
   * Whether the source is enabled.
   * @default "Enabled"
   */
  status?: "Enabled" | "Disabled";
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface ArtifactSource extends Resource<
  "Azure.DevTestLabs.ArtifactSource",
  ArtifactSourceProps,
  {
    /** Name of the source. */
    artifactSourceName: string;
    /** ARM resource ID of the source. */
    artifactSourceId: string;
    /** Resource group of the lab. */
    resourceGroup: string;
    /** Name of the lab. */
    lab: string;
    /** Clone URI of the repository. */
    uri: string | undefined;
    /** Whether the source is enabled. */
    status: string | undefined;
    /** Unique immutable identifier (GUID) of the source. */
    uniqueIdentifier: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A DevTest Labs artifact source — a Git repository of VM artifacts and
 * ARM environment templates that lab users can apply.
 *
 * @see https://learn.microsoft.com/azure/devtest-labs/add-artifact-repository
 *
 * ### Adding a Repository
 * **Example:** Private GitHub repository
 * ```typescript
 * const repo = yield* Azure.DevTestLabs.ArtifactSource("artifacts", {
 *   resourceGroup: group.resourceGroupName,
 *   lab: lab.labName,
 *   displayName: "Team artifacts",
 *   uri: "https://github.com/acme/lab-artifacts.git",
 *   sourceType: "GitHub",
 *   folderPath: "/Artifacts",
 *   armTemplateFolderPath: "/Environments",
 *   branchRef: "main",
 *   securityToken: Redacted.make(githubToken),
 * });
 * ```
 *
 * @resource
 */
export const ArtifactSource = Resource<ArtifactSource>(
  "Azure.DevTestLabs.ArtifactSource",
);

const getSource = (
  subscriptionId: string,
  resourceGroupName: string,
  labName: string,
  name: string,
) =>
  orUndefinedIfNotFound(
    devtestlabs.GetArtifactSource({
      subscriptionId,
      resourceGroupName,
      labName,
      name,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  lab: string,
  name: string,
  s: devtestlabs.GetArtifactSourceResponse,
): ArtifactSource["Attributes"] => ({
  artifactSourceName: name,
  artifactSourceId: s.id ?? "",
  resourceGroup,
  lab,
  uri: s.properties?.uri,
  status: s.properties?.status,
  uniqueIdentifier: s.properties?.uniqueIdentifier,
  tags: userTags(s.tags),
});

const tokenOf = (token: Redacted.Redacted<string> | undefined) =>
  token === undefined ? undefined : Redacted.value(token);

export const ArtifactSourceProvider = () =>
  Provider.succeed(ArtifactSource, {
    stables: ["artifactSourceName", "artifactSourceId", "resourceGroup", "lab"],

    // Artifact sources are deleted with their lab.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        news.lab.toLowerCase() !== output.lab.toLowerCase() ||
        (news.name !== undefined &&
          news.name.toLowerCase() !== output.artifactSourceName.toLowerCase())
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const lab = output?.lab ?? olds?.lab;
      if (resourceGroup === undefined || lab === undefined) return undefined;
      const name =
        output?.artifactSourceName ??
        olds?.name ??
        (yield* createLabResourceName(id));
      const observed = yield* getSource(subscriptionId, resourceGroup, lab, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, lab, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, DEVTESTLAB_NAMESPACE);
      const { resourceGroup, lab } = news;
      const name =
        news.name ??
        output?.artifactSourceName ??
        (yield* createLabResourceName(id));
      const tags = yield* desiredTags(id, news.tags);
      const properties: devtestlabs.ArtifactSourcePropertiesInput = {
        displayName: news.displayName,
        uri: news.uri,
        sourceType: news.sourceType,
        folderPath: news.folderPath,
        armTemplateFolderPath: news.armTemplateFolderPath,
        branchRef: news.branchRef,
        status: news.status ?? "Enabled",
      };
      const token = tokenOf(news.securityToken);

      // Observe.
      let observed = yield* getSource(subscriptionId, resourceGroup, lab, name);

      // Ensure + sync: the PUT is a synchronous full upsert. The token is
      // write-only, so its change is detected against the previous props.
      if (
        observed === undefined ||
        diverges(properties, observed.properties) ||
        token !== tokenOf(olds?.securityToken) ||
        tagsDiffer(observed.tags, tags)
      ) {
        observed = yield* devtestlabs.ArtifactSourcesCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          labName: lab,
          name,
          location:
            observed?.location ??
            (yield* labLocation(subscriptionId, resourceGroup, lab)),
          tags,
          properties: { ...properties, securityToken: token },
        });
      }

      return toAttrs(resourceGroup, lab, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        devtestlabs.DeleteArtifactSource({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          labName: output.lab,
          name: output.artifactSourceName,
        }),
      );
      yield* waitUntilGone(
        `artifact source ${output.artifactSourceName}`,
        getSource(
          subscriptionId,
          output.resourceGroup,
          output.lab,
          output.artifactSourceName,
        ),
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
