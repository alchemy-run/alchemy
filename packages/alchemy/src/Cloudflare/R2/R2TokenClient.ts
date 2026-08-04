/**
 * Raw-HTTP client for the R2 token management API.
 *
 * Cloudflare's `POST /accounts/{account_id}/r2/tokens` endpoint creates
 * scoped S3-compatible API tokens for R2 (separate from the
 * standard Cloudflare API tokens). The endpoint isn't in distilled —
 * we make raw HTTP calls here using the same `Credentials` service that
 * powers the rest of the Cloudflare SDK surface.
 *
 * The minted token's `secret_access_key` is returned exactly once, on
 * creation; callers must persist it (Alchemy's State service handles
 * this for resources, and a local cache handles the implicit auto-mint
 * path).
 */

import {
  type CredentialsError,
  Credentials,
  formatHeaders,
} from "@distilled.cloud/cloudflare/Credentials";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";

/**
 * A token returned by the R2 token API. Cloudflare mints a unique
 * access key + secret pair per token; the token also has a name, id,
 * and the list of buckets / permissions it's scoped to.
 */
export interface R2ApiToken {
  readonly id: string;
  readonly name: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

/**
 * Token summary returned by the list endpoint — no secrets.
 */
export interface R2ApiTokenSummary {
  readonly id: string;
  readonly name: string;
}

/**
 * Permissions for an R2 token. By default we request Object Read &
 * Write scoped to all buckets in the account; this is the closest
 * analogue to the dashboard's "Object Read & Write" template. Users
 * who want narrower permissions can pass their own list of bucket
 * names via `bucketNames`.
 */
export interface CreateR2TokenOptions {
  /** Human-readable name; used to look up the token later by name. */
  readonly name: string;
  /**
   * Bucket names the token is scoped to. Defaults to `["*"]` (all
   * buckets in the account).
   */
  readonly bucketNames?: ReadonlyArray<string>;
}

const r2TokensEndpoint = (accountId: string) =>
  `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/tokens`;

const jsonRequest = <A>(
  method: "GET" | "POST",
  url: string,
  authHeaders: Record<string, string>,
  body?: unknown,
): Effect.Effect<
  A,
  CredentialsError | HttpClientError.HttpClientError,
  Credentials | HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const base =
      method === "POST"
        ? HttpClientRequest.post(url).pipe(
            HttpClientRequest.setHeaders(authHeaders),
            HttpClientRequest.bodyJsonUnsafe(body),
          )
        : HttpClientRequest.get(url).pipe(
            HttpClientRequest.setHeaders(authHeaders),
          );
    const res = yield* client.execute(base);
    const text = yield* res.text.pipe(Effect.orElseSucceed(() => ""));
    if (res.status < 200 || res.status >= 300) {
      throw new Error(
        `R2 token API ${method} ${url} failed (${res.status}): ${text}`,
      );
    }
    const parsed = JSON.parse(text) as {
      success: boolean;
      result?: A;
      errors?: unknown;
    };
    if (!parsed.success || !parsed.result) {
      throw new Error(
        `R2 token API ${method} ${url} returned non-success: ${text}`,
      );
    }
    return parsed.result;
  });

/**
 * Create an R2 API token via `POST /accounts/{account_id}/r2/tokens`.
 * Requires an API token with the `Workers R2 Storage Write` permission
 * on the target account (the same scope `alchemy login` collects).
 */
export const createR2Token = (
  options: CreateR2TokenOptions,
): Effect.Effect<
  R2ApiToken,
  CredentialsError | HttpClientError.HttpClientError,
  Credentials | HttpClient.HttpClient | CloudflareEnvironment
> =>
  Effect.gen(function* () {
    const credentialsEff = yield* Credentials;
    const credentials = yield* credentialsEff;
    const authHeaders = formatHeaders(credentials);
    const env = yield* yield* CloudflareEnvironment;
    // The fromEnv Layer returns `{ account }` and fromProfile returns
    // `{ accountId }`; both are the same value under different keys.
    const accountId = ((env as unknown as { accountId?: string }).accountId ??
      (env as unknown as { account?: string }).account) as string;
    const bucketNames = options.bucketNames ?? ["*"];

    return yield* jsonRequest<R2ApiToken>(
      "POST",
      r2TokensEndpoint(accountId),
      authHeaders,
      {
        name: options.name,
        bucketNames,
      },
    );
  });

/**
 * List existing R2 tokens via `GET /accounts/{account_id}/r2/tokens`.
 * Returns id + name only (the access-key secret is never re-exposed
 * after creation).
 */
export const listR2Tokens = (): Effect.Effect<
  ReadonlyArray<R2ApiTokenSummary>,
  CredentialsError | HttpClientError.HttpClientError,
  Credentials | HttpClient.HttpClient | CloudflareEnvironment
> =>
  Effect.gen(function* () {
    const credentialsEff = yield* Credentials;
    const credentials = yield* credentialsEff;
    const authHeaders = formatHeaders(credentials);
    const env = yield* yield* CloudflareEnvironment;
    const accountId = ((env as unknown as { accountId?: string }).accountId ??
      (env as unknown as { account?: string }).account) as string;

    const result = yield* jsonRequest<unknown>(
      "GET",
      r2TokensEndpoint(accountId),
      authHeaders,
    );
    const obj = result as Record<string, unknown>;
    const candidates: ReadonlyArray<Record<string, unknown>> = [
      ...(Array.isArray(obj.tokens)
        ? (obj.tokens as Array<Record<string, unknown>>)
        : []),
      ...(Array.isArray(obj.buckets)
        ? (obj.buckets as Array<Record<string, unknown>>)
        : []),
      ...(Array.isArray(obj.result)
        ? (obj.result as Array<Record<string, unknown>>)
        : []),
      ...(Array.isArray(obj) ? (obj as Array<Record<string, unknown>>) : []),
    ];
    return candidates
      .filter((t) => typeof t.id === "string" && typeof t.name === "string")
      .map((t) => ({ id: t.id as string, name: t.name as string }));
  });
