import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

export const hasGcpCreds = !!(
  process.env.GOOGLE_PROJECT_ID &&
  (process.env.GOOGLE_ACCESS_TOKEN ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS)
);

export const runLifecycle =
  hasGcpCreds && !!process.env.GCP_TEST_BEYONDCORP && !process.env.FAST;

export const project = process.env.GOOGLE_PROJECT_ID ?? "";

export const serviceAccountEmail =
  process.env.GOOGLE_CONNECTOR_SA_EMAIL ??
  `alchemy-testing@${project}.iam.gserviceaccount.com`;

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);
