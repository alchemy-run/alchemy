import {
  GetIssuingPersonalizationDesigns,
  GetIssuingPersonalizationDesignsPersonalizationDesign,
  type IssuingPersonalizationDesign as IssuingPersonalizationDesignObject,
  PostIssuingPersonalizationDesigns,
  PostIssuingPersonalizationDesignsPersonalizationDesign,
  type PostIssuingPersonalizationDesignsPersonalizationDesignRequest,
} from "@distilled.cloud/stripe/stripe";
import * as Effect from "effect/Effect";
import { Unowned } from "../AdoptPolicy.ts";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import {
  brandMetadata,
  isOwned,
  metadataEqual,
  metadataUpdate,
  stripInternalMetadata,
  toMetadata,
} from "./Metadata.ts";
import type { Providers } from "./Providers.ts";

/**
 * Where a personalization design sits in Stripe's asynchronous review
 * workflow.
 *
 * - `inactive` — created (or edited) but not yet submitted for review.
 * - `review` — Stripe is reviewing the card logo / carrier text.
 * - `active` — approved; the design can be used to create physical cards.
 * - `rejected` — Stripe rejected the design; see `rejectionReasons`.
 */
export type PersonalizationDesignStatus =
  | "active"
  | "inactive"
  | "rejected"
  | "review";

/** Why Stripe rejected the card logo attached to a personalization design. */
export type PersonalizationDesignCardLogoRejectionReason =
  | "geographic_location"
  | "inappropriate"
  | "network_name"
  | "non_binary_image"
  | "non_fiat_currency"
  | "other"
  | "other_entity"
  | "promotional_material";

/** Why Stripe rejected the carrier text on a personalization design. */
export type PersonalizationDesignCarrierTextRejectionReason =
  | "geographic_location"
  | "inappropriate"
  | "network_name"
  | "non_fiat_currency"
  | "other"
  | "other_entity"
  | "promotional_material";

/**
 * The text printed on the carrier letter that ships in the envelope with a
 * physical card. Only usable with physical bundles whose
 * `features.carrier_text` is `optional` or `required`.
 */
export type PersonalizationDesignCarrierText = {
  /** The footer body text of the carrier letter. */
  footerBody?: string;
  /** The footer title text of the carrier letter. */
  footerTitle?: string;
  /** The header body text of the carrier letter. */
  headerBody?: string;
  /** The header title text of the carrier letter. */
  headerTitle?: string;
};

export type IssuingPersonalizationDesignProps = {
  /**
   * ID of the Issuing physical bundle (`ipb_…`) this design is built on —
   * the card stock, carrier letter and envelope that ship to the cardholder.
   *
   * Enumerate the bundles available to your account with
   * `GET /v1/issuing/physical_bundles`. The bundle's `features` decide
   * whether {@link cardLogo} and {@link carrierText} are allowed at all.
   *
   * Updated in place: Stripe's update endpoint accepts `physical_bundle`,
   * and a design can never be deleted, so replacing on change would leave
   * an orphaned design in the account forever. Note that any edit sends the
   * design back through review — see the caution on the resource.
   */
  physicalBundle: string;
  /**
   * Friendly display name shown in the Stripe dashboard. Removing the prop
   * unsets the name (Stripe stores `null`).
   *
   * @default undefined - the design has no display name
   */
  name?: string;
  /**
   * A lookup key used to retrieve the design dynamically from a static
   * string (up to 200 characters). Must be unique across the account —
   * set {@link transferLookupKey} to steal it from another design.
   *
   * @default undefined - the design has no lookup key
   */
  lookupKey?: string;
  /**
   * Atomically remove {@link lookupKey} from whichever design currently
   * holds it and assign it to this one. Sent alongside every `lookup_key`
   * write, so it is a request-time flag rather than stored state.
   *
   * @default false
   */
  transferLookupKey?: boolean;
  /**
   * ID of an uploaded Stripe File (`file_…`) to use as the card logo, for
   * physical bundles that support one. The file must have a `purpose` of
   * `issuing_logo`; the image must be a 1000x200 PNG, binary (black and
   * white) — black logo on a white background, no grayscale.
   *
   * Removing the prop unsets the logo.
   *
   * @default undefined - no card logo
   */
  cardLogo?: string;
  /**
   * Text printed on the carrier letter, for physical bundles that support
   * carrier text. Every field is written on each update — a field omitted
   * from this object is unset on the design.
   *
   * Removing the prop entirely unsets the whole carrier text hash.
   *
   * @default undefined - no carrier text
   */
  carrierText?: PersonalizationDesignCarrierText;
  /**
   * Whether this design is used to create cards when no design is
   * specified. Stripe allows exactly one default per account.
   *
   * @default { isDefault: false }
   */
  preferences?: {
    /**
     * Whether Stripe uses this design when a card is created without one.
     *
     * @default false
     */
    isDefault: boolean;
  };
  /**
   * User metadata attached to the design. Alchemy additionally writes its
   * own `alchemy_stack` / `alchemy_stage` / `alchemy_id` branding keys into
   * Stripe's `metadata` map so the design can be re-discovered after state
   * loss; those keys are stripped back out of the `metadata` attribute.
   *
   * @default {}
   */
  metadata?: Record<string, string>;
};

export type IssuingPersonalizationDesign = Resource<
  "Stripe.IssuingPersonalizationDesign",
  IssuingPersonalizationDesignProps,
  {
    /** Stripe's unique identifier for the design, e.g. `ipd_…`. */
    personalizationDesignId: string;
    /** ID of the physical bundle (`ipb_…`) this design is built on. */
    physicalBundle: string;
    /** The design's dashboard display name, if one is set. */
    name: string | undefined;
    /** The design's account-unique lookup key, if one is set. */
    lookupKey: string | undefined;
    /** ID of the Stripe File used as the card logo, if one is set. */
    cardLogo: string | undefined;
    /** The carrier letter text, if any is set. */
    carrierText: PersonalizationDesignCarrierText | undefined;
    /** Observed default-design preferences. */
    preferences: {
      /** Whether Stripe uses this design when a card is created without one. */
      isDefault: boolean;
      /**
       * Whether this design is the Connect platform's default. Only
       * meaningful on connected accounts.
       */
      isPlatformDefault: boolean | undefined;
    };
    /**
     * Where the design sits in Stripe's review workflow. Review is
     * asynchronous and can take days — this is a point-in-time snapshot
     * taken at deploy, never waited on.
     */
    status: PersonalizationDesignStatus;
    /** Reasons Stripe rejected the design, populated when `status` is `rejected`. */
    rejectionReasons: {
      /** The reason(s) the card logo was rejected. */
      cardLogo: PersonalizationDesignCardLogoRejectionReason[];
      /** The reason(s) the carrier text was rejected. */
      carrierText: PersonalizationDesignCarrierTextRejectionReason[];
    };
    /** User metadata, with Alchemy's internal `alchemy_*` branding stripped. */
    metadata: Record<string, string>;
    /** `true` when the design lives in live mode rather than test mode. */
    livemode: boolean;
    /** Creation time, in seconds since the Unix epoch. */
    created: number;
  },
  never,
  Providers
>;

type IssuingPersonalizationDesignAttributes =
  IssuingPersonalizationDesign["Attributes"];

/**
 * A Stripe Issuing Personalization Design — the reusable grouping of a
 * physical bundle, card logo and carrier text that defines how a physical
 * card and its packaging look.
 *
 * :::caution
 * **Stripe does not support deleting a personalization design.** There is no
 * delete, archive, deactivate or expire endpoint for this object. Destroying
 * this resource only removes it from Alchemy state and logs a warning — the
 * design remains in the Stripe account permanently, visible in the dashboard
 * and in `GET /v1/issuing/personalization_designs`, and continues to hold its
 * `lookup_key`. Reclaim a lookup key by setting `transferLookupKey: true` on
 * the design that should own it.
 *
 * For the same reason this resource opts out of `alchemy unsafe nuke`
 * (`nuke: { skip: true }`), which would otherwise loop forever reporting
 * "deleted but still there".
 * :::
 *
 * Designs go through an **asynchronous review workflow**: `inactive` →
 * `review` → `active` or `rejected`. Any edit to the design's visual content
 * sends it back through review. Review can take days, so this provider never
 * polls for a terminal status — `status` and `rejectionReasons` are surfaced
 * as attributes and reflect the design at the moment the deploy ran. Re-run
 * the deploy (or read the object directly) to observe the outcome.
 *
 * Using a design requires an account with Stripe Issuing enabled and, for
 * physical cards, a physical bundle available to that account.
 *
 * ### Creating a Personalization Design
 * **Example:** Minimal design over a standard physical bundle
 * ```typescript
 * const design = yield* Stripe.IssuingPersonalizationDesign("card-design", {
 *   physicalBundle: "ipb_1MvSieGrEnnzvSFMcjPBrHYW",
 * });
 * ```
 *
 * **Example:** Named design with a lookup key
 * ```typescript
 * const design = yield* Stripe.IssuingPersonalizationDesign("card-design", {
 *   physicalBundle: "ipb_1MvSieGrEnnzvSFMcjPBrHYW",
 *   name: "Acme Blue",
 *   lookupKey: "acme-blue",
 *   transferLookupKey: true,
 * });
 * ```
 *
 * **Example:** Fully configured design
 * ```typescript
 * const design = yield* Stripe.IssuingPersonalizationDesign("card-design", {
 *   physicalBundle: "ipb_1MvSieGrEnnzvSFMcjPBrHYW",
 *   name: "Acme Blue",
 *   lookupKey: "acme-blue",
 *   transferLookupKey: true,
 *   cardLogo: "file_1MvSieGrEnnzvSFMcjPBrHYW",
 *   carrierText: {
 *     headerTitle: "Welcome to Acme",
 *     headerBody: "Your card is ready to use.",
 *     footerTitle: "Questions?",
 *     footerBody: "Reach us at support@acme.test",
 *   },
 *   preferences: { isDefault: true },
 *   metadata: { team: "payments" },
 * });
 * ```
 *
 * ### Checking review status
 * **Example:** Surface the design's review state as a stack output
 * ```typescript
 * const design = yield* Stripe.IssuingPersonalizationDesign("card-design", {
 *   physicalBundle: "ipb_1MvSieGrEnnzvSFMcjPBrHYW",
 * });
 *
 * return {
 *   status: design.status,
 *   rejectedBecause: design.rejectionReasons,
 * };
 * ```
 *
 * ### Composing with other Stripe resources
 * **Example:** Tie the design to the cardholder-facing billing portal
 * ```typescript
 * const design = yield* Stripe.IssuingPersonalizationDesign("card-design", {
 *   physicalBundle: "ipb_1MvSieGrEnnzvSFMcjPBrHYW",
 *   name: "Acme Blue",
 *   preferences: { isDefault: true },
 * });
 *
 * const customer = yield* Stripe.Customer("cardholder", {
 *   email: "cardholder@acme.test",
 *   metadata: { personalizationDesign: design.personalizationDesignId },
 * });
 *
 * return { designId: design.personalizationDesignId, customerId: customer.customerId };
 * ```
 *
 * @see https://docs.stripe.com/api/issuing/personalization_design
 *
 * @resource
 */
export const IssuingPersonalizationDesign =
  Resource<IssuingPersonalizationDesign>("Stripe.IssuingPersonalizationDesign");

/** Hard bound on list pagination so a bad cursor can never spin forever. */
const MAX_PAGES = 50;
/** Stripe's maximum page size for `GET /v1/issuing/personalization_designs`. */
const PAGE_SIZE = 100;

export const IssuingPersonalizationDesignProvider = () =>
  Provider.succeed(IssuingPersonalizationDesign, {
    stables: ["personalizationDesignId", "created", "livemode"],
    /**
     * A personalization design can never be removed from a Stripe account —
     * there is no delete, archive or deactivate endpoint — so account-wide
     * teardown skips this type entirely rather than looping forever on
     * "deleted but still there".
     */
    nuke: { skip: true },
    list: Effect.fn(function* () {
      const designs = yield* listDesigns();
      return designs.map(designAttributes);
    }),
    diff: Effect.fn(function* ({ news }) {
      // `news` is `Input<Props>` during plan — bail out until it resolves.
      if (!isResolved(news)) return undefined;
      // Nothing on this resource is immutable: Stripe generates the id
      // (`ipd_…`) itself, and `POST /v1/issuing/personalization_designs/{id}`
      // accepts every prop this resource exposes — including
      // `physical_bundle`. So there is no replacement trigger; every change
      // converges in place and the engine plans the default update.
      return undefined;
    }),
    read: Effect.fn(function* ({ id, olds, output }) {
      if (output?.personalizationDesignId) {
        const observed = yield* getDesign(output.personalizationDesignId);
        if (observed) return designAttributes(observed);
      }
      // State loss (or a stale id). The branding metadata is the primary way
      // back to the object; it is the only identity Alchemy controls.
      const branded = yield* findDesignOwnedBy(id);
      if (branded) return designAttributes(branded);

      // Last resort: the natural key. A design carrying our lookup key but
      // not our branding was created by someone else — report it as
      // `Unowned` so the engine gates takeover behind `--adopt`.
      const lookupKey = olds?.lookupKey;
      if (!lookupKey) return undefined;
      const foreign = yield* findDesignByLookupKey(lookupKey);
      return foreign ? Unowned(designAttributes(foreign)) : undefined;
    }),
    reconcile: Effect.fn(function* ({ id, news, output }) {
      const desiredMetadata = yield* brandMetadata(id, news.metadata);

      // 1. Observe — the cached id first, then the branding, then the
      //    lookup key, so a create whose state write failed is adopted
      //    rather than duplicated into a second undeletable design.
      let observed = output?.personalizationDesignId
        ? yield* getDesign(output.personalizationDesignId)
        : undefined;
      if (observed === undefined) {
        observed = yield* findDesignOwnedBy(id);
      }
      if (observed === undefined && news.lookupKey !== undefined) {
        observed = yield* findDesignByLookupKey(news.lookupKey);
      }

      // 2. Ensure — create only when genuinely missing.
      if (observed === undefined) {
        observed = yield* PostIssuingPersonalizationDesigns({
          physical_bundle: news.physicalBundle,
          metadata: desiredMetadata,
          ...(news.name !== undefined ? { name: news.name } : {}),
          ...(news.lookupKey !== undefined
            ? {
                lookup_key: news.lookupKey,
                transfer_lookup_key: news.transferLookupKey ?? false,
              }
            : {}),
          ...(news.cardLogo !== undefined ? { card_logo: news.cardLogo } : {}),
          ...(news.carrierText !== undefined
            ? { carrier_text: carrierTextRequest(news.carrierText) }
            : {}),
          ...(news.preferences !== undefined
            ? { preferences: { is_default: news.preferences.isDefault } }
            : {}),
        });
        return designAttributes(observed);
      }

      // 3. Sync — diff each mutable aspect against OBSERVED cloud state and
      //    build a single delta payload. Stripe unsets a scalar by posting
      //    an empty string, so a prop that disappeared is blanked rather
      //    than left behind.
      const update: Omit<
        PostIssuingPersonalizationDesignsPersonalizationDesignRequest,
        "personalization_design"
      > = {};
      let dirty = false;

      const observedBundle = physicalBundleId(observed.physical_bundle);
      if (observedBundle !== news.physicalBundle) {
        update.physical_bundle = news.physicalBundle;
        dirty = true;
      }

      const observedName = observed.name ?? undefined;
      if (observedName !== news.name) {
        update.name = news.name ?? "";
        dirty = true;
      }

      const observedLookupKey = observed.lookup_key ?? undefined;
      if (observedLookupKey !== news.lookupKey) {
        update.lookup_key = news.lookupKey ?? "";
        // Only meaningful when claiming a key — Stripe has nothing to
        // transfer when the key is being blanked.
        if (news.lookupKey !== undefined) {
          update.transfer_lookup_key = news.transferLookupKey ?? false;
        }
        dirty = true;
      }

      const observedCardLogo = cardLogoId(observed.card_logo);
      if (observedCardLogo !== news.cardLogo) {
        update.card_logo = news.cardLogo ?? "";
        dirty = true;
      }

      const observedCarrierText = carrierTextAttribute(observed.carrier_text);
      if (!carrierTextEqual(observedCarrierText, news.carrierText)) {
        update.carrier_text =
          news.carrierText === undefined
            ? ""
            : carrierTextRequest(news.carrierText);
        dirty = true;
      }

      const desiredIsDefault = news.preferences?.isDefault ?? false;
      if (observed.preferences.is_default !== desiredIsDefault) {
        update.preferences = { is_default: desiredIsDefault };
        dirty = true;
      }

      const observedMetadata = toMetadata(observed.metadata);
      if (!metadataEqual(observedMetadata, desiredMetadata)) {
        update.metadata = metadataUpdate(observedMetadata, desiredMetadata);
        dirty = true;
      }

      // Skip the API call entirely on a no-op — an update would otherwise
      // bounce an `active` design back into `review` for nothing.
      if (!dirty) return designAttributes(observed);

      const updated =
        yield* PostIssuingPersonalizationDesignsPersonalizationDesign({
          personalization_design: observed.id,
          ...update,
        });
      return designAttributes(updated);
    }),
    /**
     * Stripe exposes **no** delete, archive, deactivate or expire endpoint
     * for personalization designs, so there is nothing to call: destroying
     * this resource drops the state row and leaves the design in the Stripe
     * account permanently. We log a warning rather than failing so a stack
     * destroy still completes.
     */
    delete: Effect.fn(function* ({ id, output }) {
      yield* Effect.logWarning(
        `Stripe does not support deleting an Issuing personalization design. ` +
          `'${id}' (${output.personalizationDesignId}) has been removed from Alchemy state, ` +
          `but the design remains in the Stripe account permanently and still holds ` +
          `its lookup key${output.lookupKey ? ` '${output.lookupKey}'` : ""}.`,
      );
    }),
  });

/** Map a Stripe `issuing.personalization_design` onto this resource's Attributes. */
const designAttributes = (
  design: IssuingPersonalizationDesignObject,
): IssuingPersonalizationDesignAttributes => ({
  personalizationDesignId: design.id,
  physicalBundle: physicalBundleId(design.physical_bundle),
  name: design.name ?? undefined,
  lookupKey: design.lookup_key ?? undefined,
  cardLogo: cardLogoId(design.card_logo),
  carrierText: carrierTextAttribute(design.carrier_text),
  preferences: {
    isDefault: design.preferences.is_default,
    isPlatformDefault: design.preferences.is_platform_default ?? undefined,
  },
  status: design.status as PersonalizationDesignStatus,
  rejectionReasons: {
    cardLogo: [
      ...(design.rejection_reasons.card_logo ?? []),
    ] as PersonalizationDesignCardLogoRejectionReason[],
    carrierText: [
      ...(design.rejection_reasons.carrier_text ?? []),
    ] as PersonalizationDesignCarrierTextRejectionReason[],
  },
  metadata: stripInternalMetadata(toMetadata(design.metadata)),
  livemode: design.livemode,
  created: design.created,
});

/**
 * `physical_bundle` is an expandable reference: a bare `ipb_…` string unless
 * the caller asked Stripe to expand it, in which case it is the full object.
 */
const physicalBundleId = (
  bundle: IssuingPersonalizationDesignObject["physical_bundle"],
): string => (typeof bundle === "string" ? bundle : bundle.id);

/** `card_logo` is an expandable reference to a Stripe File, or `null`. */
const cardLogoId = (
  logo: IssuingPersonalizationDesignObject["card_logo"],
): string | undefined => {
  if (logo === null || logo === undefined) return undefined;
  return typeof logo === "string" ? logo : logo.id;
};

/** Normalize Stripe's nullable carrier-text hash into the attribute shape. */
const carrierTextAttribute = (
  carrierText: IssuingPersonalizationDesignObject["carrier_text"],
): PersonalizationDesignCarrierText | undefined => {
  if (carrierText === null || carrierText === undefined) return undefined;
  const normalized: PersonalizationDesignCarrierText = {};
  if (carrierText.footer_body !== null) {
    normalized.footerBody = carrierText.footer_body;
  }
  if (carrierText.footer_title !== null) {
    normalized.footerTitle = carrierText.footer_title;
  }
  if (carrierText.header_body !== null) {
    normalized.headerBody = carrierText.header_body;
  }
  if (carrierText.header_title !== null) {
    normalized.headerTitle = carrierText.header_title;
  }
  // Stripe keeps the hash present with every field null once it has ever
  // been set; treat that as "no carrier text" so it doesn't read as drift.
  return Object.keys(normalized).length === 0 ? undefined : normalized;
};

/**
 * Every field is written on each update — omitted fields are blanked with
 * `""` (Stripe's unset token) so the design converges on exactly the desired
 * carrier text rather than merging with whatever was there before.
 */
const carrierTextRequest = (carrierText: PersonalizationDesignCarrierText) => ({
  footer_body: carrierText.footerBody ?? "",
  footer_title: carrierText.footerTitle ?? "",
  header_body: carrierText.headerBody ?? "",
  header_title: carrierText.headerTitle ?? "",
});

const carrierTextEqual = (
  a: PersonalizationDesignCarrierText | undefined,
  b: PersonalizationDesignCarrierText | undefined,
): boolean =>
  (a?.footerBody ?? undefined) === (b?.footerBody ?? undefined) &&
  (a?.footerTitle ?? undefined) === (b?.footerTitle ?? undefined) &&
  (a?.headerBody ?? undefined) === (b?.headerBody ?? undefined) &&
  (a?.headerTitle ?? undefined) === (b?.headerTitle ?? undefined);

/**
 * Fetch a design by id, mapping "no such object" onto `undefined`.
 *
 * Stripe answers a missing object with `invalid_request_error` /
 * `resource_missing`, and distilled dispatches on `error.type` before HTTP
 * status — so the miss can surface as either `NotFound` or
 * `InvalidRequestError`. Both are handled.
 */
const getDesign = (personalizationDesignId: string) =>
  GetIssuingPersonalizationDesignsPersonalizationDesign({
    personalization_design: personalizationDesignId,
  }).pipe(
    Effect.map(
      (design): IssuingPersonalizationDesignObject | undefined => design,
    ),
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
    Effect.catchTag("InvalidRequestError", (error) =>
      error.code === "resource_missing"
        ? Effect.succeed(undefined)
        : Effect.fail(error),
    ),
  );

/**
 * Exhaustively page `GET /v1/issuing/personalization_designs`, optionally
 * filtered by lookup key. Bounded at {@link MAX_PAGES} pages of
 * {@link PAGE_SIZE} so a misbehaving cursor fails fast instead of hanging
 * the deploy.
 */
const listDesigns = (options: { lookupKeys?: string[] } = {}) =>
  Effect.gen(function* () {
    const designs: IssuingPersonalizationDesignObject[] = [];
    let startingAfter: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const response = yield* GetIssuingPersonalizationDesigns({
        limit: PAGE_SIZE,
        ...(options.lookupKeys !== undefined
          ? { lookup_keys: options.lookupKeys }
          : {}),
        ...(startingAfter !== undefined
          ? { starting_after: startingAfter }
          : {}),
      });
      designs.push(...response.data);
      const last = response.data[response.data.length - 1];
      if (!response.has_more || last === undefined) break;
      startingAfter = last.id;
    }
    return designs;
  });

/**
 * Find the design branded for this stack/stage/logical id. Personalization
 * designs cannot be filtered by metadata server-side, so this pages the
 * collection and matches client-side.
 */
const findDesignOwnedBy = (id: string) =>
  Effect.gen(function* () {
    const designs = yield* listDesigns();
    for (const design of designs) {
      if (yield* isOwned(id, toMetadata(design.metadata))) return design;
    }
    return undefined;
  });

/** Find the design currently holding `lookupKey`, if any. */
const findDesignByLookupKey = (lookupKey: string) =>
  Effect.gen(function* () {
    const designs = yield* listDesigns({ lookupKeys: [lookupKey] });
    return designs.find((design) => design.lookup_key === lookupKey);
  });
