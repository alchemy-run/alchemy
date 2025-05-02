import { describe, expect } from "bun:test";
import Stripe from "stripe";
import { alchemy } from "../src/alchemy.js";
import { destroy } from "../src/destroy.js";
import { Price } from "../src/stripe/price.js";
import { Product } from "../src/stripe/product.js";
import { WebhookEndpoint } from "../src/stripe/webhook.js";
import { BRANCH_PREFIX } from "./util.js";

import "../src/test/bun.js";

const test = alchemy.test(import.meta, {
  prefix: BRANCH_PREFIX,
});

const stripeApiKey = import.meta.env.STRIPE_API_KEY;
if (!stripeApiKey) {
  throw new Error("STRIPE_API_KEY environment variable is required");
}

// Initialize a Stripe client for verification
const stripe = new Stripe(stripeApiKey);

describe("Stripe Resources", () => {
  test("create and destroy stripe resources", async (scope) => {
    // Create a test product

    // Resources that we'll need to clean up
    let product;
    let webhook;
    let price;

    try {
      const productName = `${BRANCH_PREFIX} Alchemy Test Product`;
      product = await Product(`${BRANCH_PREFIX}-product`, {
        name: productName,
        description: "A product created by Alchemy tests",
      });
      expect(product.id).toBeTruthy();
      expect(product.name).toBe(productName);

      // Verify with Stripe API
      expect((await stripe.products.retrieve(product.id)).name).toBe(
        productName,
      );

      // Create a price for the product
      price = await Price(`${BRANCH_PREFIX}-price`, {
        product: product.id,
        currency: "usd",
        unitAmount: 1500, // $15.00
        recurring: {
          interval: "month",
        },
      });

      expect(price.id).toBeTruthy();
      expect(price.unitAmount).toBe(1500);
      expect(price.recurring?.interval).toBe("month");

      // Verify with Stripe API
      expect((await stripe.prices.retrieve(price.id)).unit_amount).toBe(1500);

      // Create a webhook endpoint
      webhook = await WebhookEndpoint(`${BRANCH_PREFIX}-webhook`, {
        url: "https://example.com/alchemy-webhook",
        enabledEvents: [
          "checkout.session.completed",
          "customer.subscription.created",
        ],
        description: "Webhook for Alchemy tests",
      });

      // Apply the webhook
      expect(webhook.id).toBeTruthy();
      expect(webhook.url).toBe("https://example.com/alchemy-webhook");
      expect(webhook.secret).toBeTruthy();

      // Verify with Stripe API
      expect((await stripe.webhookEndpoints.retrieve(webhook.id)).url).toBe(
        "https://example.com/alchemy-webhook",
      );
    } finally {
      await destroy(scope);

      // Verify clean up
      if (product?.id) {
        await assertProductDeactivated(product.id);
      }

      if (price?.id) {
        await assertPriceDeactivated(price.id);
      }

      if (webhook?.id) {
        await assertWebhookDeleted(webhook.id);
      }
    }
  });
});

// Helper functions for verification
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

async function assertWebhookDeleted(webhookId: string) {
  try {
    await stripe.webhookEndpoints.retrieve(webhookId);
    throw new Error("Webhook still exists");
  } catch (error) {
    // Webhook should be deleted, so we expect a resource_missing error
    if (error instanceof Stripe.errors.StripeError) {
      expect(error.code).toBe("resource_missing");
    } else {
      throw error;
    }
  }
}
