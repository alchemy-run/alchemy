import {
  GetIssuingCards,
  GetIssuingCardsCard,
  type IssuingCard as StripeCard,
  PostIssuingCards,
  PostIssuingCardsCard,
  type PostIssuingCardsCardRequest,
} from "@distilled.cloud/stripe/stripe";
import * as Effect from "effect/Effect";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import {
  deepEqual,
  type IssuingAddress,
  type IssuingObservedAddress,
  type IssuingSpendingControls,
  toObservedAddress,
  toRequestAddress,
  toRequestSpendingControls,
  toSpendingControls,
} from "./IssuingCardholder.ts";
import {
  brandMetadata,
  isOwned,
  type Metadata,
  metadataEqual,
  metadataUpdate,
  stripInternalMetadata,
  toMetadata,
} from "./Metadata.ts";
import type { Providers } from "./Providers.ts";

/** Whether the card is physical plastic or a virtual number. */
export type IssuingCardType = "virtual" | "physical";

/**
 * Whether authorizations can be approved on the card. Only `active` and
 * `inactive` are settable through props — `canceled` is terminal and is
 * reached by destroying the resource.
 */
export type IssuingCardStatus = "active" | "inactive";

/** Why the card being replaced needed replacing. */
export type IssuingCardReplacementReason =
  | "damaged"
  | "expired"
  | "lost"
  | "stolen";

/**
 * Spending controls scoped to a single card. Identical to a cardholder's
 * controls minus `spendingLimitsCurrency` — a card's limits are always
 * denominated in the card's own currency, and Stripe rejects the parameter.
 */
export type IssuingCardSpendingControls = Omit<
  IssuingSpendingControls,
  "spendingLimitsCurrency"
>;

/** Where and how a physical card is shipped. */
export type IssuingCardShippingProps = {
  /** The name printed on the shipping label. */
  name: string;
  /** The address the card is shipped to. */
  address: IssuingAddress;
  /** Phone number of the recipient, used by the courier for delivery issues. */
  phoneNumber?: string;
  /** Whether a signature is required on delivery. US only. */
  requireSignature?: boolean;
  /**
   * Shipment service.
   *
   * @default "standard"
   */
  service?: "express" | "priority" | "standard";
  /**
   * Packaging option.
   *
   * @default "individual"
   */
  type?: "bulk" | "individual";
  /**
   * EORI number used for customs. Required for bulk shipments to Europe.
   */
  customsEoriNumber?: string;
  /**
   * Address validation capabilities to apply to the shipping address.
   */
  addressValidationMode?:
    | "disabled"
    | "normalization_only"
    | "validation_and_normalization";
};

/** Shipment details exactly as Stripe reports them. */
export type IssuingCardObservedShipping = {
  /** The name printed on the shipping label. */
  name: string;
  /** The address the card was shipped to. */
  address: IssuingObservedAddress;
  /** Phone number of the recipient. */
  phoneNumber: string | undefined;
  /** Whether a signature is required on delivery. */
  requireSignature: boolean | undefined;
  /** Shipment service, e.g. `standard` or `express`. */
  service: string;
  /** Packaging option, e.g. `individual` or `bulk`. */
  type: string;
  /** Delivery status, e.g. `pending`, `shipped`, `delivered`. */
  status: string | undefined;
  /** Delivery company that shipped the card, e.g. `usps`. */
  carrier: string | undefined;
  /** Unix timestamp best-estimate of delivery. */
  eta: number | undefined;
  /** Tracking number for the shipment. */
  trackingNumber: string | undefined;
  /** Link to the carrier's tracking page. */
  trackingUrl: string | undefined;
  /** EORI number used for customs, if one was supplied. */
  customsEoriNumber: string | undefined;
};

export type IssuingCardProps = {
  /**
   * The {@link IssuingCardholder} the card belongs to. Immutable — changing
   * it **replaces** the card, which cancels the old one irreversibly.
   */
  cardholderId: string;
  /**
   * Three-letter ISO currency code for the card. Immutable — changing it
   * **replaces** the card.
   */
  currency: string;
  /**
   * `virtual` or `physical`. Immutable — changing it **replaces** the card.
   */
  type: IssuingCardType;
  /**
   * Whether authorizations can be approved on this card. Stripe may refuse
   * to activate a card while its cardholder has past-due requirements.
   *
   * @default "inactive"
   */
  status?: IssuingCardStatus;
  /** Rules that control spending on this card. */
  spendingControls?: IssuingCardSpendingControls;
  /**
   * Where the card is shipped. `physical` cards only — Stripe rejects it on
   * a virtual card. Only updatable while the shipment is still pending.
   */
  shipping?: IssuingCardShippingProps;
  /**
   * The ID of the card this one replaces. Immutable — changing it
   * **replaces** the card.
   */
  replacementFor?: string;
  /**
   * Why the card named by `replacementFor` is being replaced. Immutable —
   * changing it **replaces** the card.
   */
  replacementReason?: IssuingCardReplacementReason;
  /**
   * The ID of the personalization design (`ipd_…`) printed on the card.
   */
  personalizationDesign?: string;
  /**
   * The ID of the Treasury financial account funding the card. Immutable —
   * changing it **replaces** the card.
   */
  financialAccount?: string;
  /**
   * Arbitrary key/value pairs stored on the card. Alchemy adds its own
   * reserved `alchemy_stack` / `alchemy_stage` / `alchemy_id` entries for
   * ownership tracking; they are stripped from the `metadata` attribute.
   */
  metadata?: Metadata;
};

export type IssuingCard = Resource<
  "Stripe.IssuingCard",
  IssuingCardProps,
  {
    /** The Stripe card ID, e.g. `ic_1MvSieLkdIwHu7ixn6uuwWaG`. */
    cardId: string;
    /** The cardholder this card belongs to. */
    cardholderId: string;
    /** Three-letter lowercase ISO currency code. */
    currency: string;
    /** `virtual` or `physical`. */
    type: IssuingCardType;
    /**
     * `active`, `inactive`, or `canceled`. `canceled` is terminal — such a
     * card can never be revived, and the next deploy plans a replacement.
     */
    status: "active" | "inactive" | "canceled";
    /** Card network brand, e.g. `Visa`. */
    brand: string;
    /** The last four digits of the card number. */
    last4: string;
    /** Expiration month, 1-12. */
    expMonth: number;
    /** Four-digit expiration year. */
    expYear: number;
    /** Why the card was canceled, if it was. */
    cancellationReason: string | undefined;
    /** The ID of the card this one replaced, if any. */
    replacementForCardId: string | undefined;
    /** Why the replaced card needed replacing, if this is a replacement. */
    replacementReason: string | undefined;
    /** The ID of the latest card that replaced this one, if any. */
    replacedByCardId: string | undefined;
    /** The ID of the personalization design printed on the card, if any. */
    personalizationDesignId: string | undefined;
    /** The Treasury financial account funding the card, if any. */
    financialAccount: string | undefined;
    /** Spending controls as Stripe stored them. */
    spendingControls: IssuingCardSpendingControls | undefined;
    /** Shipment details, for physical cards that have shipping configured. */
    shipping: IssuingCardObservedShipping | undefined;
    /** User-supplied metadata, with alchemy's reserved keys stripped out. */
    metadata: Metadata;
    /** Whether the card exists in live mode. */
    livemode: boolean;
    /** Unix timestamp of when the card was created. */
    createdAt: number;
  },
  never,
  Providers
>;

type IssuingCardAttributes = IssuingCard["Attributes"];

/**
 * A Stripe Issuing card — a virtual or physical payment card issued to an
 * {@link IssuingCardholder}.
 *
 * :::caution
 * Stripe does not support deleting a card. Destroying this resource sets
 * `status: "canceled"`, which is **terminal and irreversible**: a canceled
 * card can never be reactivated, and it stays visible in the dashboard and
 * in list calls forever. Because of that, any change to an immutable prop
 * (`cardholderId`, `currency`, `type`, `replacementFor`, `replacementReason`,
 * `financialAccount`) plans a replacement that leaves a permanently dead card
 * behind. Treat those props as write-once.
 * :::
 *
 * :::caution
 * The attributes expose only the safe fields Stripe returns by default —
 * `last4`, `brand`, `expMonth`, `expYear`, `status`, `type`. The full PAN and
 * CVC are **not** modelled: retrieving them requires a separate ephemeral-key
 * flow scoped to a single client session, and putting them in Alchemy state
 * would persist raw card credentials to disk. Likewise `pin` is not modelled
 * — PIN material must be encrypted with a Stripe-issued key and never belongs
 * in infrastructure config.
 * :::
 *
 * Issuing must be enabled on the Stripe account before any of these calls
 * succeed.
 *
 * ### Issuing a card
 * **Example:** Virtual card
 * ```typescript
 * const card = yield* Stripe.IssuingCard("engineer-card", {
 *   cardholderId: cardholder.cardholderId,
 *   currency: "usd",
 *   type: "virtual",
 * });
 * ```
 *
 * **Example:** Active virtual card with spending controls
 * ```typescript
 * const card = yield* Stripe.IssuingCard("saas-card", {
 *   cardholderId: cardholder.cardholderId,
 *   currency: "usd",
 *   type: "virtual",
 *   status: "active",
 *   spendingControls: {
 *     allowedCategories: ["computer_software_stores"],
 *     spendingLimits: [{ amount: 100_000, interval: "monthly" }],
 *   },
 *   metadata: { costCenter: "eng-tools" },
 * });
 * ```
 *
 * ### Shipping a physical card
 * **Example:** Physical card with a shipping address
 * ```typescript
 * const card = yield* Stripe.IssuingCard("field-card", {
 *   cardholderId: cardholder.cardholderId,
 *   currency: "usd",
 *   type: "physical",
 *   shipping: {
 *     name: "Ada Lovelace",
 *     service: "priority",
 *     address: {
 *       line1: "1 Analytical Engine Way",
 *       city: "San Francisco",
 *       state: "CA",
 *       postalCode: "94103",
 *       country: "US",
 *     },
 *   },
 * });
 * ```
 *
 * ### Composing with a cardholder
 * **Example:** Cardholder and card in one stack
 * ```typescript
 * const cardholder = yield* Stripe.IssuingCardholder("engineer", {
 *   name: "Ada Lovelace",
 *   billing: {
 *     address: {
 *       line1: "1 Analytical Engine Way",
 *       city: "San Francisco",
 *       state: "CA",
 *       postalCode: "94103",
 *       country: "US",
 *     },
 *   },
 * });
 *
 * const card = yield* Stripe.IssuingCard("engineer-card", {
 *   cardholderId: cardholder.cardholderId,
 *   currency: "usd",
 *   type: "virtual",
 *   status: "active",
 * });
 * ```
 *
 * @see https://docs.stripe.com/api/issuing/cards
 *
 * @resource
 */
export const IssuingCard = Resource<IssuingCard>("Stripe.IssuingCard");

export const IssuingCardProvider = () =>
  Provider.succeed(IssuingCard, {
    stables: [
      "cardId",
      "cardholderId",
      "currency",
      "type",
      "brand",
      "last4",
      "expMonth",
      "expYear",
      "createdAt",
      "livemode",
    ],
    // A card can never be deleted — `delete` only cancels it, irreversibly —
    // so account-wide teardown skips the type rather than mass-cancelling
    // every card on the account.
    nuke: { skip: true },
    list: Effect.fn(function* () {
      const cards = yield* listAllCards();
      return cards.map(toCardAttributes);
    }),
    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news)) return undefined;
      if (output === undefined) return undefined;
      // A canceled card is terminal — it can never be reactivated, so the
      // only way to converge on a live card is to issue a new one.
      if (output.status === "canceled") return { action: "replace" } as const;
      if (news.cardholderId !== output.cardholderId) {
        return { action: "replace" } as const;
      }
      if (news.currency.toLowerCase() !== output.currency) {
        return { action: "replace" } as const;
      }
      if (news.type !== output.type) return { action: "replace" } as const;
      // Only compare the create-only linkage props when the user actually
      // states one: Stripe populates `replacement_*` on the card it issues
      // as a replacement, and echoing that back must not force a loop.
      if (
        news.replacementFor !== undefined &&
        news.replacementFor !== output.replacementForCardId
      ) {
        return { action: "replace" } as const;
      }
      if (
        news.replacementReason !== undefined &&
        news.replacementReason !== output.replacementReason
      ) {
        return { action: "replace" } as const;
      }
      if (
        news.financialAccount !== undefined &&
        news.financialAccount !== output.financialAccount
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),
    read: Effect.fn(function* ({ id, olds, output }) {
      if (output?.cardId) {
        const observed = yield* getCard(output.cardId);
        return observed === undefined ? undefined : toCardAttributes(observed);
      }
      // State loss: Stripe has no tags, so re-discover ours by scanning the
      // collection for alchemy's metadata branding. Narrow the scan to the
      // known cardholder when the previous props carried one.
      const cards = yield* listAllCards(olds?.cardholderId);
      for (const card of cards) {
        if (yield* isOwned(id, toMetadata(card.metadata))) {
          return toCardAttributes(card);
        }
      }
      return undefined;
    }),
    reconcile: Effect.fn(function* ({ id, news, output }) {
      const desiredMetadata = yield* brandMetadata(id, news.metadata);

      // 1. Observe — `output` only caches the id; the card may be gone.
      const observed = output?.cardId
        ? yield* getCard(output.cardId)
        : undefined;

      // 2. Ensure — issue the card when nothing is there.
      if (observed === undefined) {
        const created = yield* PostIssuingCards({
          cardholder: news.cardholderId,
          currency: news.currency,
          type: news.type,
          ...(news.status !== undefined ? { status: news.status } : {}),
          ...(news.spendingControls !== undefined
            ? {
                spending_controls: toRequestSpendingControls(
                  news.spendingControls,
                ),
              }
            : {}),
          ...(news.shipping !== undefined
            ? { shipping: toRequestShipping(news.shipping) }
            : {}),
          ...(news.replacementFor !== undefined
            ? { replacement_for: news.replacementFor }
            : {}),
          ...(news.replacementReason !== undefined
            ? { replacement_reason: news.replacementReason }
            : {}),
          ...(news.personalizationDesign !== undefined
            ? { personalization_design: news.personalizationDesign }
            : {}),
          ...(news.financialAccount !== undefined
            ? { financial_account: news.financialAccount }
            : {}),
          metadata: desiredMetadata,
        });
        return toCardAttributes(created);
      }

      // 3. Sync — diff each mutable aspect against OBSERVED state and send
      //    only the delta. An empty payload skips the API call entirely.
      const update: Omit<PostIssuingCardsCardRequest, "card"> = {};

      const desiredStatus = news.status ?? "inactive";
      // A canceled card is terminal: never attempt to patch it back to life.
      // `diff` schedules a replacement for that case instead.
      if (observed.status !== "canceled" && desiredStatus !== observed.status) {
        update.status = desiredStatus;
      }
      if (news.spendingControls !== undefined) {
        const desiredControls = toRequestSpendingControls(
          news.spendingControls,
        );
        const observedControls = toCardSpendingControls(
          toSpendingControls(observed.spending_controls),
        );
        const observedRequest =
          observedControls === undefined
            ? undefined
            : toRequestSpendingControls(observedControls);
        if (!deepEqual(desiredControls, observedRequest)) {
          update.spending_controls = desiredControls;
        }
      }
      if (news.shipping !== undefined) {
        const desiredShipping = toRequestShipping(news.shipping);
        const observedShipping = toObservedShippingRequest(observed.shipping);
        // Stripe fills in defaults for omitted shipping fields (`service`,
        // `type`), so only the keys the user actually stated are compared —
        // otherwise every deploy would report drift and re-PATCH forever.
        if (!matchesObserved(desiredShipping, observedShipping)) {
          update.shipping = desiredShipping;
        }
      }
      if (
        news.personalizationDesign !== undefined &&
        news.personalizationDesign !== toId(observed.personalization_design)
      ) {
        update.personalization_design = news.personalizationDesign;
      }
      const observedMetadata = toMetadata(observed.metadata);
      if (!metadataEqual(observedMetadata, desiredMetadata)) {
        update.metadata = metadataUpdate(observedMetadata, desiredMetadata);
      }

      if (Object.keys(update).length === 0) {
        return toCardAttributes(observed);
      }
      const updated = yield* PostIssuingCardsCard({
        card: observed.id,
        ...update,
      });
      return toCardAttributes(updated);
    }),
    delete: Effect.fn(function* ({ output }) {
      // Stripe has no card delete endpoint. Cancelling is the closest
      // approximation, is IRREVERSIBLE, and must be idempotent: an
      // already-canceled (or already-vanished) card is a success.
      const observed = yield* getCard(output.cardId);
      if (observed === undefined) return;
      if (observed.status === "canceled") return;
      yield* PostIssuingCardsCard({
        card: output.cardId,
        status: "canceled",
      });
    }),
  });

/** Stripe's list pages are capped at 100; never scan more than 10k objects. */
const MAX_PAGES = 100;

/**
 * Retrieve a card, mapping "it isn't there" onto `undefined`.
 *
 * Stripe dispatches a missing object as `invalid_request_error` with HTTP
 * 404, and distilled matches on `error.type` before status — so the miss can
 * surface as either `NotFound` or `InvalidRequestError` with
 * `code: "resource_missing"`. Both are handled.
 */
const getCard = (cardId: string) =>
  GetIssuingCardsCard({ card: cardId }).pipe(
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
    Effect.catchTag("InvalidRequestError", (error) =>
      error.code === "resource_missing"
        ? Effect.succeed(undefined)
        : Effect.fail(error),
    ),
  );

/** Exhaustively enumerate cards (optionally for one cardholder), bounded. */
const listAllCards = (cardholderId?: string) =>
  Effect.gen(function* () {
    const cards: StripeCard[] = [];
    let startingAfter: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const response = yield* GetIssuingCards({
        limit: 100,
        ...(cardholderId !== undefined ? { cardholder: cardholderId } : {}),
        ...(startingAfter !== undefined
          ? { starting_after: startingAfter }
          : {}),
      });
      cards.push(...response.data);
      const last = response.data[response.data.length - 1];
      if (!response.has_more || last === undefined) break;
      startingAfter = last.id;
    }
    return cards;
  });

/**
 * Drop `spendingLimitsCurrency` — a card's limits are always denominated in
 * the card's own currency and Stripe rejects the parameter on card writes.
 */
const toCardSpendingControls = (
  controls: IssuingSpendingControls | undefined,
): IssuingCardSpendingControls | undefined => {
  if (controls === undefined) return undefined;
  const cardControls: IssuingSpendingControls = { ...controls };
  delete cardControls.spendingLimitsCurrency;
  return cardControls;
};

const toCardAttributes = (card: StripeCard): IssuingCardAttributes => {
  return {
    cardId: card.id,
    cardholderId: card.cardholder.id,
    currency: card.currency,
    type: card.type,
    status: card.status,
    brand: card.brand,
    last4: card.last4,
    expMonth: card.exp_month,
    expYear: card.exp_year,
    cancellationReason: card.cancellation_reason ?? undefined,
    replacementForCardId: toId(card.replacement_for),
    replacementReason: card.replacement_reason ?? undefined,
    replacedByCardId: toId(card.replaced_by),
    personalizationDesignId: toId(card.personalization_design),
    financialAccount: card.financial_account ?? undefined,
    spendingControls: toCardSpendingControls(
      toSpendingControls(card.spending_controls),
    ),
    shipping: toObservedShipping(card.shipping),
    metadata: stripInternalMetadata(toMetadata(card.metadata)),
    livemode: card.livemode,
    createdAt: card.created,
  };
};

/**
 * Normalize a Stripe reference that may arrive either as a bare ID or as an
 * expanded object.
 */
const toId = (
  value: string | { readonly id: string } | null | undefined,
): string | undefined => {
  if (value == null) return undefined;
  return typeof value === "string" ? value : value.id;
};

const toRequestShipping = (shipping: IssuingCardShippingProps) => ({
  name: shipping.name,
  address: toRequestAddress(shipping.address),
  ...(shipping.phoneNumber !== undefined
    ? { phone_number: shipping.phoneNumber }
    : {}),
  ...(shipping.requireSignature !== undefined
    ? { require_signature: shipping.requireSignature }
    : {}),
  ...(shipping.service !== undefined ? { service: shipping.service } : {}),
  ...(shipping.type !== undefined ? { type: shipping.type } : {}),
  ...(shipping.customsEoriNumber !== undefined
    ? { customs: { eori_number: shipping.customsEoriNumber } }
    : {}),
  ...(shipping.addressValidationMode !== undefined
    ? { address_validation: { mode: shipping.addressValidationMode } }
    : {}),
});

/**
 * Project observed shipment details back into the *request* shape so the
 * desired payload can be compared against them field-for-field.
 * `address_validation` is deliberately excluded: Stripe rewrites it into a
 * result object that never round-trips.
 */
const toObservedShippingRequest = (
  shipping: StripeCard["shipping"],
): Record<string, unknown> => {
  if (shipping == null) return {};
  return {
    name: shipping.name,
    address: toRequestAddress(toObservedAddress(shipping.address)),
    ...(shipping.phone_number != null
      ? { phone_number: shipping.phone_number }
      : {}),
    ...(shipping.require_signature != null
      ? { require_signature: shipping.require_signature }
      : {}),
    service: shipping.service,
    type: shipping.type,
    ...(shipping.customs?.eori_number != null
      ? { customs: { eori_number: shipping.customs.eori_number } }
      : {}),
  };
};

const toObservedShipping = (
  shipping: StripeCard["shipping"],
): IssuingCardObservedShipping | undefined => {
  if (shipping == null) return undefined;
  return {
    name: shipping.name,
    address: toObservedAddress(shipping.address),
    phoneNumber: shipping.phone_number ?? undefined,
    requireSignature: shipping.require_signature ?? undefined,
    service: shipping.service,
    type: shipping.type,
    status: shipping.status ?? undefined,
    carrier: shipping.carrier ?? undefined,
    eta: shipping.eta ?? undefined,
    trackingNumber: shipping.tracking_number ?? undefined,
    trackingUrl: shipping.tracking_url ?? undefined,
    customsEoriNumber: shipping.customs?.eori_number ?? undefined,
  };
};

/**
 * Compare a sparse desired payload against observed state, considering only
 * the keys the caller actually set — Stripe's server-side defaults for
 * omitted keys are not drift.
 */
const matchesObserved = (desired: object, observed: object): boolean => {
  const observedEntries = new Map(Object.entries(observed));
  return Object.entries(desired).every(([key, value]) =>
    deepEqual(value, observedEntries.get(key)),
  );
};
