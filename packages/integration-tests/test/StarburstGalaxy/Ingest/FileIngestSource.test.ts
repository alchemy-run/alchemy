import * as StarburstGalaxy from "@alchemy.run/starburst-galaxy";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as galaxy from "@distilled.cloud/starburst-galaxy";
import * as Effect from "effect/Effect";
import { expectGone, freshStack, pinnedName, secret } from "../helpers.ts";

const { test } = Test.make({ providers: StarburstGalaxy.providers() });

const sourceExists = (fileIngestSourceId: string) =>
  galaxy.fileIngestSource.getFileIngestSource({ fileIngestSourceId }).pipe(
    Effect.as(true),
    Effect.catchTag("NotFound", () => Effect.succeed(false)),
  );

// Galaxy stores the source without reading the bucket; the public AWS Open
// Data bucket stands in, and the keys are never used.
const bucket = { bucket: "noaa-ghcn-pds", bucketCloudRegionId: "aws-us-east1" } as const;
const keys = (version: string) =>
  ({
    type: "basicAwsCredentials",
    accessKeyId: "AKIAALCHEMYTESTONLY0",
    secretAccessKey: secret(`ingest-${version}`),
  }) as const;

test.provider(
  "create a file ingest source, rename it, rotate its keys, and replace it on a new prefix",
  (stack) =>
    Effect.gen(function* () {
      yield* freshStack(stack);
      const renamed = yield* pinnedName("files", "-");

      const created = yield* stack.deploy(
        StarburstGalaxy.Ingest.FileIngestSource("Weather", {
          ...bucket,
          pathPrefix: "csv/",
          credentials: keys("v1"),
        }),
      );
      const sourceId = created.fileIngestSourceId;
      const live = yield* galaxy.fileIngestSource.getFileIngestSource({
        fileIngestSourceId: sourceId,
      });
      expect(live.bucket).toBe("noaa-ghcn-pds");
      expect(live.prefix).toBe("csv/");

      // Name, description and keys converge in place.
      const changed = yield* stack.deploy(
        StarburstGalaxy.Ingest.FileIngestSource("Weather", {
          ...bucket,
          name: renamed,
          description: "daily weather",
          pathPrefix: "csv/",
          credentials: keys("v2"),
        }),
      );
      expect(changed.fileIngestSourceId).toBe(sourceId);
      const changedLive = yield* galaxy.fileIngestSource.getFileIngestSource({
        fileIngestSourceId: sourceId,
      });
      expect(changedLive.name).toBe(renamed);
      expect(changedLive.description).toBe("daily weather");

      // Another prefix is another source.
      const moved = yield* stack.deploy(
        StarburstGalaxy.Ingest.FileIngestSource("Weather", {
          ...bucket,
          pathPrefix: "parquet/",
          credentials: keys("v2"),
        }),
      );
      expect(moved.fileIngestSourceId).not.toBe(sourceId);
      expect(moved.pathPrefix).toBe("parquet/");
      yield* expectGone(sourceExists(sourceId));

      yield* stack.destroy();
      yield* expectGone(sourceExists(moved.fileIngestSourceId));
    }).pipe(Effect.scoped),
  {
    tags: ["provider:starburst-galaxy", "provider:starburst-galaxy:ingest", "live"],
    timeout: 480_000,
  },
);
