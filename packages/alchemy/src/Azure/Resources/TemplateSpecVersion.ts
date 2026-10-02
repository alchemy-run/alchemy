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
import { sameJson } from "./Shared.ts";

/** A linked template referenced from the main template by relative path. */
export interface LinkedTemplate {
  /** Relative path used in `templateLink.relativePath`. */
  path: string;
  /** The linked ARM template. */
  template: Record<string, unknown>;
}

export interface TemplateSpecVersionProps {
  /** Resource group of the parent template spec. Changing it replaces the version. */
  resourceGroup: string;
  /** Name of the parent template spec. Changing it replaces the version. */
  templateSpecName: string;
  /**
   * Version label, e.g. `1.0.0`. At most 90 characters of letters, digits,
   * `-`, `_`, `.`, and `()`. If omitted, a unique label is generated from
   * the app, stage, and logical ID. Changing it replaces the version.
   */
  name?: string;
  /**
   * Location of the version; must equal the parent spec's location.
   * Changing it replaces the version.
   * @default the parent template spec's location
   */
  location?: string;
  /** The ARM template (JSON) published by this version. */
  mainTemplate: Record<string, unknown>;
  /** Templates the main template links to by relative path. */
  linkedTemplates?: LinkedTemplate[];
  /** Azure portal UI form definition for deploying the version. */
  uiFormDefinition?: Record<string, unknown>;
  /** Description of the version. */
  description?: string;
  /** Free-form metadata object. */
  metadata?: Record<string, unknown>;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface TemplateSpecVersion extends Resource<
  "Azure.Resources.TemplateSpecVersion",
  TemplateSpecVersionProps,
  {
    /** Version label. */
    version: string;
    /**
     * ARM ID of the version. Pass it to `Deployment.templateLink.id` to
     * deploy the version.
     */
    templateSpecVersionId: string;
    /** Name of the parent template spec. */
    templateSpecName: string;
    /** Resource group of the parent template spec. */
    resourceGroup: string;
    /** Location of the version. */
    location: string;
    /** Description. */
    description: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A version of an Azure template spec — an immutable-by-convention ARM
 * template published under a version label, deployable with
 * `Azure.Resources.Deployment` via `templateLink.id`.
 *
 * Changing `mainTemplate` updates the version in place; publish a new
 * version (a new `name`) to keep the old one.
 *
 * @see https://learn.microsoft.com/azure/azure-resource-manager/templates/template-specs
 *
 * ### Publishing a Version
 * **Example:** Version with an inline template
 * ```typescript
 * const spec = yield* Azure.Resources.TemplateSpec("app", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * const v1 = yield* Azure.Resources.TemplateSpecVersion("app-v1", {
 *   resourceGroup: group.resourceGroupName,
 *   templateSpecName: spec.templateSpecName,
 *   name: "1.0.0",
 *   mainTemplate: {
 *     $schema: "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#",
 *     contentVersion: "1.0.0.0",
 *     resources: [],
 *     outputs: { greeting: { type: "string", value: "hello" } },
 *   },
 * });
 * ```
 *
 * ### Deploying a Version
 * **Example:** Deploy the version into a resource group
 * ```typescript
 * yield* Azure.Resources.Deployment("app", {
 *   resourceGroup: group.resourceGroupName,
 *   templateLink: { id: v1.templateSpecVersionId },
 * });
 * ```
 *
 * @resource
 */
export const TemplateSpecVersion = Resource<TemplateSpecVersion>(
  "Azure.Resources.TemplateSpecVersion",
);

const versionName = (id: string, name: string | undefined) =>
  name !== undefined
    ? Effect.succeed(name)
    : createPhysicalName({ id, maxLength: 90 });

const getVersion = (
  subscriptionId: string,
  resourceGroupName: string,
  templateSpecName: string,
  templateSpecVersion: string,
) =>
  orUndefinedIfNotFound(
    resources.GetTemplateSpecVersion({
      subscriptionId,
      resourceGroupName,
      templateSpecName,
      templateSpecVersion,
    }),
  );

const toAttrs = (
  subscriptionId: string,
  resourceGroup: string,
  templateSpecName: string,
  name: string,
  observed: resources.GetTemplateSpecVersionResponse,
): TemplateSpecVersion["Attributes"] => ({
  version: name,
  templateSpecVersionId:
    observed.id ??
    `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.Resources/templateSpecs/${templateSpecName}/versions/${name}`,
  templateSpecName,
  resourceGroup,
  location: observed.location,
  description: observed.properties.description,
  tags: userTags(observed.tags),
});

export const TemplateSpecVersionProvider = () =>
  Provider.succeed(TemplateSpecVersion, {
    stables: [
      "version",
      "templateSpecVersionId",
      "templateSpecName",
      "resourceGroup",
      "location",
    ],

    // Versions are deleted with their template spec.
    list: () => Effect.succeed([]),

    diff: Effect.fn(function* ({ news, output }) {
      if (output === undefined) return undefined;
      if (!isResolved(news.resourceGroup) || !isResolved(news.templateSpecName)) {
        return { action: "replace" } as const;
      }
      if (!isResolved(news)) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        news.templateSpecName.toLowerCase() !==
          output.templateSpecName.toLowerCase() ||
        (news.name !== undefined &&
          news.name.toLowerCase() !== output.version.toLowerCase()) ||
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
      const spec = output?.templateSpecName ?? olds?.templateSpecName;
      if (group === undefined || spec === undefined) return undefined;
      const name = output?.version ?? (yield* versionName(id, olds?.name));
      const observed = yield* getVersion(subscriptionId, group, spec, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(subscriptionId, group, spec, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Resources");
      const group = news.resourceGroup;
      const spec = news.templateSpecName;
      const name = output?.version ?? (yield* versionName(id, news.name));
      const tags = yield* desiredTags(id, news.tags);

      // Observe.
      const observed = yield* getVersion(subscriptionId, group, spec, name);
      const current = observed?.properties;

      // Ensure + sync the template content with one idempotent PUT,
      // skipped when it already matches.
      if (
        observed === undefined ||
        current?.description !== news.description ||
        !sameJson(current?.mainTemplate, news.mainTemplate) ||
        !sameJson(current?.linkedTemplates ?? [], news.linkedTemplates ?? []) ||
        !sameJson(current?.uiFormDefinition, news.uiFormDefinition) ||
        !sameJson(current?.metadata ?? {}, news.metadata ?? {})
      ) {
        const location =
          observed?.location ??
          news.location ??
          output?.location ??
          (yield* orUndefinedIfNotFound(
            resources.GetTemplateSpec({
              subscriptionId,
              resourceGroupName: group,
              templateSpecName: spec,
            }),
          ))?.location ??
          (yield* AzureEnvironment.current).location;
        yield* resources.TemplateSpecVersionsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: group,
          templateSpecName: spec,
          templateSpecVersion: name,
          location,
          properties: {
            description: news.description,
            mainTemplate: news.mainTemplate,
            linkedTemplates: news.linkedTemplates,
            uiFormDefinition: news.uiFormDefinition,
            metadata: news.metadata,
          },
          tags,
        });
      } else if (tagsDiffer(observed.tags, tags)) {
        // Sync tags against the observed cloud tags.
        yield* resources.UpdateTemplateSpecVersion({
          subscriptionId,
          resourceGroupName: group,
          templateSpecName: spec,
          templateSpecVersion: name,
          tags,
        });
      }

      const fresh = yield* waitForProvisioned(
        `template spec version ${spec}/${name}`,
        getVersion(subscriptionId, group, spec, name),
        () => undefined,
        { interval: "2 seconds", times: 15 },
      );
      return toAttrs(subscriptionId, group, spec, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        resources.DeleteTemplateSpecVersion({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          templateSpecName: output.templateSpecName,
          templateSpecVersion: output.version,
        }),
      );
      yield* waitUntilGone(
        `template spec version ${output.templateSpecName}/${output.version}`,
        getVersion(
          subscriptionId,
          output.resourceGroup,
          output.templateSpecName,
          output.version,
        ),
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.Resources.TemplateSpec",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
