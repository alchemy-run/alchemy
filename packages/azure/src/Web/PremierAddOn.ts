import * as web from "@distilled.cloud/azure/web";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import {
  desiredTags,
  ensureRegistered,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  tagsDiffer,
  userTags,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import { lower, sameLocation, siteWhere } from "./common.ts";

export interface PremierAddOnProps {
  /** Resource group of the app. Changing it replaces the add-on. */
  resourceGroup: string;
  /** Name of the web app or function app. Changing it replaces the add-on. */
  siteName: string;
  /**
   * Deployment slot of the app. Changing it replaces the add-on.
   * @default the production slot
   */
  slot?: string;
  /**
   * Name of the add-on. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the add-on.
   */
  name?: string;
  /**
   * Azure location; use the location of the app. Changing it replaces the
   * add-on.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Azure Marketplace publisher ID of the offer. Changing it replaces the
   * add-on.
   */
  publisher: string;
  /** Azure Marketplace offer ID. Changing it replaces the add-on. */
  offer: string;
  /**
   * Plan (SKU) of the offer to purchase. Changing it replaces the add-on.
   */
  plan: string;
  /** Promotion code for the purchase. Changing it replaces the add-on. */
  promotionCode?: string;
  /**
   * Vendor name shown for the add-on. Changing it replaces the add-on.
   * @default `publisher`
   */
  vendor?: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface PremierAddOn extends Resource<
  "Azure.Web.PremierAddOn",
  PremierAddOnProps,
  {
    /** Name of the add-on. */
    addOnName: string;
    /** ARM resource ID of the add-on. */
    addOnId: string;
    /** Name of the app. */
    siteName: string;
    /** Deployment slot, if slot-scoped. */
    slot: string | undefined;
    /** Resource group of the app. */
    resourceGroup: string;
    /** Location of the add-on. */
    location: string;
    /** Azure Marketplace publisher ID. */
    publisher: string | undefined;
    /** Azure Marketplace offer ID. */
    offer: string | undefined;
    /** Purchased plan (SKU). */
    plan: string | undefined;
    /** Vendor name of the add-on. */
    vendor: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Marketplace offer purchased as an add-on of an App Service app
 * (`Microsoft.Web/sites/premieraddons`, or `sites/slots/premieraddons` with
 * `slot`). ARM treats it as a 3rd-party store resource: the purchase plan
 * (`publisher`, `offer`, `plan`) is validated against the Marketplace, and
 * the subscription is billed by the publisher.
 *
 * An offer that does not exist (or that the subscription may not buy) is
 * rejected with `MarketplacePurchaseValidationFailed`.
 *
 * :::caution
 * Changing `resourceGroup`, `siteName`, `slot`, `name`, `location`,
 * `publisher`, `offer`, `plan`, `promotionCode`, or `vendor` replaces the
 * add-on (a new Marketplace purchase).
 * :::
 *
 * @see https://learn.microsoft.com/rest/api/appservice/web-apps/add-premier-add-on
 *
 * ### Adding a Marketplace Add-on
 * **Example:** Marketplace offer on a web app
 * ```typescript
 * const addOn = yield* Azure.Web.PremierAddOn("monitoring", {
 *   siteName: app.siteName,
 *   location: app.location,
 *   publisher: "contoso",
 *   offer: "contoso-apm",
 *   plan: "free",
 * });
 * // addOn.addOnId
 * ```
 *
 * @resource
 */
export const PremierAddOn = GroupedResource<PremierAddOn>("Azure.Web.PremierAddOn");

type ObservedAddOn = web.WebAppsGetPremierAddOnResponse;

const createAddOnName = (id: string) =>
  createPhysicalName({ id, maxLength: 60, lowercase: true });

const getAddOn = (
  subscriptionId: string,
  resourceGroup: string,
  siteName: string,
  slot: string | undefined,
  premierAddOnName: string,
) => {
  const where = { ...siteWhere(subscriptionId, resourceGroup, siteName), premierAddOnName };
  return orUndefinedIfNotFound(
    slot === undefined
      ? web.WebAppsGetPremierAddOn(where)
      : web.WebAppsGetPremierAddOnSlot({ ...where, slot }),
  );
};

const toAttrs = (
  resourceGroup: string,
  siteName: string,
  slot: string | undefined,
  addOnName: string,
  observed: ObservedAddOn,
): PremierAddOn["Attributes"] => ({
  addOnName,
  addOnId: observed.id ?? "",
  siteName,
  slot,
  resourceGroup,
  location: observed.location,
  publisher: observed.plan?.publisher ?? observed.properties?.marketplacePublisher,
  offer: observed.plan?.product ?? observed.properties?.marketplaceOffer,
  plan: observed.plan?.name ?? observed.properties?.sku,
  vendor: observed.properties?.vendor,
  tags: userTags(observed.tags),
});

export const PremierAddOnProvider = () =>
  Provider.succeed(PremierAddOn, {
    stables: ["addOnName", "addOnId", "siteName", "slot", "resourceGroup", "location"],

    // Add-ons are removed with their app.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.siteName) !== lower(output.siteName) ||
        lower(news.slot) !== lower(output.slot) ||
        (news.name !== undefined && lower(news.name) !== lower(output.addOnName)) ||
        (news.location !== undefined && !sameLocation(news.location, output.location)) ||
        lower(news.publisher) !== lower(olds?.publisher ?? output.publisher) ||
        lower(news.offer) !== lower(olds?.offer ?? output.offer) ||
        lower(news.plan) !== lower(olds?.plan ?? output.plan) ||
        news.promotionCode !== olds?.promotionCode ||
        news.vendor !== olds?.vendor
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const siteName = output?.siteName ?? olds?.siteName;
      if (resourceGroup === undefined || siteName === undefined) return undefined;
      const slot = output?.slot ?? olds?.slot;
      const name = output?.addOnName ?? olds?.name ?? (yield* createAddOnName(id));
      const observed = yield* getAddOn(subscriptionId, resourceGroup, siteName, slot, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, siteName, slot, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.Web");
      const { resourceGroup, siteName, slot } = news;
      const name = news.name ?? output?.addOnName ?? (yield* createAddOnName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const get = getAddOn(subscriptionId, resourceGroup, siteName, slot, name);

      // Observe.
      let observed = yield* get;

      // Ensure + sync. The purchase is immutable (changes replace it); the
      // PUT re-runs only when the add-on is missing or its tags drift (the
      // PATCH body cannot carry tags).
      if (observed === undefined || tagsDiffer(observed.tags, tags)) {
        const request = {
          ...siteWhere(subscriptionId, resourceGroup, siteName),
          premierAddOnName: name,
          location,
          tags,
          plan: {
            name: news.plan,
            publisher: news.publisher,
            product: news.offer,
            promotionCode: news.promotionCode,
          },
          properties: {
            sku: news.plan,
            product: news.offer,
            vendor: news.vendor ?? news.publisher,
            marketplacePublisher: news.publisher,
            marketplaceOffer: news.offer,
          },
        };
        const written = yield* slot === undefined
          ? web.WebAppsAddPremierAddOn(request)
          : web.WebAppsAddPremierAddOnSlot({ ...request, slot });
        observed = (yield* get) ?? written;
      }

      return toAttrs(resourceGroup, siteName, slot, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const where = {
        ...siteWhere(subscriptionId, output.resourceGroup, output.siteName),
        premierAddOnName: output.addOnName,
      };
      yield* ignoreNotFound(
        output.slot === undefined
          ? web.WebAppsDeletePremierAddOn(where)
          : web.WebAppsDeletePremierAddOnSlot({ ...where, slot: output.slot }),
      );
      yield* waitUntilGone(
        `premier add-on ${output.addOnName}`,
        getAddOn(
          subscriptionId,
          output.resourceGroup,
          output.siteName,
          output.slot,
          output.addOnName,
        ),
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.Resources.ResourceGroup",
        "Azure.Web.WebApp",
        "Azure.Web.FunctionApp",
        "Azure.Web.WebAppSlot",
      ],
    },
  });
