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

// Create is Forbidden: "Cloud Vision API has not been used in project … or
// it is disabled." Set GCP_TEST_VISION=1 on an entitled project.
export const runLifecycle =
  hasGcpCreds && !process.env.FAST && process.env.GCP_TEST_VISION === "1";

export const project = process.env.GOOGLE_PROJECT_ID ?? "";

export const location = "us-west1";
