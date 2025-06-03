import Stripe from "stripe";
import { describe, expect } from "vitest";
import { alchemy } from "../../src/alchemy.ts";
import { destroy } from "../../src/destroy.ts";
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

describe("Product Resource", () => {
  const testProductId = `${BRANCH_PREFIX}-product`;

  test("create, update, and delete product", async (scope) => {
    let product: Product | undefined;

    try {
      // Create a test product
      const productName = `${BRANCH_PREFIX} Alchemy Test Product`;
      product = await Product(testProductId, {
        name: productName,
        description: "A product created by Alchemy tests",
      });

      expect(product.id).toBeTruthy();
      expect(product).toMatchObject({
        name: productName,
        description: "A product created by Alchemy tests",
      });

      // Verify with Stripe API
      const stripeProduct = await stripe.products.retrieve(product.id);
      expect(stripeProduct).toMatchObject({
        name: productName,
        description: "A product created by Alchemy tests",
      });

      // Update the product
      const updatedName = `${BRANCH_PREFIX} Updated Alchemy Test Product`;
      product = await Product(testProductId, {
        name: updatedName,
        description: "An updated product created by Alchemy tests",
      });

      expect(product.id).toBeTruthy();
      expect(product).toMatchObject({
        name: updatedName,
        description: "An updated product created by Alchemy tests",
      });

      // Verify update with Stripe API
      const updatedStripeProduct = await stripe.products.retrieve(product.id);
      expect(updatedStripeProduct).toMatchObject({
        name: updatedName,
        description: "An updated product created by Alchemy tests",
      });
    } catch (err) {
      // log the error or else it's silently swallowed by destroy errors
      console.log(err);
      throw err;
    } finally {
      // Always clean up, even if test assertions fail
      await destroy(scope);

      // Verify product was deactivated
      if (product?.id) {
        await assertProductDeactivated(product.id);
      }
    }
  });
});

// Helper function for verification
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
