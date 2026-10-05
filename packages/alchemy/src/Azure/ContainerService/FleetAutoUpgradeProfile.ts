import * as cs from "@distilled.cloud/azure/containerservice";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
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
  createChildName,
  isFleetOwned,
  sameName,
  whileFleetBusy,
} from "./Common.ts";

export type FleetUpgradeChannel = cs.UpgradeChannel_2;

export interface FleetAutoUpgradeProfileProps {
  /** Resource group of the fleet. Changing it replaces the profile. */
  resourceGroup: string;
  /** Name of the fleet. Changing it replaces the profile. */
  fleet: string;
  /**
   * Profile name: 1-50 lowercase letters, digits, and hyphens. If omitted,
   * a unique name is generated from the app, stage, and logical ID.
   * Changing it replaces the profile.
   */
  name?: string;
  /**
   * Which upgrades are triggered: `Stable` / `Rapid` Kubernetes releases,
   * `NodeImage` only, or `TargetKubernetesVersion`.
   */
  channel: FleetUpgradeChannel;
  /**
   * ARM resource ID of a `FleetUpdateStrategy` used by the triggered runs.
   * When omitted, all members are updated at once.
   */
  updateStrategyId?: string;
  /**
   * Node image selection of triggered runs: `Latest` image per cluster, or
   * `Consistent` images across clusters.
   * @default "Latest"
   */
  nodeImageSelection?: "Latest" | "Consistent";
  /**
   * Pause the profile (no update runs are triggered).
   * @default false
   */
  disabled?: boolean;
  /**
   * Target `major.minor` version (required for the
   * `TargetKubernetesVersion` channel).
   */
  targetKubernetesVersion?: string;
  /** Upgrade to long-term-support patch versions (with `TargetKubernetesVersion`). */
  longTermSupport?: boolean;
}

export interface FleetAutoUpgradeProfile extends Resource<
  "Azure.ContainerService.FleetAutoUpgradeProfile",
  FleetAutoUpgradeProfileProps,
  {
    /** Name of the profile. */
    autoUpgradeProfileName: string;
    /** ARM resource ID of the profile. */
    autoUpgradeProfileId: string;
    /** Name of the fleet. */
    fleet: string;
    /** Resource group of the fleet. */
    resourceGroup: string;
    /** Observed upgrade channel. */
    channel: string;
    /** Whether the profile is paused. */
    disabled: boolean;
  },
  never,
  Providers
> {}

/**
 * An auto-upgrade profile of an Azure Kubernetes Fleet Manager fleet: when
 * a new Kubernetes or node image release arrives on the channel, Fleet
 * Manager starts an update run across the members.
 *
 * Profiles cannot be tagged; ownership follows the fleet's Alchemy tags.
 *
 * @see https://learn.microsoft.com/azure/kubernetes-fleet/update-automation
 *
 * ### Automating Upgrades
 * **Example:** Stable channel through a staged strategy
 * ```typescript
 * yield* Azure.ContainerService.FleetAutoUpgradeProfile("stable", {
 *   resourceGroup: group.resourceGroupName,
 *   fleet: fleet.fleetName,
 *   channel: "Stable",
 *   updateStrategyId: strategy.updateStrategyId,
 * });
 * ```
 *
 * **Example:** Paused node-image profile
 * ```typescript
 * yield* Azure.ContainerService.FleetAutoUpgradeProfile("node-images", {
 *   resourceGroup: group.resourceGroupName,
 *   fleet: fleet.fleetName,
 *   channel: "NodeImage",
 *   disabled: true,
 * });
 * ```
 *
 * @resource
 */
export const FleetAutoUpgradeProfile = Resource<FleetAutoUpgradeProfile>(
  "Azure.ContainerService.FleetAutoUpgradeProfile",
);

type ObservedProfile = cs.GetAutoUpgradeProfileResponse;

const createProfileName = (id: string) => createChildName(id, 50);

const getProfile = (
  subscriptionId: string,
  resourceGroupName: string,
  fleetName: string,
  autoUpgradeProfileName: string,
) =>
  orUndefinedIfNotFound(
    cs.GetAutoUpgradeProfile({
      subscriptionId,
      resourceGroupName,
      fleetName,
      autoUpgradeProfileName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  fleet: string,
  name: string,
  profile: ObservedProfile,
): FleetAutoUpgradeProfile["Attributes"] => ({
  autoUpgradeProfileName: name,
  autoUpgradeProfileId: profile.id ?? "",
  fleet,
  resourceGroup,
  channel: profile.properties?.channel ?? "",
  disabled: profile.properties?.disabled ?? false,
});

const stateOf = (profile: ObservedProfile) =>
  profile.properties?.provisioningState;

const matches = (
  news: FleetAutoUpgradeProfileProps,
  observed: ObservedProfile["properties"],
) =>
  observed !== undefined &&
  observed.channel === news.channel &&
  sameName(observed.updateStrategyId ?? "", news.updateStrategyId ?? "") &&
  (observed.nodeImageSelection?.type ?? "Latest") ===
    (news.nodeImageSelection ?? "Latest") &&
  (observed.disabled ?? false) === (news.disabled ?? false) &&
  (observed.targetKubernetesVersion ?? "") ===
    (news.targetKubernetesVersion ?? "") &&
  (observed.longTermSupport ?? false) === (news.longTermSupport ?? false);

export const FleetAutoUpgradeProfileProvider = () =>
  Provider.succeed(FleetAutoUpgradeProfile, {
    stables: [
      "autoUpgradeProfileName",
      "autoUpgradeProfileId",
      "fleet",
      "resourceGroup",
    ],

    // Profiles live inside a fleet; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.fleet, output.fleet) ||
        (news.name !== undefined && news.name !== output.autoUpgradeProfileName)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const fleet = output?.fleet ?? olds?.fleet;
      if (resourceGroup === undefined || fleet === undefined) return undefined;
      const name =
        output?.autoUpgradeProfileName ??
        olds?.name ??
        (yield* createProfileName(id));
      const observed = yield* getProfile(
        subscriptionId,
        resourceGroup,
        fleet,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, fleet, name, observed);
      return (yield* isFleetOwned(subscriptionId, resourceGroup, fleet))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.ContainerService");
      const { resourceGroup, fleet } = news;
      const name =
        news.name ??
        output?.autoUpgradeProfileName ??
        (yield* createProfileName(id));
      const get = getProfile(subscriptionId, resourceGroup, fleet, name);
      const waitReady = waitForProvisioned(
        `fleet auto-upgrade profile ${fleet}/${name}`,
        get,
        stateOf,
        { interval: "3 seconds", times: 40 },
      );

      // Observe, then PUT the full profile only on drift.
      const observed = yield* get;
      if (observed === undefined || !matches(news, observed.properties)) {
        yield* cs
          .AutoUpgradeProfilesCreateOrUpdate({
            subscriptionId,
            resourceGroupName: resourceGroup,
            fleetName: fleet,
            autoUpgradeProfileName: name,
            properties: {
              channel: news.channel,
              updateStrategyId: news.updateStrategyId,
              nodeImageSelection: {
                type: news.nodeImageSelection ?? "Latest",
              },
              disabled: news.disabled ?? false,
              targetKubernetesVersion: news.targetKubernetesVersion,
              longTermSupport: news.longTermSupport,
            },
          })
          .pipe(Effect.retry(whileFleetBusy));
      }

      const fresh = yield* waitReady;
      return toAttrs(resourceGroup, fleet, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        cs
          .DeleteAutoUpgradeProfile({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            fleetName: output.fleet,
            autoUpgradeProfileName: output.autoUpgradeProfileName,
          })
          .pipe(Effect.retry(whileFleetBusy)),
      );
      yield* waitUntilGone(
        `fleet auto-upgrade profile ${output.fleet}/${output.autoUpgradeProfileName}`,
        getProfile(
          subscriptionId,
          output.resourceGroup,
          output.fleet,
          output.autoUpgradeProfileName,
        ),
      );
    }),
  });
