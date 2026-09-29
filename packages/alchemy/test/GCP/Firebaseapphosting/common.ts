import { GcpEnvironment } from "@/GCP/Environment";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Firebase App Hosting is entitlement-gated. Live create returns Forbidden:
// "Firebase App Hosting API has not been used in project alchemy-gcp-testing-83661
// before or it is disabled. Enable it by visiting
// https://console.developers.google.com/apis/api/firebaseapphosting.googleapis.com/overview?project=alchemy-gcp-testing-83661"
export const runLifecycle =
  !process.env.FAST && process.env.GCP_TEST_FIREBASE_APP_HOSTING === "1";

export const currentProject = GcpEnvironment.current.pipe(
  Effect.map((env) => env.project),
);
export const location = "us-central1";

export const serviceAccountOf = (project: string) =>
  process.env.GCP_TEST_FIREBASE_APP_HOSTING_SA ??
  `alchemy-testing@${project}.iam.gserviceaccount.com`;

export const probeTags = ["NotFound", "Forbidden", "BadRequest"];

export const missingBackendOf =
  (project: string) =>
  (backendId = "alchemy-missing-backend") =>
    `projects/${project}/locations/${location}/backends/${backendId}`;
