import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Output from "../../Output.ts";
import { sha256 } from "../../Util/sha256.ts";
import type { AccountApiToken } from "../ApiToken/AccountApiToken.ts";
import type { Bucket } from "./Bucket.ts";

/**
 * S3-compatible credentials for R2's S3 API, derived from an
 * {@link AccountApiToken}. Both fields are {@link Output.Output}s —
 * resolve them at plan time (e.g. a Pipelines Sink config) or bind
 * them into a runtime's environment.
 */
export interface AccessKey {
  /** The S3 access key id — the API token's id. */
  readonly accessKeyId: Output.Output<string, never>;
  /** The S3 secret — the SHA-256 hex digest of the API token's value. */
  readonly secretAccessKey: Output.Output<Redacted.Redacted<string>, never>;
}

/**
 * Derive R2's S3-compatible credentials from an API token — a pure
 * Output transformation, NOT a resource: Cloudflare defines the S3
 * access key as `(token id, SHA-256 hex of the token value)`, so there
 * is no separate cloud object to reconcile. Grant the token the
 * `Workers R2 Storage Read`/`Write` permission groups for the S3 API
 * to accept it.
 */
export const accessKey = (token: AccountApiToken): AccessKey => ({
  accessKeyId: token.tokenId,
  secretAccessKey: Output.mapEffect((value: Redacted.Redacted<string>) =>
    sha256(Redacted.value(value)).pipe(Effect.map(Redacted.make)),
  )(token.value),
});

/**
 * The R2 S3 API endpoint for an account, jurisdiction-aware:
 * `https://{accountId}.r2.cloudflarestorage.com`, with the jurisdiction
 * infix (`eu`, `fedramp`) when the bucket is jurisdiction-pinned.
 */
export const s3Endpoint = (
  accountId: string,
  jurisdiction?: Bucket.Jurisdiction,
): string =>
  jurisdiction === undefined || jurisdiction === "default"
    ? `https://${accountId}.r2.cloudflarestorage.com`
    : `https://${accountId}.${jurisdiction}.r2.cloudflarestorage.com`;
