import {
  GetPaymentMethodConfigurations,
  GetPaymentMethodConfigurationsConfiguration,
  type PaymentMethodConfigResourcePaymentMethodProperties,
  type PaymentMethodConfiguration as StripePaymentMethodConfiguration,
  PostPaymentMethodConfigurations,
  PostPaymentMethodConfigurationsConfiguration,
  type PostPaymentMethodConfigurationsConfigurationRequest,
} from "@distilled.cloud/stripe/stripe";
import * as Effect from "effect/Effect";
import { Unowned } from "../AdoptPolicy.ts";
import { isResolved } from "../Diff.ts";
import { createPhysicalName } from "../PhysicalName.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import type { Providers } from "./Providers.ts";

/**
 * The account's display preference for a single payment method.
 *
 * - `on` — offer the payment method at checkout (when its capability is active)
 * - `off` — never offer the payment method
 * - `none` — no explicit preference; Stripe (or, for child configurations,
 *   the parent configuration) decides
 */
export type PaymentMethodPreference = "none" | "off" | "on";

/**
 * Per-payment-method toggle. Mirrors Stripe's
 * `{ display_preference: { preference } }` request shape.
 */
export type PaymentMethodToggle = {
  /** Whether or not the payment method should be displayed at checkout. */
  displayPreference?: {
    /** The account's preference for this payment method. */
    preference?: PaymentMethodPreference;
  };
};

/**
 * The observed state of a single payment method on a deployed configuration.
 */
export type PaymentMethodStatus = {
  /**
   * Whether the payment method may actually be offered at checkout — true
   * when `preference` is `on` **and** the account's capability for that
   * payment method is active.
   */
  available: boolean;
  /** The account's configured display preference. */
  preference: string;
  /** The effective display preference after parent/child resolution. */
  value: string;
  /**
   * For child configurations, whether the connected account's preference is
   * observed. `undefined` on direct (non-Connect) configurations.
   */
  overridable: boolean | undefined;
};

/**
 * Observed payment-method state, keyed by the same camelCase names used in
 * {@link PaymentMethodConfigurationProps}.
 */
export type PaymentMethodStatuses = {
  [K in PaymentMethodKey]?: PaymentMethodStatus;
};

/**
 * camelCase prop name to Stripe wire name, for every payment method the
 * `POST /v1/payment_method_configurations` request accepts.
 */
const PAYMENT_METHODS = {
  acssDebit: "acss_debit",
  affirm: "affirm",
  afterpayClearpay: "afterpay_clearpay",
  alipay: "alipay",
  alma: "alma",
  amazonPay: "amazon_pay",
  applePay: "apple_pay",
  applePayLater: "apple_pay_later",
  auBecsDebit: "au_becs_debit",
  bacsDebit: "bacs_debit",
  bancontact: "bancontact",
  billie: "billie",
  bizum: "bizum",
  blik: "blik",
  boleto: "boleto",
  card: "card",
  cartesBancaires: "cartes_bancaires",
  cashapp: "cashapp",
  crypto: "crypto",
  customerBalance: "customer_balance",
  eps: "eps",
  fpx: "fpx",
  frMealVoucherConecs: "fr_meal_voucher_conecs",
  giropay: "giropay",
  googlePay: "google_pay",
  grabpay: "grabpay",
  ideal: "ideal",
  jcb: "jcb",
  kakaoPay: "kakao_pay",
  klarna: "klarna",
  konbini: "konbini",
  krCard: "kr_card",
  link: "link",
  mbWay: "mb_way",
  mobilepay: "mobilepay",
  multibanco: "multibanco",
  naverPay: "naver_pay",
  nzBankAccount: "nz_bank_account",
  oxxo: "oxxo",
  p24: "p24",
  payByBank: "pay_by_bank",
  payco: "payco",
  paynow: "paynow",
  paypal: "paypal",
  payto: "payto",
  pix: "pix",
  promptpay: "promptpay",
  revolutPay: "revolut_pay",
  samsungPay: "samsung_pay",
  satispay: "satispay",
  scalapay: "scalapay",
  sepaDebit: "sepa_debit",
  sofort: "sofort",
  sunbit: "sunbit",
  swish: "swish",
  twint: "twint",
  upi: "upi",
  usBankAccount: "us_bank_account",
  wechatPay: "wechat_pay",
  zip: "zip",
} as const;

/** camelCase name of a payment method toggle. */
export type PaymentMethodKey = keyof typeof PAYMENT_METHODS;

/** Stripe wire name of a payment method toggle. */
export type PaymentMethodWireKey = (typeof PAYMENT_METHODS)[PaymentMethodKey];

const PAYMENT_METHOD_KEYS = Object.keys(PAYMENT_METHODS) as PaymentMethodKey[];

const WIRE_TO_KEY: Record<string, PaymentMethodKey | undefined> =
  Object.fromEntries(
    PAYMENT_METHOD_KEYS.map((key) => [PAYMENT_METHODS[key], key]),
  );

/**
 * `apple_pay_later` and `fr_meal_voucher_conecs` are accepted by the create
 * and update requests but are **not echoed back** on the
 * `PaymentMethodConfiguration` object, so their live preference cannot be
 * observed. For those two — and only those two — the previously-deployed
 * props are used as the diff baseline (the doctrine's "olds as a hint"
 * allowance) instead of observed cloud state.
 */
const UNOBSERVABLE_METHODS = new Set<PaymentMethodKey>([
  "applePayLater",
  "frMealVoucherConecs",
]);

/** Hard bound on list pagination so a runaway cursor can never spin. */
const MAX_LIST_PAGES = 50;

export type PaymentMethodConfigurationProps = {
  /**
   * Human-readable name for the configuration, shown in the Stripe
   * dashboard. If omitted, a unique name is generated from
   * `${app}-${stage}-${id}`.
   *
   * Because payment method configurations carry no `metadata`, the name is
   * also how Alchemy re-discovers this configuration if its state row is
   * lost — supplying your own name opts out of that safety net and makes
   * re-adoption require `--adopt`.
   */
  name?: string;
  /**
   * The ID of the parent configuration for a Connect **child**
   * configuration. Parent configurations are managed in the dashboard and
   * cannot be created through the API.
   *
   * Cannot be changed after creation — changing it replaces the resource.
   */
  parent?: string;
  /** Canadian pre-authorized debit. */
  acssDebit?: PaymentMethodToggle;
  /** Affirm buy-now-pay-later. */
  affirm?: PaymentMethodToggle;
  /** Afterpay / Clearpay buy-now-pay-later. */
  afterpayClearpay?: PaymentMethodToggle;
  /** Alipay. */
  alipay?: PaymentMethodToggle;
  /** Alma buy-now-pay-later. */
  alma?: PaymentMethodToggle;
  /** Amazon Pay. */
  amazonPay?: PaymentMethodToggle;
  /** Apple Pay. */
  applePay?: PaymentMethodToggle;
  /**
   * Apple Pay Later.
   *
   * Stripe accepts this on create/update but does not return it on the
   * configuration object, so its live value cannot be observed.
   */
  applePayLater?: PaymentMethodToggle;
  /** Australian BECS direct debit. */
  auBecsDebit?: PaymentMethodToggle;
  /** UK Bacs direct debit. */
  bacsDebit?: PaymentMethodToggle;
  /** Bancontact (Belgium). */
  bancontact?: PaymentMethodToggle;
  /** Billie (Germany, B2B). */
  billie?: PaymentMethodToggle;
  /** Bizum (Spain). */
  bizum?: PaymentMethodToggle;
  /** BLIK (Poland). */
  blik?: PaymentMethodToggle;
  /** Boleto (Brazil). */
  boleto?: PaymentMethodToggle;
  /** Card payments. */
  card?: PaymentMethodToggle;
  /** Cartes Bancaires (France). */
  cartesBancaires?: PaymentMethodToggle;
  /** Cash App Pay. */
  cashapp?: PaymentMethodToggle;
  /** Crypto payments. */
  crypto?: PaymentMethodToggle;
  /** Customer balance (bank transfer). */
  customerBalance?: PaymentMethodToggle;
  /** EPS (Austria). */
  eps?: PaymentMethodToggle;
  /** FPX (Malaysia). */
  fpx?: PaymentMethodToggle;
  /**
   * French meal voucher (Conecs).
   *
   * Stripe accepts this on create/update but does not return it on the
   * configuration object, so its live value cannot be observed.
   */
  frMealVoucherConecs?: PaymentMethodToggle;
  /** giropay (Germany). */
  giropay?: PaymentMethodToggle;
  /** Google Pay. */
  googlePay?: PaymentMethodToggle;
  /** GrabPay (Southeast Asia). */
  grabpay?: PaymentMethodToggle;
  /** iDEAL (Netherlands). */
  ideal?: PaymentMethodToggle;
  /** JCB cards. */
  jcb?: PaymentMethodToggle;
  /** Kakao Pay (South Korea). */
  kakaoPay?: PaymentMethodToggle;
  /** Klarna buy-now-pay-later. */
  klarna?: PaymentMethodToggle;
  /** Konbini (Japanese convenience stores). */
  konbini?: PaymentMethodToggle;
  /** Korean cards. */
  krCard?: PaymentMethodToggle;
  /** Link, Stripe's one-click checkout. */
  link?: PaymentMethodToggle;
  /** MB WAY (Portugal). */
  mbWay?: PaymentMethodToggle;
  /** MobilePay (Denmark, Finland). */
  mobilepay?: PaymentMethodToggle;
  /** Multibanco (Portugal). */
  multibanco?: PaymentMethodToggle;
  /** Naver Pay (South Korea). */
  naverPay?: PaymentMethodToggle;
  /** New Zealand bank account debit. */
  nzBankAccount?: PaymentMethodToggle;
  /** OXXO (Mexico). */
  oxxo?: PaymentMethodToggle;
  /** Przelewy24 (Poland). */
  p24?: PaymentMethodToggle;
  /** Pay by Bank (open banking). */
  payByBank?: PaymentMethodToggle;
  /** PAYCO (South Korea). */
  payco?: PaymentMethodToggle;
  /** PayNow (Singapore). */
  paynow?: PaymentMethodToggle;
  /** PayPal. */
  paypal?: PaymentMethodToggle;
  /** PayTo (Australia). */
  payto?: PaymentMethodToggle;
  /** Pix (Brazil). */
  pix?: PaymentMethodToggle;
  /** PromptPay (Thailand). */
  promptpay?: PaymentMethodToggle;
  /** Revolut Pay. */
  revolutPay?: PaymentMethodToggle;
  /** Samsung Pay. */
  samsungPay?: PaymentMethodToggle;
  /** Satispay (Italy). */
  satispay?: PaymentMethodToggle;
  /** Scalapay buy-now-pay-later. */
  scalapay?: PaymentMethodToggle;
  /** SEPA direct debit. */
  sepaDebit?: PaymentMethodToggle;
  /** SOFORT. */
  sofort?: PaymentMethodToggle;
  /** Sunbit buy-now-pay-later. */
  sunbit?: PaymentMethodToggle;
  /** Swish (Sweden). */
  swish?: PaymentMethodToggle;
  /** TWINT (Switzerland). */
  twint?: PaymentMethodToggle;
  /** UPI (India). */
  upi?: PaymentMethodToggle;
  /** ACH direct debit on a US bank account. */
  usBankAccount?: PaymentMethodToggle;
  /** WeChat Pay. */
  wechatPay?: PaymentMethodToggle;
  /** Zip buy-now-pay-later. */
  zip?: PaymentMethodToggle;
};

export type PaymentMethodConfiguration = Resource<
  "Stripe.PaymentMethodConfiguration",
  PaymentMethodConfigurationProps,
  {
    /** The configuration's Stripe ID (`pmc_...`). */
    paymentMethodConfigurationId: string;
    /** The configuration's name. */
    name: string;
    /**
     * Whether the configuration can be used for new payments. Destroying
     * this resource flips it to `false` — Stripe has no delete API.
     */
    active: boolean;
    /**
     * Whether this is the account's default configuration, used whenever a
     * payment method configuration is not explicitly specified. Default
     * configurations cannot be deactivated.
     */
    isDefault: boolean;
    /** For child configurations, the parent configuration's ID. */
    parent: string | undefined;
    /** For child configurations, the associated Connect application. */
    application: string | undefined;
    /** `true` when the configuration lives in live mode. */
    livemode: boolean;
    /** Observed per-payment-method state, keyed by camelCase prop name. */
    paymentMethods: PaymentMethodStatuses;
  },
  never,
  Providers
>;

type PaymentMethodConfigurationAttributes =
  PaymentMethodConfiguration["Attributes"];

/**
 * A Stripe payment method configuration — the set of payment methods offered
 * to customers when a Checkout Session, Payment Link or Payment Intent does
 * not spell out `payment_method_types` explicitly.
 *
 * Each payment method is a `{ displayPreference: { preference } }` toggle:
 * `on` offers it, `off` hides it, and `none` defers to Stripe's (or the
 * parent configuration's) default. A payment method only becomes
 * `available` once the account's capability for it is also active.
 *
 * :::caution
 * Stripe does not support deleting a payment method configuration.
 * Destroying this resource **archives** it by setting `active: false`; the
 * configuration remains visible in the dashboard and in list calls. The
 * account's default configuration cannot even be deactivated — destroying a
 * resource that adopted the default logs a warning and leaves it untouched.
 * :::
 *
 * ### Creating a configuration
 * **Example:** Cards only
 * ```typescript
 * const cardsOnly = yield* Stripe.PaymentMethodConfiguration("cards-only", {
 *   name: "Cards only",
 *   card: { displayPreference: { preference: "on" } },
 * });
 * ```
 *
 * **Example:** A wallet-forward European checkout
 * ```typescript
 * const eu = yield* Stripe.PaymentMethodConfiguration("eu-checkout", {
 *   name: "EU checkout",
 *   card: { displayPreference: { preference: "on" } },
 *   link: { displayPreference: { preference: "on" } },
 *   applePay: { displayPreference: { preference: "on" } },
 *   googlePay: { displayPreference: { preference: "on" } },
 *   ideal: { displayPreference: { preference: "on" } },
 *   bancontact: { displayPreference: { preference: "on" } },
 *   sepaDebit: { displayPreference: { preference: "on" } },
 *   klarna: { displayPreference: { preference: "off" } },
 * });
 * ```
 *
 * ### Turning a payment method off
 * **Example:** Hide buy-now-pay-later without deleting the configuration
 * ```typescript
 * const config = yield* Stripe.PaymentMethodConfiguration("checkout", {
 *   card: { displayPreference: { preference: "on" } },
 *   affirm: { displayPreference: { preference: "off" } },
 *   afterpayClearpay: { displayPreference: { preference: "off" } },
 *   klarna: { displayPreference: { preference: "off" } },
 * });
 * ```
 *
 * ### Connect child configurations
 * **Example:** Derive a child configuration from a dashboard-managed parent
 * ```typescript
 * const child = yield* Stripe.PaymentMethodConfiguration("connected-account", {
 *   name: "Connected account methods",
 *   parent: "pmc_1234567890",
 *   card: { displayPreference: { preference: "on" } },
 * });
 * ```
 *
 * ### Using the configuration
 * **Example:** Reference the configuration from another Stripe API
 * ```typescript
 * const config = yield* Stripe.PaymentMethodConfiguration("checkout", {
 *   card: { displayPreference: { preference: "on" } },
 * });
 *
 * // A `pmc_...` id, ready to pass to any Stripe API that accepts
 * // `payment_method_configuration` (Checkout Sessions, Payment Links,
 * // Payment Intents, ...).
 * const configurationId = config.paymentMethodConfigurationId;
 * ```
 *
 * @see https://docs.stripe.com/api/payment_method_configurations
 *
 * @resource
 */
export const PaymentMethodConfiguration = Resource<PaymentMethodConfiguration>(
  "Stripe.PaymentMethodConfiguration",
);

export const PaymentMethodConfigurationProvider = () =>
  Provider.succeed(PaymentMethodConfiguration, {
    stables: ["paymentMethodConfigurationId"],
    list: Effect.fn(function* () {
      const configurations = yield* listAllConfigurations;
      return configurations.map(toAttributes);
    }),
    diff: Effect.fn(function* ({ news, olds = {}, output }) {
      if (!isResolved(news)) return undefined;
      // `parent` is fixed at creation: a Connect child configuration cannot
      // be re-parented, and a direct configuration cannot become a child.
      const oldParent = output?.parent ?? olds.parent;
      if ((news.parent ?? undefined) !== (oldParent ?? undefined)) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),
    read: Effect.fn(function* ({ id, output, olds }) {
      if (output?.paymentMethodConfigurationId) {
        const observed = yield* getConfiguration(
          output.paymentMethodConfigurationId,
        );
        return observed === undefined ? undefined : toAttributes(observed);
      }
      // State loss. Payment method configurations carry no metadata, so the
      // name is the only identity available — find the one Alchemy would
      // have created for this logical id.
      const name = olds?.name ?? (yield* createPhysicalName({ id }));
      const configurations = yield* listAllConfigurations;
      const match = configurations.find(
        (configuration) => configuration.name === name,
      );
      if (match === undefined) return undefined;
      const attrs = toAttributes(match);
      // An auto-generated name is effectively a branding: nothing else on
      // the account would carry it. A user-supplied name proves nothing, so
      // gate that takeover behind `--adopt`.
      return olds?.name === undefined ? attrs : Unowned(attrs);
    }),
    reconcile: Effect.fn(function* ({ id, news = {}, olds, output }) {
      const desiredName =
        news.name ?? output?.name ?? (yield* createPhysicalName({ id }));
      const desired = desiredPreferences(news);

      // 1. Observe — `output` only caches the id; the configuration may have
      //    been removed out of band.
      const observed = output?.paymentMethodConfigurationId
        ? yield* getConfiguration(output.paymentMethodConfigurationId)
        : undefined;

      // 2. Ensure — create when missing, applying the whole desired set.
      if (observed === undefined) {
        const created = yield* PostPaymentMethodConfigurations({
          name: desiredName,
          ...(news.parent !== undefined ? { parent: news.parent } : {}),
          ...togglePayload(desired),
        });
        return toAttributes(created);
      }

      // 3. Sync — diff desired against OBSERVED state, one aspect at a time,
      //    and skip the API call entirely when nothing drifted.
      const update: PostPaymentMethodConfigurationsConfigurationRequest = {
        configuration: observed.id,
      };
      let changed = false;

      if (observed.name !== desiredName) {
        update.name = desiredName;
        changed = true;
      }
      // A previously-destroyed (archived) configuration is revived rather
      // than duplicated.
      if (!observed.active) {
        update.active = true;
        changed = true;
      }

      const observedPreferences = readToggles(observed);
      const oldPreferences = desiredPreferences(olds ?? {});
      const drifted: Partial<
        Record<PaymentMethodKey, PaymentMethodPreference>
      > = {};
      for (const key of PAYMENT_METHOD_KEYS) {
        const preference = desired[key];
        if (preference === undefined) continue;
        if (UNOBSERVABLE_METHODS.has(key)) {
          // Not echoed by Stripe — fall back to the previously-deployed prop
          // as a hint so we do not POST it on every no-op deploy.
          if (oldPreferences[key] !== preference) {
            drifted[key] = preference;
            changed = true;
          }
          continue;
        }
        if (observedPreferences[key]?.preference !== preference) {
          drifted[key] = preference;
          changed = true;
        }
      }

      if (!changed) return toAttributes(observed);

      const updated = yield* PostPaymentMethodConfigurationsConfiguration({
        ...update,
        ...togglePayload(drifted),
      });
      return toAttributes(updated);
    }),
    delete: Effect.fn(function* ({ output }) {
      const observed = yield* getConfiguration(
        output.paymentMethodConfigurationId,
      );
      // Already gone (or never created) — deletion is idempotent.
      if (observed === undefined) return;
      if (observed.is_default) {
        yield* Effect.logWarning(
          `Stripe payment method configuration ${observed.id} is the account default and cannot be deactivated - leaving it in place.`,
        );
        return;
      }
      // Already archived — nothing to do.
      if (!observed.active) return;
      yield* PostPaymentMethodConfigurationsConfiguration({
        configuration: observed.id,
        active: false,
      }).pipe(
        Effect.asVoid,
        Effect.catchTag("NotFound", () => Effect.void),
        Effect.catchTag("InvalidRequestError", (error) =>
          error.code === "resource_missing" ? Effect.void : Effect.fail(error),
        ),
      );
    }),
  });

/**
 * Payload fragment keyed by Stripe wire names. Every toggle is structurally
 * identical, so one mapped type covers all sixty payment methods and the
 * spread type-checks against both the create and the update request shape.
 */
type TogglePayload = {
  [K in PaymentMethodWireKey]?: {
    display_preference: { preference: PaymentMethodPreference };
  };
};

const togglePayload = (
  preferences: Partial<Record<PaymentMethodKey, PaymentMethodPreference>>,
): TogglePayload => {
  const payload: TogglePayload = {};
  for (const key of PAYMENT_METHOD_KEYS) {
    const preference = preferences[key];
    if (preference === undefined) continue;
    payload[PAYMENT_METHODS[key]] = { display_preference: { preference } };
  }
  return payload;
};

const desiredPreferences = (
  props: PaymentMethodConfigurationProps,
): Partial<Record<PaymentMethodKey, PaymentMethodPreference>> => {
  const desired: Partial<Record<PaymentMethodKey, PaymentMethodPreference>> =
    {};
  for (const key of PAYMENT_METHOD_KEYS) {
    const preference = props[key]?.displayPreference?.preference;
    if (preference !== undefined) desired[key] = preference;
  }
  return desired;
};

/**
 * Stripe spreads the sixty payment methods across sixty sibling members of
 * the configuration object rather than nesting them under one map, so the
 * observed state is read by walking the object's own entries and keeping the
 * ones whose key is a known payment method.
 */
const isMethodProperties = (
  value: unknown,
): value is PaymentMethodConfigResourcePaymentMethodProperties =>
  typeof value === "object" &&
  value !== null &&
  "available" in value &&
  "display_preference" in value;

const readToggles = (
  configuration: StripePaymentMethodConfiguration,
): PaymentMethodStatuses => {
  const statuses: PaymentMethodStatuses = {};
  const view: Record<string, unknown> = { ...configuration };
  for (const [wire, value] of Object.entries(view)) {
    const key = WIRE_TO_KEY[wire];
    if (key === undefined) continue;
    if (!isMethodProperties(value)) continue;
    statuses[key] = {
      available: value.available,
      preference: value.display_preference.preference,
      value: value.display_preference.value,
      overridable: value.display_preference.overridable ?? undefined,
    };
  }
  return statuses;
};

const toAttributes = (
  configuration: StripePaymentMethodConfiguration,
): PaymentMethodConfigurationAttributes => ({
  paymentMethodConfigurationId: configuration.id,
  name: configuration.name,
  active: configuration.active,
  isDefault: configuration.is_default,
  parent: configuration.parent ?? undefined,
  application: configuration.application ?? undefined,
  livemode: configuration.livemode,
  paymentMethods: readToggles(configuration),
});

/**
 * Fetch a configuration, mapping "missing" onto `undefined`.
 *
 * Stripe answers a missing object with `invalid_request_error` /
 * `resource_missing`, which distilled dispatches by `error.type` before
 * status — so the tag is `InvalidRequestError`, not `NotFound`. Both are
 * handled until distilled types `resource_missing` as its own tag.
 */
const getConfiguration = (configuration: string) =>
  GetPaymentMethodConfigurationsConfiguration({ configuration }).pipe(
    Effect.map(
      (result): StripePaymentMethodConfiguration | undefined => result,
    ),
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
    Effect.catchTag("InvalidRequestError", (error) =>
      error.code === "resource_missing"
        ? Effect.succeed(undefined)
        : Effect.fail(error),
    ),
  );

/**
 * Enumerate every payment method configuration on the account. Stripe pages
 * with a `starting_after` cursor plus a `has_more` flag; the page count is
 * hard-bounded so a misbehaving cursor can never spin forever.
 */
const listAllConfigurations = Effect.gen(function* () {
  const configurations: StripePaymentMethodConfiguration[] = [];
  let startingAfter: string | undefined;
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const response = yield* GetPaymentMethodConfigurations({
      limit: 100,
      ...(startingAfter !== undefined ? { starting_after: startingAfter } : {}),
    });
    configurations.push(...response.data);
    const last = response.data[response.data.length - 1];
    if (!response.has_more || last === undefined) break;
    startingAfter = last.id;
  }
  return configurations;
});
