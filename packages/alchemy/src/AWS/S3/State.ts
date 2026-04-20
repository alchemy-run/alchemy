import { Credentials } from "@distilled.cloud/aws/Credentials";
import { Region } from "@distilled.cloud/aws/Region";
import type { BucketLocationConstraint } from "@distilled.cloud/aws/s3";
import * as s3 from "@distilled.cloud/aws/s3";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import type { HttpClient } from "effect/unstable/http/HttpClient";
import { decodeFqn, encodeFqn } from "../../FQN.ts";
import type { ResourceState } from "../../State/ResourceState.ts";
import {
  deserializeResourceState,
  serializeResourceState,
} from "../../State/Serde.ts";
import {
  State,
  StateStoreError,
  type StateService,
} from "../../State/State.ts";

/** Tagged buckets are owned by alchemy and rediscovered across deploys. */
export const STATE_BUCKET_TAG = "alchemy::state-bucket";
export const STATE_BUCKET_REGION_TAG = "alchemy::state-bucket-region";

export interface StateOptions {
  /** Explicit bucket; must exist. Omit to auto-provision + tag. */
  bucketName?: string;
  /** Key prefix (trailing slash optional). @default "alchemy/" */
  prefix?: string;
}

const DEFAULT_PREFIX = "alchemy/";

const normalizePrefix = (prefix: string | undefined): string => {
  if (!prefix || prefix.length === 0) return DEFAULT_PREFIX;
  return prefix.endsWith("/") ? prefix : `${prefix}/`;
};

const bodyToString = (body: s3.GetObjectOutput["Body"]) =>
  body === undefined
    ? Effect.succeed("")
    : (body as Stream.Stream<Uint8Array, Error, never>).pipe(
        Stream.decodeText({ encoding: "utf-8" }),
        Stream.mkString,
      );

const describeCause = (cause: unknown): string =>
  (cause as { _tag?: string })?._tag ??
  (cause as { message?: string })?.message ??
  String(cause);

const wrapError = (message: string) => (cause: unknown) =>
  new StateStoreError({
    message: `${message}: ${describeCause(cause)}`,
    cause: cause instanceof Error ? cause : undefined,
  });

// Mirrors AWS/Bootstrap.ts for the assets bucket. Imperative — can't be a
// stack resource since it stores that stack's state.

const generateStateBucketName = (region: string) =>
  `alchemy-state-${region}-${crypto
    .randomUUID()
    .replaceAll("-", "")
    .slice(0, 16)}`.toLowerCase();

const stateBucketTags = (region: string) => [
  { Key: STATE_BUCKET_TAG, Value: "true" },
  { Key: STATE_BUCKET_REGION_TAG, Value: region },
];

const getBucketTags = (bucketName: string) =>
  s3.getBucketTagging({ Bucket: bucketName }).pipe(
    Effect.map((response) => response.TagSet ?? []),
    Effect.catchTag("NoSuchTagSet", () =>
      Effect.succeed<Array<{ Key?: string; Value?: string }>>([]),
    ),
  );

const normalizeBucketRegion = (location: string | undefined) => {
  if (!location) return "us-east-1";
  if (location === "EU") return "eu-west-1";
  return location;
};

const lookupStateBucket = Effect.fn(function* () {
  const region = yield* Region;
  const buckets = (yield* s3.listBuckets({})).Buckets ?? [];

  for (const bucket of buckets) {
    const bucketName = bucket.Name;
    if (!bucketName) continue;

    const tags = yield* getBucketTags(bucketName).pipe(
      Effect.catch(() =>
        Effect.succeed<Array<{ Key?: string; Value?: string }>>([]),
      ),
    );

    const hasStateTag = tags.some(
      (tag) => tag.Key === STATE_BUCKET_TAG && tag.Value === "true",
    );
    if (!hasStateTag) continue;

    const taggedRegion = tags.find(
      (tag) => tag.Key === STATE_BUCKET_REGION_TAG,
    )?.Value;
    if (taggedRegion === region) return Option.some(bucketName);
    if (taggedRegion !== undefined) continue;

    // Region tag missing (manual bucket?) — fall back to actual location.
    const location = yield* s3.getBucketLocation({ Bucket: bucketName }).pipe(
      Effect.map((response) =>
        normalizeBucketRegion(response.LocationConstraint),
      ),
      Effect.catch(() => Effect.succeed<string | undefined>(undefined)),
    );
    if (location === region) return Option.some(bucketName);
  }

  return Option.none<string>();
});

const ensureStateBucketTags = Effect.fn(function* (
  bucketName: string,
  region: string,
) {
  const existing = yield* getBucketTags(bucketName);
  const tagSet = [
    ...existing.filter(
      (tag) =>
        tag.Key !== STATE_BUCKET_TAG && tag.Key !== STATE_BUCKET_REGION_TAG,
    ),
    ...stateBucketTags(region),
  ];
  yield* s3.putBucketTagging({
    Bucket: bucketName,
    Tagging: {
      TagSet: tagSet.map((tag) => ({ Key: tag.Key!, Value: tag.Value! })),
    },
  });
});

const createStateBucket = Effect.fn(function* (region: string) {
  const bucketName = generateStateBucketName(region);

  if (region === "us-east-1") {
    yield* s3.createBucket({ Bucket: bucketName });
  } else {
    yield* s3
      .createBucket({
        Bucket: bucketName,
        CreateBucketConfiguration: {
          LocationConstraint: region as BucketLocationConstraint,
        },
      })
      .pipe(Effect.catchTag("BucketAlreadyOwnedByYou", () => Effect.void));
  }

  // Wait for eventual consistency before tagging.
  yield* s3.headBucket({ Bucket: bucketName }).pipe(
    Effect.retry({
      schedule: Schedule.exponential(100).pipe(
        Schedule.both(Schedule.recurs(10)),
      ),
    }),
  );

  yield* ensureStateBucketTags(bucketName, region);
  yield* Effect.logInfo(`Created alchemy state bucket: ${bucketName}`);

  return bucketName;
});

const probeExplicitBucket = (bucketName: string) =>
  s3.headBucket({ Bucket: bucketName }).pipe(
    Effect.asVoid,
    Effect.catchTag("NotFound", () =>
      Effect.fail(
        new StateStoreError({
          message:
            `S3 bucket '${bucketName}' does not exist. Create it first, ` +
            `or omit bucketName to let alchemy auto-provision a state bucket.`,
        }),
      ),
    ),
    Effect.mapError(wrapError(`Failed to access S3 bucket '${bucketName}'`)),
  );

const resolveBucket = Effect.fn(function* (explicitName: string | undefined) {
  if (explicitName) {
    yield* probeExplicitBucket(explicitName);
    return explicitName;
  }

  const region = yield* Region;
  const existing = yield* lookupStateBucket();
  if (Option.isSome(existing)) {
    // Re-tag every run so manual buckets converge on our schema.
    yield* ensureStateBucketTags(existing.value, region);
    return existing.value;
  }

  return yield* createStateBucket(region);
});

/**
 * S3-backed state backend. Key layout:
 * `${prefix}${stack}/${stage}/${encodeFqn(fqn)}.json` — compatible with
 * LocalState via `State/Serde.ts` (lift with
 * `aws s3 cp --recursive .alchemy/state/ s3://<bucket>/alchemy/`).
 *
 * Without `bucketName`: discover-or-create a tagged bucket (one per
 * account+region). With `bucketName`: must already exist.
 *
 * @example
 * ```ts
 * state: AWS.S3.state()
 * state: AWS.S3.state({ bucketName: "my-infra-state" })
 * ```
 */
export const state = (
  options: StateOptions = {},
): Layer.Layer<State, StateStoreError, Credentials | Region | HttpClient> => {
  const prefix = normalizePrefix(options.prefix);

  return Layer.effect(
    State,
    Effect.gen(function* () {
      // yield* binds ops (R=never); `.pages` stays unbound, so capture
      // awsContext for the page streams.
      const getObject = yield* s3.getObject;
      const putObject = yield* s3.putObject;
      const deleteObject = yield* s3.deleteObject;
      const awsContext = yield* Effect.context<
        Credentials | Region | HttpClient
      >();

      const bucketName = yield* resolveBucket(options.bucketName).pipe(
        Effect.mapError((err) =>
          err instanceof StateStoreError
            ? err
            : wrapError("Failed to resolve alchemy state bucket")(err),
        ),
      );

      const stagePrefix = (stack: string, stage: string) =>
        `${prefix}${stack}/${stage}/`;

      const objectKey = (request: {
        stack: string;
        stage: string;
        fqn: string;
      }) =>
        `${stagePrefix(request.stack, request.stage)}${encodeFqn(request.fqn)}.json`;

      const stripCommonPrefix = (
        fullPrefix: string,
        commonPrefix: string | undefined,
      ): string | undefined => {
        if (!commonPrefix || !commonPrefix.startsWith(fullPrefix)) {
          return undefined;
        }
        const tail = commonPrefix.slice(fullPrefix.length);
        return tail.endsWith("/") ? tail.slice(0, -1) : tail;
      };

      const listDirectories = (fullPrefix: string) =>
        s3.listObjectsV2
          .pages({
            Bucket: bucketName,
            Prefix: fullPrefix,
            Delimiter: "/",
          })
          .pipe(
            Stream.runFold(
              () => new Set<string>(),
              (acc, page) => {
                for (const cp of page.CommonPrefixes ?? []) {
                  const name = stripCommonPrefix(fullPrefix, cp.Prefix);
                  if (name) acc.add(name);
                }
                return acc;
              },
            ),
            Effect.map((names) => Array.from(names).sort()),
            Effect.mapError(wrapError("listObjectsV2 failed")),
            Effect.provide(awsContext),
          );

      const listResources = (stack: string, stage: string) => {
        const full = stagePrefix(stack, stage);
        return s3.listObjectsV2
          .pages({
            Bucket: bucketName,
            Prefix: full,
          })
          .pipe(
            Stream.runFold(
              () => [] as string[],
              (acc, page) => {
                for (const obj of page.Contents ?? []) {
                  if (!obj.Key?.endsWith(".json")) continue;
                  const filename = obj.Key.slice(full.length, -".json".length);
                  if (filename.length === 0) continue;
                  acc.push(decodeFqn(filename));
                }
                return acc;
              },
            ),
            Effect.map((fqns) => fqns.sort()),
            Effect.mapError(wrapError("listObjectsV2 failed")),
            Effect.provide(awsContext),
          );
      };

      const service: StateService = {
        listStacks: () => listDirectories(prefix),

        listStages: (stack) => listDirectories(`${prefix}${stack}/`),

        get: (request) =>
          getObject({
            Bucket: bucketName,
            Key: objectKey(request),
          }).pipe(
            Effect.flatMap((res) => bodyToString(res.Body)),
            Effect.map((content) => deserializeResourceState(content)),
            Effect.catchTag("NoSuchKey", () =>
              Effect.succeed<ResourceState | undefined>(undefined),
            ),
            Effect.mapError(wrapError("getObject failed")),
          ),

        getReplacedResources: (request) =>
          Effect.gen(function* () {
            const fqns = yield* service.list(request);
            const all = yield* Effect.all(
              fqns.map((fqn) =>
                service.get({
                  stack: request.stack,
                  stage: request.stage,
                  fqn,
                }),
              ),
            );
            return all.filter(
              (r): r is Extract<ResourceState, { status: "replaced" }> =>
                r?.status === "replaced",
            );
          }),

        set: (request) =>
          putObject({
            Bucket: bucketName,
            Key: objectKey(request),
            Body: serializeResourceState(request.value),
            ContentType: "application/json",
          }).pipe(
            Effect.as(request.value),
            Effect.mapError(wrapError("putObject failed")),
          ),

        // S3 DeleteObject is idempotent — missing keys succeed silently.
        delete: (request) =>
          deleteObject({
            Bucket: bucketName,
            Key: objectKey(request),
          }).pipe(
            Effect.asVoid,
            Effect.mapError(wrapError("deleteObject failed")),
          ),

        list: (request) => listResources(request.stack, request.stage),
      };

      return service;
    }),
  );
};
