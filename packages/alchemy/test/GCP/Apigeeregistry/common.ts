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

export const runLifecycle =
  hasGcpCreds && !process.env.FAST && !!process.env.GCP_TEST_APIGEE_REGISTRY;

export const probeTags = ["NotFound", "Forbidden", "InternalServerError"];

export const project = process.env.GOOGLE_PROJECT_ID ?? "";
export const location = "us-central1";

export const openApi = JSON.stringify({
  openapi: "3.0.0",
  info: { title: "pets", version: "1.0.0" },
  paths: {},
});
