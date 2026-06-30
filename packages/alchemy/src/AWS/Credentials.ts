import {
  AwsCredentialProviderError,
  Credentials,
  type ResolvedCredentials,
} from "@distilled.cloud/aws/Credentials";
import { Region } from "@distilled.cloud/aws/Region";
import * as sts from "@distilled.cloud/aws/sts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { AWSEnvironment } from "./Environment.ts";

/**
 * Refresh assumed-role credentials this long before they actually expire, so a
 * request never signs with credentials on the verge of expiring.
 */
const CREDENTIAL_REFRESH_WINDOW_MS = 5 * 60 * 1000;

// NB: do not re-export `fromEnv` here — it is unavailable under the
// browser/workerd bundle condition (`credentials.browser`), which would break
// any Cloudflare Worker that transitively imports this module.
export { Credentials, fromCredentials } from "@distilled.cloud/aws/Credentials";

declare module "@distilled.cloud/aws/Credentials" {
  interface Credentials {
    readonly kind: "Credentials";
  }
}

/**
 * Lazy `Credentials` layer derived from the surrounding {@link AWSEnvironment}.
 * Credentials are resolved on first access (not during layer construction),
 * matching the existing @distilled.cloud/aws semantics.
 */
export const fromEnvironment = Layer.effect(
  Credentials,
  Effect.gen(function* () {
    return Effect.flatMap(yield* AWSEnvironment, (env) => env.credentials);
  }),
);

/**
 * A `Credentials` layer that assumes an IAM Role via STS and serves the
 * returned temporary credentials (cached until shortly before expiry).
 *
 * `base` supplies the long-lived credentials used to *sign* the `AssumeRole`
 * call — typically static IAM-user access keys (see
 * {@link fromCredentials}). The `AssumeRole` request itself is signed against
 * `base`, while the temporary credentials it returns become the resolved
 * `Credentials` for every downstream AWS call.
 *
 * This is how a non-AWS host (e.g. a Cloudflare Worker, which has no AWS
 * execution role) obtains scoped AWS credentials: an IAM User's access key is
 * bound to the host, and that user assumes a least-privilege role at runtime.
 */
export const fromAssumeRole = (options: {
  /** ARN of the IAM Role to assume. */
  readonly roleArn: string;
  /** Static credentials used to sign the `AssumeRole` call. */
  readonly base: Layer.Layer<Credentials>;
  /** STS role session name. @default "alchemy-microvm" */
  readonly roleSessionName?: string;
  /**
   * Region for the STS endpoint. STS `AssumeRole` is global, so this only
   * selects the regional STS endpoint. @default "us-east-1"
   */
  readonly region?: string;
}): Layer.Layer<Credentials> =>
  Layer.effect(
    Credentials,
    Effect.gen(function* () {
      const resolve = Effect.gen(function* () {
        const response = yield* sts
          .assumeRole({
            RoleArn: options.roleArn,
            RoleSessionName: options.roleSessionName ?? "alchemy-microvm",
          })
          .pipe(
            // A freshly-created IAM user/role/access-key is eventually
            // consistent: the first `AssumeRole` calls can fail with
            // `AccessDenied` until the trust policy + permissions propagate.
            // Retry those for up to ~30s.
            Effect.retry({
              while: (error) =>
                (error as { name?: string }).name === "AccessDeniedException" ||
                (error as { _tag?: string })._tag === "AccessDeniedException",
              schedule: Schedule.exponential("1 second"),
              times: 8,
            }),
          );
        const creds = response.Credentials;
        if (!creds) {
          return yield* new AwsCredentialProviderError({
            message: "STS AssumeRole returned no credentials",
            provider: "assume-role",
          });
        }
        return {
          accessKeyId: Redacted.make(creds.AccessKeyId),
          secretAccessKey: Redacted.isRedacted(creds.SecretAccessKey)
            ? creds.SecretAccessKey
            : Redacted.make(creds.SecretAccessKey),
          sessionToken: Redacted.make(creds.SessionToken),
          expiration: creds.Expiration?.getTime(),
        } satisfies ResolvedCredentials;
      }).pipe(
        // Sign AssumeRole with the static base credentials, and provide a
        // (regional) STS endpoint + HttpClient so the resolve effect is
        // self-contained (`R = never`).
        Effect.provide(options.base),
        Effect.provide(
          Layer.succeed(Region, Effect.succeed(options.region ?? "us-east-1")),
        ),
        Effect.provide(FetchHttpClient.layer),
        Effect.mapError((cause) =>
          cause instanceof AwsCredentialProviderError
            ? cause
            : new AwsCredentialProviderError({
                message: "STS AssumeRole failed",
                provider: "assume-role",
                cause,
              }),
        ),
      );

      // Single-flight, expiry-aware cache. A `Ref` holds the last-resolved
      // credentials; a 1-permit semaphore serializes refreshes so that N
      // concurrent callers observing stale/expiring credentials trigger
      // exactly ONE `AssumeRole` call (the rest await the permit and then see
      // the freshly-cached value via the re-check inside the critical section).
      const cache = yield* Ref.make<ResolvedCredentials | undefined>(undefined);
      const refreshLock = yield* Semaphore.make(1);

      const isFresh = (
        creds: ResolvedCredentials | undefined,
      ): creds is ResolvedCredentials =>
        creds !== undefined &&
        (creds.expiration === undefined ||
          creds.expiration - CREDENTIAL_REFRESH_WINDOW_MS > Date.now());

      return Effect.gen(function* () {
        const current = yield* Ref.get(cache);
        // Fast path: cached and not within the refresh window.
        if (isFresh(current)) return current;
        // Slow path: acquire the refresh permit, re-check (another fiber may
        // have refreshed while we waited), then resolve once and cache.
        return yield* refreshLock.withPermits(1)(
          Effect.gen(function* () {
            const latest = yield* Ref.get(cache);
            if (isFresh(latest)) return latest;
            const resolved = yield* resolve;
            yield* Ref.set(cache, resolved);
            return resolved;
          }),
        );
      });
    }),
  );
