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
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { EDGE_WAIT, edgeState, sameJson } from "./EdgeShared.ts";
import type { SiteAddress } from "./Site.ts";

export interface SubscriptionSiteProps {
  /**
   * Name of the site, unique within the subscription. If omitted, a unique
   * name is generated from the app, stage, and logical ID. Changing it
   * replaces the site.
   */
  name?: string;
  /** Display name of the site. */
  displayName?: string;
  /** Description of the site. */
  description?: string;
  /** Physical address of the site. */
  siteAddress?: SiteAddress;
  /**
   * User labels. Sites have no ARM tags, so Alchemy ownership markers
   * (`alchemy::stack`, `alchemy::stage`, `alchemy::id`) are merged into the
   * labels.
   */
  labels?: Record<string, string>;
}

export interface SubscriptionSite extends Resource<
  "Azure.Edge.SubscriptionSite",
  SubscriptionSiteProps,
  {
    /** Name of the site. */
    siteName: string;
    /** ARM resource ID of the site. */
    siteId: string;
    /** Display name of the site. */
    displayName: string | undefined;
    /** Description of the site. */
    description: string | undefined;
    /** Physical address of the site. */
    siteAddress: SiteAddress | undefined;
    /** User labels (Alchemy ownership markers stripped). */
    labels: Record<string, string>;
    /** Provisioning state of the last operation. */
    provisioningState: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An Azure Arc site manager site at subscription scope. It groups every
 * Arc resource in the subscription under one physical location.
 *
 * Sites have no ARM tags; Alchemy records ownership in the site's labels.
 *
 * @see https://learn.microsoft.com/azure/azure-arc/site-manager/overview
 *
 * ### Creating a Site
 * **Example:** Subscription-wide site
 * ```typescript
 * const site = yield* Azure.Edge.SubscriptionSite("hq", {
 *   displayName: "Headquarters",
 *   siteAddress: { city: "Redmond", country: "US" },
 * });
 * ```
 *
 * @resource
 */
export const SubscriptionSite = Resource<SubscriptionSite>(
  "Azure.Edge.SubscriptionSite",
);

const getSite = (subscriptionId: string, siteName: string) =>
  orUndefinedIfNotFound(
    edge.GetSitesBySubscription({ subscriptionId, siteName }),
  );

const toAttrs = (
  name: string,
  site: edge.GetSitesBySubscriptionResponse,
): SubscriptionSite["Attributes"] => ({
  siteName: name,
  siteId: site.id ?? "",
  displayName: site.properties?.displayName,
  description: site.properties?.description,
  siteAddress: site.properties?.siteAddress,
  labels: userTags(site.properties?.labels),
  provisioningState: site.properties?.provisioningState,
});

const siteName = (id: string) => createPhysicalName({ id, maxLength: 63 });

export const SubscriptionSiteProvider = () =>
  Provider.succeed(SubscriptionSite, {
    stables: ["siteName", "siteId"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* edge
        .ListSitesBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListSitesBySubscription", page),
          ),
        );
      return page.value.flatMap((site) =>
        site.name !== undefined &&
        !/\/resourceGroups\//i.test(site.id ?? "") &&
        hasAnyAlchemyTag(site.properties?.labels)
          ? [toAttrs(site.name, site)]
          : [],
      );
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.name !== undefined &&
        news.name.toLowerCase() !== output.siteName.toLowerCase()
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const name = output?.siteName ?? olds?.name ?? (yield* siteName(id));
      const observed = yield* getSite(subscriptionId, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(name, observed);
      return (yield* isOwned(id, observed.properties?.labels))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Edge");
      const name = news.name ?? output?.siteName ?? (yield* siteName(id));
      const labels = yield* desiredTags(id, news.labels);
      const get = getSite(subscriptionId, name);

      // Observe.
      const observed = yield* get;

      // Ensure + sync with one full PUT (PATCH cannot remove labels).
      const props = observed?.properties;
      if (
        observed === undefined ||
        props?.displayName !== news.displayName ||
        props?.description !== news.description ||
        !sameJson(props?.siteAddress, news.siteAddress) ||
        tagsDiffer(props?.labels, labels)
      ) {
        yield* edge.SitesBySubscriptionCreateOrUpdate({
          subscriptionId,
          siteName: name,
          properties: {
            displayName: news.displayName,
            description: news.description,
            siteAddress: news.siteAddress,
            labels,
          },
        });
      }

      const fresh = yield* waitForProvisioned(
        `edge subscription site ${name}`,
        get,
        edgeState,
        EDGE_WAIT,
      );
      return toAttrs(name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        edge.DeleteSitesBySubscription({
          subscriptionId,
          siteName: output.siteName,
        }),
      );
      yield* waitUntilGone(
        `edge subscription site ${output.siteName}`,
        getSite(subscriptionId, output.siteName),
        EDGE_WAIT,
      );
    }),
  });
