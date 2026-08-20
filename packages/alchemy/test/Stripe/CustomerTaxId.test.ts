import * as Stripe from "@/Stripe";
import * as Test from "@/Test/Alchemy";
import {
  GetCustomersCustomerTaxIds,
  GetCustomersCustomerTaxIdsId,
} from "@distilled.cloud/stripe/stripe";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: Stripe.providers() });

/**
 * Format-valid tax ID values from Stripe's own API documentation. Stripe
 * verifies EU VAT numbers asynchronously against VIES, so these are only
 * ever asserted for registration — never for a verification outcome.
 */
const EU_VAT = "DE123456789";
const EU_VAT_ALTERNATE = "DE987654321";
const US_EIN = "12-3456789";

/** Look a tax ID up out-of-band, mapping "missing" onto `undefined`. */
const fetchTaxId = Effect.fn(function* (customerId: string, taxIdId: string) {
  return yield* GetCustomersCustomerTaxIdsId({
    customer: customerId,
    id: taxIdId,
  }).pipe(
    Effect.map(
      (taxId): { id: string; type: string; value: string } | undefined => taxId,
    ),
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
    Effect.catchTag("InvalidRequestError", (e) =>
      e.code === "resource_missing"
        ? Effect.succeed(undefined)
        : Effect.fail(e),
    ),
  );
});

test.provider("create and delete an EU VAT tax id", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const deployed = yield* stack.deploy(
      Effect.gen(function* () {
        const customer = yield* Stripe.Customer("TaxIdCustomer", {
          name: "Alchemy Tax Id Test",
          email: "tax-id-minimal@alchemy.test",
        });
        const taxId = yield* Stripe.CustomerTaxId("TaxId", {
          customerId: customer.customerId,
          type: "eu_vat",
          value: EU_VAT,
        });
        return { customer, taxId };
      }),
    );

    expect(deployed.taxId.taxIdId).toBeDefined();
    expect(deployed.taxId.taxIdId.startsWith("txi_")).toBe(true);
    expect(deployed.taxId.customerId).toEqual(deployed.customer.customerId);
    expect(deployed.taxId.type).toEqual("eu_vat");
    expect(deployed.taxId.value).toEqual(EU_VAT);
    // Verification is asynchronous — the provider must not poll for it, so
    // all we can pin is that Stripe reported *some* status.
    expect(deployed.taxId.verification?.status).toBeDefined();

    const fetched = yield* fetchTaxId(
      deployed.customer.customerId,
      deployed.taxId.taxIdId,
    );
    expect(fetched?.id).toEqual(deployed.taxId.taxIdId);
    expect(fetched?.type).toEqual("eu_vat");
    expect(fetched?.value).toEqual(EU_VAT);

    yield* stack.destroy();

    // The customer is destroyed alongside the tax id, so the tax id lookup
    // resolves to "missing" either way.
    const afterDestroy = yield* fetchTaxId(
      deployed.customer.customerId,
      deployed.taxId.taxIdId,
    );
    expect(afterDestroy).toBeUndefined();
  }),
);

test.provider("create a US EIN tax id alongside an EU VAT one", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const deployed = yield* stack.deploy(
      Effect.gen(function* () {
        const customer = yield* Stripe.Customer("MultiTaxIdCustomer", {
          name: "Alchemy Multi Tax Id Test",
          email: "tax-id-multi@alchemy.test",
        });
        const vat = yield* Stripe.CustomerTaxId("EuVat", {
          customerId: customer.customerId,
          type: "eu_vat",
          value: EU_VAT,
        });
        const ein = yield* Stripe.CustomerTaxId("UsEin", {
          customerId: customer.customerId,
          type: "us_ein",
          value: US_EIN,
        });
        return { customer, vat, ein };
      }),
    );

    expect(deployed.vat.taxIdId).not.toEqual(deployed.ein.taxIdId);
    expect(deployed.ein.type).toEqual("us_ein");
    expect(deployed.ein.value).toEqual(US_EIN);

    const listed = yield* GetCustomersCustomerTaxIds({
      customer: deployed.customer.customerId,
      limit: 100,
    });
    const ids = listed.data.map((taxId) => taxId.id);
    expect(ids).toContain(deployed.vat.taxIdId);
    expect(ids).toContain(deployed.ein.taxIdId);

    yield* stack.destroy();
  }),
);

test.provider("re-deploying identical props keeps the same tax id", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const program = Effect.gen(function* () {
      const customer = yield* Stripe.Customer("StableTaxIdCustomer", {
        name: "Alchemy Stable Tax Id Test",
        email: "tax-id-stable@alchemy.test",
      });
      const taxId = yield* Stripe.CustomerTaxId("StableTaxId", {
        customerId: customer.customerId,
        type: "eu_vat",
        value: EU_VAT,
      });
      return { customer, taxId };
    });

    const created = yield* stack.deploy(program);
    const redeployed = yield* stack.deploy(program);

    // Tax IDs have no update endpoint — an unchanged deploy must be a
    // no-op, not a silent re-registration.
    expect(redeployed.taxId.taxIdId).toEqual(created.taxId.taxIdId);
    expect(redeployed.taxId.value).toEqual(created.taxId.value);

    const listed = yield* GetCustomersCustomerTaxIds({
      customer: created.customer.customerId,
      limit: 100,
    });
    expect(listed.data.filter((taxId) => taxId.value === EU_VAT)).toHaveLength(
      1,
    );

    yield* stack.destroy();
  }),
);

test.provider("changing the tax id value replaces the object", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const program = (value: string) =>
      Effect.gen(function* () {
        const customer = yield* Stripe.Customer("ReplaceTaxIdCustomer", {
          name: "Alchemy Replace Tax Id Test",
          email: "tax-id-replace@alchemy.test",
        });
        const taxId = yield* Stripe.CustomerTaxId("ReplaceTaxId", {
          customerId: customer.customerId,
          type: "eu_vat",
          value,
        });
        return { customer, taxId };
      });

    const created = yield* stack.deploy(program(EU_VAT));
    const replaced = yield* stack.deploy(program(EU_VAT_ALTERNATE));

    // `value` is immutable — the provider must replace, not update.
    expect(replaced.taxId.taxIdId).not.toEqual(created.taxId.taxIdId);
    expect(replaced.taxId.value).toEqual(EU_VAT_ALTERNATE);
    // The customer is untouched by the replacement.
    expect(replaced.customer.customerId).toEqual(created.customer.customerId);

    const oldTaxId = yield* fetchTaxId(
      created.customer.customerId,
      created.taxId.taxIdId,
    );
    expect(oldTaxId).toBeUndefined();

    const newTaxId = yield* fetchTaxId(
      replaced.customer.customerId,
      replaced.taxId.taxIdId,
    );
    expect(newTaxId?.value).toEqual(EU_VAT_ALTERNATE);

    yield* stack.destroy();
  }),
);

test.provider("changing the tax id type replaces the object", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const program = (type: Stripe.CustomerTaxIdType, value: string) =>
      Effect.gen(function* () {
        const customer = yield* Stripe.Customer("RetypeTaxIdCustomer", {
          name: "Alchemy Retype Tax Id Test",
          email: "tax-id-retype@alchemy.test",
        });
        const taxId = yield* Stripe.CustomerTaxId("RetypeTaxId", {
          customerId: customer.customerId,
          type,
          value,
        });
        return { customer, taxId };
      });

    const created = yield* stack.deploy(program("eu_vat", EU_VAT));
    const replaced = yield* stack.deploy(program("us_ein", US_EIN));

    expect(replaced.taxId.taxIdId).not.toEqual(created.taxId.taxIdId);
    expect(replaced.taxId.type).toEqual("us_ein");

    const oldTaxId = yield* fetchTaxId(
      created.customer.customerId,
      created.taxId.taxIdId,
    );
    expect(oldTaxId).toBeUndefined();

    yield* stack.destroy();
  }),
);

test.provider("deleting the tax id leaves the customer intact", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const withTaxId = Effect.gen(function* () {
      const customer = yield* Stripe.Customer("DetachTaxIdCustomer", {
        name: "Alchemy Detach Tax Id Test",
        email: "tax-id-detach@alchemy.test",
      });
      const taxId = yield* Stripe.CustomerTaxId("DetachTaxId", {
        customerId: customer.customerId,
        type: "eu_vat",
        value: EU_VAT,
      });
      return { customer, taxId };
    });

    const created = yield* stack.deploy(withTaxId);

    // Drop the tax id from the stack; the customer stays.
    const withoutTaxId = yield* stack.deploy(
      Effect.gen(function* () {
        const customer = yield* Stripe.Customer("DetachTaxIdCustomer", {
          name: "Alchemy Detach Tax Id Test",
          email: "tax-id-detach@alchemy.test",
        });
        return { customer };
      }),
    );

    expect(withoutTaxId.customer.customerId).toEqual(
      created.customer.customerId,
    );

    const listed = yield* GetCustomersCustomerTaxIds({
      customer: created.customer.customerId,
      limit: 100,
    });
    expect(listed.data.map((taxId) => taxId.id)).not.toContain(
      created.taxId.taxIdId,
    );

    yield* stack.destroy();
  }),
);
