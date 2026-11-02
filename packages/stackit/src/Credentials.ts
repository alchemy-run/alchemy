import { ConfigError } from "@distilled.cloud/core/errors";
import {
  Credentials,
  fromServiceAccountKey,
  parseServiceAccountKey,
  type Config,
} from "@distilled.cloud/stackit/Credentials";
import { lazyCredentials } from "alchemy/Auth/Resolve";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Semaphore from "effect/Semaphore";
import { STACKIT_AUTH_PROVIDER_NAME, type StackitResolvedCredentials } from "./AuthProvider.ts";

export {
  Credentials,
  CredentialsFromEnv,
  credentials,
  DEFAULT_REGION,
  fromServiceAccountKey,
  parseServiceAccountKey,
  type Config as CredentialsConfig,
  type ServiceAccountKey,
} from "@distilled.cloud/stackit/Credentials";

const readFile = (fs: FileSystem.FileSystem, path: string, what: string) =>
  fs.readFileString(path).pipe(
    Effect.mapError((cause) =>
      ConfigError.make({
        message: `Failed to read the STACKIT ${what} at ${path}: ${cause.message}`,
      }),
    ),
  );

/** Identity of the key material, so a changed profile re-mints tokens. */
const fingerprintOf = (creds: StackitResolvedCredentials) =>
  JSON.stringify([
    creds.serviceAccountKeyPath ?? null,
    creds.serviceAccountKey === undefined ? null : Redacted.value(creds.serviceAccountKey),
    creds.privateKeyPath ?? null,
    creds.privateKey === undefined ? null : Redacted.value(creds.privateKey),
    creds.region,
  ]);

/**
 * Build a `Credentials` layer that resolves STACKIT credentials via the
 * Alchemy AuthProvider using the configured profile (defaults to "default",
 * overridable with the `ALCHEMY_PROFILE` env/config value).
 *
 * The profile names a service-account key (inline JSON or a key file path).
 * On first use the key is read and handed to distilled's
 * `fromServiceAccountKey`, which signs a JWT assertion with the key's
 * private key, exchanges it for an access token at STACKIT's token endpoint,
 * and refreshes it before it expires. Nothing is resolved while the layer is
 * built, so building providers never needs a configured profile.
 */
export const fromAuthProvider = () =>
  Layer.effect(
    Credentials,
    Effect.gen(function* () {
      const resolve = yield* lazyCredentials<StackitResolvedCredentials, ConfigError>()(
        STACKIT_AUTH_PROVIDER_NAME,
        (creds) => creds,
      );
      const fs = yield* FileSystem.FileSystem;
      const http = yield* HttpClient.HttpClient;
      // The token-minting layer lives as long as the providers layer, so its
      // token cache (and any refresh machinery) survives across calls.
      const scope = yield* Effect.scope;
      const lock = yield* Semaphore.make(1);
      let minted:
        | { readonly fingerprint: string; readonly config: Effect.Effect<Config, ConfigError> }
        | undefined;

      const readKeyJson = (creds: StackitResolvedCredentials) => {
        if (creds.serviceAccountKey !== undefined) {
          return Effect.succeed(Redacted.value(creds.serviceAccountKey));
        }
        if (creds.serviceAccountKeyPath !== undefined) {
          return readFile(fs, creds.serviceAccountKeyPath, "service-account key");
        }
        return Effect.fail(
          ConfigError.make({
            message:
              "STACKIT credentials name no service-account key. Run `alchemy profile edit --add Stackit` or set STACKIT_SERVICE_ACCOUNT_KEY_PATH.",
          }),
        );
      };
      const readPrivateKey = (creds: StackitResolvedCredentials) => {
        if (creds.privateKey !== undefined) return Effect.succeed(creds.privateKey);
        if (creds.privateKeyPath !== undefined) {
          return readFile(fs, creds.privateKeyPath, "private key").pipe(Effect.map(Redacted.make));
        }
        return Effect.succeed(undefined);
      };

      const mint = Effect.fn(function* (creds: StackitResolvedCredentials) {
        const fingerprint = fingerprintOf(creds);
        if (minted?.fingerprint === fingerprint) return minted.config;
        const keyJson = yield* readKeyJson(creds);
        const key = yield* parseServiceAccountKey(keyJson);
        const privateKey = yield* readPrivateKey(creds);
        const context = yield* Layer.buildWithScope(
          fromServiceAccountKey({ key, privateKey, region: creds.region }),
          scope,
        ).pipe(Effect.provideService(HttpClient.HttpClient, http));
        const config = Context.get(context, Credentials);
        minted = { fingerprint, config };
        return config;
      });

      return resolve.pipe(
        Effect.flatMap((creds) => lock.withPermits(1)(mint(creds))),
        Effect.flatMap((config) => config),
      );
    }),
  );
