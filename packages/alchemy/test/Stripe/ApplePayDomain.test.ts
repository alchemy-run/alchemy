import * as Stripe from "@/Stripe";
import * as Test from "@/Test/Alchemy";
import {
  GetApplePayDomains,
  GetApplePayDomainsDomain,
  PostApplePayDomains,
} from "@distilled.cloud/stripe/stripe";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

const { test } = Test.make({ providers: Stripe.providers() });

/**
 * Registering an Apple Pay domain is a *verification* handshake, not a plain
 * record write: Stripe fetches
 * `https://{domain}/.well-known/apple-developer-merchantid-domain-association`
 * and rejects the create when that file is not already served over HTTPS from
 * a publicly-reachable host with a publicly-trusted certificate.
 *
 * There is no way to fake that from a test, so the full lifecycle is gated on
 * a real, controlled domain supplied out of band:
 *
 * ```sh
 * STRIPE_TEST_APPLE_PAY_DOMAIN=pay.example.com \
 * STRIPE_TEST_APPLE_PAY_DOMAIN_ALT=pay2.example.com \
 *   pnpm test test/Stripe/ApplePayDomain.test.ts --profile testing
 * ```
 *
 * The ungated probe below still runs everywhere: it pins the shape of the
 * rejection so the gating stays honest and the typed-error surface is
 * exercised on every run.
 */
const DOMAIN = process.env.STRIPE_TEST_APPLE_PAY_DOMAIN;
const DOMAIN_ALT = process.env.STRIPE_TEST_APPLE_PAY_DOMAIN_ALT;

/**
 * A domain that provably cannot serve the verification file — `.invalid` is
 * reserved by RFC 2606 and never resolves.
 */
const UNVERIFIABLE_DOMAIN = "alchemy-apple-pay-probe.invalid";

test.provider(
  "registering an unverifiable domain fails with a typed Stripe error",
  () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        PostApplePayDomains({ domain_name: UNVERIFIABLE_DOMAIN }),
      );

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        // Stripe reports the failed verification as an invalid_request_error.
        // Assert it lands on a *typed* tag rather than the catch-all so a
        // future distilled regression is caught here.
        expect(result.failure._tag).not.toEqual("UnknownStripeError");
      }
    }),
);

test.provider.skipIf(!DOMAIN)(
  "create, refresh and delete an apple pay domain",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deploy = stack.deploy(
        Stripe.ApplePayDomain("PayDomain", { domainName: DOMAIN! }),
      );

      const created = yield* deploy;
      expect(created.applePayDomainId).toBeDefined();
      expect(created.applePayDomainId).toMatch(/^apwc_/);
      expect(created.domainName).toEqual(DOMAIN);
      expect(created.created).toBeGreaterThan(0);

      // Out-of-band: the registration really exists in Stripe.
      const fetched = yield* GetApplePayDomainsDomain({
        domain: created.applePayDomainId,
      });
      expect(fetched.id).toEqual(created.applePayDomainId);
      expect(fetched.domain_name).toEqual(DOMAIN);

      // An unchanged redeploy is a no-op — same registration, same id.
      const again = yield* deploy;
      expect(again.applePayDomainId).toEqual(created.applePayDomainId);
      expect(again.domainName).toEqual(created.domainName);
      expect(again.created).toEqual(created.created);

      yield* stack.destroy();

      // Apple Pay domains are genuinely deletable — the registration is gone.
      const afterDelete = yield* Effect.result(
        GetApplePayDomainsDomain({ domain: created.applePayDomainId }),
      );
      expect(Result.isFailure(afterDelete)).toBe(true);

      const listed = yield* GetApplePayDomains({
        domain_name: DOMAIN!,
        limit: 100,
      });
      expect(listed.data.some((d) => d.id === created.applePayDomainId)).toBe(
        false,
      );

      yield* stack.destroy();
    }),
  { timeout: 120_000 },
);

test.provider.skipIf(!DOMAIN || !DOMAIN_ALT)(
  "changing the domain name replaces the registration",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Stripe.ApplePayDomain("ReplacedDomain", { domainName: DOMAIN! }),
      );
      expect(created.domainName).toEqual(DOMAIN);

      // `domain_name` is immutable — Stripe exposes no update endpoint — so
      // a change must plan a replacement and mint a new id.
      const replaced = yield* stack.deploy(
        Stripe.ApplePayDomain("ReplacedDomain", { domainName: DOMAIN_ALT! }),
      );
      expect(replaced.domainName).toEqual(DOMAIN_ALT);
      expect(replaced.applePayDomainId).not.toEqual(created.applePayDomainId);

      const fetched = yield* GetApplePayDomainsDomain({
        domain: replaced.applePayDomainId,
      });
      expect(fetched.domain_name).toEqual(DOMAIN_ALT);

      // The superseded registration was deleted as part of the replacement.
      const old = yield* Effect.result(
        GetApplePayDomainsDomain({ domain: created.applePayDomainId }),
      );
      expect(Result.isFailure(old)).toBe(true);

      yield* stack.destroy();
    }),
  { timeout: 120_000 },
);
