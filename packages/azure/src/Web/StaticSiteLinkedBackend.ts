import * as web from "@distilled.cloud/azure/web";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import { lower, sameLocation } from "./common.ts";

export interface StaticSiteLinkedBackendProps {
  /**
   * Resource group of the static site. Changing it replaces the link.
   */
  resourceGroup: string;
  /** Name of the static site. Changing it replaces the link. */
  staticSiteName: string;
  /**
   * Environment (build) the link applies to, e.g. a pull request preview
   * environment. Changing it replaces the link.
   * @default the production environment
   */
  environmentName?: string;
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
    /** Environment (build), if environment-scoped. */
    environmentName: string | undefined;
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
 * it (`Microsoft.Web/staticSites/linkedBackends`, or
 * `staticSites/builds/linkedBackends` with `environmentName`). Requires the
 * `Standard` plan; a site has at most one linked backend.
 *
 * @see https://learn.microsoft.com/azure/static-web-apps/apis-overview
 *
 * ### Linking a Backend
 * **Example:** Function app behind `/api`
 * ```typescript
 * const site = yield* Azure.Web.StaticSite("site", {
 *   sku: "Standard",
 * });
 * yield* Azure.Web.StaticSiteLinkedBackend("api", {
 *   staticSiteName: site.staticSiteName,
 *   backendResourceId: functionApp.siteId,
 *   region: functionApp.location,
 * });
 * ```
 *
 * @resource
 */
export const StaticSiteLinkedBackend = GroupedResource<StaticSiteLinkedBackend>(
  "Azure.Web.StaticSiteLinkedBackend",
);

type ObservedLink = web.GetStaticSiteLinkedBackendResponse;

const createLinkName = (id: string) => createPhysicalName({ id, maxLength: 40, lowercase: true });

const getLink = (
  subscriptionId: string,
  resourceGroupName: string,
  name: string,
  environmentName: string | undefined,
  linkedBackendName: string,
) => {
  const where = { subscriptionId, resourceGroupName, name, linkedBackendName };
  return orUndefinedIfNotFound(
    environmentName === undefined
      ? web.GetStaticSiteLinkedBackend(where)
      : web.GetStaticSiteLinkedBackendForBuild({ ...where, environmentName }),
  );
};

const toAttrs = (
  props: {
    resourceGroup: string;
    staticSiteName: string;
    environmentName: string | undefined;
    linkedBackendName: string;
    cleanAuthConfigOnUnlink: boolean;
  },
  link: ObservedLink,
): StaticSiteLinkedBackend["Attributes"] => ({
  linkedBackendName: props.linkedBackendName,
  staticSiteName: props.staticSiteName,
  environmentName: props.environmentName,
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
      "environmentName",
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
        news.environmentName !== output.environmentName ||
        (news.name !== undefined && lower(news.name) !== lower(output.linkedBackendName)) ||
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
      const environmentName = output?.environmentName ?? olds?.environmentName;
      const linkedBackendName =
        output?.linkedBackendName ?? olds?.name ?? (yield* createLinkName(id));
      const observed = yield* getLink(
        subscriptionId,
        resourceGroup,
        staticSiteName,
        environmentName,
        linkedBackendName,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(
        {
          resourceGroup,
          staticSiteName,
          environmentName,
          linkedBackendName,
          cleanAuthConfigOnUnlink:
            output?.cleanAuthConfigOnUnlink ?? olds?.cleanAuthConfigOnUnlink ?? true,
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
        environmentName: news.environmentName,
        linkedBackendName: news.name ?? output?.linkedBackendName ?? (yield* createLinkName(id)),
        cleanAuthConfigOnUnlink: news.cleanAuthConfigOnUnlink ?? true,
      };
      const get = getLink(
        subscriptionId,
        props.resourceGroup,
        props.staticSiteName,
        props.environmentName,
        props.linkedBackendName,
      );

      // Observe.
      const observed = yield* get;

      // Ensure. A link has no mutable properties; a failed link is re-sent.
      if (observed === undefined || observed.properties?.provisioningState === "Failed") {
        const request = {
          subscriptionId,
          resourceGroupName: props.resourceGroup,
          name: props.staticSiteName,
          linkedBackendName: props.linkedBackendName,
          properties: {
            backendResourceId: news.backendResourceId,
            region: news.region,
          },
        };
        yield* props.environmentName === undefined
          ? web.StaticSitesLinkBackend(request)
          : web.StaticSitesLinkBackendToBuild({
              ...request,
              environmentName: props.environmentName,
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
      const where = {
        subscriptionId,
        resourceGroupName: output.resourceGroup,
        name: output.staticSiteName,
        linkedBackendName: output.linkedBackendName,
        isCleaningAuthConfig: output.cleanAuthConfigOnUnlink,
      };
      yield* ignoreNotFound(
        output.environmentName === undefined
          ? web.UnlinkStaticSiteBackend(where)
          : web.UnlinkStaticSiteBackendFromBuild({
              ...where,
              environmentName: output.environmentName,
            }),
      );
      yield* waitUntilGone(
        `linked backend ${output.linkedBackendName}`,
        getLink(
          subscriptionId,
          output.resourceGroup,
          output.staticSiteName,
          output.environmentName,
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
