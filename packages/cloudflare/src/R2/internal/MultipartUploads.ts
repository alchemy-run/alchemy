import * as SigV4 from "@distilled.cloud/aws4signer";
import * as accounts from "@distilled.cloud/cloudflare/accounts";
import { sha256 } from "alchemy/Util/sha256";
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { resolvePolicies } from "../../ApiToken/Common.ts";
import type { Bucket } from "../Bucket.ts";
import { liveEndpoint, s3CredentialsPolicy } from "../S3CredentialsBinding.ts";

/** An S3 API request against R2 failed. */
export class R2S3RequestError extends Data.TaggedError("R2S3RequestError")<{
  method: string;
  url: string;
  status: number;
  body: string;
}> {
  override get message() {
    return `R2 S3 API ${this.method} ${this.url} failed with ${this.status}: ${this.body}`;
  }
}

interface S3Credentials {
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: Redacted.Redacted<string>;
}

interface Upload {
  key: string;
  uploadId: string;
}

/**
 * Abort every incomplete multipart upload in a bucket.
 *
 * R2 refuses to delete a bucket that holds incomplete multipart uploads, and
 * the Cloudflare REST API cannot list or abort them — only R2's S3 API can.
 * The S3 API needs S3 credentials, so this mints a short-lived account API
 * token scoped to the bucket, derives S3 credentials from it (access key id
 * = token id, secret = SHA-256 of the token value), aborts the uploads, and
 * deletes the token.
 *
 * Returns the number of uploads aborted.
 */
export const abortMultipartUploads = Effect.fn("R2.abortMultipartUploads")(function* (
  accountId: string,
  bucketName: string,
  jurisdiction: Bucket.Jurisdiction,
) {
  const now = yield* Clock.currentTimeMillis;
  return yield* Effect.acquireUseRelease(
    accounts.createToken({
      accountId,
      name: `alchemy-r2-abort-uploads-${bucketName}`,
      policies: resolvePolicies([
        s3CredentialsPolicy(accountId, bucketName, jurisdiction, "read-write"),
      ]),
      // A backstop: the token is deleted below, but if that fails (or the
      // process dies) it must not outlive the teardown by long.
      expiresOn: new Date(now + 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"),
    }),
    Effect.fn(function* (token) {
      if (!token.id || !token.value) {
        return yield* Effect.die(
          new Error(`Cloudflare did not return an id and value for the R2 cleanup token.`),
        );
      }
      const credentials: S3Credentials = {
        endpoint: liveEndpoint(accountId, jurisdiction),
        accessKeyId: token.id,
        secretAccessKey: Redacted.make(yield* sha256(token.value)),
      };
      let aborted = 0;
      let markers: { keyMarker?: string; uploadIdMarker?: string } = {};
      // Bounded: 100 pages of 1000 uploads.
      for (let page = 0; page < 100; page++) {
        const listed = yield* listMultipartUploads(credentials, bucketName, markers);
        yield* Effect.forEach(
          listed.uploads,
          (upload) => abortMultipartUpload(credentials, bucketName, upload),
          { concurrency: 10, discard: true },
        );
        aborted += listed.uploads.length;
        if (!listed.next) break;
        markers = listed.next;
      }
      return aborted;
    }),
    (token) =>
      token.id
        ? accounts
            .deleteToken({ accountId, tokenId: token.id })
            .pipe(
              Effect.catch((error) =>
                Effect.logWarning(
                  `Could not delete the temporary R2 cleanup token ${token.id}; it expires in an hour.`,
                  error,
                ),
              ),
            )
        : Effect.void,
  );
});

const listMultipartUploads = Effect.fn(function* (
  credentials: S3Credentials,
  bucketName: string,
  markers: { keyMarker?: string; uploadIdMarker?: string },
) {
  const url = new URL(`${credentials.endpoint}/${encodeURIComponent(bucketName)}`);
  url.searchParams.set("uploads", "");
  if (markers.keyMarker !== undefined) url.searchParams.set("key-marker", markers.keyMarker);
  if (markers.uploadIdMarker !== undefined) {
    url.searchParams.set("upload-id-marker", markers.uploadIdMarker);
  }
  const xml = yield* s3Request(credentials, "GET", url);
  const uploads = [...xml.matchAll(/<Upload>([\s\S]*?)<\/Upload>/g)].flatMap(([, body]) => {
    const key = xmlField(body!, "Key");
    const uploadId = xmlField(body!, "UploadId");
    return key !== undefined && uploadId !== undefined ? [{ key, uploadId }] : [];
  });
  const truncated = xmlField(xml, "IsTruncated") === "true";
  const keyMarker = xmlField(xml, "NextKeyMarker");
  const uploadIdMarker = xmlField(xml, "NextUploadIdMarker");
  return {
    uploads,
    next: truncated && (keyMarker || uploadIdMarker) ? { keyMarker, uploadIdMarker } : undefined,
  };
});

const abortMultipartUpload = (credentials: S3Credentials, bucketName: string, upload: Upload) => {
  const key = upload.key.split("/").map(encodeURIComponent).join("/");
  const url = new URL(`${credentials.endpoint}/${encodeURIComponent(bucketName)}/${key}`);
  url.searchParams.set("uploadId", upload.uploadId);
  return s3Request(credentials, "DELETE", url).pipe(
    // Already completed or aborted by someone else.
    Effect.catchIf(
      (error) => error._tag === "R2S3RequestError" && error.status === 404,
      () => Effect.succeed(""),
    ),
  );
};

/**
 * Send one SigV4-signed request to R2's S3 API and return the response body.
 * A freshly minted token takes a few seconds to be accepted by the S3 API,
 * so 401/403 responses are retried, bounded.
 */
const s3Request = (credentials: S3Credentials, method: "GET" | "DELETE", url: URL) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const signed = yield* SigV4.sign({
      method,
      url: url.toString(),
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      service: "s3",
      region: "auto",
      hashPayload: true,
    });
    const response = yield* client.execute(
      HttpClientRequest.make(method)(signed.url).pipe(HttpClientRequest.setHeaders(signed.headers)),
    );
    const body = yield* response.text;
    if (response.status < 200 || response.status >= 300) {
      return yield* new R2S3RequestError({
        method,
        url: `${url.origin}${url.pathname}`,
        status: response.status,
        body,
      });
    }
    return body;
  }).pipe(
    Effect.retry({
      while: (error) =>
        error._tag === "R2S3RequestError" && (error.status === 401 || error.status === 403),
      schedule: Schedule.exponential("500 millis"),
      times: 8,
    }),
  );

const xmlField = (xml: string, name: string): string | undefined => {
  const match = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml);
  return match ? unescapeXml(match[1]!) : undefined;
};

const unescapeXml = (value: string) =>
  value.replace(/&(lt|gt|quot|apos|amp|#\d+|#x[0-9a-fA-F]+);/g, (_, entity: string) => {
    switch (entity) {
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "quot":
        return '"';
      case "apos":
        return "'";
      case "amp":
        return "&";
      default:
        return String.fromCodePoint(
          entity.startsWith("#x") ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10),
        );
    }
  });
