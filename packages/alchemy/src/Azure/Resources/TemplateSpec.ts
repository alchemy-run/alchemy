import * as resources from "@distilled.cloud/azure/resources";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
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
import { sameJson } from "./Shared.ts";

export interface TemplateSpecProps {
  /** Resource group that holds the template spec. Changing it replaces the spec. */
  resourceGroup: string;
  /**
   * Name of the template spec. 1-90 characters of letters, digits, `-`,
   * `_`, `.`, and `()`. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the spec.
   */
  name?: string;
  /**
   * Azure location of the template spec. Changing it replaces the spec.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /** Description of the template spec. */
  description?: string;
  /** Display name of the template spec. */
  displayName?: string;
  /** Free-form metadata object. */
  metadata?: Record<string, unknown>;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface TemplateSpec extends Resource<
  "Azure.Resources.TemplateSpec",
  TemplateSpecProps,
  {
    /** Name of the template spec. */
    templateSpecName: string;
    /** ARM ID of the template spec. */
    templateSpecId: string;
    /** Resource group holding the spec. */
    resourceGroup: string;
    /** Location of the spec. Versions must use the same location. */
    location: string;
    /** Display name. */
    displayName: string | undefined;
    /** Description. */
    description: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure template spec — a versioned, shareable container for ARM
 * templates. Publish versions with `Azure.Resources.TemplateSpecVersion`
 * and deploy them with `Azure.Resources.Deployment`.
 *
 * Deleting a template spec deletes all of its versions.
 *
 * @see https://learn.microsoft.com/azure/azure-resource-manager/templates/template-specs
 *
 * ### Creating a Template Spec
 * **Example:** Template spec in a resource group
 * ```typescript
 * const spec = yield* Azure.Resources.TemplateSpec("network", {
 *   resourceGroup: group.resourceGroupName,
 *   displayName: "Network baseline",
 *   description: "VNet + NSG baseline",
 * });
 * ```
 *
 * ### Publishing a Version
 * **Example:** Version with an inline template
 * ```typescript
 * const version = yield* Azure.Resources.TemplateSpecVersion("network-v1", {
 *   resourceGroup: group.resourceGroupName,
 *   templateSpecName: spec.templateSpecName,
 *   name: "1.0.0",
 *   mainTemplate: {
 *     $schema: "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
 *     contentVersion: "1.0.0.0",
 *     resources: [],
 *   },
 * });
 * ```
 *
 * @resource
 */
export const TemplateSpec = Resource<TemplateSpec>(
  "Azure.Resources.TemplateSpec",
);

const specName = (id: string, name: string | undefined) =>
  name !== undefined
    ? Effect.succeed(name)
    : createPhysicalName({ id, maxLength: 90 });

const getTemplateSpec = (
  subscriptionId: string,
  resourceGroupName: string,
  templateSpecName: string,
) =>
  orUndefinedIfNotFound(
    resources.GetTemplateSpec({
      subscriptionId,
      resourceGroupName,
      templateSpecName,
    }),
  );

const toAttrs = (
  subscriptionId: string,
  resourceGroup: string,
  name: string,
  observed: resources.GetTemplateSpecResponse,
): TemplateSpec["Attributes"] => ({
  templateSpecName: name,
  templateSpecId:
    observed.id ??
    `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.Resources/templateSpecs/${name}`,
  resourceGroup,
  location: observed.location,
  displayName: observed.properties?.displayName,
  description: observed.properties?.description,
  tags: userTags(observed.tags),
});

export const TemplateSpecProvider = () =>
  Provider.succeed(TemplateSpec, {
    stables: ["templateSpecName", "templateSpecId", "resourceGroup", "location"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* resources
        .ListTemplateSpecBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListTemplateSpecBySubscription", page),
          ),
        );
      return (page.value ?? []).flatMap((spec) => {
        const group = resourceGroupOf(spec.id);
        return spec.name !== undefined &&
          group !== undefined &&
          hasAnyAlchemyTag(spec.tags)
          ? [toAttrs(subscriptionId, group, spec.name, spec)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (output === undefined) return undefined;
      if (!isResolved(news.resourceGroup)) return { action: "replace" } as const;
      if (!isResolved(news)) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        (news.name !== undefined &&
          news.name.toLowerCase() !== output.templateSpecName.toLowerCase()) ||
        (news.location !== undefined &&
          news.location.toLowerCase() !== output.location.toLowerCase())
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const group = output?.resourceGroup ?? olds?.resourceGroup;
      if (group === undefined) return undefined;
      const name =
        output?.templateSpecName ?? (yield* specName(id, olds?.name));
      const observed = yield* getTemplateSpec(subscriptionId, group, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(subscriptionId, group, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.Resources");
      const group = news.resourceGroup;
      const name = output?.templateSpecName ?? (yield* specName(id, news.name));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);

      // Observe.
      const observed = yield* getTemplateSpec(subscriptionId, group, name);
      const current = observed?.properties;

      // Ensure + sync the properties with one idempotent PUT (it keeps
      // existing versions), skipped when they already match.
      if (
        observed === undefined ||
        current?.displayName !== news.displayName ||
        current?.description !== news.description ||
        !sameJson(current?.metadata ?? {}, news.metadata ?? {})
      ) {
        yield* resources.TemplateSpecsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: group,
          templateSpecName: name,
          location: observed?.location ?? location,
          properties: {
            displayName: news.displayName,
            description: news.description,
            metadata: news.metadata,
          },
          tags,
        });
      } else if (tagsDiffer(observed.tags, tags)) {
        // Sync tags against the observed cloud tags.
        yield* resources.UpdateTemplateSpec({
          subscriptionId,
          resourceGroupName: group,
          templateSpecName: name,
          tags,
        });
      }

      const fresh = yield* waitForProvisioned(
        `template spec ${name}`,
        getTemplateSpec(subscriptionId, group, name),
        () => undefined,
        { interval: "2 seconds", times: 15 },
      );
      return toAttrs(subscriptionId, group, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        resources.DeleteTemplateSpec({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          templateSpecName: output.templateSpecName,
        }),
      );
      yield* waitUntilGone(
        `template spec ${output.templateSpecName}`,
        getTemplateSpec(
          subscriptionId,
          output.resourceGroup,
          output.templateSpecName,
        ),
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
