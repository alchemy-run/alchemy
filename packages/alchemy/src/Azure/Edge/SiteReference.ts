import * as edge from "@distilled.cloud/azure/edge";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
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
import { EDGE_WAIT, edgeState, sameId } from "./EdgeShared.ts";

export interface SiteReferenceProps {
  /** Resource group of the context. Changing it replaces the reference. */
  resourceGroup: string;
  /** Name of the parent context. Changing it replaces the reference. */
  context: string;
  /**
   * Name of the site reference: 3-24 letters, digits, and `-`. If
   * omitted, a unique name is generated
   * from the app, stage, and logical ID. Changing it replaces the
   * reference.
   */
  name?: string;
  /** ARM resource ID of the `Azure.Edge.Site` to add to the context. */
  siteId: string;
}

export interface SiteReference extends Resource<
  "Azure.Edge.SiteReference",
  SiteReferenceProps,
  {
    /** Name of the site reference. */
    siteReferenceName: string;
    /** Name of the parent context. */
    context: string;
    /** Resource group of the context. */
    resourceGroup: string;
    /** ARM resource ID of the site reference. */
    siteReferenceId: string;
    /** ARM resource ID of the referenced site. */
    siteId: string;
  },
  never,
  Providers
> {}

/**
 * Adds an Azure Arc site to a workload orchestration context, making the
 * site a hierarchy entity that targets and configurations can attach to.
 *
 * Site references carry no tags or free-form fields, so Alchemy cannot
 * mark them; one found under the expected name is treated as this
 * resource.
 *
 * @see https://learn.microsoft.com/azure/azure-arc/workload-orchestration/overview
 *
 * ### Linking a Site
 * **Example:** Site in the context
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
export const SiteReference = Resource<SiteReference>(
  "Azure.Edge.SiteReference",
);

const getReference = (
  subscriptionId: string,
  resourceGroupName: string,
  contextName: string,
  siteReferenceName: string,
) =>
  orUndefinedIfNotFound(
    edge.GetSiteReference({
      subscriptionId,
      resourceGroupName,
      contextName,
      siteReferenceName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  context: string,
  name: string,
  observed: edge.GetSiteReferenceResponse,
): SiteReference["Attributes"] => ({
  siteReferenceName: name,
  context,
  resourceGroup,
  siteReferenceId: observed.id ?? "",
  siteId: observed.properties?.siteId ?? "",
});

const referenceName = (id: string) => createPhysicalName({ id, maxLength: 24 });

export const SiteReferenceProvider = () =>
  Provider.succeed(SiteReference, {
    stables: [
      "siteReferenceName",
      "context",
      "resourceGroup",
      "siteReferenceId",
    ],

    // References vanish with their context.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        news.context.toLowerCase() !== output.context.toLowerCase() ||
        (news.name !== undefined &&
          news.name.toLowerCase() !== output.siteReferenceName.toLowerCase())
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const context = output?.context ?? olds?.context;
      if (resourceGroup === undefined || context === undefined)
        return undefined;
      const name =
        output?.siteReferenceName ?? olds?.name ?? (yield* referenceName(id));
      const observed = yield* getReference(
        subscriptionId,
        resourceGroup,
        context,
        name,
      );
      return observed === undefined
        ? undefined
        : toAttrs(resourceGroup, context, name, observed);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Edge");
      const { resourceGroup, context } = news;
      const name =
        news.name ?? output?.siteReferenceName ?? (yield* referenceName(id));
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        contextName: context,
        siteReferenceName: name,
      };
      const get = getReference(subscriptionId, resourceGroup, context, name);

      // Observe.
      const observed = yield* get;

      // Ensure, then sync the referenced site against observed state.
      if (observed === undefined) {
        yield* edge.SiteReferencesCreateOrUpdate({
          ...where,
          properties: { siteId: news.siteId },
        });
      } else if (!sameId(observed.properties?.siteId, news.siteId)) {
        yield* edge.UpdateSiteReference({
          ...where,
          properties: { siteId: news.siteId },
        });
      }

      const fresh = yield* waitForProvisioned(
        `edge site reference ${context}/${name}`,
        get,
        edgeState,
        EDGE_WAIT,
      );
      return toAttrs(resourceGroup, context, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        edge.DeleteSiteReference({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          contextName: output.context,
          siteReferenceName: output.siteReferenceName,
        }),
      );
      yield* waitUntilGone(
        `edge site reference ${output.context}/${output.siteReferenceName}`,
        getReference(
          subscriptionId,
          output.resourceGroup,
          output.context,
          output.siteReferenceName,
        ),
        EDGE_WAIT,
      );
    }),
  });
