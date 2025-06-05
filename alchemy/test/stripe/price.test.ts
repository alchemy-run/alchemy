import Stripe from "stripe";
import { describe, expect } from "vitest";
import { alchemy } from "../../src/alchemy.ts";
import { destroy } from "../../src/destroy.ts";
import { createStripeClient } from "../../src/stripe/client.ts";
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
const stripe = createStripeClient({ apiKey: stripeApiKey });

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

  test("adopt existing price with different ID", async (scope) => {
    const lookupKey = `${BRANCH_PREFIX}-adopt-price-key`;
    const firstId = `${testPriceId}-adopt-first`;
    const secondId = `${testPriceId}-adopt-second`;
    const productId = `${testProductId}-adopt`;

    let product: Product | undefined;
    let firstPrice: Price | undefined;
    let secondPrice: Price | undefined;

    try {
      // Create a test product first
      product = await Product(productId, {
        name: `${BRANCH_PREFIX} Adoption Price Test Product`,
        description: "A product for price adoption testing",
      });

      // Create first price with lookup key
      firstPrice = await Price(firstId, {
        product: product.id,
        currency: "usd",
        unitAmount: 1000,
        lookupKey: lookupKey,
        nickname: "First price",
      });

      expect(firstPrice.id).toBeTruthy();
      expect(firstPrice.lookupKey).toEqual(lookupKey);

      // Verify first price was created
      const stripeFirstPrice = await stripe.prices.retrieve(firstPrice.id);
      expect(stripeFirstPrice.lookup_key).toEqual(lookupKey);

      secondPrice = await Price(secondId, {
        product: product.id,
        currency: "usd",
        unitAmount: 1000, // Same amount (immutable)
        lookupKey: lookupKey, // Same lookup key
        nickname: "Second price - adopted",
        adopt: true, // Enable adoption
      });

      expect(secondPrice.id).toBeTruthy();
      expect(secondPrice.id).toEqual(firstPrice.id); // Should have same underlying resource ID
      expect(secondPrice.lookupKey).toEqual(lookupKey);

      // Verify the price was updated with new configuration
      const stripeSecondPrice = await stripe.prices.retrieve(secondPrice.id);
      expect(stripeSecondPrice.lookup_key).toEqual(lookupKey);
      expect(stripeSecondPrice.nickname).toEqual("Second price - adopted");
    } catch (err) {
      console.log(err);
      throw err;
    } finally {
      await destroy(scope);

      if (firstPrice?.id) {
        await assertPriceDeactivated(firstPrice.id);
      }
      if (product?.id) {
        await assertProductDeactivated(product.id);
      }
    }
  });

  test("price adoption fails without lookup key", async (scope) => {
    const firstId = `${testPriceId}-no-key-first`;
    const secondId = `${testPriceId}-no-key-second`;
    const productId = `${testProductId}-no-key`;

    let product: Product | undefined;
    let firstPrice: Price | undefined;

    try {
      // Create a test product first
      product = await Product(productId, {
        name: `${BRANCH_PREFIX} No Key Price Test Product`,
        description: "A product for price no-key testing",
      });

      // Create first price without lookup key
      firstPrice = await Price(firstId, {
        product: product.id,
        currency: "usd",
        unitAmount: 1000,
        nickname: "First price without key",
      });

      expect(firstPrice.id).toBeTruthy();

      const secondPrice = await Price(secondId, {
        product: product.id,
        currency: "usd",
        unitAmount: 1000,
        nickname: "Second price - should create separate price",
        adopt: true, // Enable adoption but no lookup key
      });

      expect(secondPrice.id).toBeTruthy();
      expect(secondPrice.id).not.toEqual(firstPrice.id); // Should have different IDs
    } catch (err) {
      console.log(err);
      throw err;
    } finally {
      await destroy(scope);

      if (firstPrice?.id) {
        await assertPriceDeactivated(firstPrice.id);
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
