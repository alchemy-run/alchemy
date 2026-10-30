import * as GCP from "@alchemy.run/gcp";
import { GcpEnvironment } from "@alchemy.run/gcp/Environment";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

export const location = "us-central1";

export const parentOf = GcpEnvironment.current.pipe(
  Effect.map(({ project }) => `projects/${project}/locations/${location}`),
);

/** The testing project doesn't enable Dataproc Metastore by default: every test deploys it first. */
export const MetastoreApi = GCP.ServiceUsage.ProjectService("MetastoreApi", {
  service: "metastore.googleapis.com",
});

/** The smallest Dataproc Metastore service: a developer-tier Hive metastore (20–40 minutes to provision). */
export const hiveService = (labels: Record<string, string>) =>
  Effect.gen(function* () {
    // Create needs a warehouse directory ("Must specify config override
    // hive.metastore.warehouse.dir").
    const warehouse = yield* GCP.Storage.Bucket("Warehouse", {
      location: "US-CENTRAL1",
      forceDestroy: true,
    });
    return yield* GCP.Metastore.Service("Hive", {
      location,
      hiveMetastoreConfig: {
        version: "3.1.2",
        configOverrides: {
          "hive.metastore.warehouse.dir": Output.interpolate`gs://${warehouse.bucketName}/hive`,
        },
      },
      tier: "DEVELOPER",
      labels,
    });
  });

/** Poll `get` until it answers NotFound. */
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
      schedule: Schedule.spaced("5 seconds"),
      until: (status) => status === "gone",
      times: 24,
    }),
  );
