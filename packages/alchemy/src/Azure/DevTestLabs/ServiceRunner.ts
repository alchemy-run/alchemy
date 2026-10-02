import * as devtestlabs from "@distilled.cloud/azure/devtestlabs";
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
  labLocation,
} from "./Common.ts";

export interface ServiceRunnerProps {
  /** Resource group of the lab. Changing it replaces the runner. */
  resourceGroup: string;
  /** Name of the lab. Changing it replaces the runner. */
  lab: string;
  /**
   * Runner name. If omitted, a unique name is generated from the app,
   * stage, and logical ID. Changing it replaces the runner.
   */
  name?: string;
  /**
   * ARM ID of the user-assigned identity the lab runs as, e.g.
   * `UserAssignedIdentity.identityId`. It must be in the lab's region and
   * subscription; a lab supports one. Changing it replaces the runner.
   */
  identityId: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface ServiceRunner extends Resource<
  "Azure.DevTestLabs.ServiceRunner",
  ServiceRunnerProps,
  {
    /** Name of the runner. */
    serviceRunnerName: string;
    /** ARM resource ID of the runner. */
    serviceRunnerId: string;
    /** Resource group of the lab. */
    resourceGroup: string;
    /** Name of the lab. */
    lab: string;
    /** ARM ID of the user-assigned identity. */
    identityId: string;
    /** Kind of managed identity. */
    identityType: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A DevTest Labs service runner — the managed identity a lab uses to
 * deploy environments and apply artifacts on users' behalf.
 *
 * @see https://learn.microsoft.com/azure/devtest-labs/use-managed-identities-environments
 *
 * ### Lab Identity
 * **Example:** Run lab services as a user-assigned identity
 * ```typescript
 * const identity = yield* Azure.ManagedIdentity.UserAssignedIdentity("lab", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * const runner = yield* Azure.DevTestLabs.ServiceRunner("runner", {
 *   resourceGroup: group.resourceGroupName,
 *   lab: lab.labName,
 *   identityId: identity.identityId,
 * });
 * ```
 *
 * @resource
 */
export const ServiceRunner = Resource<ServiceRunner>(
  "Azure.DevTestLabs.ServiceRunner",
);

const getRunner = (
  subscriptionId: string,
  resourceGroupName: string,
  labName: string,
  name: string,
) =>
  orUndefinedIfNotFound(
    devtestlabs.GetServiceRunner({
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
  r: devtestlabs.GetServiceRunnerResponse,
): ServiceRunner["Attributes"] => ({
  serviceRunnerName: name,
  serviceRunnerId: r.id ?? "",
  resourceGroup,
  lab,
  identityId: Object.keys(r.identity?.userAssignedIdentities ?? {})[0] ?? "",
  identityType: r.identity?.type,
  tags: userTags(r.tags),
});

export const ServiceRunnerProvider = () =>
  Provider.succeed(ServiceRunner, {
    stables: ["serviceRunnerName", "serviceRunnerId", "resourceGroup", "lab"],

    // Service runners are deleted with their lab.
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
          news.name.toLowerCase() !== output.serviceRunnerName.toLowerCase()) ||
        news.identityId.toLowerCase() !== output.identityId.toLowerCase()
      ) {
        // A lab holds one user-assigned identity: remove the old runner first.
        return { action: "replace", deleteFirst: true } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const lab = output?.lab ?? olds?.lab;
      if (resourceGroup === undefined || lab === undefined) return undefined;
      const name =
        output?.serviceRunnerName ??
        olds?.name ??
        (yield* createLabResourceName(id));
      const observed = yield* getRunner(subscriptionId, resourceGroup, lab, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, lab, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, DEVTESTLAB_NAMESPACE);
      const { resourceGroup, lab } = news;
      const name =
        news.name ??
        output?.serviceRunnerName ??
        (yield* createLabResourceName(id));
      const tags = yield* desiredTags(id, news.tags);
      const identity: devtestlabs.IdentityProperties = {
        type: "UserAssigned",
        userAssignedIdentities: { [news.identityId]: {} },
      };

      // Observe.
      let observed = yield* getRunner(subscriptionId, resourceGroup, lab, name);

      // Ensure + sync tags: the PUT is a synchronous full upsert and the
      // identity is fixed for the runner's life.
      if (observed === undefined || tagsDiffer(observed.tags, tags)) {
        observed = yield* devtestlabs.ServiceRunnersCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          labName: lab,
          name,
          location:
            observed?.location ??
            (yield* labLocation(subscriptionId, resourceGroup, lab)),
          tags,
          identity,
        });
      }

      return toAttrs(resourceGroup, lab, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        devtestlabs.DeleteServiceRunner({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          labName: output.lab,
          name: output.serviceRunnerName,
        }),
      );
      yield* waitUntilGone(
        `service runner ${output.serviceRunnerName}`,
        getRunner(
          subscriptionId,
          output.resourceGroup,
          output.lab,
          output.serviceRunnerName,
        ),
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
