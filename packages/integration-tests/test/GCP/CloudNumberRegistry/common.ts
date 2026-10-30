import * as GCP from "@alchemy.run/gcp";
import { GcpEnvironment } from "@alchemy.run/gcp/Environment";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// The testing project doesn't enable the Cloud Number Registry API by
// default: every test deploys it first.
export const CloudNumberRegistryApi = GCP.ServiceUsage.ProjectService("CloudNumberRegistryApi", {
  service: "cloudnumberregistry.googleapis.com",
});

export const currentProject = GcpEnvironment.current.pipe(Effect.map((env) => env.project));
export const location = "global";

export const waitUntilGone = <E extends { readonly _tag: string }, R>(
  get: Effect.Effect<unknown, E, R>,
) =>
  get.pipe(
    Effect.as("found" as const),
    Effect.catchIf(
      (error): error is Extract<E, { readonly _tag: "NotFound" }> => error._tag === "NotFound",
      () => Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );
