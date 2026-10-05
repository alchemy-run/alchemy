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
  tagsDiffer,
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

export interface FleetMemberProps {
  /** Resource group of the fleet. Changing it replaces the member. */
  resourceGroup: string;
  /** Name of the fleet. Changing it replaces the member. */
  fleet: string;
  /**
   * Member name: 1-50 lowercase letters, digits, and hyphens. If omitted, a
   * unique name is generated from the app, stage, and logical ID. Changing
   * it replaces the member.
   */
  name?: string;
  /**
   * ARM resource ID of the AKS cluster to join. Changing it replaces the
   * member.
   */
  clusterResourceId: string;
  /**
   * Update group of the member, referenced by update strategies.
   * @default "default"
   */
  group?: string;
  /** Labels used to select members (e.g. for placement). */
  labels?: Record<string, string>;
}

export interface FleetMember extends Resource<
  "Azure.ContainerService.FleetMember",
  FleetMemberProps,
  {
    /** Name of the member. */
    memberName: string;
    /** ARM resource ID of the member. */
    memberId: string;
    /** Name of the fleet. */
    fleet: string;
    /** Resource group of the fleet. */
    resourceGroup: string;
    /** ARM resource ID of the member cluster. */
    clusterResourceId: string;
    /** Update group of the member. */
    group: string | undefined;
    /** Labels of the member. */
    labels: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * Joins an AKS managed cluster to an Azure Kubernetes Fleet Manager fleet.
 *
 * Members cannot be tagged; ownership follows the fleet's Alchemy tags.
 *
 * @see https://learn.microsoft.com/azure/kubernetes-fleet/concepts-fleet
 *
 * ### Joining Clusters
 * **Example:** Join a cluster to a fleet
 * ```typescript
 * yield* Azure.ContainerService.FleetMember("prod-east", {
 *   resourceGroup: group.resourceGroupName,
 *   fleet: fleet.fleetName,
 *   clusterResourceId: cluster.clusterId,
 *   group: "production",
 *   labels: { region: "eastus" },
 * });
 * ```
 *
 * @resource
 */
export const FleetMember = Resource<FleetMember>(
  "Azure.ContainerService.FleetMember",
);

type ObservedMember = cs.GetFleetMemberResponse;

const createMemberName = (id: string) => createChildName(id, 50);

const getMember = (
  subscriptionId: string,
  resourceGroupName: string,
  fleetName: string,
  fleetMemberName: string,
) =>
  orUndefinedIfNotFound(
    cs.GetFleetMember({
      subscriptionId,
      resourceGroupName,
      fleetName,
      fleetMemberName,
    }),
  );

const plainRecord = (
  record: Record<string, string | undefined> | undefined,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(record ?? {}).flatMap(([k, v]) =>
      v === undefined ? [] : [[k, v]],
    ),
  );

const toAttrs = (
  resourceGroup: string,
  fleet: string,
  name: string,
  member: ObservedMember,
): FleetMember["Attributes"] => ({
  memberName: name,
  memberId: member.id ?? "",
  fleet,
  resourceGroup,
  clusterResourceId: member.properties?.clusterResourceId ?? "",
  group: member.properties?.group,
  labels: plainRecord(member.properties?.labels),
});

const stateOf = (member: ObservedMember) =>
  member.properties?.provisioningState;

const isPending = (state: string | undefined) =>
  state !== undefined &&
  state !== "Succeeded" &&
  state !== "Failed" &&
  state !== "Canceled";

export const FleetMemberProvider = () =>
  Provider.succeed(FleetMember, {
    stables: ["memberName", "memberId", "fleet", "resourceGroup"],

    // Members live inside a fleet; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.fleet, output.fleet) ||
        (news.name !== undefined && news.name !== output.memberName) ||
        !sameName(news.clusterResourceId, output.clusterResourceId)
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
        output?.memberName ?? olds?.name ?? (yield* createMemberName(id));
      const observed = yield* getMember(
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
        news.name ?? output?.memberName ?? (yield* createMemberName(id));
      const group = news.group ?? "default";
      const labels = news.labels ?? {};
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        fleetName: fleet,
        fleetMemberName: name,
      };
      const get = getMember(subscriptionId, resourceGroup, fleet, name);
      // Joining installs the fleet agent on the cluster (1-3 minutes).
      const waitReady = waitForProvisioned(
        `fleet member ${fleet}/${name}`,
        get,
        stateOf,
        { interval: "10 seconds", times: 60 },
      );

      // Observe.
      let observed = yield* get;
      if (observed !== undefined && isPending(stateOf(observed))) {
        observed = yield* waitReady;
      }

      // Ensure.
      if (observed === undefined) {
        yield* cs
          .CreateFleetMember({
            ...where,
            properties: {
              clusterResourceId: news.clusterResourceId,
              group,
              labels,
            },
          })
          .pipe(Effect.retry(whileFleetBusy));
        observed = yield* waitReady;
      }

      // Sync group and labels via PATCH.
      if (
        (observed.properties?.group ?? "default") !== group ||
        tagsDiffer(observed.properties?.labels, labels)
      ) {
        yield* cs
          .UpdateFleetMember({ ...where, properties: { group, labels } })
          .pipe(Effect.retry(whileFleetBusy));
        observed = yield* waitReady;
      }

      return toAttrs(resourceGroup, fleet, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        cs
          .DeleteFleetMember({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            fleetName: output.fleet,
            fleetMemberName: output.memberName,
          })
          .pipe(Effect.retry(whileFleetBusy)),
      );
      yield* waitUntilGone(
        `fleet member ${output.fleet}/${output.memberName}`,
        getMember(
          subscriptionId,
          output.resourceGroup,
          output.fleet,
          output.memberName,
        ),
        { interval: "10 seconds", times: 60 },
      );
    }),
  });
