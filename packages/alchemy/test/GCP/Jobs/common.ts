import { GcpEnvironment } from "@/GCP/Environment";
import { MinimumLogLevel } from "effect/References";
import * as Effect from "effect/Effect";

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Cloud Talent Solution is entitlement-gated. Live create returns Forbidden:
// "Cloud Talent Solution API has not been used in project 457525637530
// before or it is disabled."
export const runLifecycle =
  !process.env.FAST && process.env.GCP_TEST_JOBS === "1";

export const currentProject = GcpEnvironment.current.pipe(
  Effect.map((env) => env.project),
);
