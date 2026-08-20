import * as Stripe from "@/Stripe";
import * as Test from "@/Test/Alchemy";
import {
  GetPaymentMethodDomains,
  GetPaymentMethodDomainsPaymentMethodDomain,
} from "@distilled.cloud/stripe/stripe";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: Stripe.providers() });

/**
 * Registering a payment method domain does NOT require the domain to serve
 * the per-method well-known files — Stripe records the registration either
 * way and reports the per-method outcome in the `applePay` / `googlePay` /
 * … statuses. So these tests use plain deterministic subdomains of the
 * standing test zone and assert on the registration, not on the statuses
 * being `active`.
 *
 * Stripe has **no delete endpoint** for payment method domains: teardown only
 * disables them. Every domain below therefore survives the run (disabled) and
 * is re-adopted + re-enabled by the next run, which is exactly what the
 * reconciler's observe-by-natural-key step exists for. Each test owns a
 * distinct domain so concurrently-running tests never reconcile the same
 * Stripe object.
 */
const BASIC_DOMAIN = "pmd-basic.alchemy-test-2.us";
const FULL_DOMAIN = "pmd-full.alchemy-test-2.us";
const TOGGLE_DOMAIN = "pmd-toggle.alchemy-test-2.us";
const REPLACE_DOMAIN = "pmd-replace-a.alchemy-test-2.us";
const REPLACE_DOMAIN_ALT = "pmd-replace-b.alchemy-test-2.us";

test.provider(
  "create with minimal props, then disable on destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deploy = stack.deploy(
        Stripe.PaymentMethodDomain("BasicDomain", {
          domainName: BASIC_DOMAIN,
        }),
      );

      const created = yield* deploy;
      expect(created.paymentMethodDomainId).toBeDefined();
      expect(created.paymentMethodDomainId).toMatch(/^pmd_/);
      expect(created.domainName).toEqual(BASIC_DOMAIN);
      // `enabled` defaults to true.
      expect(created.enabled).toBe(true);
      expect(created.created).toBeGreaterThan(0);
      // Every payment method surfaces a status object.
      expect(created.applePay.status).toBeDefined();
      expect(created.googlePay.status).toBeDefined();
      expect(created.link.status).toBeDefined();
      expect(created.paypal.status).toBeDefined();
      expect(created.amazonPay.status).toBeDefined();
      expect(created.klarna.status).toBeDefined();

      // Out-of-band: the registration really exists in Stripe.
      const fetched = yield* GetPaymentMethodDomainsPaymentMethodDomain({
        payment_method_domain: created.paymentMethodDomainId,
      });
      expect(fetched.id).toEqual(created.paymentMethodDomainId);
      expect(fetched.domain_name).toEqual(BASIC_DOMAIN);
      expect(fetched.enabled).toBe(true);

      // An unchanged redeploy is a no-op — same registration, same id.
      const again = yield* deploy;
      expect(again.paymentMethodDomainId).toEqual(
        created.paymentMethodDomainId,
      );
      expect(again.created).toEqual(created.created);

      yield* stack.destroy();

      // Archive-instead-of-delete: the object still exists, but disabled.
      const afterDestroy = yield* GetPaymentMethodDomainsPaymentMethodDomain({
        payment_method_domain: created.paymentMethodDomainId,
      });
      expect(afterDestroy.id).toEqual(created.paymentMethodDomainId);
      expect(afterDestroy.enabled).toBe(false);

      yield* stack.destroy();
    }),
  { timeout: 120_000 },
);

test.provider(
  "create with the full prop surface",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Stripe.PaymentMethodDomain("FullDomain", {
          domainName: FULL_DOMAIN,
          enabled: false,
          validate: true,
        }),
      );

      expect(created.domainName).toEqual(FULL_DOMAIN);
      expect(created.enabled).toBe(false);
      // Validation ran; the domain does not serve the well-known files, so
      // the statuses report the failure rather than going active.
      expect(created.applePay.status).toEqual("inactive");

      const fetched = yield* GetPaymentMethodDomainsPaymentMethodDomain({
        payment_method_domain: created.paymentMethodDomainId,
      });
      expect(fetched.enabled).toBe(false);
      expect(fetched.domain_name).toEqual(FULL_DOMAIN);

      yield* stack.destroy();
    }),
  { timeout: 120_000 },
);

test.provider(
  "toggling enabled updates in place",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const disabled = yield* stack.deploy(
        Stripe.PaymentMethodDomain("ToggleDomain", {
          domainName: TOGGLE_DOMAIN,
          enabled: false,
        }),
      );
      expect(disabled.enabled).toBe(false);

      const enabled = yield* stack.deploy(
        Stripe.PaymentMethodDomain("ToggleDomain", {
          domainName: TOGGLE_DOMAIN,
          enabled: true,
        }),
      );
      // `enabled` is mutable — the id must survive the update.
      expect(enabled.paymentMethodDomainId).toEqual(
        disabled.paymentMethodDomainId,
      );
      expect(enabled.enabled).toBe(true);

      const fetched = yield* GetPaymentMethodDomainsPaymentMethodDomain({
        payment_method_domain: enabled.paymentMethodDomainId,
      });
      expect(fetched.enabled).toBe(true);

      yield* stack.destroy();
    }),
  { timeout: 120_000 },
);

test.provider(
  "changing the domain name replaces the registration",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Stripe.PaymentMethodDomain("ReplacedDomain", {
          domainName: REPLACE_DOMAIN,
        }),
      );
      expect(created.domainName).toEqual(REPLACE_DOMAIN);
      expect(created.enabled).toBe(true);

      // `domain_name` is immutable — Stripe's update endpoint accepts only
      // `enabled` — so a change must plan a replacement and mint a new id.
      const replaced = yield* stack.deploy(
        Stripe.PaymentMethodDomain("ReplacedDomain", {
          domainName: REPLACE_DOMAIN_ALT,
        }),
      );
      expect(replaced.domainName).toEqual(REPLACE_DOMAIN_ALT);
      expect(replaced.paymentMethodDomainId).not.toEqual(
        created.paymentMethodDomainId,
      );
      expect(replaced.enabled).toBe(true);

      const fetched = yield* GetPaymentMethodDomainsPaymentMethodDomain({
        payment_method_domain: replaced.paymentMethodDomainId,
      });
      expect(fetched.domain_name).toEqual(REPLACE_DOMAIN_ALT);
      expect(fetched.enabled).toBe(true);

      // The superseded registration cannot be deleted, so the replacement's
      // teardown disables it instead — it is still listed, just off.
      const old = yield* GetPaymentMethodDomainsPaymentMethodDomain({
        payment_method_domain: created.paymentMethodDomainId,
      });
      expect(old.enabled).toBe(false);

      const listed = yield* GetPaymentMethodDomains({
        domain_name: REPLACE_DOMAIN,
        limit: 100,
      });
      expect(
        listed.data.some((d) => d.id === created.paymentMethodDomainId),
      ).toBe(true);

      yield* stack.destroy();
    }),
  { timeout: 120_000 },
);
