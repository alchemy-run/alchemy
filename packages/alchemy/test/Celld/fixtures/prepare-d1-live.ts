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

// These public credentials and key belong only to the isolated loopback fixture.
export const fixtureBucket = "alchemy-celld-v05-d1-live";
export const fixtureCredentials = {
  AWS_ACCESS_KEY_ID: "alchemy-test",
  AWS_SECRET_ACCESS_KEY: "alchemy-test-secret",
  AWS_REGION: "us-east-1",
};
export const fixturePeerKey = "22".repeat(32);
export const fixtureNode = "alchemy-d1-live-node";

export const prepareD1Live = (endpoint: string) =>
  Effect.gen(function* () {
    if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(endpoint))
      return yield* Effect.fail(
        new Error("Use only the owned loopback fixture store."),
      );
    const http = yield* HttpClient.HttpClient;
    const services = Layer.mergeAll(
      Layer.succeed(HttpClient.HttpClient, http),
      Endpoint.of(endpoint),
      Layer.succeed(Retry, { while: () => false }),
      Layer.succeed(
        Credentials,
        Effect.succeed({
          accessKeyId: Redacted.make(fixtureCredentials.AWS_ACCESS_KEY_ID),
          secretAccessKey: Redacted.make(
            fixtureCredentials.AWS_SECRET_ACCESS_KEY,
          ),
          sessionToken: undefined,
          region: "us-east-1",
        }),
      ),
    );
    yield* S3.createBucket({ Bucket: fixtureBucket }).pipe(
      Effect.catchTag("BucketAlreadyOwnedByYou", () => Effect.void),
      Effect.provide(services),
    );
    const bucket = {
      uri: `s3://${fixtureBucket}`,
      endpoint,
      region: "us-east-1",
    };
    const store = yield* makeS3Store(bucket, fixtureCredentials, http);
    const key = "fleet/peer-auth.json";
    const peer = yield* Effect.sync(() =>
      new TextEncoder().encode(
        JSON.stringify({ version: 1, key: fixturePeerKey }),
      ),
    );
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
        new Error("Fixture peer key differs; refusing to overwrite it."),
      );
    const bootstrap = yield* ensureBootstrap(store, {
      bucket,
      runtimeVersion: "0.5.0",
    });
    yield* Effect.log({
      bucket: fixtureBucket,
      endpoint,
      bootstrapVersion: bootstrap.version,
      root: bootstrap.root,
    });
  });

if (import.meta.main) {
  Effect.runPromise(
    prepareD1Live(process.env.CELLD_D1_STORAGE_URL ?? "").pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.timeout("45 seconds"),
    ),
  ).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
