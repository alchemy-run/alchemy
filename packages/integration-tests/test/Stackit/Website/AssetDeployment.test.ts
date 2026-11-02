import * as Stackit from "@alchemy.run/stackit";
import { expect } from "@alchemy.run/test";
import * as s3 from "@distilled.cloud/aws/s3";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { logLevel, makeStackitTest, stackitEnvironment, stackitTags } from "../helpers.ts";
import { s3Propagation, withOutOfBandS3 } from "../ObjectStorage/s3.ts";

const { test } = makeStackitTest();

// Two buckets and a few small objects: under EUR 0.01 per run, ungated.
const options = { tags: stackitTags("website", "assetdeployment"), timeout: 300_000 } as const;

const FOREIGN = "uploads/avatar.png";

test.provider(
  "deletes only what it wrote, follows a move, and sweeps only on request",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { projectId, region } = yield* stackitEnvironment;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const source = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-assets-stackit-" });
      const write = (name: string, body: string) =>
        fs.writeFileString(path.join(source, name), body);
      yield* write("index.html", "<h1>v1</h1>");
      yield* write("old.txt", "old");

      const app = (props: { target?: "first" | "second"; prefix?: string; purge?: boolean } = {}) =>
        Effect.gen(function* () {
          const first = yield* Stackit.ObjectStorage.Bucket("FirstBucket", { forceDestroy: true });
          const second = yield* Stackit.ObjectStorage.Bucket("SecondBucket", {
            forceDestroy: true,
          });
          const bucket = props.target === "second" ? second : first;
          const files = yield* Stackit.Website.AssetDeployment("SiteFiles", {
            bucketName: bucket.bucketName,
            urlPathStyle: bucket.urlPathStyle,
            projectId: bucket.projectId,
            region: bucket.region,
            sourcePath: source,
            prefix: props.prefix,
            purge: props.purge,
          });
          return { first, second, files };
        });

      /** Out-of-band: the keys a bucket holds, sorted. */
      const keysOf = (bucketName: string) =>
        withOutOfBandS3(
          { projectId, region },
          s3.listObjectsV2({ Bucket: bucketName }).pipe(
            Effect.retry({
              while: (error) => error._tag === "InvalidAccessKeyId",
              ...s3Propagation,
            }),
            Effect.map((page) => (page.Contents ?? []).flatMap((item) => item.Key ?? []).sort()),
          ),
        );

      const created = yield* stack.deploy(app());
      const bucketName = created.first.bucketName;
      expect(created.files.keys).toEqual(["index.html", "old.txt"]);
      expect(yield* keysOf(bucketName)).toEqual(["index.html", "old.txt"]);

      // Something else writes to the same bucket.
      yield* withOutOfBandS3(
        { projectId, region },
        s3.putObject({ Bucket: bucketName, Key: FOREIGN, Body: "theirs" }).pipe(
          Effect.retry({
            while: (error) => error._tag === "InvalidAccessKeyId",
            ...s3Propagation,
          }),
        ),
      );

      // A redeploy removes the file it wrote that is gone from the directory, and only that.
      yield* fs.remove(path.join(source, "old.txt"));
      yield* write("index.html", "<h1>v2</h1>");
      const updated = yield* stack.deploy(app());
      expect(updated.files.keys).toEqual(["index.html"]);
      expect(yield* keysOf(bucketName)).toEqual(["index.html", FOREIGN]);

      // A new prefix leaves nothing under the old location, and the foreign key alone.
      const moved = yield* stack.deploy(app({ prefix: "docs" }));
      expect(moved.files.keys).toEqual(["docs/index.html", "docs", "docs/"].sort());
      expect(yield* keysOf(bucketName)).toEqual([...moved.files.keys, FOREIGN].sort());

      // A new bucket takes the files with it. The old one keeps only the foreign key.
      const secondBucket = moved.second.bucketName;
      const relocated = yield* stack.deploy(app({ target: "second" }));
      expect(relocated.files.bucketName).toEqual(secondBucket);
      expect(yield* keysOf(secondBucket)).toEqual(["index.html"]);
      expect(yield* keysOf(bucketName)).toEqual([FOREIGN]);

      // `purge` sweeps what it didn't write. Back in the first bucket, the foreign key goes.
      const swept = yield* stack.deploy(app({ purge: true }));
      expect(swept.files.bucketName).toEqual(bucketName);
      expect(yield* keysOf(bucketName)).toEqual(["index.html"]);
      expect(yield* keysOf(secondBucket)).toEqual([]);

      // An unchanged deploy touches nothing.
      const plan = yield* stack.plan(app({ purge: true }));
      expect(plan.resources.SiteFiles).toMatchObject({ action: "noop" });

      // A destroy removes what it wrote from a bucket that stays.
      yield* stack.deploy(
        Effect.gen(function* () {
          const first = yield* Stackit.ObjectStorage.Bucket("FirstBucket", { forceDestroy: true });
          const second = yield* Stackit.ObjectStorage.Bucket("SecondBucket", {
            forceDestroy: true,
          });
          return { first, second };
        }),
      );
      expect(yield* keysOf(bucketName)).toEqual([]);

      yield* stack.destroy();
    }).pipe(logLevel),
  options,
);
