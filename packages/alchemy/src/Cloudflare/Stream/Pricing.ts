/**
 * Cloudflare Stream's published rates, attached to the Stream live input's
 * `ProviderService.pricing` (see `../../Cost.ts`).
 *
 * Stream bills two dimensions, both attributable to the video a live input
 * produces: minutes *stored* and minutes *delivered*. Ingest and encoding
 * are always free, and bandwidth is already included in "delivered" — there
 * is no separate egress line. Storage is prepaid in $5 / 1,000-minute
 * increments; that increment is an account-level Stream subscription rather
 * than a per-live-input charge, so it is surfaced as the storage rate and
 * not multiplied into every input's `floorMonthlyUsd`.
 *
 * The rest of the Stream directory — watermark profiles, webhook
 * notification subscriptions, signing keys, and live outputs (simulcast
 * destinations) — carries no published per-unit rate, so those resources
 * intentionally have no `pricing` field at all.
 *
 * Rates verified against Cloudflare's published pricing docs, 2026-08:
 * - https://developers.cloudflare.com/stream/pricing/
 *
 * Plan-time rule (same as a provider `diff`): props may still contain
 * unresolved `Output`s, so every price-determining prop is read through
 * `planProp` and degrades to a labeled default when its value is unknown.
 */
import { planProp, type ResourceCost } from "../../Cost.ts";
import type { LiveInputProps } from "./LiveInput.ts";

const STREAM_STORAGE_USD_PER_1K_MIN = 5;
const STREAM_DELIVERY_USD_PER_1K_MIN = 1;

export const StreamPricing: ResourceCost<LiveInputProps> = {
  // Nothing is charged until video is actually stored or delivered.
  floorMonthlyUsd: () => 0,
  requiresPaidPlan: false,
  rates: (props) => {
    const recording = planProp(props, "recording");
    // `recording.mode` defaults to "off" — an input that records nothing
    // never accrues the storage dimension, only delivery of the live
    // stream itself. When the prop is unresolved, show the recorded
    // (more expensive) shape rather than silently dropping a rate.
    const records =
      recording.unresolved || recording.value?.mode === "automatic";
    return [
      ...(records
        ? [
            {
              label: recording.unresolved
                ? "Stream storage (recording mode unresolved at plan time — recorded rates shown)"
                : "Stream storage (recording: automatic)",
              perUnit: STREAM_STORAGE_USD_PER_1K_MIN,
              unit: "1,000 minutes stored/month (prepaid in $5 increments)",
            },
          ]
        : []),
      {
        label: "Stream delivery",
        perUnit: STREAM_DELIVERY_USD_PER_1K_MIN,
        unit: "1,000 minutes delivered",
        freeIncluded: "bandwidth included — no separate egress fee",
      },
      {
        label: "Stream ingest + encoding",
        perUnit: 0,
        unit: "minute ingested",
        freeIncluded: "always free",
      },
    ];
  },
};
