import { fromCredentials } from "@distilled.cloud/aws/Credentials";
import * as AwsEndpoint from "@distilled.cloud/aws/Endpoint";
import type { RegionName } from "@distilled.cloud/aws/Region";
import * as s3 from "@distilled.cloud/aws/s3";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Fly from "@/Fly";
import * as Test from "@/Test/Alchemy";

const { test } = Test.make({ providers: Fly.providers() });

test.provider(
  "prunes stale keys under the prefix, then empties the prefix on delete, each with one DeleteObjects request",
  (stack) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const fixture = (version: "v1" | "v2") =>
        path.resolve(import.meta.dirname, `../../AWS/Website/fixtures/asset-deployment-${version}`);

      yield* stack.destroy();

      const requests: string[] = [];
      const recordingFetch: typeof globalThis.fetch = Object.assign(
        (input: RequestInfo | URL, init?: RequestInit) => {
          const request = input instanceof Request ? input : undefined;
          const url = new URL(request ? request.url : String(input));
          const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
          requests.push(`${method} ${url.pathname}${url.search}`);
          return globalThis.fetch(input, init);
        },
        globalThis.fetch,
      );

      const deploy = (version: "v1" | "v2" | undefined) =>
        stack
          .deploy(
            Effect.gen(function* () {
              const bucket = yield* Fly.Bucket("Assets");
              if (version !== undefined) {
                yield* Fly.Website.AssetDeployment("Files", {
                  bucket,
                  sourcePath: fixture(version),
                  prefix: "site",
                });
              }
              return bucket;
            }),
          )
          .pipe(Effect.provideService(FetchHttpClient.Fetch, recordingFetch));

      const bucket = yield* deploy("v1");
      const tigris = Layer.mergeAll(
        fromCredentials(
          { accessKeyId: bucket.accessKeyId!, secretAccessKey: bucket.secretAccessKey! },
          (bucket.region ? Redacted.value(bucket.region) : "auto") as RegionName,
        ),
        AwsEndpoint.of(Redacted.value(bucket.endpoint!)),
        FetchHttpClient.layer,
      );
      const bucketName = Redacted.value(bucket.bucketName!);
      const assertKeys = (expected: string[]) =>
        s3.listObjectsV2({ Bucket: bucketName }).pipe(
          Effect.map((listed) =>
            (listed.Contents ?? []).flatMap(({ Key }) => (Key === undefined ? [] : [Key])).sort(),
          ),
          Effect.repeat({
            schedule: Schedule.spaced("500 millis"),
            until: (keys) => keys.join("\n") === expected.join("\n"),
            times: 15,
          }),
          Effect.map((keys) => expect(keys).toEqual(expected)),
        );
      const deletesDuring = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        Effect.sync(() => requests.splice(0)).pipe(
          Effect.andThen(effect),
          Effect.map(() =>
            requests.filter(
              (request) =>
                request.startsWith(`DELETE /${bucketName}/`) ||
                request === `POST /${bucketName}?delete`,
            ),
          ),
        );

      yield* s3
        .putObject({ Bucket: bucketName, Key: "outside.txt", Body: "outside" })
        .pipe(Effect.provide(tigris));
      yield* Effect.gen(function* () {
        yield* assertKeys([
          "outside.txt",
          "site/about.html",
          "site/index.html",
          "site/robots.txt",
        ]).pipe(Effect.provide(tigris));

        expect(yield* deletesDuring(deploy("v2"))).toEqual([`POST /${bucketName}?delete`]);
        yield* assertKeys([
          "outside.txt",
          "site/extra.css",
          "site/index.html",
          "site/robots.txt",
        ]).pipe(Effect.provide(tigris));

        expect(yield* deletesDuring(deploy(undefined))).toEqual([`POST /${bucketName}?delete`]);
        yield* assertKeys(["outside.txt"]).pipe(Effect.provide(tigris));
      }).pipe(
        Effect.ensuring(
          s3
            .deleteObject({ Bucket: bucketName, Key: "outside.txt" })
            .pipe(Effect.provide(tigris), Effect.ignore),
        ),
      );
      yield* stack.destroy();
    }),
  { tags: ["provider:fly", "provider:fly:website", "live"], timeout: 120_000 },
);
