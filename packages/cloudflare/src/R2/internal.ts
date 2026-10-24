import * as AwsClient from "@distilled.cloud/aws4signer/AwsClient";
import * as accounts from "@distilled.cloud/cloudflare/accounts";
import { sha256 } from "alchemy/Util/sha256";
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type * as HttpClient from "effect/http/HttpClient";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { resolvePolicies } from "../ApiToken/Common.ts";
import type { Bucket } from "./Bucket.ts";
import { s3CredentialsPolicy } from "./S3CredentialsBinding.ts";

/** A request to R2's S3 API answered with an unexpected status. */
export class R2S3RequestFailed extends Data.TaggedError("R2S3RequestFailed")<{
  operation: "ListMultipartUploads" | "AbortMultipartUpload";
  status: number;
  body: string;
}> {
  override get message() {
    return `R2 S3 ${this.operation} failed with HTTP ${this.status}: ${this.body}`;
  }
}

export interface BucketRef {
  accountId: string;
  bucketName: string;
  jurisdiction: Bucket.Jurisdiction;
}

const s3Endpoint = ({ accountId, jurisdiction }: BucketRef) =>
  jurisdiction === "default"
    ? `https://${accountId}.r2.cloudflarestorage.com`
    : `https://${accountId}.${jurisdiction}.r2.cloudflarestorage.com`;

/**
 * An S3 client for one bucket, signed with credentials derived from a
 * short-lived account API token scoped to that bucket. The token is
 * deleted when the ambient `Scope` closes (and expires within the hour
 * regardless).
 *
 * The R2 REST API has no multipart-upload operations; only the S3 API
 * can list and abort them.
 */
export const makeBucketS3Client = Effect.fn(function* (bucket: BucketRef) {
  const now = yield* Clock.currentTimeMillis;
  const token = yield* Effect.acquireRelease(
    accounts.createToken({
      accountId: bucket.accountId,
      name: `alchemy-r2-force-destroy-${bucket.bucketName}`.slice(0, 120),
      policies: resolvePolicies([
        s3CredentialsPolicy(bucket.accountId, bucket.bucketName, bucket.jurisdiction, "read-write"),
      ]),
      expiresOn: new Date(now + 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"),
    }),
    (token) =>
      accounts.deleteToken({ accountId: bucket.accountId, tokenId: token.id! }).pipe(
        Effect.catchTags({
          InvalidRoute: () => Effect.void,
          TokenNotFound: () => Effect.void,
        }),
        // The token expires within the hour; a failed cleanup is not worth
        // failing the bucket delete over.
        Effect.tapError((error) =>
          Effect.logWarning(`Failed to delete temporary R2 token ${token.id}`, error),
        ),
        Effect.ignore,
      ),
  );
  if (!token.id || !token.value) {
    return yield* Effect.die(
      new Error("Cloudflare did not return the temporary R2 token's id and value."),
    );
  }
  const secretAccessKey = yield* sha256(token.value);
  const client = yield* AwsClient.make({
    credentials: {
      accessKeyId: token.id,
      secretAccessKey: Redacted.make(secretAccessKey),
    },
    service: "s3",
    region: "auto",
  });
  return { client, endpoint: `${s3Endpoint(bucket)}/${encodeURIComponent(bucket.bucketName)}` };
});

type BucketS3Client = { client: HttpClient.HttpClient; endpoint: string };

// A freshly minted token takes a few seconds to be accepted by the S3 API.
const retryUntilTokenPropagates = <A, R>(
  effect: Effect.Effect<
    A,
    R2S3RequestFailed | HttpClient.HttpClientError | AwsClient.SignRequestError,
    R
  >,
) =>
  effect.pipe(
    Effect.retry({
      while: (e) => e._tag === "R2S3RequestFailed" && (e.status === 401 || e.status === 403),
      schedule: Schedule.max([Schedule.exponential("500 millis"), Schedule.recurs(8)]),
    }),
  );

const decodeXml = (text: string) =>
  text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&amp;/g, "&");

const tag = (xml: string, name: string) =>
  new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml)?.[1];

/** One page of `ListMultipartUploads`. */
const listUploadsPage = Effect.fn(function* (
  { client, endpoint }: BucketS3Client,
  marker: { key: string; uploadId: string } | undefined,
) {
  const url = new URL(endpoint);
  url.search = "uploads";
  if (marker) {
    url.searchParams.set("key-marker", marker.key);
    url.searchParams.set("upload-id-marker", marker.uploadId);
  }
  const res = yield* client.get(url.toString());
  const body = yield* res.text;
  if (res.status !== 200) {
    return yield* new R2S3RequestFailed({
      operation: "ListMultipartUploads",
      status: res.status,
      body,
    });
  }
  const uploads = [...body.matchAll(/<Upload>([\s\S]*?)<\/Upload>/g)].flatMap(([, upload]) => {
    const key = tag(upload!, "Key");
    const uploadId = tag(upload!, "UploadId");
    return key !== undefined && uploadId !== undefined
      ? [{ key: decodeXml(key), uploadId: decodeXml(uploadId) }]
      : [];
  });
  const nextKey = tag(body, "NextKeyMarker");
  const nextUploadId = tag(body, "NextUploadIdMarker");
  const next =
    tag(body, "IsTruncated") === "true" && nextKey !== undefined && nextUploadId !== undefined
      ? { key: decodeXml(nextKey), uploadId: decodeXml(nextUploadId) }
      : undefined;
  return { uploads, next };
});

const abortUpload = Effect.fn(function* (
  { client, endpoint }: BucketS3Client,
  upload: { key: string; uploadId: string },
) {
  const url = new URL(`${endpoint}/${upload.key.split("/").map(encodeURIComponent).join("/")}`);
  url.searchParams.set("uploadId", upload.uploadId);
  const res = yield* client.del(url.toString());
  // 404 `NoSuchUpload`: completed or aborted in the meantime.
  if (res.status !== 204 && res.status !== 200 && res.status !== 404) {
    return yield* new R2S3RequestFailed({
      operation: "AbortMultipartUpload",
      status: res.status,
      body: yield* res.text,
    });
  }
});

/**
 * Abort every incomplete multipart upload in the bucket. Returns how many
 * were aborted.
 */
export const abortMultipartUploads = Effect.fn(function* (s3: BucketS3Client) {
  let aborted = 0;
  let marker: { key: string; uploadId: string } | undefined;
  do {
    const page = yield* retryUntilTokenPropagates(listUploadsPage(s3, marker));
    yield* Effect.forEach(
      page.uploads,
      (upload) => retryUntilTokenPropagates(abortUpload(s3, upload)),
      {
        concurrency: 10,
        discard: true,
      },
    );
    aborted += page.uploads.length;
    marker = page.next;
  } while (marker !== undefined);
  return aborted;
});
