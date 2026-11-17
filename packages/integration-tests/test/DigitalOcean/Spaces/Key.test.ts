import * as DigitalOcean from "@alchemy.run/digitalocean";
import { inRegion } from "@alchemy.run/digitalocean/Spaces/Bucket";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { listSpacesKey } from "@distilled.cloud/digitalocean";
import * as S3 from "@distilled.cloud/s3";
import { Credentials } from "@distilled.cloud/s3/Credentials";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { logLevel } from "../support.ts";

const { test } = Test.make({ providers: DigitalOcean.providers() });

const REGION = "nyc3";
const LIVE_TAGS = ["provider:digitalocean", "provider:digitalocean:spaces", "live"];
const LIVE_TIMEOUT = 240_000;

// Signs S3 calls with the key under test instead of the deploy's key.
const asKey = (key: DigitalOcean.Spaces.KeyAttributes) =>
  Effect.provideService(
    Credentials,
    Effect.succeed({
      accessKeyId: Redacted.make(key.accessKeyId),
      secretAccessKey: key.secretAccessKey,
      sessionToken: undefined,
      region: "us-east-1",
    }),
  );

const keyExists = (accessKeyId: string) =>
  listSpacesKey.items({}).pipe(
    Stream.filter((key) => key.access_key === accessKeyId),
    Stream.runHead,
    Effect.map((found) => found._tag === "Some"),
  );

// A new key or grant takes a few seconds to reach the storage nodes.
const eventually = { schedule: Schedule.spaced("3 seconds"), times: 20 } as const;

test.provider(
  "key lifecycle: a read-write key writes, narrowing it to read refuses writes, destroy deletes it",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const declare = (permission: "readwrite" | "read") =>
        Effect.gen(function* () {
          const bucket = yield* DigitalOcean.Spaces.Bucket("Data", {
            region: REGION,
            forceDestroy: true,
          });
          const key = yield* DigitalOcean.Spaces.Key("Writer", {
            grants: [{ bucket: bucket.bucketName, permission }],
          });
          return { bucket, key };
        });

      const { bucket, key } = yield* stack.deploy(declare("readwrite"));
      expect(key.grants).toEqual([{ bucket: bucket.bucketName, permission: "readwrite" }]);
      yield* S3.putObject({ Bucket: bucket.bucketName, Key: "hello.txt", Body: "hi" }).pipe(
        inRegion(REGION),
        asKey(key),
        Effect.retry(eventually),
      );

      const narrowed = yield* stack.deploy(declare("read"));
      expect(narrowed.key.accessKeyId).toEqual(key.accessKeyId);
      const refused = yield* S3.putObject({
        Bucket: bucket.bucketName,
        Key: "refused.txt",
        Body: "no",
      }).pipe(inRegion(REGION), asKey(key), Effect.flip, Effect.retry(eventually));
      expect(refused._tag).toEqual("AccessDeniedException");

      yield* stack.destroy();

      expect(yield* keyExists(key.accessKeyId)).toBe(false);
    }).pipe(logLevel),
  { tags: LIVE_TAGS, timeout: LIVE_TIMEOUT },
);
