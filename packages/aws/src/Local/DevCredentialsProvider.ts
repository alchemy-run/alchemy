import * as ssm from "@distilled.cloud/aws/ssm";
import type { AuthProviders } from "alchemy/Auth/AuthProvider";
import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import type { ProfileStore } from "alchemy/Auth/Profile";
import * as LocalProvider from "alchemy/Local/LocalProvider";
import * as ProviderLayer from "alchemy/Local/ProviderLayer";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import type { FileSystem } from "effect/FileSystem";
import type { HttpClient } from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import type { Path } from "effect/Path";
import type { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { AwsAuth } from "../AuthProvider.ts";
import { AWSEnvironment, Default as DefaultEnvironment } from "../Environment.ts";
import { DevCredentials, type DevCredentialsValue } from "./DevCredentials.ts";
import { flociProvidersUrl } from "./DevWatchProvider.ts";
import { flociServices } from "./FlociServices.ts";

/**
 * The developer's credentials from their profile. Built from config, not
 * the run's ambient AWS environment, which in `alchemy dev` is the emulator.
 */
const developerCredentials = Effect.gen(function* () {
  const environment = yield* yield* AWSEnvironment;
  const credentials = yield* environment.credentials;
  return {
    accessKeyId: Redacted.value(credentials.accessKeyId),
    secretAccessKey: Redacted.value(credentials.secretAccessKey),
    sessionToken: credentials.sessionToken && Redacted.value(credentials.sessionToken),
    region: environment.region,
    expiration: credentials.expiration,
  } satisfies DevCredentialsValue;
}).pipe(
  Effect.provide(
    DefaultEnvironment.pipe(Layer.provideMerge(AwsAuth), Layer.provideMerge(CredentialsStoreLive)),
  ),
);

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
 * emulator parameter, then rewrites it every 10 minutes (well inside an SSO
 * session's lifetime) until `alchemy dev` stops.
 */
export const DevCredentialsProviderLocal = () =>
  LocalProvider.make(
    DevCredentials,
    flociProvidersUrl(),
    Effect.gen(function* () {
      // The profile chain's services, from the process hosting this provider.
      const services = yield* Effect.context<
        AuthProviders | ProfileStore | FileSystem | Path | ChildProcessSpawner | HttpClient
      >();
      return {
        start: Effect.fn(function* ({ news: { parameterName } }) {
          const write = Effect.gen(function* () {
            const value = yield* developerCredentials.pipe(Effect.provide(services));
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
          yield* write.pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning(
                "[alchemy dev] failed to refresh the relayed AWS credentials",
                cause,
              ),
            ),
            Effect.repeat(Schedule.spaced("10 minutes")),
            Effect.delay("10 minutes"),
            Effect.forkScoped,
          );
          return { parameterName };
        }),
      } satisfies LocalProvider.LocalProviderSpec<DevCredentials>;
    }),
  );

export const DevCredentialsProvider = () =>
  ProviderLayer.dual(DevCredentials, {
    live: DevCredentialsProviderLive,
    local: DevCredentialsProviderLocal,
  });
