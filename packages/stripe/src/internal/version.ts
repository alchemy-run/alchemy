import { withRequestOptions } from "@distilled.cloud/stripe";

/**
 * The API version the Stripe SDK's spec describes. Newer endpoints change
 * shape by version (balance settings nest under `payments` only from
 * here), and the v2 API rejects calls without one, so their calls pin it.
 */
export const STRIPE_SPEC_API_VERSION = "2026-10-28.endive";

/** Pins a call to {@link STRIPE_SPEC_API_VERSION}. */
export const atSpecApiVersion = withRequestOptions({ apiVersion: STRIPE_SPEC_API_VERSION });
