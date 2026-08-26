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

export const enterpriseId =
  process.env.GCP_ANDROIDENTERPRISE_ENTERPRISE_ID?.trim() ||
  process.env.GCP_ANDROID_ENTERPRISE_ID?.trim();

export const runLifecycle =
  hasGcpCreds &&
  !process.env.FAST &&
  !!process.env.GCP_TEST_ANDROIDENTERPRISE &&
  !!enterpriseId;

export const probeEnterpriseId = enterpriseId ?? "alchemy-missing-enterprise";
