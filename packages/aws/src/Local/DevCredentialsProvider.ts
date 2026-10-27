import * as Endpoint from "@distilled.cloud/aws/Endpoint";
import * as ssm from "@distilled.cloud/aws/ssm";
import * as sts from "@distilled.cloud/aws/sts";
import type { AuthProviders } from "alchemy/Auth/AuthProvider";
import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import type { ProfileStore } from "alchemy/Auth/Profile";
import * as LocalProvider from "alchemy/Local/LocalProvider";
import * as ProviderLayer from "alchemy/Local/ProviderLayer";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import type { FileSystem } from "effect/FileSystem";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import type { HttpClient } from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import type { Path } from "effect/Path";
import type { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { AwsAuth } from "../AuthProvider.ts";
import * as Credentials from "../Credentials.ts";
import { AWSEnvironment, Default as DefaultEnvironment } from "../Environment.ts";
import * as Region from "../Region.ts";
import { DevCredentials, type DevCredentialsValue } from "./DevCredentials.ts";
import { flociProvidersUrl } from "./DevWatchProvider.ts";
import { flociServices } from "./FlociServices.ts";

/** Rewrite the parameter this often, well inside any credential lifetime. */
const REFRESH_INTERVAL = "10 minutes";

/** Session-token lifetime for a profile holding a long-lived key. */
const SESSION_TOKEN_SECONDS = 3600;

/**
 * The developer's live AWS environment (profile, SSO session), built from
 * config rather than the run's ambient: in `alchemy dev` the ambient AWS
 * environment is the emulator.
 */
const liveEnvironment = Layer.mergeAll(
  Region.fromEnvironment,
  Credentials.fromEnvironment,
  Layer.succeed(Endpoint.Endpoint, Effect.succeed(undefined)),
  FetchHttpClient.layer,
).pipe(
  Layer.provideMerge(DefaultEnvironment),
  Layer.provideMerge(AwsAuth),
  Layer.provideMerge(CredentialsStoreLive),
);

/**
 * The developer's current credentials, always temporary: a long-lived key
 * (no session token) is exchanged for a session token, so the emulator never
 * holds a key that outlives the session.
 */
const resolveTemporaryCredentials = Effect.gen(function* () {
  const environment = yield* yield* AWSEnvironment;
  const credentials = yield* environment.credentials;
  if (credentials.sessionToken !== undefined) {
    return {
      accessKeyId: Redacted.value(credentials.accessKeyId),
      secretAccessKey: Redacted.value(credentials.secretAccessKey),
      sessionToken: Redacted.value(credentials.sessionToken),
      region: environment.region,
      expiration: credentials.expiration,
    } satisfies DevCredentialsValue;
  }
  const { Credentials: session } = yield* sts.getSessionToken({
    DurationSeconds: SESSION_TOKEN_SECONDS,
  });
  return {
    accessKeyId: session!.AccessKeyId,
    secretAccessKey: Redacted.isRedacted(session!.SecretAccessKey)
      ? Redacted.value(session!.SecretAccessKey)
      : session!.SecretAccessKey,
    sessionToken: session!.SessionToken,
    region: environment.region,
    expiration: session!.Expiration.getTime(),
  } satisfies DevCredentialsValue;
}).pipe(Effect.provide(liveEnvironment));

/** Outside `alchemy dev` there is no emulator to relay into. */
export const DevCredentialsProviderLive = () =>
  Provider.succeed(DevCredentials, {
    list: () => Effect.succeed([]),
    diff: () => Effect.succeed({ action: "noop" }),
    reconcile: ({ news }) => Effect.succeed({ parameterName: news.parameterName }),
    delete: () => Effect.void,
  });

/**
 * Runs in the dev sidecar: writes the developer's credentials to the
 * emulator parameter at readiness, then rewrites them every
 * {@link REFRESH_INTERVAL} until the instance stops. Delete removes the
 * parameter.
 */
export const DevCredentialsProviderLocal = () =>
  LocalProvider.make(
    DevCredentials,
    flociProvidersUrl(),
    Effect.gen(function* () {
      // What the live profile chain needs (profiles, auth, the SSO cache),
      // from the process hosting this provider.
      const services = yield* Effect.context<
        AuthProviders | ProfileStore | FileSystem | Path | ChildProcessSpawner | HttpClient
      >();
      // Parameters written by this sidecar, for `stop` (which only gets the FQN).
      const written = new Map<string, string>();
      return {
        start: Effect.fn(function* ({ fqn, news: { parameterName } }) {
          const write = Effect.gen(function* () {
            const value = yield* resolveTemporaryCredentials.pipe(Effect.provide(services));
            yield* ssm
              .putParameter({
                Name: parameterName,
                Type: "SecureString",
                Value: JSON.stringify(value),
                Overwrite: true,
              })
              .pipe(Effect.provide(flociServices()));
          });
          yield* write;
          written.set(fqn, parameterName);
          yield* write.pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning(
                `[alchemy dev] failed to refresh AWS credentials for ${fqn}`,
                cause,
              ),
            ),
            Effect.repeat(Schedule.spaced(REFRESH_INTERVAL)),
            Effect.delay(REFRESH_INTERVAL),
            Effect.forkScoped,
          );
          return { parameterName };
        }),
        stop: Effect.fn(function* ({ fqn }) {
          const parameterName = written.get(fqn);
          if (parameterName === undefined) return;
          written.delete(fqn);
          yield* ssm.deleteParameter({ Name: parameterName }).pipe(
            Effect.catchTag("ParameterNotFound", () => Effect.void),
            Effect.provide(flociServices()),
          );
        }),
      } satisfies LocalProvider.LocalProviderSpec<DevCredentials>;
    }),
  );

export const DevCredentialsProvider = () =>
  ProviderLayer.dual(DevCredentials, {
    live: DevCredentialsProviderLive,
    local: DevCredentialsProviderLocal,
  });
