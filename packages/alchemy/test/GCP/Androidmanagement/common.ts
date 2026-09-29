import { GcpEnvironment } from "@/GCP/Environment";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

export const enterpriseName =
  process.env.GCP_ANDROIDMANAGEMENT_ENTERPRISE?.trim() || undefined;

export const runLifecycle =
  !process.env.FAST && !!process.env.GCP_TEST_ANDROIDMANAGEMENT;

export const runChildLifecycle = runLifecycle && !!enterpriseName;

export const currentProject = GcpEnvironment.current.pipe(
  Effect.map((env) => env.project),
);
