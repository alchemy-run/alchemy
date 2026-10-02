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
import { EDGE_WAIT, edgeState } from "./EdgeShared.ts";

export interface ConfigTemplateVersionProps {
  /** Resource group of the config template. Changing it replaces the version. */
  resourceGroup: string;
  /** Name of the parent config template. Changing it replaces the version. */
  configTemplate: string;
  /**
   * Semantic version, e.g. `1.0.0`. Versions are immutable; changing it
   * creates a new version and deletes the old one.
   */
  version: string;
  /**
   * Config template YAML: an optional inline `configTemplate:` plus `configs:`.
   * Versions are immutable; changing it replaces the version.
   */
  configurations: string;
}

export interface ConfigTemplateVersion extends Resource<
  "Azure.Edge.ConfigTemplateVersion",
  ConfigTemplateVersionProps,
  {
    /** Version name. */
    version: string;
    /** Name of the parent config template. */
    configTemplate: string;
    /** Resource group of the config template. */
    resourceGroup: string;
    /** ARM resource ID of the version. */
    configTemplateVersionId: string;
    /** Config template YAML: an optional inline `configTemplate:` plus `configs:`. */
    configurations: string;
  },
  never,
  Providers
> {}

/**
 * An immutable version of an Azure Arc workload orchestration config
 * template. The YAML `configurations` carry the shared configuration
 * values and, optionally, the configTemplate rules they validate against.
 *
 * Versions carry no tags or free-form fields, so Alchemy cannot mark them;
 * a version found under the expected name is treated as this resource.
 *
 * @see https://learn.microsoft.com/azure/azure-arc/workload-orchestration/configuring-template
 *
 * ### Publishing a Version
 * **Example:** Config template with an inline configTemplate
 * ```typescript
 * const v1 = yield* Azure.Edge.ConfigTemplateVersion("common-v1", {
 *   resourceGroup: group.resourceGroupName,
 *   configTemplate: template.configTemplateName,
 *   version: "1.0.0",
 *   configurations: [
 *     "configTemplate:",
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
export const ConfigTemplateVersion = Resource<ConfigTemplateVersion>(
  "Azure.Edge.ConfigTemplateVersion",
);

const getVersion = (
  subscriptionId: string,
  resourceGroupName: string,
  configTemplateName: string,
  configTemplateVersionName: string,
) =>
  orUndefinedIfNotFound(
    edge.GetConfigTemplateVersion({
      subscriptionId,
      resourceGroupName,
      configTemplateName,
      configTemplateVersionName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  configTemplate: string,
  version: string,
  observed: edge.GetConfigTemplateVersionResponse,
): ConfigTemplateVersion["Attributes"] => ({
  version,
  configTemplate,
  resourceGroup,
  configTemplateVersionId: observed.id ?? "",
  configurations: observed.properties?.configurations ?? "",
});

export const ConfigTemplateVersionProvider = () =>
  Provider.succeed(ConfigTemplateVersion, {
    stables: ["version", "configTemplate", "resourceGroup", "configTemplateVersionId"],

    // Versions vanish with their config template.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      const moved =
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        news.configTemplate.toLowerCase() !== output.configTemplate.toLowerCase() ||
        news.version !== output.version;
      if (moved || news.configurations !== output.configurations) {
        // Same name, new payload: the old version must go first.
        return { action: "replace", deleteFirst: !moved } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const configTemplate = output?.configTemplate ?? olds?.configTemplate;
      const version = output?.version ?? olds?.version;
      if (
        resourceGroup === undefined ||
        configTemplate === undefined ||
        version === undefined
      ) {
        return undefined;
      }
      const observed = yield* getVersion(
        subscriptionId,
        resourceGroup,
        configTemplate,
        version,
      );
      return observed === undefined
        ? undefined
        : toAttrs(resourceGroup, configTemplate, version, observed);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Edge");
      const { resourceGroup, configTemplate, version } = news;
      const get = getVersion(subscriptionId, resourceGroup, configTemplate, version);

      // Observe.
      const observed = yield* get;

      // Ensure. The payload is the version's only aspect.
      if (observed === undefined || observed.properties?.configurations !== news.configurations) {
        yield* edge.ConfigTemplateVersionsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          configTemplateName: configTemplate,
          configTemplateVersionName: version,
          properties: { configurations: news.configurations },
        });
      }

      const fresh = yield* waitForProvisioned(
        `edge config template version ${configTemplate}/${version}`,
        get,
        edgeState,
        EDGE_WAIT,
      );
      return toAttrs(resourceGroup, configTemplate, version, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        edge.DeleteConfigTemplateVersion({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          configTemplateName: output.configTemplate,
          configTemplateVersionName: output.version,
        }),
      );
      yield* waitUntilGone(
        `edge config template version ${output.configTemplate}/${output.version}`,
        getVersion(
          subscriptionId,
          output.resourceGroup,
          output.configTemplate,
          output.version,
        ),
        EDGE_WAIT,
      );
    }),
  });
