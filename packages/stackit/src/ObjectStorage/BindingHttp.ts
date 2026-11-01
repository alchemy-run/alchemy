import type { StackitOpContext } from "@distilled.cloud/stackit/Protocol";
import * as Binding from "alchemy/Binding";
import { CurrentRuntimeContext, sanitizeKey } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as StackitBindings from "../StackitBindings.ts";
import { AccessKey } from "./AccessKey.ts";
import type { Bucket } from "./Bucket.ts";
import { CredentialsGroup } from "./CredentialsGroup.ts";
import { type S3Services, s3ServicesLayer, withDeployerS3 } from "./internal.ts";

/**
 * Shared S3 scaffolding for Object Storage bucket bindings.
 * NOT exported from index.ts.
 *
 * Objects live on the S3 API, which signs with an Object Storage key rather
 * than a STACKIT token, so these bindings use no IAM grants and no service
 * account. Each host gets, per bucket and access level:
 *
 * - a `CredentialsGroup` and an `AccessKey` in it, whose values are bound into
 *   the host's env;
 * - statements on the bucket's policy, through the bucket's binding contract,
 *   that limit the group to the level's actions on that bucket.
 *
 * The group, the key and the policy are created in that order, and the group
 * reads the bucket's props rather than its attributes, because the bucket
 * depends on the group here.
 */

/** The access levels a host can hold on a bucket. */
export type BucketAccessLevel = "Read" | "Write" | "ReadWrite";

const READ_ACTIONS = ["s3:GetObject", "s3:GetObjectVersion", "s3:ListBucket"];

const WRITE_ACTIONS = [
  "s3:PutObject",
  "s3:PutOverwriteObject",
  "s3:DeleteObject",
  "s3:DeleteObjectVersion",
  "s3:AbortMultipartUpload",
  "s3:ListMultipartUploadParts",
];

/** Permissions from STACKIT's supported-permissions reference. */
const BUCKET_ACTIONS: Record<BucketAccessLevel, readonly string[]> = {
  Read: READ_ACTIONS,
  Write: WRITE_ACTIONS,
  ReadWrite: [...READ_ACTIONS, ...WRITE_ACTIONS],
};

/** Env vars holding a host's key for one bucket and access level. */
const keyEnvNames = (bucket: Bucket, level: BucketAccessLevel) => {
  const prefix = sanitizeKey(`ALCHEMY_STACKIT_BUCKET_${bucket.LogicalId}_${level}`).toUpperCase();
  return {
    accessKeyId: `${prefix}_ACCESS_KEY_ID`,
    secretAccessKey: `${prefix}_SECRET_ACCESS_KEY`,
  };
};

type GrantBucketAccess = (
  tag: string,
  level: BucketAccessLevel,
  bucket: Bucket,
) => Effect.Effect<void>;

/**
 * Give the host its group and key on a bucket. Deploy-time only; a host bundle
 * captures nothing here and drops the identity resources. Without a host there
 * is nothing to grant: a deploy-time caller signs with a key the deployer mints.
 */
const GrantBucketAccess: Effect.Effect<GrantBucketAccess> = Effect.gen(function* () {
  if (globalThis.__ALCHEMY_RUNTIME__) return () => Effect.void;
  const StackitCredentialsGroup = yield* CredentialsGroup;
  const StackitAccessKey = yield* AccessKey;
  return Effect.fn(function* (tag: string, level: BucketAccessLevel, bucket: Bucket) {
    const host = yield* Binding.Host;
    if (host === undefined) return;
    const id = `${host.LogicalId}${bucket.LogicalId}${level}`;
    const location = { projectId: bucket.Props?.projectId, region: bucket.Props?.region };
    const group = yield* StackitCredentialsGroup(`${id}Credentials`, location);
    const key = yield* StackitAccessKey(`${id}AccessKey`, {
      ...location,
      credentialsGroupId: group.credentialsGroupId,
    });
    yield* bucket.bind`${tag}(${host.LogicalId})`({
      access: [{ principal: group.urn, actions: [...BUCKET_ACTIONS[level]] }],
    });
    const env = keyEnvNames(bucket, level);
    const runtime = (yield* CurrentRuntimeContext)!;
    yield* runtime.set(env.accessKeyId, key.accessKeyId);
    yield* runtime.set(env.secretAccessKey, key.secretAccessKey);
  });
});

/** The key this host holds on a bucket, as its env has it. Runtime only. */
const readHostKey = Effect.fn(function* (bucket: Bucket, level: BucketAccessLevel) {
  const env = keyEnvNames(bucket, level);
  const runtime = yield* CurrentRuntimeContext;
  const accessKeyId = yield* runtime!.get<string>(env.accessKeyId);
  const secretAccessKey = yield* runtime!.get<string | Redacted.Redacted<string>>(
    env.secretAccessKey,
  );
  if (accessKeyId === undefined || secretAccessKey === undefined) {
    return yield* Effect.die(
      new Error(`${env.accessKeyId} is not set: deploy ${bucket.LogicalId}'s binding again.`),
    );
  }
  return {
    accessKeyId,
    secretAccessKey: Redacted.isRedacted(secretAccessKey)
      ? secretAccessKey
      : Redacted.make(secretAccessKey),
  };
});

/** A bound bucket, as a client builder sees it. */
export interface BoundBucket {
  /** The bucket's name, read when a call runs. */
  readonly bucketName: Effect.Effect<string>;
  /** Run an S3 call with the credentials this binding holds on the bucket. */
  readonly withS3: <A, E>(effect: Effect.Effect<A, E, S3Services>) => Effect.Effect<A, E>;
}

/**
 * Build a bucket binding: grant the access level at deploy, and hand the client
 * builder a {@link BoundBucket}.
 */
export const makeBucketHttpBinding = <Client>(options: {
  /** Fully-qualified binding tag, e.g. `Stackit.ObjectStorage.ReadBucket`. */
  tag: string;
  /** What the binding needs on the bucket. Bindings of one level share a key. */
  level: BucketAccessLevel;
  /** Build the runtime client. */
  makeClient: (bucket: BoundBucket) => Client;
}) =>
  Effect.gen(function* () {
    const grant = yield* GrantBucketAccess;
    // Resolved only at deploy: a host bundle signs with its own bound key.
    const deployer = globalThis.__ALCHEMY_RUNTIME__
      ? undefined
      : yield* StackitBindings.withCredentials(Effect.context<StackitOpContext>());
    return Effect.fn(function* (bucket: Bucket) {
      const bucketName = yield* bucket.bucketName;
      const urlPathStyle = yield* bucket.urlPathStyle;
      const region = yield* bucket.region;
      const projectId = yield* bucket.projectId;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* grant(options.tag, options.level, bucket);
      }
      const hostKey = globalThis.__ALCHEMY_RUNTIME__
        ? yield* readHostKey(bucket, options.level)
        : undefined;
      const withS3: BoundBucket["withS3"] = (effect) =>
        Effect.gen(function* () {
          const target = { urlPathStyle: yield* urlPathStyle, region: yield* region };
          if (hostKey !== undefined) {
            return yield* effect.pipe(Effect.provide(s3ServicesLayer({ ...hostKey, ...target })));
          }
          // A deploy-time caller, such as an Action, signs with a key the deployer
          // mints per call. A failure to mint it isn't one of the operation's
          // errors, so it is a defect here; the operation's own stay typed.
          const exit = yield* withDeployerS3(
            { ...target, projectId: yield* projectId, bucketName: yield* bucketName },
            Effect.exit(effect),
          ).pipe(Effect.provideContext(deployer!), Effect.orDie);
          return yield* exit;
        });
      return options.makeClient({ bucketName, withS3 });
    });
  });
