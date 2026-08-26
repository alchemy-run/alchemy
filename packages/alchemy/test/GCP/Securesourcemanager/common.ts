import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

export const hasGcpCreds = !!(
  process.env.GOOGLE_PROJECT_ID &&
  (process.env.GOOGLE_ACCESS_TOKEN ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS)
);

export const runLifecycle =
  hasGcpCreds &&
  !process.env.FAST &&
  !!process.env.GCP_TEST_SECURE_SOURCE_MANAGER;

export const project = process.env.GOOGLE_PROJECT_ID ?? "";

export const missingRepo = `projects/${project}/locations/us-central1/repositories/alchemy-missing-ssm-repo`;

export const missingIssue = `${missingRepo}/issues/alchemy-missing-issue`;

export const missingPullRequest = `${missingRepo}/pullRequests/alchemy-missing-pr`;

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);
