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
import { EDGE_WAIT, edgeState, sameJson } from "./EdgeShared.ts";

/** A capability declared by a context. */
export interface ContextCapability {
  /** Name of the capability. */
  name: string;
  /** Description of the capability. */
  description: string;
  /**
   * Whether the capability is in use.
   * @default "active"
   */
  state?: "active" | "inactive";
}

/** A hierarchy level declared by a context. */
export interface ContextHierarchy {
  /** Name of the hierarchy level. */
  name: string;
  /** Description of the hierarchy level. */
  description: string;
}

export interface ContextProps {
  /** Resource group the context is created in. Changing it replaces the context. */
  resourceGroup: string;
  /**
   * Name of the context. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the context.
   */
  name?: string;
  /**
   * Azure location of the context. Workload orchestration is available in
   * `eastus` and `eastus2`. Changing it replaces the context.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /** Capabilities (kinds of workloads) available in the context. */
  capabilities: ContextCapability[];
  /** Hierarchy levels, top-down (Microsoft documents up to 4 levels). */
  hierarchies: ContextHierarchy[];
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Context extends Resource<
  "Azure.Edge.Context",
  ContextProps,
  {
    /** Name of the context. */
    contextName: string;
    /** Resource group that holds the context. */
    resourceGroup: string;
    /** ARM resource ID of the context. */
    contextId: string;
    /** Location of the context. */
    location: string;
    /** System-generated unique identifier of the context. */
    uniqueIdentifier: string | undefined;
    /** Capabilities declared by the context. */
    capabilities: ContextCapability[];
    /** Hierarchy levels declared by the context. */
    hierarchies: ContextHierarchy[];
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Arc workload orchestration context: the root object that
 * declares the capabilities (kinds of workloads) and the hierarchy levels
 * (country, region, factory, line, ...) used by sites, targets, and
 * solution templates.
 *
 * Azure allows only one context per subscription; creating a second one
 * fails with `Context ... already exists`.
 *
 * @see https://learn.microsoft.com/azure/azure-arc/workload-orchestration/overview
 *
 * ### Creating a Context
 * **Example:** Context with two hierarchy levels
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("edge", {
 *   location: "eastus",
 * });
 * const context = yield* Azure.Edge.Context("context", {
 *   resourceGroup: group.resourceGroupName,
 *   capabilities: [{ name: "soap", description: "Soap production" }],
 *   hierarchies: [
 *     { name: "country", description: "Country" },
 *     { name: "factory", description: "Factory" },
 *   ],
 * });
 * ```
 *
 * ### Linking Sites
 * **Example:** Add a site to the context
 * ```typescript
 * const site = yield* Azure.Edge.Site("plant", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * yield* Azure.Edge.SiteReference("plant-ref", {
 *   resourceGroup: group.resourceGroupName,
 *   context: context.contextName,
 *   siteId: site.siteId,
 * });
 * ```
 *
 * @resource
 */
export const Context = Resource<Context>("Azure.Edge.Context");

const getContext = (
  subscriptionId: string,
  resourceGroupName: string,
  contextName: string,
) =>
  orUndefinedIfNotFound(
    edge.GetContext({ subscriptionId, resourceGroupName, contextName }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  context: edge.GetContextResponse,
): Context["Attributes"] => ({
  contextName: name,
  resourceGroup,
  contextId: context.id ?? "",
  location: context.location,
  uniqueIdentifier: context.properties?.uniqueIdentifier,
  capabilities: (context.properties?.capabilities ?? []).map((c) => ({
    name: c.name,
    description: c.description,
    ...(c.state !== undefined ? { state: c.state } : {}),
  })),
  hierarchies: (context.properties?.hierarchies ?? []).map((h) => ({
    name: h.name,
    description: h.description,
  })),
  tags: userTags(context.tags),
});

const contextName = (id: string) => createPhysicalName({ id, maxLength: 63 });

export const ContextProvider = () =>
  Provider.succeed(Context, {
    stables: ["contextName", "resourceGroup", "contextId", "location"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* edge
        .ListContextBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListContextBySubscription", page),
          ),
        );
      return page.value.flatMap((context) => {
        const group = resourceGroupOf(context.id);
        return hasAnyAlchemyTag(context.tags) &&
          group !== undefined &&
          context.name !== undefined
          ? [toAttrs(group, context.name, context)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        (news.name !== undefined &&
          news.name.toLowerCase() !== output.contextName.toLowerCase()) ||
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
      const name = output?.contextName ?? olds?.name ?? (yield* contextName(id));
      const observed = yield* getContext(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.Edge");
      const resourceGroup = news.resourceGroup;
      const name = news.name ?? output?.contextName ?? (yield* contextName(id));
      const tags = yield* desiredTags(id, news.tags);
      const get = getContext(subscriptionId, resourceGroup, name);

      // Observe.
      const observed = yield* get;

      const desired = {
        capabilities: news.capabilities,
        hierarchies: news.hierarchies,
      };

      // Ensure.
      if (observed === undefined) {
        yield* edge.ContextsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          contextName: name,
          location: news.location ?? output?.location ?? env.location,
          tags,
          properties: desired,
        });
      } else {
        // Sync: PATCH only the observed deltas.
        const observedAttrs = toAttrs(resourceGroup, name, observed);
        const delta: edge.ContextUpdateProperties = {
          ...(!sameJson(observedAttrs.capabilities, desired.capabilities)
            ? { capabilities: desired.capabilities }
            : {}),
          ...(!sameJson(observedAttrs.hierarchies, desired.hierarchies)
            ? { hierarchies: desired.hierarchies }
            : {}),
        };
        const tagsChanged = tagsDiffer(observed.tags, tags);
        if (tagsChanged || Object.keys(delta).length > 0) {
          yield* edge.UpdateContext({
            subscriptionId,
            resourceGroupName: resourceGroup,
            contextName: name,
            ...(tagsChanged ? { tags } : {}),
            properties: delta,
          });
        }
      }

      const fresh = yield* waitForProvisioned(
        `edge context ${name}`,
        get,
        edgeState,
        EDGE_WAIT,
      );
      return toAttrs(resourceGroup, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        edge.DeleteContext({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          contextName: output.contextName,
        }),
      );
      yield* waitUntilGone(
        `edge context ${output.contextName}`,
        getContext(subscriptionId, output.resourceGroup, output.contextName),
        EDGE_WAIT,
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
