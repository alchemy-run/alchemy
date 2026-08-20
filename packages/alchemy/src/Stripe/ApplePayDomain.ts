import type { StripeOpError } from "@distilled.cloud/stripe";
import {
  type ApplePayDomain as StripeApplePayDomain,
  DeleteApplePayDomainsDomain,
  GetApplePayDomains,
  GetApplePayDomainsDomain,
  PostApplePayDomains,
} from "@distilled.cloud/stripe/stripe";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import { Unowned } from "../AdoptPolicy.ts";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import type { Providers } from "./Providers.ts";

const TypeId = "Stripe.ApplePayDomain" as const;
type TypeId = typeof TypeId;

/**
 * Upper bound on list pages walked while searching for a domain. Stripe
 * returns at most 100 objects per page, so this caps a cold read at 10k
 * objects rather than looping unbounded on a pathological account.
 */
const MAX_PAGES = 100;

export type ApplePayDomainProps = {
  /**
   * The web domain to register with Apple Pay, e.g. `checkout.example.com`.
   * Do not include a scheme or a path.
   *
   * The domain is the object's only configurable field and is immutable —
   * changing it replaces the resource (the new domain is registered, then
   * the old registration is removed).
   *
   * Registration fails unless the domain is already serving the Apple Pay
   * verification file at
   * `https://{domainName}/.well-known/apple-developer-merchantid-domain-association`
   * over HTTPS with a publicly-trusted certificate. Deploy that file before
   * deploying this resource.
   */
  domainName: string;
};

export type ApplePayDomainAttributes = {
  /** Stripe's identifier for the registration, e.g. `apwc_1A2b3C4d5E6f`. */
  applePayDomainId: string;
  /** The registered web domain. */
  domainName: string;
  /** Unix timestamp (seconds) at which the registration was created. */
  created: number;
  /** `true` when the registration lives in the account's live mode. */
  livemode: boolean;
};

export type ApplePayDomain = Resource<
  TypeId,
  ApplePayDomainProps,
  ApplePayDomainAttributes,
  never,
  Providers
>;

/**
 * A domain registered with Apple Pay through Stripe, so that the Apple Pay
 * button can be rendered on that domain by Stripe.js / Elements.
 *
 * Registration is a verification handshake, not just a record: Stripe fetches
 * `https://{domainName}/.well-known/apple-developer-merchantid-domain-association`
 * and the create call **fails** if that file is not already being served over
 * HTTPS from a publicly-reachable host with a publicly-trusted certificate.
 * Host the file first, then deploy this resource — ordering the two with an
 * explicit dependency is the usual way to get that right.
 *
 * Apple Pay domains carry no `metadata` field, so Alchemy cannot brand them
 * with the usual `alchemy_*` ownership keys. Identity is the domain name
 * itself: if the state row for this resource is lost, `read` re-discovers the
 * registration by listing domains and matching `domainName`, and reports it as
 * unowned so the engine gates takeover behind `--adopt`.
 *
 * ### Registering a Domain
 * **Example:** Register a domain for Apple Pay
 * ```typescript
 * const domain = yield* Stripe.ApplePayDomain("Checkout", {
 *   domainName: "checkout.example.com",
 * });
 * ```
 *
 * **Example:** Register several domains for one storefront
 * ```typescript
 * const apex = yield* Stripe.ApplePayDomain("Apex", {
 *   domainName: "example.com",
 * });
 * const www = yield* Stripe.ApplePayDomain("Www", {
 *   domainName: "www.example.com",
 * });
 * ```
 *
 * ### Serving the verification file first
 * **Example:** Register only after the well-known file is deployed
 * ```typescript
 * // The Worker serves
 * // /.well-known/apple-developer-merchantid-domain-association.
 * const site = yield* Storefront;
 *
 * const domain = yield* Stripe.ApplePayDomain("Checkout", {
 *   // Depending on the Worker's output orders the registration after the
 *   // deploy that starts serving the verification file.
 *   domainName: site.customDomain,
 * });
 * ```
 *
 * ### Changing the domain
 * **Example:** A new domain name replaces the registration
 * ```typescript
 * // `domainName` is immutable — this creates a registration for the new
 * // domain and then deletes the old one. `applePayDomainId` changes.
 * const domain = yield* Stripe.ApplePayDomain("Checkout", {
 *   domainName: "pay.example.com",
 * });
 * ```
 *
 * @see https://docs.stripe.com/api/apple_pay_domains
 *
 * @resource
 * @product Stripe
 */
export const ApplePayDomain = Resource<ApplePayDomain>(TypeId);

/** Returns true if the given value is an ApplePayDomain resource. */
export const isApplePayDomain = (value: unknown): value is ApplePayDomain =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

const toAttributes = (
  domain: StripeApplePayDomain,
): ApplePayDomainAttributes => ({
  applePayDomainId: domain.id,
  domainName: domain.domain_name,
  created: domain.created,
  livemode: domain.livemode,
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
const getDomainById = (applePayDomainId: string) =>
  missingAsUndefined(GetApplePayDomainsDomain({ domain: applePayDomainId }));

/**
 * Walk every page of `/v1/apple_pay/domains`, optionally filtered by domain
 * name. Bounded by {@link MAX_PAGES}; Stripe pages with `starting_after` +
 * `has_more`.
 */
const listDomains = Effect.fn(function* (domainName?: string) {
  const domains: StripeApplePayDomain[] = [];
  let startingAfter: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const response = yield* GetApplePayDomains({
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

export const ApplePayDomainProvider = () =>
  Provider.succeed(ApplePayDomain, {
    // `domainName` is replace-only and `created`/`livemode` are assigned once
    // at registration, so nothing here is ever mutated by an update.
    stables: ["applePayDomainId", "domainName", "created", "livemode"],

    list: Effect.fn(function* () {
      const domains = yield* listDomains();
      return domains.map(toAttributes);
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news)) return undefined;
      // The whole object is immutable — Stripe exposes no update endpoint —
      // so the only possible change is a replacement.
      if (output !== undefined && news.domainName !== output.domainName) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      // Owned path — refresh through the cached Stripe id.
      if (output?.applePayDomainId) {
        const observed = yield* getDomainById(output.applePayDomainId);
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
      // 1. Observe — the cached id is a hint, not proof the registration is
      //    still there. Fall back to the natural key so a create whose state
      //    commit failed is re-discovered instead of duplicated.
      let observed = output?.applePayDomainId
        ? yield* getDomainById(output.applePayDomainId)
        : undefined;
      if (!observed || observed.domain_name !== news.domainName) {
        observed = yield* findByDomainName(news.domainName);
      }

      // 2. Ensure — register when missing. Observation above already covers
      //    the "created but state commit failed" case, so this is reached
      //    only when Stripe genuinely has no registration for the domain.
      if (!observed) {
        observed = yield* PostApplePayDomains({
          domain_name: news.domainName,
        });
      }

      // 3. No sync step — an Apple Pay domain has no mutable field.
      return toAttributes(observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      // Idempotent: an already-deleted registration is success, not an error.
      yield* missingAsUndefined(
        DeleteApplePayDomainsDomain({ domain: output.applePayDomainId }),
      );
    }),
  });
