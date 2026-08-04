/**
 * R2 presign credentials — resolves the scoped R2 access-key pair needed
 * to sign SigV4 query-string URLs for R2 objects.
 *
 * R2's S3-compatible API requires its own credential pair (separate from
 * `CLOUDFLARE_API_TOKEN` used by other Cloudflare services). Mint keys
 * in the Cloudflare dashboard: R2 → Manage R2 API Tokens → Create Token
 * (Object Read & Write scoped to the buckets you need).
 *
 * The binding layer reads these from the environment at deploy time and
 * registers them as `secret_text` Worker bindings; the runtime client
 * signs the URL with `aws4fetch.AwsV4Signer` — no API call is made, so
 * the credentials stay out of the Worker bundle after deploy.
 */

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { AuthError } from "../../Auth/AuthProvider.ts";
import { getEnvRedacted } from "../../Auth/Env.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";

export const R2_PRESIGN_AUTH_PROVIDER_NAME = "Cloudflare.R2";

export const R2_PRESIGN_ACCESS_KEY_ID_ENV = "CLOUDFLARE_R2_ACCESS_KEY_ID";
export const R2_PRESIGN_SECRET_ACCESS_KEY_ENV =
  "CLOUDFLARE_R2_SECRET_ACCESS_KEY";
export const R2_PRESIGN_ACCOUNT_ID_ENV = "CLOUDFLARE_ACCOUNT_ID";

export const R2_PRESIGN_ACCESS_KEY_ID_BINDING = "R2_PRESIGN_ACCESS_KEY_ID";
export const R2_PRESIGN_SECRET_ACCESS_KEY_BINDING =
  "R2_PRESIGN_SECRET_ACCESS_KEY";
export const R2_PRESIGN_ACCOUNT_ID_BINDING = "R2_PRESIGN_ACCOUNT_ID";
export const R2_PRESIGN_BUCKET_NAME_BINDING = "R2_PRESIGN_BUCKET_NAME";

export interface R2PresignCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: Redacted.Redacted<string>;
  readonly accountId: string;
}

export const readR2PresignEnvCredentials = (): Effect.Effect<
  R2PresignCredentials,
  AuthError
> =>
  Effect.gen(function* () {
    const accessKeyId = yield* getEnvRedacted(
      R2_PRESIGN_ACCESS_KEY_ID_ENV,
    ).pipe(Effect.map((v) => (v ? Redacted.value(v) : undefined)));
    const secretAccessKey = yield* getEnvRedacted(
      R2_PRESIGN_SECRET_ACCESS_KEY_ENV,
    );

    if (!accessKeyId || !secretAccessKey) {
      const missing = [
        accessKeyId ? null : R2_PRESIGN_ACCESS_KEY_ID_ENV,
        secretAccessKey ? null : R2_PRESIGN_SECRET_ACCESS_KEY_ENV,
      ].filter((k): k is string => k !== null);
      return yield* new AuthError({
        message: `Missing R2 presign credentials: ${missing.join(", ")}. Mint keys in the Cloudflare dashboard under R2 → Manage R2 API Tokens (Object Read & Write). The account id is resolved automatically from your Alchemy profile.`,
      });
    }

    // Account id: prefer the env var, fall back to the Alchemy-managed
    // `CloudflareEnvironment` (populated by `alchemy login` or the
    // CLOUDFLARE_ACCOUNT_ID env var). This means users who already ran
    // `alchemy login` don't need to set the account id a second time.
    const envAccountId = yield* getEnvRedacted(R2_PRESIGN_ACCOUNT_ID_ENV).pipe(
      Effect.map((v) => (v ? Redacted.value(v) : undefined)),
    );
    const profileAccountId = yield* Effect.gen(function* () {
      const opt = yield* Effect.serviceOption(CloudflareEnvironment);
      if (Option.isNone(opt)) return undefined as string | undefined;
      const env = yield* opt.value;
      return (
        (env as unknown as { accountId?: string }).accountId ??
        (env as unknown as { account?: string }).account
      );
    });
    const accountId = envAccountId ?? profileAccountId;

    if (!accountId) {
      return yield* new AuthError({
        message:
          "Could not resolve Cloudflare account id. Set CLOUDFLARE_ACCOUNT_ID or run `alchemy login` and provide your account ID.",
      });
    }

    return {
      accessKeyId,
      secretAccessKey,
      accountId,
    } satisfies R2PresignCredentials;
  });

export const R2_SIGNING_REGION = "auto";

export const r2Endpoint = (accountId: string): string =>
  `https://${accountId}.r2.cloudflarestorage.com`;

export const r2ObjectUrl = (
  accountId: string,
  bucket: string,
  key: string,
): string => {
  const encodedKey = key
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `${r2Endpoint(accountId)}/${bucket}/${encodedKey}`;
};
