import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

export const runLifecycle =
  !process.env.FAST && !!process.env.GCP_TEST_DISPLAYVIDEO;

export const partnerId = process.env.GCP_DISPLAYVIDEO_PARTNER_ID ?? "1";
export const billingProfileId =
  process.env.GCP_DISPLAYVIDEO_BILLING_PROFILE_ID ?? "1";

export const advertiserProps = {
  partnerId,
  billingProfileId,
  displayName: "alchemy-dv",
  generalConfig: {
    domainUrl: "https://example.com",
    currencyCode: "USD",
  },
  adServerConfig: { thirdPartyOnlyConfig: {} },
};

export const campaignGoal = {
  campaignGoalType: "CAMPAIGN_GOAL_TYPE_BRAND_AWARENESS",
  performanceGoal: {
    performanceGoalType: "PERFORMANCE_GOAL_TYPE_CPM",
    performanceGoalAmountMicros: "10000000",
  },
};
