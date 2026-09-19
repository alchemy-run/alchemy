import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { getEnv, getEnvRedacted } from "./Env.ts";

/**
 * Platform-issued OIDC tokens, for exchanging with a secrets manager's OIDC
 * identity auth (Doppler service account identities, Infisical machine
 * identities) so CI never holds a long-lived credential.
 *
 * Detection order and sources are adapted from varlock's `oidc-tokens`
 * utility (MIT, see THIRD_PARTY_LICENSES.md):
 * https://github.com/dmno-dev/varlock/blob/9a7dfc2e76f0598f0c5bd56a0f084a48a2efd9e3/packages/utils/src/oidc-tokens.ts
 *
 *
 * | Platform       | Detected by       | Token source                              |
 * | -------------- | ----------------- | ----------------------------------------- |
 * | explicit       | the caller's env  | the variable itself                       |
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

/** Which env vars a provider reserves for its explicit token and audience. */
export interface OidcTokenEnv {
  /** Explicit override for platforms that are not auto-detected. */
  readonly token: string;
  /** Optional `aud` claim to request where the platform supports it. */
  readonly audience: string;
}

/** The platforms {@link detectOidcToken} knows, for error messages. */
export const SUPPORTED_OIDC_PLATFORMS =
  "Vercel, GitHub Actions (needs `permissions: id-token: write`), GitLab CI (needs `id_tokens`), Fly.io, and GCP";

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
export const detectOidcToken = (env: OidcTokenEnv) =>
  Effect.gen(function* () {
    const audience = yield* getEnv(env.audience);
    const probes = [
      ["explicit", attempt(tokenFromEnv(env.token))],
      ["vercel", attempt(fromVercel)],
      ["github-actions", attempt(fromGitHubActions(audience))],
      ["gitlab", attempt(fromGitLab)],
      ["fly", attempt(fromFly(audience))],
      ["gcp", attempt(fromGcp(audience))],
    ] as const;
    for (const [platform, probe] of probes) {
      const token = yield* probe;
      if (token !== undefined) {
        const found: OidcToken = { platform, token };
        return found;
      }
    }
    return undefined;
  });
