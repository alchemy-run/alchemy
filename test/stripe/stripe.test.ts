import { Price, Product, WebhookEndpoint } from "alchemy/stripe";
import { describe, expect, test } from "bun:test";
import Stripe from "stripe";
import { apply } from "../../alchemy/src/apply";
import { destroy } from "../../alchemy/src/destroy";

const stripeApiKey = process.env.STRIPE_API_KEY;
if (!stripeApiKey) {
  throw new Error("STRIPE_API_KEY environment variable is required");
}

// Initialize a Stripe client for verification
const stripe = new Stripe(stripeApiKey);

describe("Stripe Resources", () => {
  test("create and destroy stripe resources", async () => {
    // Create a test product
    const product = new Product("alchemy-test-product", {
      name: "Alchemy Test Product",
      description: "A product created by Alchemy tests",
    });

    // Apply the product first to get its ID
    const productOutput = await apply(product);
    expect(productOutput.id).toBeTruthy();
    expect(productOutput.name).toBe("Alchemy Test Product");

    // Verify with Stripe API
    const stripeProduct = await stripe.products.retrieve(productOutput.id);
    expect(stripeProduct.name).toBe("Alchemy Test Product");

    // Create a price for the product
    const price = new Price("alchemy-test-price", {
      product: productOutput.id,
      currency: "usd",
      unitAmount: 1500, // $15.00
      recurring: {
        interval: "month",
      },
    });

    // Apply the price
    const priceOutput = await apply(price);
    expect(priceOutput.id).toBeTruthy();
    expect(priceOutput.unitAmount).toBe(1500);
    expect(priceOutput.recurring?.interval).toBe("month");

    // Verify with Stripe API
    const stripePrice = await stripe.prices.retrieve(priceOutput.id);
    expect(stripePrice.unit_amount).toBe(1500);

    // Create a webhook endpoint
    const webhook = new WebhookEndpoint("alchemy-test-webhook", {
      url: "https://example.com/alchemy-webhook",
      enabledEvents: [
        "checkout.session.completed",
        "customer.subscription.created",
      ],
      description: "Webhook for Alchemy tests",
    });

    // Apply the webhook
    const webhookOutput = await apply(webhook);
    expect(webhookOutput.id).toBeTruthy();
    expect(webhookOutput.url).toBe("https://example.com/alchemy-webhook");
    expect(webhookOutput.secret).toBeTruthy();

    // Verify with Stripe API
    const stripeWebhook = await stripe.webhookEndpoints.retrieve(
      webhookOutput.id,
    );
    expect(stripeWebhook.url).toBe("https://example.com/alchemy-webhook");

    // Clean up resources
    console.log("Cleaning up Stripe resources...");
    await destroy(webhook);
    await destroy(price);
    await destroy(product);

    // Verify clean up
    await assertProductDeactivated(productOutput.id);
    await assertPriceDeactivated(priceOutput.id);
    await assertWebhookDeleted(webhookOutput.id);
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
