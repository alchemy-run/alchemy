import * as discovery from "@distilled.cloud/azure/discovery";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
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
import {
  canonicalJson,
  createDiscoveryName,
  DISCOVERY_NAMESPACE,
  lower,
  sameLocation,
} from "./common.ts";

export interface ToolProps {
  /** Resource group the tool is created in. Changing it replaces the tool. */
  resourceGroup: string;
  /**
   * Tool name: 3-24 letters, digits, and hyphens. If omitted, a unique name
   * is generated from the app, stage, and logical ID. Changing it replaces
   * the tool.
   */
  name?: string;
  /**
   * Azure location. Changing it replaces the tool.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /** Version of the tool definition, e.g. `1.0.0`. */
  version: string;
  /**
   * Tool definition document (container image, commands, inputs and
   * outputs) as JSON.
   */
  definitionContent: Record<string, unknown>;
  /** Environment variables made available to the tool. */
  environmentVariables?: Record<string, string>;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Tool extends Resource<
  "Azure.Discovery.Tool",
  ToolProps,
  {
    /** Name of the tool. */
    toolName: string;
    /** ARM resource ID of the tool. */
    toolId: string;
    /** Resource group that holds the tool. */
    resourceGroup: string;
    /** Location of the tool. */
    location: string;
    /** Version of the tool definition. */
    version: string;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A Microsoft Discovery tool (`Microsoft.Discovery/tools`) — a containerized
 * capability that Discovery agents can invoke, described by a JSON tool
 * definition.
 *
 * Microsoft Discovery is a gated preview: on subscriptions without the
 * preview, ARM rejects the resource type with `InvalidResourceType`.
 *
 * @see https://learn.microsoft.com/azure/microsoft-discovery/
 *
 * ### Creating a Tool
 * **Example:** Tool backed by a container image
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("science");
 * const tool = yield* Azure.Discovery.Tool("docking", {
 *   resourceGroup: group.resourceGroupName,
 *   version: "1.0.0",
 *   definitionContent: {
 *     name: "docking",
 *     image: "myregistry.azurecr.io/docking:1.0.0",
 *     command: ["python", "dock.py"],
 *   },
 * });
 * ```
 *
 * ### Configuring the Tool
 * **Example:** Environment variables
 * ```typescript
 * const tool = yield* Azure.Discovery.Tool("docking", {
 *   resourceGroup: group.resourceGroupName,
 *   version: "1.1.0",
 *   definitionContent: { name: "docking" },
 *   environmentVariables: { LOG_LEVEL: "info" },
 * });
 * ```
 *
 * @resource
 */
export const Tool = Resource<Tool>("Azure.Discovery.Tool");

/**
 * Without the Discovery preview ARM rejects the type itself
 * (`InvalidResourceType`): no tool can exist there.
 */
const getTool = (
  subscriptionId: string,
  resourceGroupName: string,
  toolName: string,
) =>
  orUndefinedIfNotFound(
    discovery.GetTool({ subscriptionId, resourceGroupName, toolName }),
  ).pipe(
    Effect.catchTag("InvalidResourceType", () => Effect.succeed(undefined)),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  observed: Pick<
    discovery.GetToolResponse,
    "id" | "location" | "properties" | "tags"
  >,
): Tool["Attributes"] => ({
  toolName: name,
  toolId: observed.id ?? "",
  resourceGroup,
  location: observed.location,
  version: observed.properties?.version ?? "",
  tags: userTags(observed.tags),
});

export const ToolProvider = () =>
  Provider.succeed(Tool, {
    stables: ["toolName", "toolId", "resourceGroup", "location"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* discovery
        .ListToolBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListToolBySubscription", page),
          ),
          Effect.catchTag("InvalidResourceType", () =>
            Effect.succeed(undefined),
          ),
        );
      return (page?.value ?? []).flatMap((observed) => {
        const group = resourceGroupOf(observed.id);
        return hasAnyAlchemyTag(observed.tags) &&
          group !== undefined &&
          observed.name !== undefined
          ? [toAttrs(group, observed.name, observed)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        (news.name !== undefined &&
          lower(news.name) !== lower(output.toolName)) ||
        (news.location !== undefined &&
          !sameLocation(news.location, output.location))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name =
        output?.toolName ?? olds?.name ?? (yield* createDiscoveryName(id));
      const observed = yield* getTool(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, DISCOVERY_NAMESPACE);
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ?? output?.toolName ?? (yield* createDiscoveryName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const environmentVariables = news.environmentVariables ?? {};
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        toolName: name,
      };
      const ready = waitForProvisioned(
        `discovery tool ${name}`,
        getTool(subscriptionId, resourceGroup, name),
        (tool) => tool.properties?.provisioningState,
        { interval: "5 seconds", times: 60 },
      );

      // Observe.
      let observed = yield* getTool(subscriptionId, resourceGroup, name);

      // Ensure.
      if (observed === undefined) {
        yield* discovery.ToolsCreateOrUpdate({
          ...where,
          location,
          tags,
          properties: {
            version: news.version,
            definitionContent: news.definitionContent,
            environmentVariables,
          },
        });
      }
      observed = yield* ready;

      // Sync: PATCH only the observed deltas.
      const props = observed.properties;
      const versionChanged = props?.version !== news.version;
      const definitionChanged =
        canonicalJson(props?.definitionContent ?? {}) !==
        canonicalJson(news.definitionContent);
      const envChanged =
        canonicalJson(props?.environmentVariables ?? {}) !==
        canonicalJson(environmentVariables);
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (versionChanged || definitionChanged || envChanged || tagsChanged) {
        yield* discovery.UpdateTool({
          ...where,
          tags: tagsChanged ? tags : undefined,
          properties:
            versionChanged || definitionChanged || envChanged
              ? {
                  version: versionChanged ? news.version : undefined,
                  definitionContent: definitionChanged
                    ? news.definitionContent
                    : undefined,
                  environmentVariables: envChanged
                    ? environmentVariables
                    : undefined,
                }
              : undefined,
        });
        observed = yield* ready;
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        discovery.DeleteTool({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          toolName: output.toolName,
        }),
      ).pipe(Effect.catchTag("InvalidResourceType", () => Effect.void));
      yield* waitUntilGone(
        `discovery tool ${output.toolName}`,
        getTool(subscriptionId, output.resourceGroup, output.toolName),
        { interval: "5 seconds", times: 60 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
