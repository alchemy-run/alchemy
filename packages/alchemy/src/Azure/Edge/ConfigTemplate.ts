import * as edge from "@distilled.cloud/azure/edge";
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
import { EDGE_WAIT, edgeState } from "./EdgeShared.ts";

export interface ConfigTemplateProps {
  /** Resource group the config template is created in. Changing it replaces the config template. */
  resourceGroup: string;
  /**
   * Name of the config template. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the config template.
   */
  name?: string;
  /**
   * Azure location of the config template. Workload orchestration is available in
   * `eastus` and `eastus2`. Changing it replaces the config template.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /** Description of the config template. */
  description: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface ConfigTemplate extends Resource<
  "Azure.Edge.ConfigTemplate",
  ConfigTemplateProps,
  {
    /** Name of the config template. */
    configTemplateName: string;
    /** Resource group that holds the config template. */
    resourceGroup: string;
    /** ARM resource ID of the config template. */
    configTemplateId: string;
    /** Location of the config template. */
    location: string;
    /** Description of the config template. */
    description: string;
    /** System-generated unique identifier of the config template. */
    uniqueIdentifier: string | undefined;
    /** Latest version of the config template, if any. */
    latestVersion: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Arc workload orchestration configuration template. A config
 * template carries shared configuration (with its inline schema) that is
 * linked to hierarchy levels of a context. Its YAML lives in immutable
 * `Azure.Edge.ConfigTemplateVersion` children.
 *
 * @see https://learn.microsoft.com/azure/azure-arc/workload-orchestration/configuring-template
 *
 * ### Creating a Config Template
 * **Example:** Config template with a version
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("edge", {
 *   location: "eastus",
 * });
 * const template = yield* Azure.Edge.ConfigTemplate("common", {
 *   resourceGroup: group.resourceGroupName,
 *   description: "Shared plant configuration",
 * });
 * yield* Azure.Edge.ConfigTemplateVersion("common-v1", {
 *   resourceGroup: group.resourceGroupName,
 *   configTemplate: template.configTemplateName,
 *   version: "1.0.0",
 *   configurations: [
 *     "schema:",
 *     "  rules:",
 *     "    configs:",
 *     "      Endpoint:",
 *     "        type: string",
 *     "        required: true",
 *     "        editableBy:",
 *     "          - OT",
 *     "configs:",
 *     "  Endpoint: ${{$val(Endpoint)}}",
 *   ].join("\n"),
 * });
 * ```
 *
 * @resource
 */
export const ConfigTemplate = Resource<ConfigTemplate>("Azure.Edge.ConfigTemplate");

const getConfigTemplate = (
  subscriptionId: string,
  resourceGroupName: string,
  configTemplateName: string,
) =>
  orUndefinedIfNotFound(
    edge.GetConfigTemplate({ subscriptionId, resourceGroupName, configTemplateName }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  configTemplate: edge.GetConfigTemplateResponse,
): ConfigTemplate["Attributes"] => ({
  configTemplateName: name,
  resourceGroup,
  configTemplateId: configTemplate.id ?? "",
  location: configTemplate.location,
  description: configTemplate.properties?.description ?? "",
  uniqueIdentifier: configTemplate.properties?.uniqueIdentifier,
  latestVersion: configTemplate.properties?.latestVersion,
  tags: userTags(configTemplate.tags),
});

const configTemplateName = (id: string) => createPhysicalName({ id, maxLength: 63 });

export const ConfigTemplateProvider = () =>
  Provider.succeed(ConfigTemplate, {
    stables: ["configTemplateName", "resourceGroup", "configTemplateId", "location"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* edge
        .ListConfigTemplateBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListConfigTemplateBySubscription", page),
          ),
        );
      return page.value.flatMap((configTemplate) => {
        const group = resourceGroupOf(configTemplate.id);
        return hasAnyAlchemyTag(configTemplate.tags) &&
          group !== undefined &&
          configTemplate.name !== undefined
          ? [toAttrs(group, configTemplate.name, configTemplate)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        (news.name !== undefined &&
          news.name.toLowerCase() !== output.configTemplateName.toLowerCase()) ||
        (news.location !== undefined &&
          news.location.toLowerCase() !== output.location.toLowerCase())
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name = output?.configTemplateName ?? olds?.name ?? (yield* configTemplateName(id));
      const observed = yield* getConfigTemplate(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.Edge");
      const resourceGroup = news.resourceGroup;
      const name = news.name ?? output?.configTemplateName ?? (yield* configTemplateName(id));
      const tags = yield* desiredTags(id, news.tags);
      const get = getConfigTemplate(subscriptionId, resourceGroup, name);

      // Observe.
      const observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* edge.ConfigTemplatesCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          configTemplateName: name,
          location: news.location ?? output?.location ?? env.location,
          tags,
          properties: { description: news.description },
        });
      } else if (
        tagsDiffer(observed.tags, tags) ||
        observed.properties?.description !== news.description
      ) {
        // Sync tags and description against the observed template.
        yield* edge.UpdateConfigTemplate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          configTemplateName: name,
          tags,
          properties: { description: news.description },
        });
      }

      const fresh = yield* waitForProvisioned(
        `edge config template ${name}`,
        get,
        edgeState,
        EDGE_WAIT,
      );
      return toAttrs(resourceGroup, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        edge.DeleteConfigTemplate({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          configTemplateName: output.configTemplateName,
        }),
      );
      yield* waitUntilGone(
        `edge config template ${output.configTemplateName}`,
        getConfigTemplate(subscriptionId, output.resourceGroup, output.configTemplateName),
        EDGE_WAIT,
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
