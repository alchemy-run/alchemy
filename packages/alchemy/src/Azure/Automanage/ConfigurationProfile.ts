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

export interface ConfigurationProfileProps {
  /**
   * Resource group the profile is created in. Changing it replaces the
   * profile.
   */
  resourceGroup: string;
  /**
   * Name of the profile. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the profile.
   */
  name?: string;
  /**
   * Azure location of the profile. Changing it replaces the profile.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Automanage configuration dictionary, keyed by `<Service>/<Setting>`,
   * e.g. `{ "Antimalware/Enable": true, "AzureSecurityBaseline/Enable": true,
   * "Backup/Enable": false }`. Updated in place.
   */
  configuration: Record<string, unknown>;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface ConfigurationProfile extends Resource<
  "Azure.Automanage.ConfigurationProfile",
  ConfigurationProfileProps,
  {
    /** Name of the profile. */
    configurationProfileName: string;
    /** Resource group that holds the profile. */
    resourceGroup: string;
    /**
     * ARM resource ID of the profile. Pass it as the `configurationProfile`
     * of a `ConfigurationProfileAssignment`.
     */
    configurationProfileId: string;
    /** Location of the profile. */
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
 * An Azure Automanage configuration profile — a custom set of Automanage
 * Machine Best Practices services (antimalware, security baseline, backup,
 * Log Analytics, ...) that can be assigned to virtual machines.
 *
 * Automanage Machine Best Practices retires on 2027-09-30; Microsoft
 * recommends Azure Policy / Machine Configuration for new deployments.
 *
 * @see https://learn.microsoft.com/azure/automanage/virtual-machines-custom-profile
 *
 * ### Creating a Profile
 * **Example:** Profile enabling the security baseline
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("app");
 * const profile = yield* Azure.Automanage.ConfigurationProfile("baseline", {
 *   resourceGroup: group.resourceGroupName,
 *   configuration: {
 *     "AzureSecurityBaseline/Enable": true,
 *     "Antimalware/Enable": true,
 *   },
 * });
 * ```
 *
 * ### Assigning the Profile
 * **Example:** Attach the profile to a virtual machine
 * ```typescript
 * yield* Azure.Automanage.ConfigurationProfileAssignment("vm-profile", {
 *   resourceGroup: group.resourceGroupName,
 *   virtualMachine: vm.virtualMachineName,
 *   configurationProfile: profile.configurationProfileId,
 * });
 * ```
 *
 * @resource
 */
export const ConfigurationProfile = Resource<ConfigurationProfile>(
  "Azure.Automanage.ConfigurationProfile",
);

type ObservedProfile = automanage.GetConfigurationProfileResponse;

const getProfile = (
  subscriptionId: string,
  resourceGroupName: string,
  configurationProfileName: string,
) =>
  orUndefinedIfNotFound(
    automanage.GetConfigurationProfile({
      subscriptionId,
      resourceGroupName,
      configurationProfileName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  profile: ObservedProfile,
): ConfigurationProfile["Attributes"] => ({
  configurationProfileName: name,
  resourceGroup,
  configurationProfileId: profile.id ?? "",
  location: profile.location,
  configuration: configurationOf(profile.properties?.configuration),
  tags: userTags(profile.tags),
});

export const ConfigurationProfileProvider = () =>
  Provider.succeed(ConfigurationProfile, {
    stables: [
      "configurationProfileName",
      "resourceGroup",
      "configurationProfileId",
      "location",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* automanage.ListConfigurationProfileBySubscription({
        subscriptionId,
      });
      return (page.value ?? []).flatMap((profile) => {
        const group = resourceGroupOf(profile.id);
        return hasAnyAlchemyTag(profile.tags) &&
          group !== undefined &&
          profile.name !== undefined
          ? [toAttrs(group, profile.name, profile)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        (news.name !== undefined &&
          news.name.toLowerCase() !==
            output.configurationProfileName.toLowerCase()) ||
        (news.location !== undefined &&
          news.location.replaceAll(" ", "").toLowerCase() !==
            output.location.replaceAll(" ", "").toLowerCase())
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
        output?.configurationProfileName ??
        olds?.name ??
        (yield* createProfileName(id));
      const observed = yield* getProfile(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.Automanage");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ??
        output?.configurationProfileName ??
        (yield* createProfileName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);

      // Observe.
      let observed = yield* getProfile(subscriptionId, resourceGroup, name);

      // Ensure + sync configuration: PUT is a synchronous full upsert.
      if (
        observed === undefined ||
        configurationDiffers(
          observed.properties?.configuration,
          news.configuration,
        )
      ) {
        observed = yield* automanage.ConfigurationProfilesCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          configurationProfileName: name,
          location: observed?.location ?? location,
          tags,
          properties: { configuration: news.configuration },
        });
      } else if (tagsDiffer(observed.tags, tags)) {
        // Sync tags only.
        observed = yield* automanage.UpdateConfigurationProfile({
          subscriptionId,
          resourceGroupName: resourceGroup,
          configurationProfileName: name,
          tags,
        });
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        automanage.DeleteConfigurationProfile({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          configurationProfileName: output.configurationProfileName,
        }),
      );
      yield* waitUntilGone(
        `Automanage configuration profile ${output.configurationProfileName}`,
        getProfile(
          subscriptionId,
          output.resourceGroup,
          output.configurationProfileName,
        ),
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
