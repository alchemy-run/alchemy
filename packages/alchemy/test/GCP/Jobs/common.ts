import { MinimumLogLevel } from "effect/References";
import * as Effect from "effect/Effect";

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

export const hasGcpCreds = !!(
  process.env.GOOGLE_PROJECT_ID &&
  (process.env.GOOGLE_ACCESS_TOKEN ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS)
);

// Cloud Talent Solution is entitlement-gated. Live create returns Forbidden:
// "Cloud Talent Solution API has not been used in project 457525637530
// before or it is disabled."
export const runLifecycle =
  hasGcpCreds && !process.env.FAST && process.env.GCP_TEST_JOBS === "1";

export const project = process.env.GOOGLE_PROJECT_ID ?? "";
