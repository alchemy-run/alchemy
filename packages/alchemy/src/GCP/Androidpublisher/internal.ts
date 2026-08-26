import * as androidpublisher from "@distilled.cloud/gcp/androidpublisher_v3";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { createPhysicalName } from "../../PhysicalName.ts";
import {
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
} from "../Labels.ts";

export const DEFAULT_LANGUAGE = "en-US";
export const DEFAULT_REGION = "US";
export const DEFAULT_CURRENCY = "USD";
export const DEFAULT_REGIONS_VERSION = "2025/01";
export const DEFAULT_PRICE_MICROS = "990000";
export const DEFAULT_SUBSCRIPTION_PRICE_UNITS = "5";
export const DEFAULT_BILLING_PERIOD = "P1M";
export const DEFAULT_OFFER_DURATION = "P1W";
export const MAX_PRODUCT_ID_LENGTH = 40;
export const MAX_BASE_PLAN_ID_LENGTH = 63;
export const MAX_OFFER_ID_LENGTH = 63;
export const MAX_SKU_LENGTH = 40;
export const MAX_LISTING_TITLE_LENGTH = 50;
export const MAX_LISTING_DESCRIPTION_LENGTH = 200;
export const MAX_INAPP_DESCRIPTION_LENGTH = 4000;
export const MAX_OFFER_TAG_LENGTH = 20;
export const PROBE_PACKAGE_NAME = "com.alchemy.missing.app";

export const packageNamesFromEnv = () => {
  const raw =
    process.env.GCP_ANDROIDPUBLISHER_PACKAGE_NAME?.trim() ||
    process.env.GCP_PLAY_PACKAGE_NAME?.trim();
  if (!raw) return [] as string[];
  return raw.split(/[,\s]+/).filter((name) => name.length > 0);
};

export const sameText = (left: string | undefined, right: string | undefined) =>
  (left ?? "") === (right ?? "");

export const jsonEqual = (left: unknown, right: unknown) =>
  JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

export const sameStringList = (
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
) =>
  jsonEqual(
    [...(left ?? [])].slice().sort(),
    [...(right ?? [])].slice().sort(),
  );

export const updateMaskOf = (...fields: Array<string | undefined>) =>
  fields.filter((field): field is string => field !== undefined).join(",");

const isMissing = <E extends { readonly _tag: string }>(
  error: E,
): error is Extract<E, { readonly _tag: "NotFound" | "Forbidden" }> =>
  error._tag === "NotFound" || error._tag === "Forbidden";

export const ignoreList =
  <A>(fallback: A) =>
  <A1, E extends { readonly _tag: string }, R>(
    self: Effect.Effect<A1, E, R>,
  ): Effect.Effect<A1 | A, E, R> =>
    self.pipe(Effect.catchIf(isMissing, () => Effect.succeed(fallback)));

export const catchMissing = <A, E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
) => effect.pipe(Effect.catchIf(isMissing, () => Effect.succeed(undefined)));

export const ignoreMissing = <E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<unknown, E, R>,
) => effect.pipe(Effect.catchIf(isMissing, () => Effect.void));

const emptyList = <A>() => Effect.succeed([] as A[]);

export const collectPages = <Page, A, E, R>(
  pages: Stream.Stream<Page, E, R>,
  items: (page: Page) => readonly A[] | undefined,
) =>
  pages.pipe(
    Stream.flatMap((page) => Stream.fromIterable(items(page) ?? [])),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
  );

const markerOf = (
  _labels: Record<string, string>,
  stack: string,
  stage: string,
  id: string,
) =>
  `[alchemy ${alchemyLabelKeys.stack}=${stack} ${alchemyLabelKeys.stage}=${stage} ${alchemyLabelKeys.id}=${id}]`;

const fitMarker = (labels: Record<string, string>, maxLength: number) => {
  let stack = labels[alchemyLabelKeys.stack] ?? "x";
  let stage = labels[alchemyLabelKeys.stage] ?? "x";
  let id = labels[alchemyLabelKeys.id] ?? "x";
  let marker = markerOf(labels, stack, stage, id);
  while (
    marker.length > maxLength &&
    (stack.length > 1 || stage.length > 1 || id.length > 1)
  ) {
    if (stack.length >= stage.length && stack.length >= id.length) {
      stack = stack.slice(0, -1);
    } else if (stage.length >= id.length) {
      stage = stage.slice(0, -1);
    } else {
      id = id.slice(0, -1);
    }
    marker = markerOf(labels, stack, stage, id);
  }
  return marker.slice(0, maxLength);
};

export const encodeOwnership = (
  labels: Record<string, string>,
  text: string | undefined,
  maxLength = MAX_INAPP_DESCRIPTION_LENGTH,
): string => {
  const marker = fitMarker(labels, Math.min(800, maxLength));
  const trimmed = text?.trim();
  const combined =
    trimmed && trimmed.length > 0 ? `${marker}\n${trimmed}` : marker;
  return combined.slice(0, maxLength);
};

export const encodeOwnershipLine = (
  labels: Record<string, string>,
  text: string | undefined,
  maxLength = MAX_LISTING_DESCRIPTION_LENGTH,
): string => {
  const trimmed = text?.replace(/[\r\n]+/g, " ").trim();
  if (!trimmed) return fitMarker(labels, maxLength);
  const minMarker = 24;
  const reserved = Math.min(
    trimmed.length + 1,
    Math.max(0, maxLength - minMarker),
  );
  const marker = fitMarker(labels, maxLength - reserved);
  return `${marker} ${trimmed}`.slice(0, maxLength);
};

export const parseOwnership = (
  text: string | undefined,
): {
  labels: Record<string, string>;
  text: string | undefined;
} => {
  if (!text?.startsWith("[alchemy ")) {
    return { labels: {}, text };
  }
  const end = text.indexOf("]");
  if (end < 0) return { labels: {}, text };
  const labels: Record<string, string> = {};
  for (const part of text.slice("[alchemy ".length, end).split(/\s+/)) {
    const eq = part.indexOf("=");
    if (eq > 0) {
      labels[part.slice(0, eq)] = part.slice(eq + 1);
    }
  }
  const rest = text.slice(end + 1).replace(/^[\s\n]+/, "");
  return { labels, text: rest.length > 0 ? rest : undefined };
};

export const hasOwnershipMarker = (text: string | undefined) =>
  Object.keys(parseOwnership(text).labels).some((key) =>
    key.startsWith("alchemy-"),
  );

const prefixMatch = (expected: string, observed: string) =>
  expected === observed ||
  expected.startsWith(observed) ||
  observed.startsWith(expected);

export const ownedByAlchemy = (id: string, text: string | undefined) =>
  Effect.gen(function* () {
    const expected = yield* createInternalLabels(id);
    const { labels } = parseOwnership(text);
    if (!hasOwnershipMarker(text)) return false;
    const exact = yield* hasAlchemyLabels(id, labels);
    if (exact) return true;
    return (
      prefixMatch(
        expected[alchemyLabelKeys.stack] ?? "",
        labels[alchemyLabelKeys.stack] ?? "",
      ) &&
      prefixMatch(
        expected[alchemyLabelKeys.stage] ?? "",
        labels[alchemyLabelKeys.stage] ?? "",
      ) &&
      prefixMatch(
        expected[alchemyLabelKeys.id] ?? "",
        labels[alchemyLabelKeys.id] ?? "",
      )
    );
  });

export const ownershipLabels = (id: string) => createInternalLabels(id);

const toGenerated = (
  id: string,
  requested: string | undefined,
  existing: string | undefined,
  options: {
    maxLength: number;
    delimiter: string;
    prefixIfNeeded: string;
  },
) =>
  Effect.gen(function* () {
    if (requested !== undefined && requested.length > 0) return requested;
    if (existing !== undefined && existing.length > 0) return existing;
    const generated = yield* createPhysicalName({
      id,
      maxLength: options.maxLength,
      lowercase: true,
      delimiter: options.delimiter,
    });
    const next = /^[a-z]/.test(generated)
      ? generated
      : `${options.prefixIfNeeded}${generated}`.slice(0, options.maxLength);
    const trimmed = next
      .replace(new RegExp(`${options.delimiter}+`, "g"), options.delimiter)
      .replace(
        new RegExp(`^${options.delimiter}|${options.delimiter}$`, "g"),
        "",
      );
    return trimmed.length >= 1
      ? trimmed
      : `${options.prefixIfNeeded}1`.slice(0, options.maxLength);
  });

export const toProductId = (
  id: string,
  requested: string | undefined,
  existing: string | undefined,
) =>
  toGenerated(id, requested, existing, {
    maxLength: MAX_PRODUCT_ID_LENGTH,
    delimiter: "_",
    prefixIfNeeded: "a",
  });

export const toSku = (
  id: string,
  requested: string | undefined,
  existing: string | undefined,
) =>
  toGenerated(id, requested, existing, {
    maxLength: MAX_SKU_LENGTH,
    delimiter: "_",
    prefixIfNeeded: "a",
  });

export const toBasePlanId = (
  id: string,
  requested: string | undefined,
  existing: string | undefined,
) =>
  toGenerated(id, requested, existing, {
    maxLength: MAX_BASE_PLAN_ID_LENGTH,
    delimiter: "-",
    prefixIfNeeded: "b",
  });

export const toOfferId = (
  id: string,
  requested: string | undefined,
  existing: string | undefined,
) =>
  toGenerated(id, requested, existing, {
    maxLength: MAX_OFFER_ID_LENGTH,
    delimiter: "-",
    prefixIfNeeded: "o",
  });

export const toDisplayName = (
  id: string,
  requested: string | undefined,
  existing: string | undefined,
  maxLength = MAX_LISTING_TITLE_LENGTH,
) =>
  Effect.gen(function* () {
    if (requested !== undefined && requested.length > 0) {
      return requested.slice(0, maxLength);
    }
    if (existing !== undefined && existing.length > 0) {
      return existing.slice(0, maxLength);
    }
    return (yield* toProductId(id, undefined, undefined)).slice(0, maxLength);
  });

export const offerOwnershipTag = (labels: Record<string, string>) => {
  const id = (labels[alchemyLabelKeys.id] ?? "x")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 16);
  const tag = `alc${id || "x"}`.slice(0, MAX_OFFER_TAG_LENGTH);
  return /^[a-z]/.test(tag) ? tag : `a${tag}`.slice(0, MAX_OFFER_TAG_LENGTH);
};

export const stampOfferTags = (
  labels: Record<string, string>,
  tags: readonly androidpublisher.OfferTag[] | undefined,
): androidpublisher.OfferTag[] => {
  const ownership = offerOwnershipTag(labels);
  const rest = (tags ?? []).filter((tag) => tag.tag !== ownership);
  return [{ tag: ownership }, ...rest].slice(0, 20);
};

export const hasOfferOwnership = (
  tags: readonly androidpublisher.OfferTag[] | undefined,
) => (tags ?? []).some((tag) => (tag.tag ?? "").startsWith("alc"));

export const offerOwnedByAlchemy = (
  id: string,
  offer: androidpublisher.SubscriptionOffer,
) =>
  Effect.gen(function* () {
    const labels = yield* createInternalLabels(id);
    const expected = offerOwnershipTag(labels);
    return (offer.offerTags ?? []).some((tag) => {
      const value = tag.tag ?? "";
      return value === expected || prefixMatch(expected, value);
    });
  });

export const stampSubscriptionListings = (
  labels: Record<string, string>,
  listings: readonly androidpublisher.SubscriptionListing[] | undefined,
  title: string,
): androidpublisher.SubscriptionListing[] => {
  const source =
    listings && listings.length > 0
      ? listings
      : [{ languageCode: DEFAULT_LANGUAGE, title }];
  return source.map((listing, index) =>
    index === 0
      ? {
          ...listing,
          title: listing.title ?? title,
          languageCode: listing.languageCode ?? DEFAULT_LANGUAGE,
          description: encodeOwnershipLine(
            labels,
            listing.description,
            MAX_LISTING_DESCRIPTION_LENGTH,
          ),
        }
      : listing,
  );
};

export const stampInappListings = (
  labels: Record<string, string>,
  listings: androidpublisher.InAppProductListingMap | undefined,
  title: string,
  defaultLanguage: string,
): androidpublisher.InAppProductListingMap => {
  const next = { ...(listings ?? {}) };
  const current = next[defaultLanguage] ?? { title };
  next[defaultLanguage] = {
    ...current,
    title: current.title ?? title,
    description: encodeOwnership(
      labels,
      current.description,
      MAX_INAPP_DESCRIPTION_LENGTH,
    ),
  };
  return next;
};

export const subscriptionOwnershipText = (
  subscription: androidpublisher.Subscription,
) =>
  subscription.listings?.[0]?.description ?? subscription.listings?.[0]?.title;

export const inappOwnershipText = (product: androidpublisher.InAppProduct) => {
  const listings = product.listings ?? {};
  const preferred =
    listings[product.defaultLanguage ?? DEFAULT_LANGUAGE] ??
    Object.values(listings)[0];
  return preferred?.description ?? preferred?.title;
};

export const stripListing = (
  listing: androidpublisher.SubscriptionListing | undefined,
): androidpublisher.SubscriptionListing | undefined => {
  if (listing === undefined) return undefined;
  return {
    ...listing,
    description: parseOwnership(listing.description).text,
    title: listing.title,
  };
};

export const publicListings = (
  listings: readonly androidpublisher.SubscriptionListing[] | undefined,
) => listings?.map((listing) => stripListing(listing) ?? listing);

export const publicInappListings = (
  listings: androidpublisher.InAppProductListingMap | undefined,
): androidpublisher.InAppProductListingMap | undefined => {
  if (listings === undefined) return undefined;
  return Object.fromEntries(
    Object.entries(listings).map(([language, listing]) => [
      language,
      listing
        ? {
            ...listing,
            description: parseOwnership(listing.description).text,
          }
        : listing,
    ]),
  );
};

export const publicBasePlans = (
  plans: readonly androidpublisher.BasePlan[] | undefined,
) =>
  plans?.map((plan) => ({
    regionalConfigs: plan.regionalConfigs,
    otherRegionsConfig: plan.otherRegionsConfig,
    offerTags: plan.offerTags,
    installmentsBasePlanType: plan.installmentsBasePlanType,
    autoRenewingBasePlanType: plan.autoRenewingBasePlanType,
    basePlanId: plan.basePlanId,
    prepaidBasePlanType: plan.prepaidBasePlanType,
  }));

export const defaultOfferPhases =
  (): androidpublisher.SubscriptionOfferPhase[] => [
    {
      duration: DEFAULT_OFFER_DURATION,
      recurrenceCount: 1,
      regionalConfigs: [{ regionCode: DEFAULT_REGION, free: {} }],
    },
  ];

export const defaultOfferRegionalConfigs =
  (): androidpublisher.RegionalSubscriptionOfferConfig[] => [
    { regionCode: DEFAULT_REGION, newSubscriberAvailability: true },
  ];

export const defaultOfferTargeting =
  (): androidpublisher.SubscriptionOfferTargeting => ({
    acquisitionRule: { scope: { thisSubscription: {} } },
  });

export const defaultInappPrice = (): androidpublisher.Price => ({
  currency: DEFAULT_CURRENCY,
  priceMicros: DEFAULT_PRICE_MICROS,
});

export const getSubscription = (packageName: string, productId: string) =>
  packageName.length === 0 || productId.length === 0
    ? Effect.succeed(undefined)
    : catchMissing(
        androidpublisher.getMonetizationSubscriptions({
          packageName,
          productId,
        }),
      );

export const getOffer = (
  packageName: string,
  productId: string,
  basePlanId: string,
  offerId: string,
) =>
  packageName.length === 0 ||
  productId.length === 0 ||
  basePlanId.length === 0 ||
  offerId.length === 0
    ? Effect.succeed(undefined)
    : catchMissing(
        androidpublisher.getMonetizationSubscriptionsBasePlansOffers({
          packageName,
          productId,
          basePlanId,
          offerId,
        }),
      );

export const getInappproduct = (packageName: string, sku: string) =>
  packageName.length === 0 || sku.length === 0
    ? Effect.succeed(undefined)
    : catchMissing(androidpublisher.getInappproducts({ packageName, sku }));

export const getEdit = (packageName: string, editId: string) =>
  packageName.length === 0 || editId.length === 0
    ? Effect.succeed(undefined)
    : catchMissing(androidpublisher.getEdits({ packageName, editId }));

export const listSubscriptionsAt = (packageName: string) =>
  packageName.length === 0
    ? emptyList<androidpublisher.Subscription>()
    : collectPages(
        androidpublisher.listMonetizationSubscriptions.pages({
          packageName,
          pageSize: 200,
        }),
        (page) => page.subscriptions,
      ).pipe(ignoreList([] as androidpublisher.Subscription[]));

export const listOffersAt = (packageName: string) =>
  packageName.length === 0
    ? emptyList<androidpublisher.SubscriptionOffer>()
    : collectPages(
        androidpublisher.listMonetizationSubscriptionsBasePlansOffers.pages({
          packageName,
          productId: "-",
          basePlanId: "-",
          pageSize: 200,
        }),
        (page) => page.subscriptionOffers,
      ).pipe(ignoreList([] as androidpublisher.SubscriptionOffer[]));

export const listInappproductsAt = (packageName: string) =>
  Effect.gen(function* () {
    if (packageName.length === 0) {
      return [] as androidpublisher.InAppProduct[];
    }
    const items: androidpublisher.InAppProduct[] = [];
    let token: string | undefined;
    for (let i = 0; i < 8; i++) {
      const page = yield* androidpublisher
        .listInappproducts({ packageName, token })
        .pipe(
          ignoreList(
            undefined as androidpublisher.InappproductsListResponse | undefined,
          ),
        );
      if (page === undefined) break;
      items.push(...(page.inappproduct ?? []));
      token = page.tokenPagination?.nextPageToken;
      if (!token) break;
    }
    return items;
  });

export const findOwnedSubscription = (id: string, packageName: string) =>
  Effect.gen(function* () {
    const subscriptions = yield* listSubscriptionsAt(packageName);
    for (const subscription of subscriptions) {
      if (yield* ownedByAlchemy(id, subscriptionOwnershipText(subscription))) {
        return subscription;
      }
    }
    return undefined;
  });

export const findOwnedOffer = (
  id: string,
  packageName: string,
  productId?: string,
  basePlanId?: string,
) =>
  Effect.gen(function* () {
    const offers = yield* listOffersAt(packageName);
    for (const offer of offers) {
      if (productId && offer.productId !== productId) continue;
      if (basePlanId && offer.basePlanId !== basePlanId) continue;
      if (yield* offerOwnedByAlchemy(id, offer)) return offer;
    }
    return undefined;
  });

export const findOwnedInappproduct = (
  id: string,
  packageName: string,
  sku?: string,
) =>
  Effect.gen(function* () {
    const products = yield* listInappproductsAt(packageName);
    for (const product of products) {
      if (sku && product.sku !== sku) continue;
      if (yield* ownedByAlchemy(id, inappOwnershipText(product))) {
        return product;
      }
    }
    return undefined;
  });

export const listOwnedSubscriptions = () =>
  Effect.gen(function* () {
    const packageNames = packageNamesFromEnv();
    const pages = yield* Effect.forEach(
      packageNames,
      (packageName) =>
        listSubscriptionsAt(packageName).pipe(
          Effect.map((subscriptions) =>
            subscriptions.filter((subscription) =>
              hasOwnershipMarker(subscriptionOwnershipText(subscription)),
            ),
          ),
        ),
      { concurrency: 4 },
    );
    return pages.flat();
  });

export const listOwnedOffers = () =>
  Effect.gen(function* () {
    const packageNames = packageNamesFromEnv();
    const pages = yield* Effect.forEach(
      packageNames,
      (packageName) =>
        listOffersAt(packageName).pipe(
          Effect.map((offers) =>
            offers.filter((offer) => hasOfferOwnership(offer.offerTags)),
          ),
        ),
      { concurrency: 4 },
    );
    return pages.flat();
  });

export const listOwnedInappproducts = () =>
  Effect.gen(function* () {
    const packageNames = packageNamesFromEnv();
    const pages = yield* Effect.forEach(
      packageNames,
      (packageName) =>
        listInappproductsAt(packageName).pipe(
          Effect.map((products) =>
            products.filter((product) =>
              hasOwnershipMarker(inappOwnershipText(product)),
            ),
          ),
        ),
      { concurrency: 4 },
    );
    return pages.flat();
  });
