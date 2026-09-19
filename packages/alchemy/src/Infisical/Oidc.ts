import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { AuthError } from "../Auth/AuthProvider.ts";
import { getEnv, getEnvRedacted } from "../Auth/Env.ts";

/**
 * Platform-issued OIDC tokens, for exchanging with Infisical's OIDC machine
 * identity auth so CI never holds a long-lived Infisical credential.
 *
 * Detection order and sources mirror varlock's `oidc-tokens` utility:
 *
 * | Platform       | Detected by       | Token source                              |
 * | -------------- | ----------------- | ----------------------------------------- |
 * | explicit       | `INFISICAL_OIDC_TOKEN` | the variable itself                  |
 * | Vercel         | `VERCEL`          | `VERCEL_OIDC_TOKEN`                       |
 * | GitHub Actions | `GITHUB_ACTIONS`  | `ACTIONS_ID_TOKEN_REQUEST_URL` + token    |
 * | GitLab CI      | `GITLAB_CI`       | `CI_JOB_JWT_V2` or `SIGSTORE_ID_TOKEN`    |
 * | Fly.io         | `FLY_APP_NAME`    | `http://_api.internal:4280/v1/tokens/oidc` |
 * | GCP            | `K_SERVICE` etc.  | the metadata server's identity endpoint   |
 */
export type OidcPlatform =
  | "explicit"
  | "vercel"
  | "github-actions"
  | "gitlab"
  | "fly"
  | "gcp";

export interface OidcToken {
  readonly platform: OidcPlatform;
  readonly token: Redacted.Redacted<string>;
}

/** Explicit override for platforms that are not auto-detected. */
export const INFISICAL_OIDC_TOKEN_ENV = "INFISICAL_OIDC_TOKEN";
/** Optional `aud` claim to request where the platform supports it. */
export const INFISICAL_OIDC_AUDIENCE_ENV = "INFISICAL_OIDC_AUDIENCE";

/** Metadata and internal endpoints answer fast or not at all. */
const PROBE_TIMEOUT = Duration.seconds(5);

const present = (value: string | undefined): value is string =>
  value !== undefined && value.length > 0;

/** Read a non-empty env var as a token, or nothing. */
const tokenFromEnv = (name: string) =>
  getEnvRedacted(name).pipe(
    Effect.map((token) =>
      token !== undefined && Redacted.value(token).length > 0
        ? token
        : undefined,
    ),
  );

const fromExplicit = tokenFromEnv(INFISICAL_OIDC_TOKEN_ENV);

const fromVercel = Effect.gen(function* () {
  if (!present(yield* getEnv("VERCEL"))) return undefined;
  return yield* tokenFromEnv("VERCEL_OIDC_TOKEN");
});

/**
 * GitHub Actions hands out tokens through a per-job request URL. Needs
 * `permissions: id-token: write` on the workflow or job.
 */
const fromGitHubActions = (audience: string | undefined) =>
  Effect.gen(function* () {
    if (!present(yield* getEnv("GITHUB_ACTIONS"))) return undefined;
    const requestUrl = yield* getEnv("ACTIONS_ID_TOKEN_REQUEST_URL");
    const requestToken = yield* getEnvRedacted(
      "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
    );
    if (!present(requestUrl) || requestToken === undefined) return undefined;

    const client = yield* HttpClient.HttpClient;
    const url = new URL(requestUrl);
    if (audience !== undefined) url.searchParams.set("audience", audience);
    const response = yield* client.get(url, {
      headers: {
        Authorization: `Bearer ${Redacted.value(requestToken)}`,
        Accept: "application/json; api-version=2.0",
      },
    });
    if (response.status !== 200) return undefined;
    const body = (yield* response.json) as { value?: string };
    return present(body.value) ? Redacted.make(body.value) : undefined;
  });

/** GitLab exposes the job's ID token through whichever variable `id_tokens` names. */
const fromGitLab = Effect.gen(function* () {
  if (!present(yield* getEnv("GITLAB_CI"))) return undefined;
  return (
    (yield* tokenFromEnv("CI_JOB_JWT_V2")) ??
    (yield* tokenFromEnv("SIGSTORE_ID_TOKEN"))
  );
});

/** Every Fly Machine can mint a token from the internal API. */
const fromFly = (audience: string | undefined) =>
  Effect.gen(function* () {
    if (!present(yield* getEnv("FLY_APP_NAME"))) return undefined;
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(
      HttpClientRequest.post("http://_api.internal:4280/v1/tokens/oidc").pipe(
        HttpClientRequest.bodyJsonUnsafe(
          audience === undefined ? {} : { aud: audience },
        ),
      ),
    );
    if (response.status !== 200) return undefined;
    const token = (yield* response.text).trim();
    return present(token) ? Redacted.make(token) : undefined;
  });

/**
 * Cloud Run, Cloud Functions, and GCE expose identity tokens through the
 * metadata server. Gated on the env vars those runtimes set so a laptop
 * never waits on a DNS lookup for `metadata.google.internal`.
 */
const fromGcp = (audience: string | undefined) =>
  Effect.gen(function* () {
    const onGcp =
      present(yield* getEnv("K_SERVICE")) ||
      present(yield* getEnv("GCE_METADATA_HOST")) ||
      present(yield* getEnv("GOOGLE_CLOUD_PROJECT"));
    if (!onGcp) return undefined;

    const client = yield* HttpClient.HttpClient;
    const url = new URL(
      "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity",
    );
    if (audience !== undefined) url.searchParams.set("audience", audience);
    const response = yield* client.get(url, {
      headers: { "Metadata-Flavor": "Google" },
    });
    if (response.status !== 200) return undefined;
    const token = (yield* response.text).trim();
    return present(token) ? Redacted.make(token) : undefined;
  });

/** A probe that fails or hangs is treated as "not this platform". */
const attempt = <A, E, R>(probe: Effect.Effect<A | undefined, E, R>) =>
  probe.pipe(
    Effect.timeout(PROBE_TIMEOUT),
    Effect.catch(() => Effect.succeed(undefined)),
  );

/**
 * Find the OIDC token of the platform this process is running on. Probes
 * run in order and the first token wins; `undefined` means no supported
 * platform (or its token) was detected.
 */
export const detectOidcToken: Effect.Effect<
  OidcToken | undefined,
  AuthError,
  HttpClient.HttpClient
> = Effect.gen(function* () {
  const audience = yield* getEnv(INFISICAL_OIDC_AUDIENCE_ENV);
  // Probe failures (HTTP or env) are swallowed by `attempt`, hence `unknown`.
  const probes: ReadonlyArray<
    readonly [
      OidcPlatform,
      Effect.Effect<
        Redacted.Redacted<string> | undefined,
        unknown,
        HttpClient.HttpClient
      >,
    ]
  > = [
    ["explicit", fromExplicit],
    ["vercel", fromVercel],
    ["github-actions", fromGitHubActions(audience)],
    ["gitlab", fromGitLab],
    ["fly", fromFly(audience)],
    ["gcp", fromGcp(audience)],
  ];
  for (const [platform, probe] of probes) {
    const token = yield* attempt(probe);
    if (token !== undefined) return { platform, token };
  }
  return undefined;
});
