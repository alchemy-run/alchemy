import { fromCredentials } from "@distilled.cloud/aws/Credentials";
import * as AwsEndpoint from "@distilled.cloud/aws/Endpoint";
import type { RegionName } from "@distilled.cloud/aws/Region";
import * as S3 from "@distilled.cloud/aws/s3";
import * as railway from "@distilled.cloud/railway";
import * as Provider from "@/Provider";
import * as Railway from "@/Railway";
import { suiteProject } from "./suiteProject.ts";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

const { test } = Test.make({ providers: Railway.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const OBJECT_KEY = "alchemy-marker.txt";
const OBJECT_BODY = "hello-from-railway";

const listProjectBuckets = (projectId: string) =>
  railway.project({ id: projectId }).pipe(
    Effect.map((project) => project.buckets.edges.map((edge) => edge.node)),
    Effect.catchTag(["RailwayNotFound", "NotFound"], () => Effect.succeed([])),
  );

const findBucket = (projectId: string, bucketId: string, name: string) =>
  listProjectBuckets(projectId).pipe(
    Effect.map(
      (buckets) =>
        buckets.find((bucket) => bucket.id === bucketId) ??
        buckets.find((bucket) => bucket.name === name),
    ),
  );

const firstCredentials = (
  bucketId: string,
  environmentId: string,
  projectId: string,
) =>
  railway
    .bucketS3Credentials({
      bucketId,
      environmentId,
      projectId,
    })
    .pipe(
      Effect.flatMap((items) => {
        const first = items[0];
        return first !== undefined
          ? Effect.succeed(first)
          : Effect.fail(new Error("missing bucket credentials"));
      }),
      Effect.retry({
        schedule: Schedule.spaced("2 seconds"),
        times: 8,
      }),
    );

const waitUntilBucketGone = (
  projectId: string,
  bucketId: string,
  name: string,
) =>
  findBucket(projectId, bucketId, name).pipe(
    Effect.map((bucket) =>
      bucket === undefined ? ("gone" as const) : ("found" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const withBucketS3 = <A, E, R>(
  creds: {
    accessKeyId: string;
    secretAccessKey: string;
    endpoint: string;
    region: string;
  },
  operation: Effect.Effect<A, E, R>,
) =>
  operation.pipe(
    Effect.provide(
      fromCredentials(
        {
          accessKeyId: creds.accessKeyId,
          secretAccessKey: creds.secretAccessKey,
        },
        creds.region as RegionName,
      ),
    ),
    Effect.provide(AwsEndpoint.of(creds.endpoint)),
  );

test.provider(
  "create, update, list, put/get/delete objects, and delete a bucket",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const project = yield* suiteProject;
          const bucket = yield* Railway.Bucket("Data", {
            project,
          });
          return { project, bucket };
        }),
      );

      expect(created.bucket.bucketId).toEqual(expect.any(String));
      expect(created.bucket.bucketId.length).toBeGreaterThan(0);
      expect(created.bucket.projectId).toEqual(created.project.projectId);
      expect(created.bucket.environmentId).toEqual(
        created.project.environmentId,
      );
      expect(created.bucket.name).toEqual(expect.any(String));
      expect(created.bucket.name.length).toBeGreaterThan(0);
      expect(created.bucket.name.length).toBeLessThanOrEqual(32);
      expect(created.bucket.name).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(created.bucket.region).toEqual("sjc");
      expect(created.bucket.s3BucketName).toEqual(expect.any(String));
      expect((created.bucket.s3BucketName ?? "").length).toBeGreaterThan(0);
      expect(created.bucket.endpoint).toEqual(expect.any(String));
      expect(created.bucket.createdAt).toEqual(expect.any(String));

      const fetched = yield* findBucket(
        created.project.projectId,
        created.bucket.bucketId,
        created.bucket.name,
      );
      expect(fetched).toBeDefined();
      expect(fetched?.id).toEqual(created.bucket.bucketId);
      expect(fetched?.name).toEqual(created.bucket.name);
      expect(fetched?.projectId).toEqual(created.project.projectId);

      const provider = yield* Provider.findProvider(Railway.Bucket);
      const listed = yield* provider.list();
      const found = listed.find(
        (bucket) => bucket.bucketId === created.bucket.bucketId,
      );
      expect(found).toBeDefined();
      expect(found?.name).toEqual(created.bucket.name);
      expect(found?.projectId).toEqual(created.project.projectId);
      expect(found?.environmentId).toEqual(created.bucket.environmentId);

      const creds = yield* firstCredentials(
        created.bucket.bucketId,
        created.bucket.environmentId,
        created.project.projectId,
      );
      expect(creds.bucketName.length).toBeGreaterThan(0);
      expect(creds.endpoint.length).toBeGreaterThan(0);
      expect(creds.accessKeyId.length).toBeGreaterThan(0);
      expect(creds.secretAccessKey.length).toBeGreaterThan(0);

      yield* withBucketS3(
        creds,
        S3.putObject({
          Bucket: creds.bucketName,
          Key: OBJECT_KEY,
          Body: OBJECT_BODY,
          ContentType: "text/plain",
        }),
      );

      const got = yield* withBucketS3(
        creds,
        S3.getObject({
          Bucket: creds.bucketName,
          Key: OBJECT_KEY,
        }),
      );
      const text =
        got.Body === undefined
          ? ""
          : yield* Stream.mkString(Stream.decodeText(got.Body));
      expect(text).toEqual(OBJECT_BODY);

      const listedObjects = yield* withBucketS3(
        creds,
        S3.listObjectsV2({
          Bucket: creds.bucketName,
          Prefix: OBJECT_KEY,
        }),
      );
      expect(
        (listedObjects.Contents ?? []).some((item) => item.Key === OBJECT_KEY),
      ).toEqual(true);

      yield* withBucketS3(
        creds,
        S3.deleteObject({
          Bucket: creds.bucketName,
          Key: OBJECT_KEY,
        }),
      );

      const nextName =
        created.bucket.name.slice(0, -1) +
        (created.bucket.name.endsWith("z") ? "y" : "z");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const project = yield* suiteProject;
          const bucket = yield* Railway.Bucket("Data", {
            project,
            name: nextName,
          });
          return { project, bucket };
        }),
      );

      expect(updated.bucket.bucketId).toEqual(created.bucket.bucketId);
      expect(updated.bucket.name).toEqual(nextName);
      expect(updated.bucket.projectId).toEqual(created.project.projectId);
      expect(updated.bucket.environmentId).toEqual(
        created.bucket.environmentId,
      );

      const fetchedUpdate = yield* findBucket(
        updated.project.projectId,
        updated.bucket.bucketId,
        updated.bucket.name,
      );
      expect(fetchedUpdate).toBeDefined();
      expect(fetchedUpdate?.id).toEqual(created.bucket.bucketId);
      expect(fetchedUpdate?.name).toEqual(nextName);

      yield* stack.destroy();

      const gone = yield* waitUntilBucketGone(
        created.project.projectId,
        created.bucket.bucketId,
        nextName,
      );
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 480_000 },
);
