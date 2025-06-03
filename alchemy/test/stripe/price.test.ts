import Stripe from "stripe";
import { describe, expect } from "vitest";
import { alchemy } from "../../src/alchemy.ts";
import { destroy } from "../../src/destroy.ts";
import { Price } from "../../src/stripe/price.ts";
import { Product } from "../../src/stripe/product.ts";
import { BRANCH_PREFIX } from "../util.ts";

import "../../src/test/vitest.ts";

const test = alchemy.test(import.meta, {
  prefix: BRANCH_PREFIX,
});

const stripeApiKey = import.meta.env.STRIPE_API_KEY;
if (!stripeApiKey) {
  throw new Error("STRIPE_API_KEY environment variable is required");
}

// Initialize a Stripe client for verification
const stripe = new Stripe(stripeApiKey);

describe("Price Resource", () => {
  const testPriceId = `${BRANCH_PREFIX}-price`;
  const testProductId = `${BRANCH_PREFIX}-price-product`;

  test("create, update, and delete price", async (scope) => {
    let product: Product | undefined;
    let price: Price | undefined;

    try {
      // Create a test product first (needed for price)
      const productName = `${BRANCH_PREFIX} Alchemy Price Test Product`;
      product = await Product(testProductId, {
        name: productName,
        description: "A product created for price testing",
      });

      expect(product.id).toBeTruthy();

      // Create a test price
      price = await Price(testPriceId, {
        product: product.id,
        currency: "usd",
        unitAmount: 1500, // $15.00
        nickname: "Original price",
        recurring: {
          interval: "month",
        },
        metadata: {
          test: "initial",
        },
      });

      expect(price.id).toBeTruthy();
      expect(price).toMatchObject({
        product: product.id,
        currency: "usd",
        unitAmount: 1500,
        nickname: "Original price",
        recurring: { interval: "month" },
        metadata: { test: "initial" },
      });

      // Verify with Stripe API
      const stripePrice = await stripe.prices.retrieve(price.id);
      expect(stripePrice).toMatchObject({
        unit_amount: 1500,
        currency: "usd",
        recurring: { interval: "month" },
        product: product.id,
        nickname: "Original price",
      });

      // Update the price (only mutable properties like nickname, metadata, active)
      // Note: unitAmount, currency, product, recurring are immutable in Stripe
      price = await Price(testPriceId, {
        product: product.id,
        currency: "usd",
        unitAmount: 1500, // Keep same amount - immutable
        nickname: "Updated price",
        recurring: {
          interval: "month",
        },
        metadata: {
          test: "updated",
          version: "2",
        },
        active: true,
      });

      expect(price.id).toBeTruthy();
      expect(price).toMatchObject({
        unitAmount: 1500, // Should remain the same
        nickname: "Updated price",
        metadata: { test: "updated", version: "2" },
        currency: "usd",
        recurring: { interval: "month" },
      });

      // Verify update with Stripe API
      const updatedStripePrice = await stripe.prices.retrieve(price.id);
      expect(updatedStripePrice).toMatchObject({
        unit_amount: 1500, // Should remain the same
        nickname: "Updated price",
        metadata: { test: "updated", version: "2" },
      });
    } catch (err) {
      // log the error or else it's silently swallowed by destroy errors
      console.log(err);
      throw err;
    } finally {
      // Always clean up, even if test assertions fail
      await destroy(scope);

      // Verify price was deactivated
      if (price?.id) {
        await assertPriceDeactivated(price.id);
      }

      // Verify product was deactivated
      if (product?.id) {
        await assertProductDeactivated(product.id);
      }
    }
  });

  test("create one-time price", async (scope) => {
    let product: Product | undefined;
    let price: Price | undefined;

    try {
      // Create a test product
      const productName = `${BRANCH_PREFIX} One-time Price Test Product`;
      product = await Product(`${testProductId}-onetime`, {
        name: productName,
        description: "A product for one-time price testing",
      });

      // Create a one-time price (no recurring)
      price = await Price(`${testPriceId}-onetime`, {
        product: product.id,
        currency: "usd",
        unitAmount: 2999, // $29.99
      });

      expect(price.id).toBeTruthy();
      expect(price).toMatchObject({
        product: product.id,
        currency: "usd",
        unitAmount: 2999,
        recurring: undefined,
      });

      // Verify with Stripe API
      const stripePrice = await stripe.prices.retrieve(price.id);
      expect(stripePrice).toMatchObject({
        unit_amount: 2999,
        currency: "usd",
        recurring: null,
        product: product.id,
      });
    } catch (err) {
      console.log(err);
      throw err;
    } finally {
      await destroy(scope);

      if (price?.id) {
        await assertPriceDeactivated(price.id);
      }

      if (product?.id) {
        await assertProductDeactivated(product.id);
      }
    }
  });
});

// Helper functions for verification
async function assertPriceDeactivated(priceId: string) {
  try {
    const price = await stripe.prices.retrieve(priceId);
    // Prices are deactivated, not deleted
    expect(price.active).toBe(false);
  } catch (error) {
    // If price is not found, that's also acceptable
    if (
      error instanceof Stripe.errors.StripeError &&
      error.code === "resource_missing"
    ) {
      return;
    }
    throw error;
  }
}

async function assertProductDeactivated(productId: string) {
  try {
    const product = await stripe.products.retrieve(productId);
    // Products are deactivated, not deleted
    expect(product.active).toBe(false);
  } catch (error) {
    // If product is not found, that's also acceptable
    if (
      error instanceof Stripe.errors.StripeError &&
      error.code === "resource_missing"
    ) {
      return;
    }
    throw error;
  }
}
