import type { StripeOpError } from "@distilled.cloud/stripe";
import {
  GetPaymentMethodDomains,
  GetPaymentMethodDomainsPaymentMethodDomain,
  type PaymentMethodDomain as StripePaymentMethodDomain,
  PostPaymentMethodDomains,
  PostPaymentMethodDomainsPaymentMethodDomain,
  PostPaymentMethodDomainsPaymentMethodDomainValidate,
} from "@distilled.cloud/stripe/stripe";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import { Unowned } from "../AdoptPolicy.ts";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import type { Providers } from "./Providers.ts";

const TypeId = "Stripe.PaymentMethodDomain" as const;
type TypeId = typeof TypeId;

/**
 * Upper bound on list pages walked while searching for a domain. Stripe
 * returns at most 100 objects per page, so this caps a cold read at 10k
 * objects rather than looping unbounded on a pathological account.
 */
const MAX_PAGES = 100;

/**
 * The status of one payment method on a registered domain, as most recently
 * determined by Stripe's domain validation.
 */
export type PaymentMethodDomainStatus = {
  /**
   * `"active"` when the payment method may be shown on the domain,
   * `"inactive"` when Stripe's validation for that method did not pass.
   */
  status: "active" | "inactive" | (string & {});
  /**
   * Why the method is inactive, when Stripe supplied a reason — typically a
   * missing or unreachable well-known verification file.
   */
  statusDetails?: {
    /** Human-readable explanation of the failure. */
    errorMessage: string;
  };
};

export type PaymentMethodDomainProps = {
  /**
   * The web domain to register, e.g. `checkout.example.com`. Do not include
   * a scheme or a path.
   *
   * Immutable — changing it replaces the resource.
   */
  domainName: string;
  /**
   * Whether payment methods that require a registered domain may be shown in
   * Elements and Embedded Checkout on this domain. Mutable in place.
   *
   * @default true
   */
  enabled?: boolean;
  /**
   * Re-run Stripe's domain validation on every deploy.
   *
   * Validation is what flips the per-method `applePay` / `googlePay` /
   * `link` / … statuses between `active` and `inactive`: Stripe re-fetches
   * each payment method's well-known file from the domain and records the
   * result. Because those statuses are observable state that the reconciler
   * returns as Attributes, re-validating during reconcile is how they
   * converge after you fix hosting — there is no other way to refresh them.
   *
   * Off by default so an unchanged deploy does not spend an extra API call.
   *
   * @default false
   */
  validate?: boolean;
};

export type PaymentMethodDomainAttributes = {
  /** Stripe's identifier for the registration, e.g. `pmd_1A2b3C4d5E6f`. */
  paymentMethodDomainId: string;
  /** The registered web domain. */
  domainName: string;
  /** Whether the domain is currently enabled. */
  enabled: boolean;
  /** Unix timestamp (seconds) at which the registration was created. */
  created: number;
  /** `true` when the registration lives in the account's live mode. */
  livemode: boolean;
  /** Status of Amazon Pay on the domain. */
  amazonPay: PaymentMethodDomainStatus;
  /** Status of Apple Pay on the domain. */
  applePay: PaymentMethodDomainStatus;
  /** Status of Google Pay on the domain. */
  googlePay: PaymentMethodDomainStatus;
  /** Status of Klarna on the domain. */
  klarna: PaymentMethodDomainStatus;
  /** Status of Link on the domain. */
  link: PaymentMethodDomainStatus;
  /** Status of PayPal on the domain. */
  paypal: PaymentMethodDomainStatus;
};

export type PaymentMethodDomain = Resource<
  TypeId,
  PaymentMethodDomainProps,
  PaymentMethodDomainAttributes,
  never,
  Providers
>;

/**
 * A web domain registered with Stripe so that domain-gated payment methods
 * (Apple Pay, Google Pay, Link, PayPal, Amazon Pay, Klarna) can be rendered
 * by Elements and Embedded Checkout on it.
 *
 * Registering a domain makes Stripe fetch each payment method's well-known
 * verification file from it. The registration itself succeeds regardless; the
 * outcome per method is reported in the `applePay` / `googlePay` / `link` /
 * `paypal` / `amazonPay` / `klarna` attributes as `active` or `inactive` with
 * an `errorMessage`. Set `validate: true` to have every deploy re-run that
 * check so the statuses converge once hosting is fixed.
 *
 * :::caution
 * Stripe does not support deleting a payment method domain. Destroying this
 * resource **disables** it (`enabled: false`); the registration remains
 * visible in the dashboard and in `GET /v1/payment_method_domains`. A later
 * deploy of the same `domainName` re-adopts and re-enables that same
 * registration rather than creating a second one.
 * :::
 *
 * Payment method domains carry no `metadata` field, so Alchemy cannot brand
 * them with the usual `alchemy_*` ownership keys. Identity is the domain name
 * itself: if the state row is lost, `read` re-discovers the registration by
 * listing domains and matching `domainName`, and reports it as unowned so the
 * engine gates takeover behind `--adopt`.
 *
 * ### Registering a Domain
 * **Example:** Register a domain
 * ```typescript
 * const domain = yield* Stripe.PaymentMethodDomain("Checkout", {
 *   domainName: "checkout.example.com",
 * });
 * ```
 *
 * **Example:** Register it disabled, to enable later
 * ```typescript
 * const domain = yield* Stripe.PaymentMethodDomain("Checkout", {
 *   domainName: "checkout.example.com",
 *   enabled: false,
 * });
 * ```
 *
 * ### Validating the domain
 * **Example:** Re-check the well-known files on every deploy
 * ```typescript
 * const domain = yield* Stripe.PaymentMethodDomain("Checkout", {
 *   domainName: "checkout.example.com",
 *   validate: true,
 * });
 *
 * // `applePay.status` is "active" once the verification file is reachable.
 * const applePayStatus = domain.applePay.status;
 * ```
 *
 * ### Pairing with an Apple Pay domain
 * **Example:** Register the same domain for both surfaces
 * ```typescript
 * const domainName = "checkout.example.com";
 *
 * // Apple Pay's own registration — required for the Apple Pay button.
 * yield* Stripe.ApplePayDomain("CheckoutApplePay", { domainName });
 *
 * // Elements/Embedded Checkout domain gating for every other method.
 * const domain = yield* Stripe.PaymentMethodDomain("Checkout", {
 *   domainName,
 *   validate: true,
 * });
 * ```
 *
 * ### Changing the domain
 * **Example:** A new domain name replaces the registration
 * ```typescript
 * // `domainName` is immutable — this registers the new domain and disables
 * // the old one. `paymentMethodDomainId` changes.
 * const domain = yield* Stripe.PaymentMethodDomain("Checkout", {
 *   domainName: "pay.example.com",
 * });
 * ```
 *
 * @see https://docs.stripe.com/api/payment_method_domains
 *
 * @resource
 * @product Stripe
 */
export const PaymentMethodDomain = Resource<PaymentMethodDomain>(TypeId);

/** Returns true if the given value is a PaymentMethodDomain resource. */
export const isPaymentMethodDomain = (
  value: unknown,
): value is PaymentMethodDomain =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

const toStatus = (
  status: StripePaymentMethodDomain["apple_pay"],
): PaymentMethodDomainStatus => ({
  status: status.status,
  ...(status.status_details !== undefined
    ? {
        statusDetails: { errorMessage: status.status_details.error_message },
      }
    : {}),
});

const toAttributes = (
  domain: StripePaymentMethodDomain,
): PaymentMethodDomainAttributes => ({
  paymentMethodDomainId: domain.id,
  domainName: domain.domain_name,
  enabled: domain.enabled,
  created: domain.created,
  livemode: domain.livemode,
  amazonPay: toStatus(domain.amazon_pay),
  applePay: toStatus(domain.apple_pay),
  googlePay: toStatus(domain.google_pay),
  klarna: toStatus(domain.klarna),
  link: toStatus(domain.link),
  paypal: toStatus(domain.paypal),
});

/**
 * Stripe answers a lookup for a deleted/never-existing object with HTTP 404
 * and `type: "invalid_request_error"`, `code: "resource_missing"`. Distilled
 * dispatches on `type` before status, so that surfaces as
 * `InvalidRequestError` rather than `NotFound` — both are treated as absent.
 *
 * TODO(distilled): patch the Stripe model so `resource_missing` is typed as a
 * dedicated `NotFound`-shaped tag and this second arm can go away.
 */
const missingAsUndefined = <A, R>(
  effect: Effect.Effect<A, StripeOpError, R>,
): Effect.Effect<A | undefined, StripeOpError, R> =>
  effect.pipe(
    Effect.map((value): A | undefined => value),
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
    Effect.catchIf(
      (e) => e._tag === "InvalidRequestError" && e.code === "resource_missing",
      () => Effect.succeed(undefined),
    ),
  );

/** Retrieve one registration by Stripe id; `undefined` when it is gone. */
const getDomainById = (paymentMethodDomainId: string) =>
  missingAsUndefined(
    GetPaymentMethodDomainsPaymentMethodDomain({
      payment_method_domain: paymentMethodDomainId,
    }),
  );

/**
 * Walk every page of `/v1/payment_method_domains`, optionally filtered by
 * domain name. Bounded by {@link MAX_PAGES}; Stripe pages with
 * `starting_after` + `has_more`.
 *
 * The `enabled` filter is deliberately NOT passed: a destroyed-then-
 * redeployed domain sits at `enabled: false`, and filtering it out would make
 * the reconciler register a duplicate.
 */
const listDomains = Effect.fn(function* (domainName?: string) {
  const domains: StripePaymentMethodDomain[] = [];
  let startingAfter: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const response = yield* GetPaymentMethodDomains({
      limit: 100,
      ...(domainName !== undefined ? { domain_name: domainName } : {}),
      ...(startingAfter !== undefined ? { starting_after: startingAfter } : {}),
    });
    domains.push(...response.data);
    const last = response.data[response.data.length - 1];
    if (!response.has_more || last === undefined) break;
    startingAfter = last.id;
  }
  return domains;
});

/** Find the registration for an exact domain name, if any. */
const findByDomainName = Effect.fn(function* (domainName: string) {
  const domains = yield* listDomains(domainName);
  // The `domain_name` query is an exact filter, but re-checking keeps this
  // correct if Stripe ever loosens it to a prefix/substring match.
  return domains.find((d) => d.domain_name === domainName);
});

export const PaymentMethodDomainProvider = () =>
  Provider.succeed(PaymentMethodDomain, {
    // `domainName` is replace-only; `created`/`livemode` are assigned once at
    // registration. `enabled` and the per-method statuses are all mutable.
    stables: ["paymentMethodDomainId", "domainName", "created", "livemode"],

    list: Effect.fn(function* () {
      const domains = yield* listDomains();
      return domains.map(toAttributes);
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news)) return undefined;
      // `domain_name` is the object's immutable identity — Stripe's update
      // endpoint accepts only `enabled`.
      if (output !== undefined && news.domainName !== output.domainName) {
        return { action: "replace" } as const;
      }
      // `enabled` and `validate` both fall through to the engine's default
      // update logic; the reconciler decides whether an API call is needed.
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      // Owned path — refresh through the cached Stripe id.
      if (output?.paymentMethodDomainId) {
        const observed = yield* getDomainById(output.paymentMethodDomainId);
        if (observed) return toAttributes(observed);
      }

      // Cold read (state loss) — the registration has no metadata to brand,
      // so the domain name is the only identity we have. A match is a real
      // registration but we cannot prove we made it, so gate takeover behind
      // `--adopt` by returning it as unowned.
      const domainName = olds?.domainName ?? output?.domainName;
      if (!domainName) return undefined;
      const match = yield* findByDomainName(domainName);
      return match ? Unowned(toAttributes(match)) : undefined;
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const desiredEnabled = news.enabled ?? true;

      // 1. Observe — the cached id is a hint, not proof the registration is
      //    still there. Fall back to the natural key so a create whose state
      //    commit failed (or a prior destroy, which only disables) is
      //    re-discovered instead of duplicated.
      let observed = output?.paymentMethodDomainId
        ? yield* getDomainById(output.paymentMethodDomainId)
        : undefined;
      if (!observed || observed.domain_name !== news.domainName) {
        observed = yield* findByDomainName(news.domainName);
      }

      // 2. Ensure — register when missing.
      if (!observed) {
        observed = yield* PostPaymentMethodDomains({
          domain_name: news.domainName,
          enabled: desiredEnabled,
        });
      }

      // 3. Sync — `enabled` is the only mutable field. Diff against the
      //    OBSERVED value so an out-of-band toggle (or a prior destroy)
      //    converges, and skip the call entirely on a no-op.
      if (observed.enabled !== desiredEnabled) {
        observed = yield* PostPaymentMethodDomainsPaymentMethodDomain({
          payment_method_domain: observed.id,
          enabled: desiredEnabled,
        });
      }

      // 4. Optionally re-run Stripe's validation so the per-method statuses
      //    reflect the domain's current hosting. Idempotent — it only
      //    re-reads the well-known files and rewrites the statuses.
      if (news.validate) {
        observed = yield* PostPaymentMethodDomainsPaymentMethodDomainValidate({
          payment_method_domain: observed.id,
        });
      }

      return toAttributes(observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      // Stripe has no delete endpoint for payment method domains — disabling
      // is the strongest teardown available. Idempotent: an already-disabled
      // or already-missing registration is success, not an error.
      yield* missingAsUndefined(
        PostPaymentMethodDomainsPaymentMethodDomain({
          payment_method_domain: output.paymentMethodDomainId,
          enabled: false,
        }),
      );
    }),
  });
