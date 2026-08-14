import type { Credentials } from "@distilled.cloud/vercel/Credentials";
import * as projects from "@distilled.cloud/vercel/projects";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import { VercelEnvironment } from "../VercelEnvironment.ts";
import { MissingOidcToken, OidcTokenMintFailed } from "./QueueTypes.ts";

/**
 * Vercel OIDC token acquisition.
 *
 * Two worlds:
 * - **Inside a deployed Vercel Function** the platform provisions a token
 *   ambiently — {@link ambientOidcToken} mirrors `@vercel/oidc`'s resolution
 *   order (request-context header `x-vercel-oidc-token`, then the
 *   `VERCEL_OIDC_TOKEN` env var).
 * - **Outside Vercel** (tests, poll-mode consumers, CLI-side infra) a token
 *   is minted from the management API via `projects.getProjectToken` —
 *   {@link mintProjectOidcToken} for a one-shot mint,
 *   {@link projectOidcToken} for an expiry-buffered auto-refreshing accessor.
 */

/** The request-context global `@vercel/oidc` reads inside a Function. */
const REQUEST_CONTEXT = Symbol.for("@vercel/request-context");

/**
 * Synchronously resolve the ambient OIDC token (or `undefined`), mirroring
 * `@vercel/oidc`'s order: request-context `x-vercel-oidc-token` header, then
 * the `VERCEL_OIDC_TOKEN` env var. Plain function so the promise-based
 * async-mode client can share it; Effect code uses {@link ambientOidcToken}.
 */
export const ambientOidcTokenUnsafe = (): string | undefined => {
  const holder = (globalThis as Record<PropertyKey, unknown>)[
    REQUEST_CONTEXT
  ] as
    | {
        get?: () =>
          | { headers?: Record<string, string | undefined> }
          | undefined;
      }
    | undefined;
  const token =
    holder?.get?.()?.headers?.["x-vercel-oidc-token"] ??
    process.env.VERCEL_OIDC_TOKEN;
  return token !== undefined && token !== "" ? token : undefined;
};

/**
 * Resolve the ambient Vercel OIDC token, mirroring `@vercel/oidc`:
 * the request-context `x-vercel-oidc-token` header first, then the
 * `VERCEL_OIDC_TOKEN` environment variable. Fails with a typed
 * {@link MissingOidcToken} when neither is present (i.e. we are not running
 * inside a Vercel Function and no token was pulled via `vercel env pull`).
 */
export const ambientOidcToken: Effect.Effect<
  Redacted.Redacted<string>,
  MissingOidcToken
> = Effect.suspend(() => {
  const token = ambientOidcTokenUnsafe();
  return token !== undefined
    ? Effect.succeed(Redacted.make(token))
    : Effect.fail(
        new MissingOidcToken({
          message:
            "No ambient Vercel OIDC token (request-context `x-vercel-oidc-token` header or VERCEL_OIDC_TOKEN env var). " +
            "Outside a Vercel Function, mint one with `mintProjectOidcToken`/`projectOidcToken` or pass `token` explicitly.",
        }),
      );
});

/**
 * Mint a fresh project OIDC token via the management API
 * (`POST /v1/projects/{idOrName}/token`). One-shot — for long-running
 * consumers prefer {@link projectOidcToken}, which refreshes before expiry.
 *
 * **Scope caveat (live-verified)**: minted tokens are ALWAYS
 * `environment: development`-scoped — there is no parameter that changes
 * this — and the queue namespace is per (project, environment). A minted
 * token therefore only interoperates with other dev-scoped clients; it can
 * NEVER observe queue traffic produced by deployed Functions (their ambient
 * token is production-scoped, a disjoint namespace even with an identical
 * deployment pin). Verify deployed-function queue behavior via in-scope
 * HTTP readback instead (see `test/Vercel/Queues/Subscribe.test.ts`).
 */
export const mintProjectOidcToken = (
  projectIdOrName: string,
): Effect.Effect<
  Redacted.Redacted<string>,
  OidcTokenMintFailed,
  Credentials | HttpClient.HttpClient | VercelEnvironment
> =>
  Effect.gen(function* () {
    const { teamId } = yield* VercelEnvironment.current;
    const { token } = yield* projects
      .getProjectToken({
        idOrName: projectIdOrName,
        teamId,
        source: "vercel-oidc-refresh",
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new OidcTokenMintFailed({
              message: `Failed to mint a Vercel OIDC token for project '${projectIdOrName}': ${
                (cause as { message?: string }).message ?? String(cause)
              }`,
              projectIdOrName,
              cause,
            }),
        ),
      );
    return Redacted.make(token);
  });

/**
 * An expiry-buffered, auto-refreshing project OIDC token accessor for
 * infrastructure running OUTSIDE Vercel (poll-mode consumers, tests).
 *
 * The outer Effect captures the management-API services (credentials, HTTP
 * client, team scope) once; the returned inner Effect is dependency-free and
 * re-mints at most once per TTL. Vercel OIDC tokens live ~1 hour, so the
 * default 45-minute TTL refreshes comfortably before expiry.
 *
 * @example Poll consumer with a refreshing token
 * ```typescript
 * const token = yield* Vercel.projectOidcToken(project.projectId);
 * const consumer = yield* Vercel.makeReceiveMessagesClient(Orders, {
 *   consumerGroup: "worker",
 *   token,
 * });
 * ```
 */
export const projectOidcToken = (
  projectIdOrName: string,
  options?: { readonly ttl?: Duration.Input },
): Effect.Effect<
  Effect.Effect<Redacted.Redacted<string>, OidcTokenMintFailed>,
  never,
  Credentials | HttpClient.HttpClient | VercelEnvironment
> =>
  Effect.gen(function* () {
    const context = yield* Effect.context<
      Credentials | HttpClient.HttpClient | VercelEnvironment
    >();
    return yield* Effect.cachedWithTTL(
      mintProjectOidcToken(projectIdOrName).pipe(
        Effect.provideContext(context),
      ),
      options?.ttl ?? "45 minutes",
    );
  });
