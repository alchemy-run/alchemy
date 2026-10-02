import * as devcenter from "@distilled.cloud/azure/devcenter";
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
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { createDevCenterName, sameArm } from "./Common.ts";

export interface EnvironmentTypeProps {
  /** Resource group of the dev center. Changing it replaces the environment type. */
  resourceGroup: string;
  /** Name of the dev center. Changing it replaces the environment type. */
  devCenter: string;
  /**
   * Environment type name, e.g. `dev`, `test`, or `prod`: 3-63 letters,
   * digits, hyphens, underscores, and periods. Projects enable an
   * environment type by creating a `ProjectEnvironmentType` with the same
   * name. If omitted, a unique name is generated from the app, stage, and
   * logical ID. Changing it replaces the environment type.
   */
  name?: string;
  /** Display name of the environment type. */
  displayName?: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface EnvironmentType extends Resource<
  "Azure.DevCenter.EnvironmentType",
  EnvironmentTypeProps,
  {
    /** Name of the environment type. */
    environmentTypeName: string;
    /** ARM resource ID of the environment type. */
    environmentTypeId: string;
    /** Name of the dev center. */
    devCenter: string;
    /** Resource group of the dev center. */
    resourceGroup: string;
    /** Display name of the environment type. */
    displayName: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A dev center environment type — a named deployment stage (such as
 * `dev`, `test`, or `prod`) for Azure Deployment Environments. Projects
 * opt in to an environment type with a `ProjectEnvironmentType` of the
 * same name, which decides the target subscription and role assignments.
 *
 * @see https://learn.microsoft.com/azure/deployment-environments/how-to-configure-devcenter-environment-types
 *
 * ### Creating an Environment Type
 * **Example:** A `dev` environment type
 * ```typescript
 * const dev = yield* Azure.DevCenter.EnvironmentType("dev", {
 *   resourceGroup: group.resourceGroupName,
 *   devCenter: center.devCenterName,
 *   name: "dev",
 *   displayName: "Development",
 * });
 * ```
 *
 * @resource
 */
export const EnvironmentType = Resource<EnvironmentType>(
  "Azure.DevCenter.EnvironmentType",
);

type ObservedEnvironmentType = devcenter.GetEnvironmentTypeResponse;

const getEnvironmentType = (
  subscriptionId: string,
  resourceGroupName: string,
  devCenterName: string,
  environmentTypeName: string,
) =>
  orUndefinedIfNotFound(
    devcenter.GetEnvironmentType({
      subscriptionId,
      resourceGroupName,
      devCenterName,
      environmentTypeName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  devCenter: string,
  name: string,
  observed: ObservedEnvironmentType,
): EnvironmentType["Attributes"] => ({
  environmentTypeName: name,
  environmentTypeId: observed.id ?? "",
  devCenter,
  resourceGroup,
  displayName: observed.properties?.displayName,
  tags: userTags(observed.tags),
});

export const EnvironmentTypeProvider = () =>
  Provider.succeed(EnvironmentType, {
    stables: [
      "environmentTypeName",
      "environmentTypeId",
      "devCenter",
      "resourceGroup",
    ],

    // Environment types live inside a dev center; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameArm(news.resourceGroup, output.resourceGroup) ||
        !sameArm(news.devCenter, output.devCenter) ||
        (news.name !== undefined &&
          !sameArm(news.name, output.environmentTypeName))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const devCenter = output?.devCenter ?? olds?.devCenter;
      if (resourceGroup === undefined || devCenter === undefined) {
        return undefined;
      }
      const name =
        output?.environmentTypeName ??
        olds?.name ??
        (yield* createDevCenterName(id));
      const observed = yield* getEnvironmentType(
        subscriptionId,
        resourceGroup,
        devCenter,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, devCenter, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.DevCenter");
      const { resourceGroup, devCenter } = news;
      const name =
        news.name ??
        output?.environmentTypeName ??
        (yield* createDevCenterName(id));
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        devCenterName: devCenter,
        environmentTypeName: name,
      };
      const label = `environment type ${name}`;
      const get = getEnvironmentType(
        subscriptionId,
        resourceGroup,
        devCenter,
        name,
      );
      const stateOf = (observed: ObservedEnvironmentType) =>
        observed.properties?.provisioningState;

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* devcenter.EnvironmentTypesCreateOrUpdate({
          ...where,
          tags,
          properties: { displayName: news.displayName },
        });
      }
      observed = yield* waitForProvisioned(label, get, stateOf, {
        interval: "3 seconds",
        times: 40,
      });

      // Sync the display name and tags against observed state.
      const displayNameChanged =
        news.displayName !== undefined &&
        observed.properties?.displayName !== news.displayName;
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (displayNameChanged || tagsChanged) {
        yield* devcenter.UpdateEnvironmentType({
          ...where,
          tags: tagsChanged ? tags : undefined,
          properties: displayNameChanged
            ? { displayName: news.displayName }
            : undefined,
        });
        observed = yield* waitForProvisioned(label, get, stateOf, {
          interval: "3 seconds",
          times: 40,
        });
      }

      return toAttrs(resourceGroup, devCenter, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        devcenter.DeleteEnvironmentType({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          devCenterName: output.devCenter,
          environmentTypeName: output.environmentTypeName,
        }),
      );
      yield* waitUntilGone(
        `environment type ${output.environmentTypeName}`,
        getEnvironmentType(
          subscriptionId,
          output.resourceGroup,
          output.devCenter,
          output.environmentTypeName,
        ),
      );
    }),

    nuke: {
      dependsOn: ["Azure.DevCenter.DevCenter", "Azure.Resources.ResourceGroup"],
    },
  });
