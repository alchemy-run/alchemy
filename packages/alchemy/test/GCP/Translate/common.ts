import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import { GcpEnvironment } from "@/GCP/Environment";

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

export const runLifecycle = !process.env.FAST;

export const currentProject = GcpEnvironment.current.pipe(Effect.map((env) => env.project));

export const location = "us-central1";

export const currentParent = currentProject.pipe(
  Effect.map((project) => `projects/${project}/locations/${location}`),
);
