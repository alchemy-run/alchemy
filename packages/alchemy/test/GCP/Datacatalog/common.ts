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

// Data Catalog API is disabled on the default testing project
// (`Forbidden`: "Google Cloud Data Catalog API has not been used in project
// alchemy-gcp-testing-83661 before or it is disabled."). Set
// GCP_TEST_DATACATALOG=1 on an entitled project to run the full lifecycle.
export const runLifecycle =
  hasGcpCreds && !process.env.FAST && process.env.GCP_TEST_DATACATALOG === "1";

export const probeTags = ["NotFound", "Forbidden"];

export const project = process.env.GOOGLE_PROJECT_ID ?? "";
export const location = "us-central1";
