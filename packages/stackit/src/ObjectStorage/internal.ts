import { type Credentials, fromCredentials } from "@distilled.cloud/aws/Credentials";
import * as Endpoint from "@distilled.cloud/aws/Endpoint";
import * as Region from "@distilled.cloud/aws/Region";
import * as s3 from "@distilled.cloud/aws/s3";
import * as objectStorage from "@distilled.cloud/stackit/object_storage";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import type * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";

/** Longest generated credentials group name. */
export const GROUP_NAME_MAX_LENGTH = 63;

/** The project's Object Storage tenant, or `undefined` when it isn't enabled. */
export const getObjectStorageTenant = (input: {
  readonly projectId: string;
  readonly region: string;
}) =>
  objectStorage
    .getServiceStatus({ projectId: input.projectId, region: input.region })
    .pipe(Effect.catchTag("NotFound", () => Effect.undefined));

/**
 * Idempotently enable Object Storage for a project in a region.
 *
 * Object Storage does not use the Service Enablement API: a project is
 * "created" in the Object Storage service itself (`POST
 * /v2/project/{projectId}/regions/{region}`, distilled `enableService`),
 * which provisions the project's tenant and its `default` credentials
 * group. The STACKIT API documents the call as idempotent ("will also be
 * successful if the project already exists"); this helper still observes
 * first so an already-enabled project costs one GET.
 *
 * Every resource in this namespace calls it, with or without a
 * `Stackit.ObjectStorage.Project` in the stack. It only ever enables, because
 * `disableService` deletes the project's whole tenant, including buckets
 * Alchemy does not manage. The only path to that call is the `Project`
 * resource's opt-in `disableOnDelete`, on a tenant that resource enabled. A
 * tenant this helper enabled is one `Project` did not, so `Project` never
 * disables it.
 */
export const ensureObjectStorageEnabled = Effect.fn("Stackit.ObjectStorage.ensureEnabled")(
  function* (input: { readonly projectId: string; readonly region: string }) {
    const status = yield* getObjectStorageTenant(input);
    if (status !== undefined) return status;
    return yield* objectStorage.enableService({
      projectId: input.projectId,
      region: input.region,
    });
  },
);

/** Normalize a distilled sensitive value (`string | Redacted<string>`) to `Redacted`. */
export const toRedacted = (value: string | Redacted.Redacted<string>): Redacted.Redacted<string> =>
  typeof value === "string" ? Redacted.make(value) : value;

/** What an S3 call on STACKIT's data plane needs. */
export type S3Services = Credentials | Region.Region | HttpClient.HttpClient;

/** How long a key minted for one reconcile or delete stays valid. */
const DEPLOY_KEY_LIFETIME = { hours: 1 };

/**
 * The S3 endpoint of a bucket's region, from the bucket's own path-style URL
 * (`https://object.storage.eu01.onstackit.cloud/<bucket>`). Under a custom
 * endpoint distilled addresses buckets path-style.
 */
export const s3EndpointOf = (urlPathStyle: string): string =>
  urlPathStyle.replace(/\/[^/]+\/?$/, "");

/**
 * Point distilled's AWS S3 client at STACKIT: SigV4 with an Object Storage key,
 * signed for the STACKIT region, against the bucket's endpoint.
 */
export const s3ServicesLayer = (input: {
  readonly accessKeyId: string;
  readonly secretAccessKey: Redacted.Redacted<string>;
  readonly urlPathStyle: string;
  readonly region: string;
}): Layer.Layer<S3Services> => {
  // A STACKIT region isn't one of AWS's. It only names the credential scope.
  const region = input.region as Region.RegionName;
  return Layer.mergeAll(
    fromCredentials(
      {
        accessKeyId: Redacted.make(input.accessKeyId),
        secretAccessKey: input.secretAccessKey,
      },
      region,
    ),
    Region.of(region),
    Endpoint.of(s3EndpointOf(input.urlPathStyle)),
    FetchHttpClient.layer,
  );
};

/**
 * Run `use` against the S3 data plane with a short-lived key the deployer mints.
 *
 * STACKIT's S3 API takes only Object Storage keys, not the deployer's token, so
 * a provider that must change bucket settings or empty a bucket creates a key in
 * the project's `default` group and deletes it afterwards. The key also expires
 * by itself in case that delete never runs.
 */
export const withDeployerS3 = <A, E>(
  target: {
    readonly projectId: string;
    readonly region: string;
    readonly bucketName: string;
    readonly urlPathStyle: string;
  },
  use: Effect.Effect<A, E, S3Services>,
) =>
  Effect.acquireUseRelease(
    DateTime.now.pipe(
      Effect.flatMap((now) =>
        objectStorage.createAccessKey({
          projectId: target.projectId,
          region: target.region,
          expires: DateTime.formatIso(DateTime.add(now, DEPLOY_KEY_LIFETIME)),
        }),
      ),
    ),
    (key) =>
      s3.getBucketLocation({ Bucket: target.bucketName }).pipe(
        // A fresh key may not be known to the S3 endpoint yet.
        Effect.retry({
          while: (error) => error._tag === "InvalidAccessKeyId",
          schedule: Schedule.spaced("3 seconds"),
          times: 10,
        }),
        Effect.andThen(use),
        Effect.provide(
          s3ServicesLayer({
            accessKeyId: key.accessKey,
            secretAccessKey: toRedacted(key.secretAccessKey),
            urlPathStyle: target.urlPathStyle,
            region: target.region,
          }),
        ),
      ),
    (key) =>
      objectStorage
        .deleteAccessKey({ projectId: target.projectId, region: target.region, keyId: key.keyId })
        // It expires on its own, and a failed cleanup mustn't fail the deploy.
        .pipe(Effect.ignore),
  );
