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

export const runLifecycle = hasGcpCreds && !process.env.FAST;

export const probeTags = ["NotFound", "Forbidden"];

export const project = process.env.GOOGLE_PROJECT_ID ?? "";
export const location = "us-central1";
/** Analytics Hub listings/query templates delete reliably in the US multi-region. */
export const hubLocation = "US";
export const primaryContact = `alchemy-testing@${project || "alchemy-gcp-testing-83661"}.iam.gserviceaccount.com`;
