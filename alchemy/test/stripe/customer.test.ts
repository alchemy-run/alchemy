import type Stripe from "stripe";
import { beforeAll, describe, expect } from "vitest";
import { alchemy } from "../../src/alchemy.ts";
import { destroy } from "../../src/destroy.ts";
import { createStripeClient } from "../../src/stripe/client.ts";
import { Customer } from "../../src/stripe/customer.ts";
import "../../src/test/vitest.ts";

const BRANCH_PREFIX = process.env.BRANCH_PREFIX || "test";

let stripeClient: Stripe;

const test = alchemy.test(import.meta, {
  prefix: BRANCH_PREFIX,
});

describe("Stripe Customer Resource", () => {
  beforeAll(() => {
    const apiKey = process.env.STRIPE_API_KEY;
    if (!apiKey) {
      throw new Error("STRIPE_API_KEY environment variable is required");
    }
    stripeClient = createStripeClient({ apiKey });
  });

  test("create, update, and delete customer", async (scope) => {
    const customerId = `${BRANCH_PREFIX}-customer-1`;

    let customer: Customer | undefined;
    try {
      customer = await Customer(customerId, {
        email: "test@example.com",
        name: "Test Customer",
        description: "A test customer",
        metadata: {
          test: "true",
          branch: BRANCH_PREFIX,
        },
        address: {
          line1: "123 Test St",
          city: "Test City",
          state: "CA",
          postalCode: "12345",
          country: "US",
        },
      });

      expect(customer).toMatchObject({
        email: "test@example.com",
        name: "Test Customer",
        description: "A test customer",
        address: expect.objectContaining({
          line1: "123 Test St",
        }),
      });

      const stripeCustomer = (await stripeClient.customers.retrieve(
        customer.id,
      )) as Stripe.Customer;
      expect(stripeCustomer.id).toBe(customer.id);
      expect(stripeCustomer.email).toBe("test@example.com");

      customer = await Customer(customerId, {
        email: "updated@example.com",
        name: "Updated Test Customer",
        description: "An updated test customer",
        metadata: {
          test: "true",
          branch: BRANCH_PREFIX,
          updated: "true",
        },
      });

      expect(customer).toMatchObject({
        email: "updated@example.com",
        name: "Updated Test Customer",
      });
    } finally {
      await destroy(scope);

      if (customer) {
        try {
          const deletedCustomer = await stripeClient.customers.retrieve(
            customer.id,
          );
          expect(deletedCustomer.deleted).toBe(true);
        } catch (error: any) {
          if (error.code === "resource_missing") {
            expect(error.code).toBe("resource_missing");
          } else {
            throw error;
          }
        }
      }
    }
  });
});
