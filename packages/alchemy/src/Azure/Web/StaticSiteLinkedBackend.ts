import * as web from "@distilled.cloud/azure/web";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
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
import { lower, sameLocation } from "./common.ts";

export interface StaticSiteLinkedBackendProps {
  /**
   * Resource group of the static site. Changing it replaces the link.
   */
  resourceGroup: string;
  /** Name of the static site. Changing it replaces the link. */
  staticSiteName: string;
  /**
   * Name of the link. If omitted, a unique name is generated from the app,
   * stage, and logical ID. Changing it replaces the link.
   */
  name?: string;
  /**
   * ARM ID of the backend: a function app, container app, API Management
   * instance, or web app. Changing it replaces the link.
   */
  backendResourceId: string;
  /**
   * Location of the backend, e.g. `eastus`. Changing it replaces the link.
   */
  region: string;
  /**
   * Remove the authentication settings Azure added to the backend when the
   * link is deleted.
   * @default true
   */
  cleanAuthConfigOnUnlink?: boolean;
}

export interface StaticSiteLinkedBackend extends Resource<
  "Azure.Web.StaticSiteLinkedBackend",
  StaticSiteLinkedBackendProps,
  {
    /** Name of the link. */
    linkedBackendName: string;
    /** Name of the static site. */
    staticSiteName: string;
    /** Resource group of the static site. */
    resourceGroup: string;
    /** ARM resource ID of the link. */
    linkedBackendId: string;
    /** ARM ID of the backend. */
    backendResourceId: string;
    /** Location of the backend. */
    region: string;
    /** Provisioning state of the link. */
    provisioningState: string | undefined;
    /** Whether deleting the link removes the backend's auth settings. */
    cleanAuthConfigOnUnlink: boolean;
  },
  never,
  Providers
> {}

/**
 * Links an Azure Static Web App to a backend API (function app, container
 * app, API Management, or web app) so requests to `/api/*` are proxied to
 * it. Requires the `Standard` plan; a site has at most one linked backend.
 *
 * @see https://learn.microsoft.com/azure/static-web-apps/apis-overview
 *
 * ### Linking a Backend
 * **Example:** Function app behind `/api`
 * ```typescript
 * const site = yield* Azure.Web.StaticSite("site", {
 *   resourceGroup: group.resourceGroupName,
 *   sku: "Standard",
 * });
 * yield* Azure.Web.StaticSiteLinkedBackend("api", {
 *   resourceGroup: group.resourceGroupName,
 *   staticSiteName: site.staticSiteName,
 *   backendResourceId: functionApp.siteId,
 *   region: functionApp.location,
 * });
 * ```
 *
 * @resource
 */
export const StaticSiteLinkedBackend = Resource<StaticSiteLinkedBackend>(
  "Azure.Web.StaticSiteLinkedBackend",
);

type ObservedLink = web.GetStaticSiteLinkedBackendResponse;

const createLinkName = (id: string) =>
  createPhysicalName({ id, maxLength: 40, lowercase: true });

const getLink = (
  subscriptionId: string,
  resourceGroupName: string,
  name: string,
  linkedBackendName: string,
) =>
  orUndefinedIfNotFound(
    web.GetStaticSiteLinkedBackend({
      subscriptionId,
      resourceGroupName,
      name,
      linkedBackendName,
    }),
  );

const toAttrs = (
  props: {
    resourceGroup: string;
    staticSiteName: string;
    linkedBackendName: string;
    cleanAuthConfigOnUnlink: boolean;
  },
  link: ObservedLink,
): StaticSiteLinkedBackend["Attributes"] => ({
  linkedBackendName: props.linkedBackendName,
  staticSiteName: props.staticSiteName,
  resourceGroup: props.resourceGroup,
  linkedBackendId: link.id ?? "",
  backendResourceId: link.properties?.backendResourceId ?? "",
  region: link.properties?.region ?? "",
  provisioningState: link.properties?.provisioningState,
  cleanAuthConfigOnUnlink: props.cleanAuthConfigOnUnlink,
});

export const StaticSiteLinkedBackendProvider = () =>
  Provider.succeed(StaticSiteLinkedBackend, {
    stables: [
      "linkedBackendName",
      "staticSiteName",
      "resourceGroup",
      "linkedBackendId",
      "backendResourceId",
      "region",
    ],

    // Links are removed with their static site.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.staticSiteName) !== lower(output.staticSiteName) ||
        (news.name !== undefined &&
          lower(news.name) !== lower(output.linkedBackendName)) ||
        lower(news.backendResourceId) !== lower(output.backendResourceId) ||
        !sameLocation(news.region, output.region)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const staticSiteName = output?.staticSiteName ?? olds?.staticSiteName;
      if (resourceGroup === undefined || staticSiteName === undefined) {
        return undefined;
      }
      const linkedBackendName =
        output?.linkedBackendName ?? olds?.name ?? (yield* createLinkName(id));
      const observed = yield* getLink(
        subscriptionId,
        resourceGroup,
        staticSiteName,
        linkedBackendName,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(
        {
          resourceGroup,
          staticSiteName,
          linkedBackendName,
          cleanAuthConfigOnUnlink:
            output?.cleanAuthConfigOnUnlink ??
            olds?.cleanAuthConfigOnUnlink ??
            true,
        },
        observed,
      );
      // Links carry no tags; only a link this stack recorded is known to be
      // ours.
      return output !== undefined ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Web");
      const props = {
        resourceGroup: news.resourceGroup,
        staticSiteName: news.staticSiteName,
        linkedBackendName:
          news.name ?? output?.linkedBackendName ?? (yield* createLinkName(id)),
        cleanAuthConfigOnUnlink: news.cleanAuthConfigOnUnlink ?? true,
      };
      const get = getLink(
        subscriptionId,
        props.resourceGroup,
        props.staticSiteName,
        props.linkedBackendName,
      );

      // Observe.
      const observed = yield* get;

      // Ensure. A link has no mutable properties; a failed link is re-sent.
      if (
        observed === undefined ||
        observed.properties?.provisioningState === "Failed"
      ) {
        yield* web.StaticSitesLinkBackend({
          subscriptionId,
          resourceGroupName: props.resourceGroup,
          name: props.staticSiteName,
          linkedBackendName: props.linkedBackendName,
          properties: {
            backendResourceId: news.backendResourceId,
            region: news.region,
          },
        });
      }
      const ready = yield* waitForProvisioned(
        `linked backend ${props.linkedBackendName}`,
        get,
        (link) => link.properties?.provisioningState,
        { interval: "5 seconds", times: 60 },
      );
      return toAttrs(props, ready);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        web.UnlinkStaticSiteBackend({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          name: output.staticSiteName,
          linkedBackendName: output.linkedBackendName,
          isCleaningAuthConfig: output.cleanAuthConfigOnUnlink,
        }),
      );
      yield* waitUntilGone(
        `linked backend ${output.linkedBackendName}`,
        getLink(
          subscriptionId,
          output.resourceGroup,
          output.staticSiteName,
          output.linkedBackendName,
        ),
        { interval: "5 seconds", times: 60 },
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.Resources.ResourceGroup",
        "Azure.Web.StaticSite",
        "Azure.Web.FunctionApp",
        "Azure.Web.WebApp",
      ],
    },
  });
