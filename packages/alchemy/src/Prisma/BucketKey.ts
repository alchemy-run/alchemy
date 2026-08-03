import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import {
  attrOrRedactedString,
  attrOrString,
  devId,
  devProvider,
} from "./Internal/DevStub.ts";
import * as ProviderLayer from "../Local/ProviderLayer.ts";
import { Resource } from "../Resource.ts";
import type { Bucket } from "./Bucket.ts";
import {
  PrismaClient,
  isNotFound,
  type PrismaManagementClient,
} from "./Client.ts";
import { fnv1a64 } from "./Internal/EnvName.ts";
import type { Providers } from "./Providers.ts";
import {
  concreteIdsChanged,
  isInputObject,
  isPrismaDevId,
  resolveBucketId,
  unresolvedBucketIdOf,
} from "./Refs.ts";
import type { BucketKey as ApiBucketKey, BucketKeyRole } from "./Types.ts";

export interface BucketKeyProps {
  /**
   * Bucket ID or `bucket.bucketId` output this key grants access to.
   */
  bucket: string | Bucket;
  /**
   * Human-readable key name prefix. Alchemy appends the resource instance
   * identity so an interrupted create can be recovered by name instead of
   * minting a second, unenumerable key.
   *
   * @default the resource's logical ID
   */
  name?: string;
  /**
   * Access role for the key: `"read"` or `"read_write"`.
   */
  role: BucketKeyRole;
}

export interface BucketKey extends Resource<
  "Prisma.BucketKey",
  BucketKeyProps,
  {
    /**
     * Prisma bucket key ID.
     */
    bucketKeyId: string;
    /**
     * Bucket ID the key belongs to, persisted so deletion can address both
     * path parameters.
     */
    bucketId: string;
    /**
     * S3 access key ID.
     */
    accessKeyId: string;
    /**
     * S3 secret access key, redacted in state. Prisma returns it exactly
     * once at creation and never again, so the persisted state is the
     * authoritative copy.
     */
    secretAccessKey: Redacted.Redacted<string>;
    /**
     * S3-compatible endpoint URL for the bucket's region.
     */
    endpoint: string;
    /**
     * Provider-side S3 bucket name (e.g. `user-<id>`). S3 clients must use
     * this as the bucket name, not the display name chosen on the bucket.
     */
    bucketName: string;
  },
  never,
  Providers
> {}

/**
 * An access key for a Prisma Object Store bucket, yielding S3 credentials.
 *
 * Prisma returns the secret access key only in the create response, so
 * Alchemy stores it as a `Redacted` value and treats persisted state as
 * authoritative: once created, the secret is never re-read from the API.
 * Changing the bucket, name, or role replaces the key with fresh
 * credentials.
 *
 * @resource
 * @section Creating a Bucket Key
 * @example Read-write credentials for a bucket
 * ```typescript
 * const key = yield* Prisma.BucketKey("uploads-key", {
 *   bucket,
 *   role: "read_write",
 * });
 * ```
 *
 * @section Binding to Platforms
 * @example Pass S3 credentials to Compute env
 * ```typescript
 * const app = yield* Prisma.Compute("api", {
 *   project,
 *   path: "./apps/api",
 *   env: {
 *     S3_ENDPOINT: key.endpoint,
 *     S3_BUCKET: key.bucketName,
 *     S3_ACCESS_KEY_ID: key.accessKeyId,
 *     S3_SECRET_ACCESS_KEY: key.secretAccessKey,
 *   },
 * });
 * ```
 */
export const BucketKey = Resource<BucketKey>("Prisma.BucketKey");

const BUCKET_KEY_STABLES = [
  "bucketKeyId",
  "bucketId",
  "accessKeyId",
  "secretAccessKey",
  "endpoint",
  "bucketName",
] satisfies Extract<keyof BucketKey["Attributes"], string>[];

/**
 * Deterministic physical name for a key owned by one resource instance.
 * Stable across retries, so a create whose response was lost (crash after
 * `POST /keys` but before state persist) can be found by name instead of
 * minting a second, unenumerable key.
 */
const physicalBucketKeyName = (name: string, instanceId: string) => {
  const instanceToken = instanceId.replaceAll(/[^a-zA-Z0-9]/g, "");
  const effectiveSuffix =
    instanceToken.length >= 12
      ? instanceToken.slice(0, 12)
      : fnv1a64(instanceId).slice(0, 12);
  const maxPrefixLength = 65 - effectiveSuffix.length - 1;
  return `${name.trim().slice(0, maxPrefixLength)}-${effectiveSuffix}`;
};

class AmbiguousPrismaBucketKeyError extends Error {
  readonly _tag = "AmbiguousPrismaBucketKeyError";

  constructor(bucketId: string, name: string, count: number) {
    super(
      `Prisma bucket '${bucketId}' has ${count} keys named '${name}'; refusing to select one arbitrarily`,
    );
  }
}

const listKeys = (client: PrismaManagementClient, bucketId: string) =>
  client
    .listBucketKeys(bucketId, { limit: 100 })
    .pipe(Effect.catchIf(isNotFound, () => Effect.succeed([])));

const uniqueKeyNamed = (
  client: PrismaManagementClient,
  bucketId: string,
  expectedName: string,
) =>
  listKeys(client, bucketId).pipe(
    Effect.flatMap((keys) => {
      const matches = keys.filter(
        (key: ApiBucketKey) => key.name === expectedName,
      );
      return matches.length > 1
        ? Effect.fail(
            new AmbiguousPrismaBucketKeyError(
              bucketId,
              expectedName,
              matches.length,
            ),
          )
        : Effect.succeed(matches[0]);
    }),
  );

const ProviderLive = () =>
  Provider.effect(
    BucketKey,
    Effect.gen(function* () {
      const client = yield* PrismaClient;
      return {
        stables: BUCKET_KEY_STABLES,
        // Bucket keys cannot be listed account-wide, and bucket deletion
        // revokes them server-side, so nuke has nothing to enumerate here.
        list: () => Effect.succeed([]),
        diff: Effect.fn(function* ({ olds, news, output }) {
          if (!isInputObject(news)) return undefined;
          if (isPrismaDevId(output?.bucketKeyId)) {
            return { action: "update" } as const;
          }
          const oldBucketId =
            output?.bucketId ?? unresolvedBucketIdOf(olds.bucket);
          const newBucketId = isResolved(news.bucket)
            ? unresolvedBucketIdOf(news.bucket)
            : undefined;
          if (concreteIdsChanged(oldBucketId, newBucketId)) {
            return { action: "replace" } as const;
          }
          // A key's name and role are fixed at creation, so changes replace
          // the key and mint fresh credentials.
          if (isResolved(news.role) && news.role !== olds.role) {
            return { action: "replace" } as const;
          }
          if (
            isResolved(news.name) &&
            news.name !== undefined &&
            news.name !== olds.name
          ) {
            return { action: "replace" } as const;
          }
          return undefined;
        }),
        read: Effect.fn(function* ({ output }) {
          // The secret access key can never be re-read from the API, so the
          // persisted state stays authoritative for credentials; the list
          // endpoint only confirms the key still exists.
          if (!output || isPrismaDevId(output.bucketKeyId)) return output;
          const keys = yield* listKeys(client, output.bucketId);
          return keys.some((key: ApiBucketKey) => key.id === output.bucketKeyId)
            ? output
            : undefined;
        }),
        reconcile: Effect.fn(function* ({ id, instanceId, news, output }) {
          const persisted =
            output && !isPrismaDevId(output.bucketKeyId) ? output : undefined;
          if (persisted) {
            // Prisma returns the secret exactly once, at creation. Persisted
            // state is authoritative afterwards — but only while the key
            // still exists; a revoked key falls through to mint fresh
            // credentials.
            const keys = yield* listKeys(client, persisted.bucketId);
            if (
              keys.some((key: ApiBucketKey) => key.id === persisted.bucketKeyId)
            ) {
              return persisted;
            }
          }
          const bucketId = yield* resolveBucketId(news.bucket);
          const expectedName = physicalBucketKeyName(
            news.name ?? id,
            instanceId,
          );
          // A crash after create but before state persist leaves a key under
          // the deterministic name whose secret was never persisted and can
          // never be recovered. Revoke it and mint a fresh key rather than
          // leaking an unusable credential.
          const orphan = yield* uniqueKeyNamed(client, bucketId, expectedName);
          if (orphan) {
            yield* client
              .deleteBucketKey(bucketId, orphan.id)
              .pipe(Effect.catchIf(isNotFound, () => Effect.void));
          }
          const created = yield* client.createBucketKey(bucketId, {
            name: expectedName,
            role: news.role,
          });
          return {
            bucketKeyId: created.id,
            bucketId,
            accessKeyId: created.accessKeyId,
            secretAccessKey: Redacted.make(created.secretAccessKey),
            endpoint: created.endpoint,
            bucketName: created.bucketName,
          } satisfies BucketKey["Attributes"];
        }),
        delete: Effect.fn(function* ({ output }) {
          if (isPrismaDevId(output.bucketKeyId)) return;
          // Bucket deletion revokes remaining keys server-side, so the key
          // may already be gone when the bucket was destroyed first.
          yield* client
            .deleteBucketKey(output.bucketId, output.bucketKeyId)
            .pipe(Effect.catchIf(isNotFound, () => Effect.void));
        }),
      };
    }),
  );

const ProviderLocal = () =>
  devProvider(BucketKey, BUCKET_KEY_STABLES, ({ id, news, output }) => ({
    bucketKeyId: devId("bucket-key", id),
    bucketId: attrOrString(news.bucket, "bucketId") ?? devId("bucket", id),
    accessKeyId: devId("access-key", id),
    // Keep the fabricated secret stable across dev reconciles, mirroring
    // the reveal-once live behavior where persisted state is authoritative.
    secretAccessKey:
      attrOrRedactedString(output, "secretAccessKey") ??
      Redacted.make(devId("secret-access-key", id)),
    endpoint: "http://localhost",
    bucketName: `dev-${id}`,
  }));

export const BucketKeyProvider = () =>
  ProviderLayer.dual(BucketKey, {
    local: () => ProviderLocal(),
    live: () => ProviderLive(),
  });
