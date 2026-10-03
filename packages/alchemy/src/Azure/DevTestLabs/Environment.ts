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
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  createLabResourceName,
  DEVTESTLAB_NAMESPACE,
  labLocation,
} from "./Common.ts";

export interface EnvironmentProps {
  /** Resource group of the lab. Changing it replaces the environment. */
  resourceGroup: string;
  /** Name of the lab. Changing it replaces the environment. */
  lab: string;
  /** Name of the lab user that owns the environment. Changing it replaces the environment. */
  user: string;
  /**
   * Environment name (letters, digits, `-`, and `_`). If omitted, a unique
   * name is generated from the app, stage, and logical ID. Changing it
   * replaces the environment.
   */
  name?: string;
  /**
   * ARM ID of the ARM template in an artifact source, e.g.
   * `${artifactSource.artifactSourceId}/armtemplates/WebApp`. Changing it
   * replaces the environment.
   */
  armTemplateId: string;
  /** Template parameters. Changing them replaces the environment. */
  parameters?: { name: string; value: string }[];
  /** Display name of the template shown in the lab. */
  armTemplateDisplayName?: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Environment extends Resource<
  "Azure.DevTestLabs.Environment",
  EnvironmentProps,
  {
    /** Name of the environment. */
    environmentName: string;
    /** ARM resource ID of the environment. */
    environmentId: string;
    /** Resource group of the lab. */
    resourceGroup: string;
    /** Name of the lab. */
    lab: string;
    /** Name of the lab user that owns the environment. */
    user: string;
    /** ARM ID of the resource group the template was deployed into. */
    environmentResourceGroupId: string | undefined;
    /** Creator of the environment. */
    createdByUser: string | undefined;
    /** Unique immutable identifier (GUID). */
    uniqueIdentifier: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A DevTest Labs environment — an ARM template from a lab artifact source
 * deployed into its own resource group on behalf of a lab user. Deleting
 * the environment deletes that resource group.
 *
 * @see https://learn.microsoft.com/azure/devtest-labs/devtest-lab-create-environment-from-arm
 *
 * ### Deploying a Template
 * **Example:** Environment from a repository template
 * ```typescript
 * const env = yield* Azure.DevTestLabs.Environment("web", {
 *   resourceGroup: group.resourceGroupName,
 *   lab: lab.labName,
 *   user: user.userName,
 *   armTemplateId: `${source.artifactSourceId}/armtemplates/WebApp`,
 *   parameters: [{ name: "siteName", value: "my-site" }],
 * });
 * ```
 *
 * @resource
 */
export const Environment = Resource<Environment>(
  "Azure.DevTestLabs.Environment",
);

const getEnvironment = (
  subscriptionId: string,
  resourceGroupName: string,
  labName: string,
  userName: string,
  name: string,
) =>
  orUndefinedIfNotFound(
    devtestlabs.GetEnvironment({
      subscriptionId,
      resourceGroupName,
      labName,
      userName,
      name,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  lab: string,
  user: string,
  name: string,
  e: devtestlabs.GetEnvironmentResponse,
): Environment["Attributes"] => ({
  environmentName: name,
  environmentId: e.id ?? "",
  resourceGroup,
  lab,
  user,
  environmentResourceGroupId: e.properties?.resourceGroupId,
  createdByUser: e.properties?.createdByUser,
  uniqueIdentifier: e.properties?.uniqueIdentifier,
  tags: userTags(e.tags),
});

export const EnvironmentProvider = () =>
  Provider.succeed(Environment, {
    stables: ["environmentName", "environmentId", "resourceGroup", "lab", "user"],

    // Environments are deleted with their lab user.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        news.lab.toLowerCase() !== output.lab.toLowerCase() ||
        news.user.toLowerCase() !== output.user.toLowerCase() ||
        (news.name !== undefined &&
          news.name.toLowerCase() !== output.environmentName.toLowerCase()) ||
        news.armTemplateId.toLowerCase() !==
          (olds?.armTemplateId ?? news.armTemplateId).toLowerCase() ||
        JSON.stringify(news.parameters ?? []) !==
          JSON.stringify(olds?.parameters ?? news.parameters ?? [])
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const lab = output?.lab ?? olds?.lab;
      const user = output?.user ?? olds?.user;
      if (
        resourceGroup === undefined ||
        lab === undefined ||
        user === undefined
      ) {
        return undefined;
      }
      const name =
        output?.environmentName ??
        olds?.name ??
        (yield* createLabResourceName(id));
      const observed = yield* getEnvironment(
        subscriptionId,
        resourceGroup,
        lab,
        user,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, lab, user, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, DEVTESTLAB_NAMESPACE);
      const { resourceGroup, lab, user } = news;
      const name =
        news.name ??
        output?.environmentName ??
        (yield* createLabResourceName(id));
      const tags = yield* desiredTags(id, news.tags);
      const get = getEnvironment(subscriptionId, resourceGroup, lab, user, name);
      const wait = waitForProvisioned(
        `lab environment ${name}`,
        get,
        (e) => e.properties?.provisioningState,
        // Template deployments can take several minutes.
        { interval: "10 seconds", times: 60 },
      );

      // Observe.
      let observed = yield* get;
      if (observed !== undefined) observed = yield* wait;

      // Ensure + sync: the template is fixed at creation; the display name
      // and tags are re-sent with a full PUT.
      if (
        observed === undefined ||
        (news.armTemplateDisplayName !== undefined &&
          news.armTemplateDisplayName !==
            observed.properties?.armTemplateDisplayName) ||
        tagsDiffer(observed.tags, tags)
      ) {
        yield* devtestlabs.EnvironmentsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          labName: lab,
          userName: user,
          name,
          location:
            observed?.location ??
            (yield* labLocation(subscriptionId, resourceGroup, lab)),
          tags,
          properties: {
            deploymentProperties: {
              armTemplateId: news.armTemplateId,
              parameters: news.parameters ?? [],
            },
            armTemplateDisplayName:
              news.armTemplateDisplayName ??
              observed?.properties?.armTemplateDisplayName,
          },
        });
        observed = yield* wait;
      }

      return toAttrs(resourceGroup, lab, user, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        devtestlabs.DeleteEnvironment({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          labName: output.lab,
          userName: output.user,
          name: output.environmentName,
        }),
      );
      // Deleting an environment deletes its resource group: minutes.
      yield* waitUntilGone(
        `lab environment ${output.environmentName}`,
        getEnvironment(
          subscriptionId,
          output.resourceGroup,
          output.lab,
          output.user,
          output.environmentName,
        ),
        { interval: "10 seconds", times: 60 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
