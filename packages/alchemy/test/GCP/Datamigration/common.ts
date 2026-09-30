import { GcpEnvironment } from "@/GCP/Environment";
import type { GcpOpError } from "@distilled.cloud/gcp/datamigration_v1";
import { Forbidden, NotFound } from "@distilled.cloud/gcp/datamigration_v1";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

export const runLifecycle = !!process.env.GCP_TEST_DATAMIGRATION;

export const runSlowLifecycle = runLifecycle && !process.env.FAST;

export const runEntitlementProbe = !process.env.GCP_TEST_DATAMIGRATION;

export const currentProject = GcpEnvironment.current.pipe(
  Effect.map((env) => env.project),
);

export const waitUntilGone = <A, R>(
  get: Effect.Effect<A, NotFound | Forbidden | GcpOpError, R>,
) =>
  get.pipe(
    Effect.as("found" as const),
    Effect.catchTag(["NotFound", "Forbidden"], () =>
      Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );
