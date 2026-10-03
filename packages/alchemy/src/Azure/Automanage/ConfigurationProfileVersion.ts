import * as automanage from "@distilled.cloud/azure/automanage";
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
  resourceGroupOf,
  tagsDiffer,
  userTags,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  configurationDiffers,
  configurationOf,
  createProfileName,
} from "./Common.ts";

export interface ConfigurationProfileVersionProps {
  /**
   * Resource group of the parent configuration profile. Changing it
   * replaces the version.
   */
  resourceGroup: string;
  /**
   * Name of the parent configuration profile. Changing it replaces the
   * version.
   */
  configurationProfile: string;
  /**
   * Version name, e.g. `1.0`. If omitted, a unique name is generated from
   * the app, stage, and logical ID. Changing it replaces the version.
   */
  name?: string;
  /**
   * Azure location of the version, normally the location of the parent
   * profile. Changing it replaces the version.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Configuration dictionary snapshot of this version. Versions are
   * immutable snapshots: changing it replaces the version.
   */
  configuration: Record<string, unknown>;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface ConfigurationProfileVersion extends Resource<
  "Azure.Automanage.ConfigurationProfileVersion",
  ConfigurationProfileVersionProps,
  {
    /** Version name. */
    versionName: string;
    /** Name of the parent configuration profile. */
    configurationProfileName: string;
    /** Resource group that holds the parent profile. */
    resourceGroup: string;
    /** ARM resource ID of the version. */
    configurationProfileVersionId: string;
    /** Location of the version. */
    location: string;
    /** Observed configuration dictionary. */
    configuration: Record<string, unknown>;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A version of an Azure Automanage configuration profile — an immutable,
 * named snapshot of a profile's configuration dictionary.
 *
 * @see https://learn.microsoft.com/rest/api/automanage/configuration-profiles-versions
 *
 * ### Creating a Version
 * **Example:** Snapshot a profile configuration as version 1.0
 * ```typescript
 * const profile = yield* Azure.Automanage.ConfigurationProfile("baseline", {
 *   resourceGroup: group.resourceGroupName,
 *   configuration: { "AzureSecurityBaseline/Enable": true },
 * });
 * const v1 = yield* Azure.Automanage.ConfigurationProfileVersion("v1", {
 *   resourceGroup: group.resourceGroupName,
 *   configurationProfile: profile.configurationProfileName,
 *   name: "1.0",
 *   configuration: { "AzureSecurityBaseline/Enable": true },
 * });
 * ```
 *
 * @resource
 */
export const ConfigurationProfileVersion =
  Resource<ConfigurationProfileVersion>(
    "Azure.Automanage.ConfigurationProfileVersion",
  );

type ObservedVersion = automanage.GetConfigurationProfilesVersionResponse;

const getVersion = (
  subscriptionId: string,
  resourceGroupName: string,
  configurationProfileName: string,
  versionName: string,
) =>
  orUndefinedIfNotFound(
    automanage.GetConfigurationProfilesVersion({
      subscriptionId,
      resourceGroupName,
      configurationProfileName,
      versionName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  profile: string,
  name: string,
  version: ObservedVersion,
): ConfigurationProfileVersion["Attributes"] => ({
  versionName: name,
  configurationProfileName: profile,
  resourceGroup,
  configurationProfileVersionId: version.id ?? "",
  location: version.location,
  configuration: configurationOf(version.properties?.configuration),
  tags: userTags(version.tags),
});

const sameLocation = (a: string, b: string) =>
  a.replaceAll(" ", "").toLowerCase() === b.replaceAll(" ", "").toLowerCase();

export const ConfigurationProfileVersionProvider = () =>
  Provider.succeed(ConfigurationProfileVersion, {
    stables: [
      "versionName",
      "configurationProfileName",
      "resourceGroup",
      "configurationProfileVersionId",
      "location",
      "configuration",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const profiles = yield* automanage.ListConfigurationProfileBySubscription(
        { subscriptionId },
      );
      const results: ConfigurationProfileVersion["Attributes"][] = [];
      for (const profile of profiles.value ?? []) {
        const group = resourceGroupOf(profile.id);
        if (group === undefined || profile.name === undefined) continue;
        const versions = yield* orUndefinedIfNotFound(
          automanage.ListConfigurationProfilesVersionChildResources({
            subscriptionId,
            resourceGroupName: group,
            configurationProfileName: profile.name,
          }),
        );
        for (const version of versions?.value ?? []) {
          // List results name versions `<profile>/<version>`.
          const name = version.name?.split("/").pop();
          if (hasAnyAlchemyTag(version.tags) && name !== undefined) {
            results.push(toAttrs(group, profile.name, name, version));
          }
        }
      }
      return results;
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        news.configurationProfile.toLowerCase() !==
          output.configurationProfileName.toLowerCase() ||
        (news.name !== undefined &&
          news.name.toLowerCase() !== output.versionName.toLowerCase()) ||
        (news.location !== undefined &&
          !sameLocation(news.location, output.location)) ||
        configurationDiffers(output.configuration, news.configuration)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const profile =
        output?.configurationProfileName ?? olds?.configurationProfile;
      if (resourceGroup === undefined || profile === undefined) {
        return undefined;
      }
      const name =
        output?.versionName ?? olds?.name ?? (yield* createProfileName(id));
      const observed = yield* getVersion(
        subscriptionId,
        resourceGroup,
        profile,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, profile, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.Automanage");
      const resourceGroup = news.resourceGroup;
      const profile = news.configurationProfile;
      const name =
        news.name ?? output?.versionName ?? (yield* createProfileName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);

      // Observe.
      let observed = yield* getVersion(
        subscriptionId,
        resourceGroup,
        profile,
        name,
      );

      // Ensure + sync tags: the PUT is a synchronous upsert and tags are
      // the only mutable aspect (configuration changes replace).
      if (observed === undefined || tagsDiffer(observed.tags, tags)) {
        observed =
          yield* automanage.ConfigurationProfilesVersionsCreateOrUpdate({
            subscriptionId,
            resourceGroupName: resourceGroup,
            configurationProfileName: profile,
            versionName: name,
            location: observed?.location ?? location,
            tags,
            properties: {
              configuration:
                observed?.properties?.configuration ?? news.configuration,
            },
          });
      }

      return toAttrs(resourceGroup, profile, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        automanage.DeleteConfigurationProfilesVersion({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          configurationProfileName: output.configurationProfileName,
          versionName: output.versionName,
        }),
      );
      yield* waitUntilGone(
        `Automanage configuration profile version ${output.configurationProfileName}/${output.versionName}`,
        getVersion(
          subscriptionId,
          output.resourceGroup,
          output.configurationProfileName,
          output.versionName,
        ),
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.Resources.ResourceGroup",
        "Azure.Automanage.ConfigurationProfile",
      ],
    },
  });
