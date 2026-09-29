import { GcpEnvironment } from "@/GCP/Environment";
import { MinimumLogLevel } from "effect/References";
import * as Effect from "effect/Effect";

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Create is Forbidden: "Cloud Vision API has not been used in project … or
// it is disabled." Set GCP_TEST_VISION=1 on an entitled project.
export const runLifecycle =
  !process.env.FAST && process.env.GCP_TEST_VISION === "1";

export const currentProject = GcpEnvironment.current.pipe(
  Effect.map((env) => env.project),
);

export const location = "us-west1";
