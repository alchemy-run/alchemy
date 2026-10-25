import * as SigV4 from "@distilled.cloud/aws4signer";
import * as accounts from "@distilled.cloud/cloudflare/accounts";
import * as user from "@distilled.cloud/cloudflare/user";
import { sha256 } from "alchemy/Util/sha256";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Redacted from "effect/Redacted";
import { Credentials } from "../../Credentials.ts";
import type { Bucket } from "../Bucket.ts";
import { liveEndpoint } from "../S3CredentialsBinding.ts";

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
 * The outcome of {@link abortMultipartUploads}: how many uploads were
 * aborted, or why they could not be.
 */
export type AbortMultipartUploadsResult = { aborted: number } | { skipped: string };

/**
 * Best-effort: abort every incomplete multipart upload in a bucket.
 *
 * R2 refuses to delete a bucket that holds incomplete multipart uploads, and
 * the Cloudflare REST API cannot list or abort them — only R2's S3 API can.
 * S3 credentials derive from an API token (access key id = token id, secret
 * = SHA-256 of the token value), so this only works when alchemy is
 * authenticated with an API token that may write the bucket's objects. It
 * never creates a token: with OAuth or a global API key, or when the token
 * lacks the permission, it reports why it skipped instead of failing.
 */
export const abortMultipartUploads = Effect.fn("R2.abortMultipartUploads")(
  function* (accountId: string, bucketName: string, jurisdiction: Bucket.Jurisdiction) {
    const resolved = yield* yield* Credentials;
    if (resolved.type !== "apiToken") {
      return { skipped: `alchemy is authenticated with ${resolved.type}, not an API token` };
    }
    // Account-owned and user-owned tokens verify on different routes.
    const tokenId = yield* accounts.verifyToken({ accountId }).pipe(
      Effect.catch(() => user.verifyToken({})),
      Effect.map((token) => token.id),
    );
    const credentials: S3Credentials = {
      endpoint: liveEndpoint(accountId, jurisdiction),
      accessKeyId: tokenId,
      secretAccessKey: Redacted.make(yield* sha256(Redacted.value(resolved.apiToken))),
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
    return { aborted } as AbortMultipartUploadsResult;
  },
  Effect.catch((error) => Effect.succeed<AbortMultipartUploadsResult>({ skipped: error.message })),
);

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
  });

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
