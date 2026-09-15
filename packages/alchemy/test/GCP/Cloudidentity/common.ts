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

export const customer =
  process.env.GCP_CLOUDIDENTITY_CUSTOMER?.trim() || "customers/my_customer";

export const domain = process.env.GCP_CLOUDIDENTITY_DOMAIN?.trim() || undefined;

export const memberEmail =
  process.env.GCP_CLOUDIDENTITY_MEMBER?.trim() || undefined;

export const runLifecycle =
  hasGcpCreds && !process.env.FAST && !!process.env.GCP_TEST_CLOUDIDENTITY;

export const runGroupLifecycle = runLifecycle && !!domain;

export const runMembershipLifecycle = runGroupLifecycle && !!memberEmail;
