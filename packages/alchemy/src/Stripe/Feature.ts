import type { StripeOpContext, StripeOpError } from "@distilled.cloud/stripe";
import {
  type EntitlementsFeature,
  GetEntitlementsFeatures,
  GetEntitlementsFeaturesId,
  PostEntitlementsFeatures,
  PostEntitlementsFeaturesId,
} from "@distilled.cloud/stripe/stripe";
import * as Effect from "effect/Effect";
import { Unowned } from "../AdoptPolicy.ts";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import {
  brandMetadata,
  isOwned,
  type Metadata,
  metadataEqual,
  metadataUpdate,
  stripInternalMetadata,
} from "./Metadata.ts";
import type { Providers } from "./Providers.ts";

/**
 * Stripe's generated metadata maps are `{ [key: string]: string | undefined }`
 * (the generator widens every optional record value). Alchemy's metadata
 * helpers work on a dense `Record<string, string>`, so drop the holes.
 */
const denseMetadata = (
  metadata: { readonly [key: string]: string | undefined } | null | undefined,
): Metadata =>
  Object.fromEntries(
    Object.entries(metadata ?? {}).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );

/**
 * Stripe reports a missing object as an HTTP 404, but distilled dispatches on
 * the Stripe `error.type` first — so a deleted feature can surface either as
 * `NotFound` or as `InvalidRequestError` with `code === "resource_missing"`.
 * Both mean "absent".
 */
const absentAsUndefined = <A>(
  effect: Effect.Effect<A, StripeOpError, StripeOpContext>,
): Effect.Effect<A | undefined, StripeOpError, StripeOpContext> =>
  effect.pipe(
    Effect.map((value): A | undefined => value),
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
    Effect.catchTag("InvalidRequestError", (error) =>
      error.code === "resource_missing"
        ? Effect.succeed(undefined)
        : Effect.fail(error),
    ),
  );

/** Stripe's list endpoints cap `limit` at 100. */
const PAGE_SIZE = 100;
/** Hard bound on pagination so a runaway cursor can never spin forever. */
const MAX_PAGES = 50;

/**
 * Exhaustively enumerate features, optionally filtered by lookup key and/or
 * archive status. Stripe's default (unfiltered) listing omits archived
 * features, so callers that need archived rows pass `archived: true`.
 */
const listFeatures = Effect.fn(function* (options: {
  lookupKey?: string;
  archived?: boolean;
}) {
  const features: EntitlementsFeature[] = [];
  let startingAfter: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const response = yield* GetEntitlementsFeatures({
      limit: PAGE_SIZE,
      ...(options.lookupKey !== undefined
        ? { lookup_key: options.lookupKey }
        : {}),
      ...(options.archived !== undefined ? { archived: options.archived } : {}),
      ...(startingAfter !== undefined ? { starting_after: startingAfter } : {}),
    });
    features.push(...response.data);
    const last = response.data[response.data.length - 1];
    if (!response.has_more || last === undefined) break;
    startingAfter = last.id;
  }
  return features;
});

/**
 * Resolve a feature by its lookup key. Checks active features first, then
 * archived ones — an archived feature still reserves its lookup key, so
 * rediscovering it is the difference between converging and failing with a
 * duplicate-key error.
 */
const findFeatureByLookupKey = Effect.fn(function* (lookupKey: string) {
  const active = yield* listFeatures({ lookupKey });
  const match = active.find((feature) => feature.lookup_key === lookupKey);
  if (match) return match;
  const archived = yield* listFeatures({ lookupKey, archived: true });
  return archived.find((feature) => feature.lookup_key === lookupKey);
});

const getFeature = (featureId: string) =>
  absentAsUndefined(GetEntitlementsFeaturesId({ id: featureId }));

const featureAttrs = (feature: EntitlementsFeature): Feature["Attributes"] => ({
  featureId: feature.id,
  lookupKey: feature.lookup_key,
  name: feature.name,
  active: feature.active,
  livemode: feature.livemode,
  metadata: stripInternalMetadata(denseMetadata(feature.metadata)),
});

export type FeatureProps = {
  /**
   * A unique key you provide as your own system identifier for the feature.
   * Up to 80 characters. Changing it **replaces** the feature — Stripe treats
   * the lookup key as the feature's immutable natural key.
   *
   * Lookup keys stay reserved even after a feature is archived, so a
   * destroyed-then-recreated feature must either reuse the same key (it is
   * re-activated) or pick a new one.
   */
  lookupKey: string;
  /**
   * The feature's name, for your own purpose. Not meant to be displayed to
   * the customer. Updated in place.
   */
  name: string;
  /**
   * Whether the feature is active. Inactive (archived) features cannot be
   * attached to new products and are omitted from the default feature
   * listing.
   *
   * @default true
   */
  active?: boolean;
  /**
   * Arbitrary key/value pairs to attach to the feature. Alchemy additionally
   * writes three reserved `alchemy_*` keys used to identify the objects it
   * owns; those are stripped from the `metadata` attribute.
   */
  metadata?: Record<string, string>;
};

export type Feature = Resource<
  "Stripe.Feature",
  FeatureProps,
  {
    /** Stripe's unique identifier for the feature (`feat_…`). */
    featureId: string;
    /** The unique lookup key the feature was created with. */
    lookupKey: string;
    /** The feature's name. */
    name: string;
    /** Whether the feature is active. Archived features report `false`. */
    active: boolean;
    /** `true` when the feature lives in live mode, `false` in test mode. */
    livemode: boolean;
    /** User-supplied metadata, with alchemy's reserved keys removed. */
    metadata: Record<string, string>;
  },
  never,
  Providers
>;

/**
 * A Stripe Entitlements feature — a monetizable ability or functionality in
 * your system. Attach a feature to a product with `Stripe.ProductFeature`, and
 * Stripe grants an entitlement to every customer who purchases that product.
 *
 * :::caution
 * Stripe does not support deleting features. Destroying this resource
 * **archives** it (`active: false`); the feature remains visible in the
 * dashboard and its `lookupKey` stays permanently reserved. Deploying a
 * feature with the same `lookupKey` again re-activates the archived object
 * rather than creating a new one.
 * :::
 *
 * ### Creating a Feature
 * **Example:** Basic feature
 * ```typescript
 * const feature = yield* Stripe.Feature("premium-support", {
 *   lookupKey: "premium_support",
 *   name: "Premium Support",
 * });
 * ```
 *
 * **Example:** Feature with metadata
 * ```typescript
 * const feature = yield* Stripe.Feature("api-access", {
 *   lookupKey: "api_access",
 *   name: "API Access",
 *   metadata: {
 *     tier: "pro",
 *     rate_limit: "10000",
 *   },
 * });
 * ```
 *
 * ### Archiving a Feature
 * **Example:** Archive a feature without destroying the resource
 * ```typescript
 * const feature = yield* Stripe.Feature("legacy-reports", {
 *   lookupKey: "legacy_reports",
 *   name: "Legacy Reports",
 *   active: false,
 * });
 * ```
 *
 * ### Attaching a Feature to a Product
 * **Example:** Grant entitlements to purchasers of a product
 * ```typescript
 * const product = yield* Stripe.Product("pro-plan", { name: "Pro Plan" });
 * const feature = yield* Stripe.Feature("api-access", {
 *   lookupKey: "api_access",
 *   name: "API Access",
 * });
 *
 * yield* Stripe.ProductFeature("pro-api-access", {
 *   productId: product.productId,
 *   entitlementFeatureId: feature.featureId,
 * });
 * ```
 *
 * @see https://docs.stripe.com/api/entitlements/feature
 *
 * @resource
 */
export const Feature = Resource<Feature>("Stripe.Feature");

export const FeatureProvider = () =>
  Provider.succeed(Feature, {
    stables: ["featureId", "lookupKey"],
    list: Effect.fn(function* () {
      // Stripe's default listing omits archived features, so enumerate both
      // halves and de-duplicate by id.
      const active = yield* listFeatures({ archived: false });
      const archived = yield* listFeatures({ archived: true });
      const byId = new Map<string, EntitlementsFeature>();
      for (const feature of [...active, ...archived]) {
        byId.set(feature.id, feature);
      }
      return [...byId.values()].map(featureAttrs);
    }),
    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news)) return undefined;
      // The lookup key is the feature's immutable natural key — Stripe has no
      // API to change it, so any change forces a replacement. Everything else
      // (name, active, metadata) is updated in place by `reconcile`.
      if (output !== undefined && news.lookupKey !== output.lookupKey) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),
    read: Effect.fn(function* ({ id, olds, output }) {
      let observed = output?.featureId
        ? yield* getFeature(output.featureId)
        : undefined;
      if (!observed) {
        // State loss (or a stale id): rediscover by lookup key. Stripe's list
        // endpoint filters on `lookup_key` directly, so this is a single call
        // rather than a full enumeration.
        const lookupKey = output?.lookupKey ?? olds?.lookupKey;
        if (lookupKey !== undefined) {
          observed = yield* findFeatureByLookupKey(lookupKey);
        }
      }
      if (!observed) return undefined;
      const attrs = featureAttrs(observed);
      // A feature that exists but carries no alchemy branding belongs to
      // someone else — gate takeover behind `--adopt`.
      return (yield* isOwned(id, denseMetadata(observed.metadata)))
        ? attrs
        : Unowned(attrs);
    }),
    reconcile: Effect.fn(function* ({ id, news, output }) {
      const desiredMetadata = yield* brandMetadata(id, news.metadata);
      const desiredActive = news.active ?? true;

      // 1. Observe — the cached id is a hint, not proof the feature exists.
      //    Fall back to the lookup key, which is the feature's natural key
      //    (and stays reserved even while archived).
      let observed =
        (output?.featureId ? yield* getFeature(output.featureId) : undefined) ??
        (yield* findFeatureByLookupKey(news.lookupKey));

      // 2. Ensure — create when missing. A concurrent deploy can win the race
      //    and claim the lookup key; re-resolve rather than fail.
      if (!observed) {
        observed = yield* PostEntitlementsFeatures({
          lookup_key: news.lookupKey,
          name: news.name,
          metadata: desiredMetadata,
        }).pipe(
          Effect.catchTag("InvalidRequestError", (error) =>
            findFeatureByLookupKey(news.lookupKey).pipe(
              Effect.flatMap((raced) =>
                raced ? Effect.succeed(raced) : Effect.fail(error),
              ),
            ),
          ),
        );
      }

      // 3. Sync — diff the observed feature against the desired state and
      //    issue a single update only when something actually differs. Note
      //    that `active` cannot be set at creation time, so a feature created
      //    with `active: false` is archived here.
      const observedMetadata = denseMetadata(observed.metadata);
      const nameChanged = observed.name !== news.name;
      const activeChanged = observed.active !== desiredActive;
      const metadataChanged = !metadataEqual(observedMetadata, desiredMetadata);
      if (nameChanged || activeChanged || metadataChanged) {
        observed = yield* PostEntitlementsFeaturesId({
          id: observed.id,
          ...(nameChanged ? { name: news.name } : {}),
          ...(activeChanged ? { active: desiredActive } : {}),
          ...(metadataChanged
            ? { metadata: metadataUpdate(observedMetadata, desiredMetadata) }
            : {}),
        });
      }

      // 4. Return the fresh attributes.
      return featureAttrs(observed);
    }),
    delete: Effect.fn(function* ({ output }) {
      // Stripe has no delete endpoint for features — archiving is the closest
      // thing. Idempotent: an already-archived or already-missing feature is
      // success, not an error.
      yield* absentAsUndefined(
        PostEntitlementsFeaturesId({ id: output.featureId, active: false }),
      );
    }),
  });
