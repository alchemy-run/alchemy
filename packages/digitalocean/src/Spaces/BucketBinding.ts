import { endpointFor } from "@distilled.cloud/digitalocean/Spaces";
import { Credentials } from "@distilled.cloud/s3/Credentials";
import { Endpoint } from "@distilled.cloud/s3/Endpoint";
import * as Binding from "alchemy/Binding";
import * as Output from "alchemy/Output";
import { CurrentRuntimeContext, type RuntimeContext } from "alchemy/RuntimeContext";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import type * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import type { Bucket } from "./Bucket.ts";
import { Key } from "./Key.ts";

/**
 * Shared scaffolding for the Spaces bucket bindings. NOT exported from
 * `index.ts`.
 *
 * DigitalOcean signs no workload identity for any runtime, so every host,
 * a `DigitalOcean.App` or another cloud's Worker or Lambda alike, gets a
 * Spaces access key scoped to the one bucket: `read` for read operations,
 * `readwrite` for writes (Spaces has no write-only grant). The key, the
 * bucket name and its region reach the host through its runtime context,
 * and each operation signs with that key against the bucket's regional
 * endpoint.
 */
export class SpacesBindingNotConfigured extends Data.TaggedError(
  "DigitalOcean.Spaces.BindingNotConfigured",
)<{
  readonly bucket: string;
}> {
  override get message() {
    return `Spaces bucket '${this.bucket}' is not bound to this runtime: its access key is missing from the environment.`;
  }
}

export type SpacesAccess = "read" | "readwrite";

const envKey = (bucket: Bucket, access: SpacesAccess, field: string) =>
  `DO_SPACES_${bucket.LogicalId}_${access}_${field}`.toUpperCase().replaceAll(/[^A-Z0-9]/g, "_");

interface SpacesScope {
  readonly bucketName: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: Redacted.Redacted<string>;
}

/**
 * At deploy, declares a scoped `Spaces.Key` for the host and writes it into
 * the host's runtime context; a no-op inside the running host and in a
 * script with no host.
 */
const grantOnBucket = Effect.fn(function* (
  SpacesKey: Effect.Success<typeof Key>,
  bucket: Bucket,
  access: SpacesAccess,
) {
  if (globalThis.__ALCHEMY_RUNTIME__) return;
  const host = yield* Binding.Host;
  const runtime = yield* CurrentRuntimeContext;
  if (host === undefined || runtime === undefined) return;
  const level = access === "read" ? "Read" : "ReadWrite";
  const key = yield* SpacesKey(`${host.LogicalId}${bucket.LogicalId}${level}Key`, {
    grants: [{ bucket: bucket.bucketName, permission: access }],
  });
  yield* runtime.set(envKey(bucket, access, "access_key"), key.accessKeyId);
  yield* runtime.set(envKey(bucket, access, "secret_key"), key.secretAccessKey);
  yield* runtime.set(envKey(bucket, access, "bucket"), bucket.bucketName);
  yield* runtime.set(envKey(bucket, access, "region"), bucket.region);
});

/** Reads the bound key back inside the running host. */
const scopeOf = Effect.fn(function* (bucket: Bucket, access: SpacesAccess) {
  const runtime = yield* CurrentRuntimeContext;
  const read = (field: string) =>
    runtime === undefined
      ? Effect.succeed(undefined)
      : runtime.get<string | Redacted.Redacted<string>>(envKey(bucket, access, field));
  const accessKeyId = yield* read("access_key");
  const secretAccessKey = yield* read("secret_key");
  const bucketName = yield* read("bucket");
  const region = yield* read("region");
  if (
    accessKeyId === undefined ||
    secretAccessKey === undefined ||
    bucketName === undefined ||
    region === undefined
  ) {
    return yield* new SpacesBindingNotConfigured({ bucket: bucket.LogicalId });
  }
  const plain = (value: string | Redacted.Redacted<string>) =>
    typeof value === "string" ? value : Redacted.value(value);
  return {
    bucketName: plain(bucketName),
    region: plain(region),
    accessKeyId: plain(accessKeyId),
    secretAccessKey:
      typeof secretAccessKey === "string" ? Redacted.make(secretAccessKey) : secretAccessKey,
  } satisfies SpacesScope;
});

const signedWith = (scope: SpacesScope) =>
  Layer.mergeAll(
    Layer.succeed(
      Credentials,
      Effect.succeed({
        accessKeyId: Redacted.make(scope.accessKeyId),
        secretAccessKey: scope.secretAccessKey,
        sessionToken: undefined,
        region: "us-east-1",
      }),
    ),
    Layer.succeed(Endpoint, Effect.succeed(endpointFor(scope.region))),
    FetchHttpClient.layer,
  );

/**
 * Builds the `bind(bucket)` of one Spaces operation: grants `access` on the
 * bucket at deploy, and returns a callable that runs `operation` with the
 * bucket filled in.
 */
export const makeSpacesBinding = <I extends { Bucket: string }, A, E>(options: {
  readonly tag: string;
  readonly access: SpacesAccess;
  readonly operation: (input: I) => Effect.Effect<A, E, Credentials | HttpClient.HttpClient>;
}) =>
  Effect.gen(function* () {
    // The key resource is resolved once, when the layer is built; a host
    // bundle never declares it.
    const SpacesKey = globalThis.__ALCHEMY_RUNTIME__ ? undefined : yield* Key;
    return Effect.fn(function* (bucket: Bucket) {
      if (SpacesKey !== undefined) yield* grantOnBucket(SpacesKey, bucket, options.access);
      const call = Effect.fn(`${options.tag}(${bucket.LogicalId})`)(function* (
        request: Omit<I, "Bucket">,
      ) {
        const scope = yield* scopeOf(bucket, options.access);
        return yield* options
          .operation({ ...request, Bucket: scope.bucketName } as I)
          .pipe(Effect.provide(signedWith(scope)));
      });
      return call as (
        request: Omit<I, "Bucket">,
      ) => Effect.Effect<A, E | SpacesBindingNotConfigured, RuntimeContext>;
    });
  });
