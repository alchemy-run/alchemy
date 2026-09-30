import { GcpEnvironment } from "@/GCP/Environment";
import { MinimumLogLevel } from "effect/References";
import * as Effect from "effect/Effect";

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// AI Platform Training & Prediction API (`ml.googleapis.com`) is disabled
// on the default testing project (`Forbidden`: "AI Platform Training &
// Prediction API has not been used in project alchemy-gcp-testing-83661
// before or it is disabled."). Set GCP_TEST_ML=1 on an entitled project
// to run create/update/delete. Version create also needs a trained
// SavedModel at GCP_TEST_ML_DEPLOYMENT_URI.
export const runLifecycle =
  !process.env.FAST && process.env.GCP_TEST_ML === "1";

export const runVersionLifecycle =
  runLifecycle && !!process.env.GCP_TEST_ML_DEPLOYMENT_URI;

export const currentProject = GcpEnvironment.current.pipe(
  Effect.map((env) => env.project),
);

export const region = "us-central1";
