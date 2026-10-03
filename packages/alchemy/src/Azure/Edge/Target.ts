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
import { EDGE_WAIT, edgeState, sameId, sameJson } from "./EdgeShared.ts";

export interface TargetProps {
  /** Resource group the target is created in. Changing it replaces the target. */
  resourceGroup: string;
  /**
   * Name of the target. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the target.
   */
  name?: string;
  /**
   * Azure location of the target. Workload orchestration is available in
   * `eastus` and `eastus2`. Changing it replaces the target.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * ARM resource ID of the custom location (`Microsoft.ExtendedLocation/customLocations`)
   * the target deploys through. Changing it replaces the target.
   */
  customLocationId: string;
  /** ARM resource ID of the context the target belongs to. */
  contextId: string;
  /** Display name of the target. */
  displayName: string;
  /** Description of the target. */
  description: string;
  /** Hierarchy level of the target (one of the context's hierarchies). */
  hierarchyLevel: string;
  /** Capabilities the target offers (declared on the context). */
  capabilities: string[];
  /** Target specification: topologies and provider bindings. */
  targetSpecification: Record<string, unknown>;
  /** Scope of the target's solutions (for example a Kubernetes namespace). */
  solutionScope?: string;
  /**
   * Whether the target accepts deployments.
   * @default "active"
   */
  state?: "active" | "inactive";
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Target extends Resource<
  "Azure.Edge.Target",
  TargetProps,
  {
    /** Name of the target. */
    targetName: string;
    /** Resource group that holds the target. */
    resourceGroup: string;
    /** ARM resource ID of the target. */
    targetId: string;
    /** Location of the target. */
    location: string;
    /** Custom location the target deploys through. */
    customLocationId: string;
    /** Context the target belongs to. */
    contextId: string;
    /** Display name of the target. */
    displayName: string;
    /** Description of the target. */
    description: string;
    /** Hierarchy level of the target. */
    hierarchyLevel: string;
    /** Capabilities the target offers. */
    capabilities: string[];
    /** Deployment status reported by the target. */
    status: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Arc workload orchestration target: a deployment destination
 * (typically a namespace on an Arc-enabled Kubernetes cluster, reached
 * through a custom location) at one hierarchy level of a context.
 *
 * Requires an existing custom location (an Arc-enabled cluster with the
 * workload orchestration extension) and the subscription's
 * `Azure.Edge.Context`.
 *
 * @see https://learn.microsoft.com/azure/azure-arc/workload-orchestration/overview
 *
 * ### Creating a Target
 * **Example:** Line-level Helm target
 * ```typescript
 * const target = yield* Azure.Edge.Target("line1", {
 *   resourceGroup: group.resourceGroupName,
 *   customLocationId: customLocationId,
 *   contextId: context.contextId,
 *   displayName: "Line 1",
 *   description: "Packaging line 1",
 *   hierarchyLevel: "line",
 *   capabilities: ["soap"],
 *   targetSpecification: {
 *     topologies: [
 *       {
 *         bindings: [
 *           {
 *             role: "helm.v3",
 *             provider: "providers.target.helm",
 *             config: { inCluster: "true" },
 *           },
 *         ],
 *       },
 *     ],
 *   },
 * });
 * ```
 *
 * @resource
 */
export const Target = Resource<Target>("Azure.Edge.Target");

const getTarget = (
  subscriptionId: string,
  resourceGroupName: string,
  targetName: string,
) =>
  orUndefinedIfNotFound(
    edge.GetTarget({ subscriptionId, resourceGroupName, targetName }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  target: edge.GetTargetResponse,
): Target["Attributes"] => ({
  targetName: name,
  resourceGroup,
  targetId: target.id ?? "",
  location: target.location,
  customLocationId: target.extendedLocation?.name ?? "",
  contextId: target.properties?.contextId ?? "",
  displayName: target.properties?.displayName ?? "",
  description: target.properties?.description ?? "",
  hierarchyLevel: target.properties?.hierarchyLevel ?? "",
  capabilities: [...(target.properties?.capabilities ?? [])],
  status: target.properties?.status?.status,
  tags: userTags(target.tags),
});

const targetName = (id: string) => createPhysicalName({ id, maxLength: 61 });

export const TargetProvider = () =>
  Provider.succeed(Target, {
    stables: [
      "targetName",
      "resourceGroup",
      "targetId",
      "location",
      "customLocationId",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* edge
        .ListTargetBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListTargetBySubscription", page),
          ),
        );
      return page.value.flatMap((target) => {
        const group = resourceGroupOf(target.id);
        return hasAnyAlchemyTag(target.tags) &&
          group !== undefined &&
          target.name !== undefined
          ? [toAttrs(group, target.name, target)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        (news.name !== undefined &&
          news.name.toLowerCase() !== output.targetName.toLowerCase()) ||
        (news.location !== undefined &&
          news.location.toLowerCase() !== output.location.toLowerCase()) ||
        news.customLocationId.toLowerCase() !==
          output.customLocationId.toLowerCase()
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name = output?.targetName ?? olds?.name ?? (yield* targetName(id));
      const observed = yield* getTarget(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.Edge");
      const resourceGroup = news.resourceGroup;
      const name = news.name ?? output?.targetName ?? (yield* targetName(id));
      const tags = yield* desiredTags(id, news.tags);
      const get = getTarget(subscriptionId, resourceGroup, name);

      // Observe.
      const observed = yield* get;

      const desired = {
        description: news.description,
        displayName: news.displayName,
        contextId: news.contextId,
        targetSpecification: news.targetSpecification,
        capabilities: news.capabilities,
        hierarchyLevel: news.hierarchyLevel,
        solutionScope: news.solutionScope,
        state: news.state ?? "active",
      };

      // Ensure.
      if (observed === undefined) {
        yield* edge.TargetsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          targetName: name,
          location: news.location ?? output?.location ?? env.location,
          extendedLocation: {
            name: news.customLocationId,
            type: "CustomLocation",
          },
          tags,
          properties: desired,
        });
      } else {
        // Sync: PATCH only the observed deltas.
        const props = observed.properties;
        const delta: edge.TargetUpdateProperties = {
          ...(props?.description !== desired.description
            ? { description: desired.description }
            : {}),
          ...(props?.displayName !== desired.displayName
            ? { displayName: desired.displayName }
            : {}),
          ...(!sameId(props?.contextId, desired.contextId)
            ? { contextId: desired.contextId }
            : {}),
          ...(!sameJson(props?.targetSpecification, desired.targetSpecification)
            ? { targetSpecification: desired.targetSpecification }
            : {}),
          ...(!sameJson(props?.capabilities, desired.capabilities)
            ? { capabilities: desired.capabilities }
            : {}),
          ...(props?.hierarchyLevel !== desired.hierarchyLevel
            ? { hierarchyLevel: desired.hierarchyLevel }
            : {}),
          ...(desired.solutionScope !== undefined &&
          props?.solutionScope !== desired.solutionScope
            ? { solutionScope: desired.solutionScope }
            : {}),
          ...((props?.state ?? "active") !== desired.state
            ? { state: desired.state }
            : {}),
        };
        const tagsChanged = tagsDiffer(observed.tags, tags);
        if (tagsChanged || Object.keys(delta).length > 0) {
          yield* edge.UpdateTarget({
            subscriptionId,
            resourceGroupName: resourceGroup,
            targetName: name,
            ...(tagsChanged ? { tags } : {}),
            properties: delta,
          });
        }
      }

      const fresh = yield* waitForProvisioned(
        `edge target ${name}`,
        get,
        edgeState,
        EDGE_WAIT,
      );
      return toAttrs(resourceGroup, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        edge.DeleteTarget({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          targetName: output.targetName,
        }),
      );
      yield* waitUntilGone(
        `edge target ${output.targetName}`,
        getTarget(subscriptionId, output.resourceGroup, output.targetName),
        EDGE_WAIT,
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
