import { describe, expect, test } from "bun:test";
import Stripe from "stripe";
import { apply } from "../../src/apply";
import { destroy } from "../../src/destroy";
import { Price } from "../../src/stripe/price";
import { Product } from "../../src/stripe/product";
import { WebhookEndpoint } from "../../src/stripe/webhook";
import { BRANCH_PREFIX } from "../util";

const stripeApiKey = process.env.STRIPE_API_KEY;
if (!stripeApiKey) {
  throw new Error("STRIPE_API_KEY environment variable is required");
}

// Initialize a Stripe client for verification
const stripe = new Stripe(stripeApiKey);

describe("Stripe Resources", () => {
  test("create and destroy stripe resources", async () => {
    // Create a test product
    const productName = `${BRANCH_PREFIX} Alchemy Test Product`;
    const product = new Product(`${BRANCH_PREFIX}-alchemy-test-product`, {
      name: productName,
      description: "A product created by Alchemy tests",
    });

    // Resources that we'll need to clean up
    let productOutput;
    let price;
    let webhook;
    let priceOutput;
    let webhookOutput;

    try {
      // Apply the product first to get its ID
      productOutput = await apply(product);
      expect(productOutput.id).toBeTruthy();
      expect(productOutput.name).toBe(productName);

      // Verify with Stripe API
      const stripeProduct = await stripe.products.retrieve(productOutput.id);
      expect(stripeProduct.name).toBe(productName);

      // Create a price for the product
      price = new Price(`${BRANCH_PREFIX}-alchemy-test-price`, {
        product: productOutput.id,
        currency: "usd",
        unitAmount: 1500, // $15.00
        recurring: {
          interval: "month",
        },
      });

      // Apply the price
      priceOutput = await apply(price);
      expect(priceOutput.id).toBeTruthy();
      expect(priceOutput.unitAmount).toBe(1500);
      expect(priceOutput.recurring?.interval).toBe("month");

      // Verify with Stripe API
      const stripePrice = await stripe.prices.retrieve(priceOutput.id);
      expect(stripePrice.unit_amount).toBe(1500);

      // Create a webhook endpoint
      webhook = new WebhookEndpoint(`${BRANCH_PREFIX}-alchemy-test-webhook`, {
        url: "https://example.com/alchemy-webhook",
        enabledEvents: [
          "checkout.session.completed",
          "customer.subscription.created",
        ],
        description: "Webhook for Alchemy tests",
      });

      // Apply the webhook
      webhookOutput = await apply(webhook);
      expect(webhookOutput.id).toBeTruthy();
      expect(webhookOutput.url).toBe("https://example.com/alchemy-webhook");
      expect(webhookOutput.secret).toBeTruthy();

      // Verify with Stripe API
      const stripeWebhook = await stripe.webhookEndpoints.retrieve(
        webhookOutput.id,
      );
      expect(stripeWebhook.url).toBe("https://example.com/alchemy-webhook");
    } finally {
      // Clean up resources in reverse order of creation
      console.log("Cleaning up Stripe resources...");

      if (webhook) {
        await destroy(webhook).catch((e) =>
          console.error("Error cleaning up webhook:", e),
        );
      }

      if (price) {
        await destroy(price).catch((e) =>
          console.error("Error cleaning up price:", e),
        );
      }

      await destroy(product).catch((e) =>
        console.error("Error cleaning up product:", e),
      );

      // Verify clean up
      if (productOutput?.id) {
        await assertProductDeactivated(productOutput.id);
      }

      if (priceOutput?.id) {
        await assertPriceDeactivated(priceOutput.id);
      }

      if (webhookOutput?.id) {
        await assertWebhookDeleted(webhookOutput.id);
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
