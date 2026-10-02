import * as edge from "@distilled.cloud/azure/edge";
import * as Effect from "effect/Effect";
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
import { EDGE_WAIT, edgeState, sameId, sameJson } from "./EdgeShared.ts";

/** Hierarchy entities of one level that a config template applies to. */
export interface ConfigTemplateHierarchy {
  /** Hierarchy level (one of the context's hierarchies), e.g. `country`. */
  level: string;
  /** ARM resource IDs of the sites or targets at that level. */
  hierarchyIds: string[];
}

export interface ConfigTemplateMetadataProps {
  /** Resource group of the config template. Changing it replaces the metadata. */
  resourceGroup: string;
  /** Name of the parent config template. Changing it replaces the metadata. */
  configTemplate: string;
  /**
   * Name of the metadata resource. Changing it replaces the metadata.
   * @default "default"
   */
  name?: string;
  /**
   * ARM resource ID of the `Azure.Edge.Context` the template is linked
   * in. Changing it replaces the metadata.
   */
  contextId: string;
  /**
   * Hierarchy entities the config template is linked to. Entities removed
   * from this list are unlinked.
   * @default []
   */
  linkedHierarchies?: ConfigTemplateHierarchy[];
}

export interface ConfigTemplateMetadata extends Resource<
  "Azure.Edge.ConfigTemplateMetadata",
  ConfigTemplateMetadataProps,
  {
    /** Name of the metadata resource. */
    configTemplateMetadataName: string;
    /** Name of the parent config template. */
    configTemplate: string;
    /** Resource group of the config template. */
    resourceGroup: string;
    /** ARM resource ID of the metadata resource. */
    configTemplateMetadataId: string;
    /** ARM resource ID of the context. */
    contextId: string;
    /** Hierarchy entities the config template is linked to. */
    linkedHierarchies: ConfigTemplateHierarchy[];
    /** Unique identifier of the config template. */
    templateUniqueIdentifier: string | undefined;
  },
  never,
  Providers
> {}

/**
 * Links an Azure Arc workload orchestration config template to hierarchy
 * entities (sites or targets) of a context, so the template's shared
 * configuration applies to them.
 *
 * The metadata resource carries no tags or free-form fields, so Alchemy
 * cannot mark it; one found under the expected name is treated as this
 * resource.
 *
 * @see https://learn.microsoft.com/azure/azure-arc/workload-orchestration/configuring-template
 *
 * ### Linking a Config Template
 * **Example:** Apply a config template to a site
 * ```typescript
 * yield* Azure.Edge.ConfigTemplateMetadata("common-links", {
 *   resourceGroup: group.resourceGroupName,
 *   configTemplate: template.configTemplateName,
 *   contextId: context.contextId,
 *   linkedHierarchies: [{ level: "country", hierarchyIds: [site.siteId] }],
 * });
 * ```
 *
 * @resource
 */
export const ConfigTemplateMetadata = Resource<ConfigTemplateMetadata>(
  "Azure.Edge.ConfigTemplateMetadata",
);

const getMetadata = (
  subscriptionId: string,
  resourceGroupName: string,
  configTemplateName: string,
  configTemplateMetadataName: string,
) =>
  orUndefinedIfNotFound(
    edge.GetConfigTemplateMetadatas({
      subscriptionId,
      resourceGroupName,
      configTemplateName,
      configTemplateMetadataName,
    }),
  );

const toHierarchies = (
  list: readonly edge.HierarchyMetadata[] | undefined,
): ConfigTemplateHierarchy[] =>
  (list ?? []).map((h) => ({
    level: h.level ?? "",
    hierarchyIds: [...(h.hierarchyIds ?? [])],
  }));

/** Canonical form for comparison: ARM echoes IDs lowercased. */
const normalize = (list: readonly ConfigTemplateHierarchy[]) =>
  list
    .map((h) => ({
      level: h.level.toLowerCase(),
      hierarchyIds: h.hierarchyIds.map((id) => id.toLowerCase()).sort(),
    }))
    .filter((h) => h.hierarchyIds.length > 0)
    .sort((a, b) => (a.level < b.level ? -1 : a.level > b.level ? 1 : 0));

/** Entities linked in `observed` that `desired` no longer links. */
const removed = (
  observed: readonly ConfigTemplateHierarchy[],
  desired: readonly ConfigTemplateHierarchy[],
): ConfigTemplateHierarchy[] => {
  const kept = new Set(
    desired.flatMap((h) =>
      h.hierarchyIds.map(
        (id) => `${h.level.toLowerCase()}|${id.toLowerCase()}`,
      ),
    ),
  );
  return observed
    .map((h) => ({
      level: h.level,
      hierarchyIds: h.hierarchyIds.filter(
        (id) => !kept.has(`${h.level.toLowerCase()}|${id.toLowerCase()}`),
      ),
    }))
    .filter((h) => h.hierarchyIds.length > 0);
};

const toAttrs = (
  resourceGroup: string,
  configTemplate: string,
  name: string,
  observed: edge.GetConfigTemplateMetadatasResponse,
): ConfigTemplateMetadata["Attributes"] => ({
  configTemplateMetadataName: name,
  configTemplate,
  resourceGroup,
  configTemplateMetadataId: observed.id ?? "",
  contextId: observed.properties?.contextId ?? "",
  linkedHierarchies: toHierarchies(observed.properties?.linkedHierarchies),
  templateUniqueIdentifier: observed.properties?.templateUniqueIdentifier,
});

export const ConfigTemplateMetadataProvider = () =>
  Provider.succeed(ConfigTemplateMetadata, {
    stables: [
      "configTemplateMetadataName",
      "configTemplate",
      "resourceGroup",
      "configTemplateMetadataId",
      "contextId",
    ],

    // Metadata vanishes with its config template.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        news.configTemplate.toLowerCase() !==
          output.configTemplate.toLowerCase() ||
        (news.name ?? "default").toLowerCase() !==
          output.configTemplateMetadataName.toLowerCase() ||
        !sameId(news.contextId, output.contextId)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const configTemplate = output?.configTemplate ?? olds?.configTemplate;
      if (resourceGroup === undefined || configTemplate === undefined) {
        return undefined;
      }
      const name =
        output?.configTemplateMetadataName ?? olds?.name ?? "default";
      const observed = yield* getMetadata(
        subscriptionId,
        resourceGroup,
        configTemplate,
        name,
      );
      return observed === undefined
        ? undefined
        : toAttrs(resourceGroup, configTemplate, name, observed);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Edge");
      const { resourceGroup, configTemplate } = news;
      const name = news.name ?? "default";
      const desired = news.linkedHierarchies ?? [];
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        configTemplateName: configTemplate,
        configTemplateMetadataName: name,
      };
      const get = getMetadata(
        subscriptionId,
        resourceGroup,
        configTemplate,
        name,
      );

      // Observe.
      const observed = yield* get;

      if (observed === undefined) {
        // Ensure. The context must be set at creation.
        yield* edge.ConfigTemplateMetadatasCreateOrUpdate({
          ...where,
          properties: {
            contextId: news.contextId,
            ...(desired.length > 0 ? { linkedHierarchies: desired } : {}),
          },
        });
      } else {
        // Sync links against observed state; removed entities are unlinked.
        const linked = toHierarchies(observed.properties?.linkedHierarchies);
        if (!sameJson(normalize(linked), normalize(desired))) {
          const unlink = removed(linked, desired);
          yield* edge.UpdateConfigTemplateMetadatas({
            ...where,
            properties: {
              linkedHierarchies: desired,
              ...(unlink.length > 0 ? { unLinkedHierarchies: unlink } : {}),
            },
          });
        }
      }

      const fresh = yield* waitForProvisioned(
        `edge config template metadata ${configTemplate}/${name}`,
        get,
        edgeState,
        EDGE_WAIT,
      );
      return toAttrs(resourceGroup, configTemplate, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        edge.DeleteConfigTemplateMetadatas({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          configTemplateName: output.configTemplate,
          configTemplateMetadataName: output.configTemplateMetadataName,
        }),
      );
      yield* waitUntilGone(
        `edge config template metadata ${output.configTemplate}/${output.configTemplateMetadataName}`,
        getMetadata(
          subscriptionId,
          output.resourceGroup,
          output.configTemplate,
          output.configTemplateMetadataName,
        ),
        EDGE_WAIT,
      );
    }),
  });
