import { Credentials } from "@distilled.cloud/aws/Credentials";
import * as Endpoint from "@distilled.cloud/aws/Endpoint";
import { Retry } from "@distilled.cloud/aws/Retry";
import * as S3 from "@distilled.cloud/aws/s3";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { ensureBootstrap } from "@/Celld/Bootstrap.ts";
import { makeS3Store } from "@/Celld/FleetStorageS3.ts";

export const bucketName = "alchemy-celld-v05-native-features-live";
export const credentials = {
  AWS_ACCESS_KEY_ID: "alchemy-test",
  AWS_SECRET_ACCESS_KEY: "alchemy-test-secret",
  AWS_REGION: "us-east-1",
};

export const prepare = (endpoint: string) =>
  Effect.gen(function* () {
    if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(endpoint))
      return yield* Effect.fail(
        new Error("Use only the isolated loopback fixture store."),
      );
    const http = yield* HttpClient.HttpClient;
    yield* S3.createBucket({ Bucket: bucketName }).pipe(
      Effect.catchTag("BucketAlreadyOwnedByYou", () => Effect.void),
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(HttpClient.HttpClient, http),
          Endpoint.of(endpoint),
          Layer.succeed(Retry, { while: () => false }),
          Layer.succeed(
            Credentials,
            Effect.succeed({
              accessKeyId: Redacted.make(credentials.AWS_ACCESS_KEY_ID),
              secretAccessKey: Redacted.make(credentials.AWS_SECRET_ACCESS_KEY),
              sessionToken: undefined,
              region: "us-east-1",
            }),
          ),
        ),
      ),
    );
    const bucket = { uri: `s3://${bucketName}`, endpoint, region: "us-east-1" };
    const store = yield* makeS3Store(bucket, credentials, http);
    const peer = yield* Effect.sync(() =>
      new TextEncoder().encode(
        JSON.stringify({ version: 1, key: "33".repeat(32) }),
      ),
    );
    const key = "fleet/peer-auth.json";
    const existing = yield* store.get(key);
    if (!existing) yield* store.put(key, peer, { ifNoneMatch: true });
    else if (
      yield* Effect.sync(
        () =>
          new TextDecoder().decode(existing.body) !==
          new TextDecoder().decode(peer),
      )
    )
      return yield* Effect.fail(
        new Error("Refusing to overwrite a different fixture peer key."),
      );
    yield* ensureBootstrap(store, { bucket, runtimeVersion: "0.5.0" });
    return store;
  });

if (import.meta.main) {
  Effect.runPromise(
    prepare(process.env.CELLD_NATIVE_STORAGE_URL ?? "").pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.timeout("45 seconds"),
    ),
  ).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
