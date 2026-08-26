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

// Firebase App Hosting is entitlement-gated. Live create returns Forbidden:
// "Firebase App Hosting API has not been used in project alchemy-gcp-testing-83661
// before or it is disabled. Enable it by visiting
// https://console.developers.google.com/apis/api/firebaseapphosting.googleapis.com/overview?project=alchemy-gcp-testing-83661"
export const runLifecycle =
  hasGcpCreds &&
  !process.env.FAST &&
  process.env.GCP_TEST_FIREBASE_APP_HOSTING === "1";

export const project = process.env.GOOGLE_PROJECT_ID ?? "";
export const location = "us-central1";

export const serviceAccount =
  process.env.GCP_TEST_FIREBASE_APP_HOSTING_SA ??
  `alchemy-testing@${project}.iam.gserviceaccount.com`;

export const probeTags = ["NotFound", "Forbidden", "BadRequest"];

export const missingBackend = (backendId = "alchemy-missing-backend") =>
  `projects/${project}/locations/${location}/backends/${backendId}`;
