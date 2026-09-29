import { GcpEnvironment } from "@/GCP/Environment";
import { MinimumLogLevel } from "effect/References";
import * as Effect from "effect/Effect";

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Speech-to-Text is entitlement-gated. Live create returns Forbidden:
// "Cloud Speech-to-Text API has not been used in project
// alchemy-gcp-testing-83661 before or it is disabled."
export const runLifecycle =
  !process.env.FAST && process.env.GCP_TEST_SPEECH === "1";

export const currentProject = GcpEnvironment.current.pipe(
  Effect.map((env) => env.project),
);

export const location = "global";

export const currentParent = currentProject.pipe(
  Effect.map((project) => `projects/${project}/locations/${location}`),
);
