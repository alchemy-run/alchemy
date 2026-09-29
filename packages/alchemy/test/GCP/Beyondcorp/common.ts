import { GcpEnvironment } from "@/GCP/Environment";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

export const runLifecycle =
  !!process.env.GCP_TEST_BEYONDCORP && !process.env.FAST;

export const currentProject = GcpEnvironment.current.pipe(
  Effect.map((env) => env.project),
);

export const serviceAccountEmailOf = (project: string) =>
  process.env.GOOGLE_CONNECTOR_SA_EMAIL ??
  `alchemy-testing@${project}.iam.gserviceaccount.com`;

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);
