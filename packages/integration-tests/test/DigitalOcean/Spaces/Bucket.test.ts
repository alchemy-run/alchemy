import * as DigitalOcean from "@alchemy.run/digitalocean";
import { inRegion } from "@alchemy.run/digitalocean/Spaces/Bucket";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as S3 from "@distilled.cloud/s3";
import { adopt, OwnedBySomeoneElse } from "alchemy/AdoptPolicy";
import * as Effect from "effect/Effect";
import { logLevel, testName } from "../support.ts";

const { test } = Test.make({ providers: DigitalOcean.providers() });

const REGION = "nyc3";
const LIVE_TAGS = ["provider:digitalocean", "provider:digitalocean:spaces", "live"];
const LIVE_TIMEOUT = 240_000;

const bucketExists = (bucket: string, region = REGION) =>
  S3.headBucket({ Bucket: bucket }).pipe(
    Effect.as(true),
    Effect.catchTag("NotFound", () => Effect.succeed(false)),
    inRegion(region),
  );

test.provider(
  "bucket lifecycle: create, change acl, versioning, cors and lifecycle in place, force-destroy with objects",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        DigitalOcean.Spaces.Bucket("Assets", { region: REGION, forceDestroy: true }),
      );
      expect(created.region).toEqual(REGION);
      expect(created.domainName).toEqual(`${created.bucketName}.${REGION}.digitaloceanspaces.com`);
      expect(yield* bucketExists(created.bucketName)).toBe(true);

      const updated = yield* stack.deploy(
        DigitalOcean.Spaces.Bucket("Assets", {
          region: REGION,
          forceDestroy: true,
          acl: "public-read",
          versioning: true,
          cors: [{ allowedOrigins: ["https://example.com"], allowedMethods: ["GET", "HEAD"] }],
          lifecycleRules: [{ id: "expire-tmp", prefix: "tmp/", expirationDays: 7 }],
        }),
      );
      expect(updated.bucketName).toEqual(created.bucketName);

      const bucket = created.bucketName;
      yield* Effect.gen(function* () {
        const versioning = yield* S3.getBucketVersioning({ Bucket: bucket });
        expect(versioning.Status).toEqual("Enabled");
        const cors = yield* S3.getBucketCors({ Bucket: bucket });
        expect(cors.CORSRules?.[0]?.AllowedOrigins).toEqual(["https://example.com"]);
        const lifecycle = yield* S3.getBucketLifecycleConfiguration({ Bucket: bucket });
        expect(lifecycle.Rules?.[0]?.ID).toEqual("expire-tmp");
        const acl = yield* S3.getBucketAcl({ Bucket: bucket });
        expect(
          acl.Grants?.some(
            (grant) =>
              grant.Grantee?.URI === "http://acs.amazonaws.com/groups/global/AllUsers" &&
              grant.Permission === "READ",
          ),
        ).toBe(true);

        // Versioned objects make force-destroy delete every version.
        yield* S3.putObject({ Bucket: bucket, Key: "a.txt", Body: "one" });
        yield* S3.putObject({ Bucket: bucket, Key: "a.txt", Body: "two" });
      }).pipe(inRegion(REGION));

      yield* stack.destroy();

      expect(yield* bucketExists(bucket)).toBe(false);
    }).pipe(logLevel),
  { tags: LIVE_TAGS, timeout: LIVE_TIMEOUT },
);

test.provider(
  "a new region replaces the bucket",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = yield* stack.deploy(DigitalOcean.Spaces.Bucket("Moved", { region: "nyc3" }));
      const second = yield* stack.deploy(DigitalOcean.Spaces.Bucket("Moved", { region: "sfo3" }));
      expect(second.region).toEqual("sfo3");
      expect(yield* bucketExists(second.bucketName, "sfo3")).toBe(true);
      expect(yield* bucketExists(first.bucketName, "nyc3")).toBe(false);

      yield* stack.destroy();

      expect(yield* bucketExists(second.bucketName, "sfo3")).toBe(false);
    }).pipe(logLevel),
  { tags: LIVE_TAGS, timeout: LIVE_TIMEOUT },
);

test.provider(
  "a bucket created outside alchemy with the chosen name needs adopt(true)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = testName(stack.stage, "spaces-foreign");

      yield* Effect.acquireUseRelease(
        S3.createBucket({ Bucket: name }).pipe(inRegion(REGION)),
        () =>
          Effect.gen(function* () {
            const declared = DigitalOcean.Spaces.Bucket("Adopted", { name, region: REGION });
            const refused = yield* stack.deploy(declared).pipe(Effect.flip);
            expect(refused).toBeInstanceOf(OwnedBySomeoneElse);

            const adopted = yield* stack.deploy(declared.pipe(adopt(true)));
            expect(adopted.bucketName).toEqual(name);

            yield* stack.destroy();

            expect(yield* bucketExists(name)).toBe(false);
          }),
        () =>
          S3.deleteBucket({ Bucket: name }).pipe(
            Effect.catchTag("NoSuchBucket", () => Effect.void),
            inRegion(REGION),
          ),
      );
    }).pipe(logLevel),
  { tags: LIVE_TAGS, timeout: LIVE_TIMEOUT },
);
