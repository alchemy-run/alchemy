import { createSpacesKey, deleteSpacesKey } from "@distilled.cloud/digitalocean";
import { Credentials } from "@distilled.cloud/digitalocean/Credentials";
import { SpacesCredentialsError } from "@distilled.cloud/digitalocean/Spaces";
import { Credentials as S3Keys, type ResolvedCredentials } from "@distilled.cloud/s3/Credentials";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import type * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import type * as Scope from "effect/Scope";

// Spaces accepts any region in the signature; the endpoint picks the region.
const SIGNING_REGION = "us-east-1";

/**
 * Spaces S3 keys for the deploy. `Spaces.Bucket` creates and deletes buckets,
 * which a key scoped to one bucket cannot do, so distilled's
 * `Spaces.layerS3Keys({ bucket })` does not fit a provider that manages every
 * bucket of the team.
 *
 * Uses the configured Spaces keys (`SPACES_ACCESS_KEY_ID` /
 * `SPACES_SECRET_ACCESS_KEY`) when present. Otherwise it creates a
 * full-access key on the first S3 call and deletes it when the deploy's scope
 * closes. The key is named `alchemy-deploy-<time>`, so a process that dies
 * before closing the scope leaves a key you can recognize.
 */
export const SpacesDeployKeys = (): Layer.Layer<
  S3Keys,
  never,
  Credentials | HttpClient.HttpClient
> =>
  Layer.effect(
    S3Keys,
    Effect.gen(function* () {
      const context = yield* Effect.context<Credentials | HttpClient.HttpClient | Scope.Scope>();

      const mint = Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const { key } = yield* createSpacesKey({
          name: `alchemy-deploy-${now}`,
          grants: [{ bucket: "", permission: "fullaccess" }],
        });
        yield* Effect.addFinalizer(() =>
          deleteSpacesKey({ access_key: key.access_key }).pipe(Effect.ignore),
        );
        return {
          accessKeyId: Redacted.make(key.access_key),
          secretAccessKey:
            typeof key.secret_key === "string" ? Redacted.make(key.secret_key) : key.secret_key,
        };
      });

      const resolve = Effect.gen(function* () {
        const credentials = yield* yield* Credentials;
        const keys =
          credentials.spacesAccessKeyId !== undefined &&
          credentials.spacesSecretAccessKey !== undefined
            ? {
                accessKeyId: credentials.spacesAccessKeyId,
                secretAccessKey: credentials.spacesSecretAccessKey,
              }
            : yield* mint;
        return {
          ...keys,
          sessionToken: undefined,
          region: SIGNING_REGION,
        } satisfies ResolvedCredentials;
      }).pipe(
        Effect.provideContext(context),
        Effect.mapError(
          (cause) =>
            new SpacesCredentialsError({
              message: "Could not create a Spaces access key for the deploy.",
              cause,
            }),
        ),
      );
      // Successes only: a failed attempt is tried again on the next call.
      let resolved: ResolvedCredentials | undefined;
      return Effect.suspend(() =>
        resolved
          ? Effect.succeed(resolved)
          : Effect.tap(resolve, (r) => Effect.sync(() => (resolved = r))),
      );
    }),
  );
