import type { GcpOpError } from "@distilled.cloud/gcp/vmmigration_v1";
import { Forbidden, NotFound } from "@distilled.cloud/gcp/vmmigration_v1";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

export const hasGcpCreds = !!(
  process.env.GOOGLE_PROJECT_ID &&
  (process.env.GOOGLE_ACCESS_TOKEN ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS)
);

export const runLifecycle =
  hasGcpCreds && !process.env.FAST && !!process.env.GCP_TEST_VMMIGRATION;

export const runEntitlementProbe =
  hasGcpCreds && !process.env.GCP_TEST_VMMIGRATION;

export const project = process.env.GOOGLE_PROJECT_ID ?? "";

export const dummyAws = {
  awsRegion: "us-east-1",
  accessKeyCreds: {
    accessKeyId: "AKIATESTALCHEMY0000",
    secretAccessKey: "alchemy-test-secret",
  },
} as const;

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
