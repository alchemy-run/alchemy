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

// Speech-to-Text is entitlement-gated. Live create returns Forbidden:
// "Cloud Speech-to-Text API has not been used in project
// alchemy-gcp-testing-83661 before or it is disabled."
export const runLifecycle =
  hasGcpCreds && !process.env.FAST && process.env.GCP_TEST_SPEECH === "1";

export const project = process.env.GOOGLE_PROJECT_ID ?? "";

export const location = "global";

export const parent = `projects/${project}/locations/${location}`;
