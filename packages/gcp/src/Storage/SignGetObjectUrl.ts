import { createHash } from "node:crypto";
import * as iamcredentials from "@distilled.cloud/gcp/iamcredentials_v1";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as GCPBindings from "../GCPBindings.ts";
import { HOST_SERVICE_ACCOUNT } from "../Host.ts";
import { grantFor } from "../HttpBinding.ts";
import type { Bucket } from "./Bucket.ts";

export interface SignGetObjectUrlRequest {
  /** Object name (key) to mint a signed download URL for. */
  object: string;
  /** Serve this generation instead of the live one. */
  generation?: string;
  /**
   * Seconds the URL stays valid (at most 604800, seven days).
   * @default 900
   */
  expiresIn?: number;
  /** Override the `Content-Type` Cloud Storage responds with. */
  contentType?: string;
}

/** The runtime could not resolve its own service account to sign with. */
export class SignedUrlFailed extends Data.TaggedError("GCP.Storage.SignedUrlFailed")<{
  message: string;
  cause?: unknown;
}> {}

export type SignGetObjectUrlError =
  | SignedUrlFailed
  | iamcredentials.SignBlobProjectsServiceAccountsError;

/**
 * Mint V4 signed download (GET) URLs for objects in a Cloud Storage
 * {@link Bucket}, so a browser can fetch an object without Google
 * credentials.
 *
 * The URL is signed with the host's own runtime service account through
 * the IAM Credentials `signBlob` API (no key file). The binding grants the
 * host `roles/storage.objectViewer` on the bucket (a signed URL carries the
 * signer's permissions) and `roles/iam.serviceAccountTokenCreator` on its
 * own service account only. See the [signed URL
 * guide](https://cloud.google.com/storage/docs/access-control/signed-urls).
 *
 * ### Signing Download URLs
 * **Example:** Mint a signed GET URL
 * ```typescript
 * const signGetObjectUrl = yield* GCP.Storage.SignGetObjectUrl(bucket);
 * const url = yield* signGetObjectUrl({ object: "reports/2026.pdf" });
 * // hand `url` to a browser — it downloads the object without credentials
 * // …provided with Effect.provide(GCP.Storage.SignGetObjectUrlHttp)
 * ```
 *
 * **Example:** Custom expiry and response Content-Type
 * ```typescript
 * const url = yield* signGetObjectUrl({
 *   object: "reports/2026.pdf",
 *   expiresIn: 3600,
 *   contentType: "application/pdf",
 * });
 * ```
 *
 * @binding
 * @category Storage
 */
export interface SignGetObjectUrl extends Binding.Service<
  SignGetObjectUrl,
  "GCP.Storage.SignGetObjectUrl",
  (
    bucket: Bucket,
  ) => Effect.Effect<
    (
      request: SignGetObjectUrlRequest,
    ) => Effect.Effect<string, SignGetObjectUrlError, RuntimeContext>
  >
> {}

export const SignGetObjectUrl = Binding.Service<SignGetObjectUrl>("GCP.Storage.SignGetObjectUrl");

const EMAIL_ENDPOINT =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/email";
const STORAGE_HOST = "storage.googleapis.com";
const DEFAULT_EXPIRES_IN = 900;
const MAX_EXPIRES_IN = 604_800;

/** RFC 3986 encoding, as V4 signing requires. */
const encode = (value: string) =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );

const sha256Hex = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

/** `20260102T030405Z` and `20260102` for a Unix time in millis. */
const timestamps = (millis: number) => {
  const iso = new Date(millis).toISOString().replace(/[-:]/g, "");
  const datetime = `${iso.slice(0, 15)}Z`;
  return { datetime, date: datetime.slice(0, 8) };
};

/**
 * HTTP implementation of {@link SignGetObjectUrl}: V4 signing where the
 * signature comes from IAM Credentials `signBlob` as the runtime's own
 * service account (read from the metadata server).
 *
 * @layer
 * @provides GCP.Storage.SignGetObjectUrl
 * @category Storage
 */
export const SignGetObjectUrlHttp = Layer.effect(
  SignGetObjectUrl,
  Effect.gen(function* () {
    const bind = yield* GCPBindings.Bind;
    const http = yield* HttpClient.HttpClient;
    const signBlob = yield* GCPBindings.withCredentials(
      iamcredentials.signBlobProjectsServiceAccounts,
    );
    let ownEmail: string | undefined;

    const serviceAccountEmail = Effect.gen(function* () {
      if (ownEmail !== undefined) return ownEmail;
      const response = yield* http.execute(
        HttpClientRequest.get(EMAIL_ENDPOINT).pipe(
          HttpClientRequest.setHeader("Metadata-Flavor", "Google"),
        ),
      );
      const text = (yield* response.text).trim();
      if (response.status !== 200 || !text.includes("@")) {
        return yield* new SignedUrlFailed({
          message: `GCE metadata email endpoint returned HTTP ${response.status}`,
        });
      }
      ownEmail = text;
      return text;
    }).pipe(
      Effect.mapError((cause) =>
        cause instanceof SignedUrlFailed
          ? cause
          : new SignedUrlFailed({
              message: `GCE metadata email endpoint is unreachable: ${String(cause)}`,
              cause,
            }),
      ),
    );

    return Effect.fn(function* (bucket: Bucket) {
      yield* GCPBindings.requireServiceAccountHost("GCP.Storage.SignGetObjectUrl");
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`GCP.Storage.SignGetObjectUrl(${bucket})`({
          iam: [
            // A signed URL carries the signer's own object permissions.
            grantFor(
              { role: "roles/storage.objectViewer", on: "storage.bucket" },
              bucket.bucketName,
            ),
            // signBlob as itself, and on no other account.
            {
              role: "roles/iam.serviceAccountTokenCreator",
              resource: {
                kind: "iam.serviceAccount",
                name: HOST_SERVICE_ACCOUNT,
              },
            },
          ],
        });
      }
      const bucketName = yield* bucket.bucketName;
      return Effect.fn(`GCP.Storage.SignGetObjectUrl(${bucket.LogicalId})`)(function* (
        request: SignGetObjectUrlRequest,
      ) {
        const email = yield* serviceAccountEmail;
        const name = yield* bucketName;
        const now = yield* Clock.currentTimeMillis;
        const { datetime, date } = timestamps(now);
        const scope = `${date}/auto/storage/goog4_request`;
        const expiresIn = Math.min(
          Math.max(Math.floor(request.expiresIn ?? DEFAULT_EXPIRES_IN), 1),
          MAX_EXPIRES_IN,
        );
        const params: Record<string, string> = {
          "X-Goog-Algorithm": "GOOG4-RSA-SHA256",
          "X-Goog-Credential": `${email}/${scope}`,
          "X-Goog-Date": datetime,
          "X-Goog-Expires": String(expiresIn),
          "X-Goog-SignedHeaders": "host",
          ...(request.generation !== undefined ? { generation: request.generation } : {}),
          ...(request.contentType !== undefined
            ? { "response-content-type": request.contentType }
            : {}),
        };
        const query = Object.keys(params)
          .sort()
          .map((key) => `${encode(key)}=${encode(params[key]!)}`)
          .join("&");
        const path = `/${name}/${request.object.split("/").map(encode).join("/")}`;
        const canonicalRequest = [
          "GET",
          path,
          query,
          `host:${STORAGE_HOST}`,
          "",
          "host",
          "UNSIGNED-PAYLOAD",
        ].join("\n");
        const stringToSign = [
          "GOOG4-RSA-SHA256",
          datetime,
          scope,
          yield* Effect.sync(() => sha256Hex(canonicalRequest)),
        ].join("\n");
        const signed = yield* signBlob({
          name: `projects/-/serviceAccounts/${email}`,
          body: {
            payload: yield* Effect.sync(() => Buffer.from(stringToSign, "utf8").toString("base64")),
          },
        });
        if (signed.signedBlob === undefined) {
          return yield* new SignedUrlFailed({
            message: "IAM Credentials signBlob returned no signature",
          });
        }
        const signature = yield* Effect.sync(() =>
          Buffer.from(signed.signedBlob!, "base64").toString("hex"),
        );
        return `https://${STORAGE_HOST}${path}?${query}&X-Goog-Signature=${signature}`;
      });
    });
  }),
);
