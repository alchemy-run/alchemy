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

export const enterpriseName =
  process.env.GCP_ANDROIDMANAGEMENT_ENTERPRISE?.trim() || undefined;

export const runLifecycle =
  hasGcpCreds && !process.env.FAST && !!process.env.GCP_TEST_ANDROIDMANAGEMENT;

export const runChildLifecycle = runLifecycle && !!enterpriseName;

export const projectId = process.env.GOOGLE_PROJECT_ID ?? "";
