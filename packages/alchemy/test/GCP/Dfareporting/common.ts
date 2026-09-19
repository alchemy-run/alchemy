import * as dfa from "@distilled.cloud/gcp/dfareporting_v5";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

export const hasGcpCreds = !!(
  process.env.GOOGLE_PROJECT_ID &&
  (process.env.GOOGLE_ACCESS_TOKEN ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS)
);

export const runLifecycle =
  hasGcpCreds && !process.env.FAST && !!process.env.GCP_TEST_DFAREPORTING;

export const advertiserIdFromEnv =
  process.env.GCP_DFAREPORTING_ADVERTISER_ID?.trim() || undefined;

export const campaignIdFromEnv =
  process.env.GCP_DFAREPORTING_CAMPAIGN_ID?.trim() || undefined;

export const siteIdFromEnv =
  process.env.GCP_DFAREPORTING_SITE_ID?.trim() || undefined;

export const floodlightActivityGroupIdFromEnv =
  process.env.GCP_DFAREPORTING_FLOODLIGHT_ACTIVITY_GROUP_ID?.trim() ||
  undefined;

export const runAdvertiserLifecycle = runLifecycle && !!advertiserIdFromEnv;

export const runFloodlightLifecycle =
  runAdvertiserLifecycle && !!floodlightActivityGroupIdFromEnv;

export const resolveProfileId = () =>
  Effect.gen(function* () {
    const fromEnv = process.env.GCP_DFAREPORTING_PROFILE_ID?.trim();
    if (fromEnv) return fromEnv;
    const profiles = yield* dfa.listUserProfiles({});
    return profiles.items?.find((profile) => profile.profileId)?.profileId;
  });
