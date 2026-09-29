import { GcpEnvironment } from "@/GCP/Environment";
import type { GcpOpError } from "@distilled.cloud/gcp/datastream_v1";
import { Forbidden, NotFound } from "@distilled.cloud/gcp/datastream_v1";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

export const runLifecycle = true;

export const runSlowLifecycle =
  runLifecycle && !process.env.FAST && !!process.env.GCP_TEST_DATASTREAM;

export const currentProject = GcpEnvironment.current.pipe(
  Effect.map((env) => env.project),
);

export const LOCATION = "us-central1";

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
