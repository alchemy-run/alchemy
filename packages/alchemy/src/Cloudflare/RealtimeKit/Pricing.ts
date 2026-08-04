/**
 * Cloudflare RealtimeKit's published rates, attached to the RealtimeKit
 * app's `ProviderService.pricing` (see `../../Cost.ts`).
 *
 * RealtimeKit bills per participant-minute of an *active* session (an idle
 * meeting costs nothing) plus per-minute export rates for recording and
 * streaming. The product is in Beta and available at no cost during that
 * period — the rates below are what Cloudflare has published to take effect
 * at GA, so each line carries "free during Beta" as its included allotment
 * rather than being priced at $0.
 *
 * Whether a participant is billed at the audio/video or audio-only rate is
 * decided at runtime by the meeting type of the preset a participant joins
 * with, not by anything on the app — so both lines are always shown.
 * Real-time transcription is billed through Workers AI's standard model
 * rates and has no RealtimeKit line of its own.
 *
 * Presets and webhooks are configuration objects with no published rate and
 * intentionally have no `pricing` field.
 *
 * Rates verified against Cloudflare's published pricing docs, 2026-08:
 * - https://developers.cloudflare.com/realtime/realtimekit/pricing/
 */
import type { ResourceCost } from "../../Cost.ts";
import type { AppProps } from "./App.ts";

const BETA_FREE = "free during Beta";

export const RealtimeKitPricing: ResourceCost<AppProps> = {
  // Billed only for the duration of an active session — an app that is
  // never joined costs nothing.
  floorMonthlyUsd: () => 0,
  requiresPaidPlan: false,
  rates: () => [
    {
      label: "RealtimeKit audio/video participant",
      perUnit: 0.002,
      unit: "participant-minute",
      freeIncluded: BETA_FREE,
    },
    {
      label: "RealtimeKit audio-only participant",
      perUnit: 0.0005,
      unit: "participant-minute",
      freeIncluded: BETA_FREE,
    },
    {
      label: "RealtimeKit export (recording, RTMP or HLS)",
      perUnit: 0.01,
      unit: "minute",
      freeIncluded: BETA_FREE,
    },
    {
      label: "RealtimeKit export (audio-only recording/streaming)",
      perUnit: 0.003,
      unit: "minute",
      freeIncluded: BETA_FREE,
    },
    {
      label: "RealtimeKit export (raw RTP into R2)",
      perUnit: 0.0005,
      unit: "minute",
      freeIncluded: BETA_FREE,
    },
  ],
};
