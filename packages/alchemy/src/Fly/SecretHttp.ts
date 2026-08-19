import { Credentials, CredentialsFromEnv } from "@distilled.cloud/fly-io";
import * as machines from "@distilled.cloud/fly-io/machines";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import * as Binding from "../Binding.ts";
import type { Resource } from "../Resource.ts";
import type { RuntimeContext } from "../RuntimeContext.ts";
import type { ServiceBinding } from "./MountVolume.ts";
import type { Secret } from "./Secret.ts";
import type { SecretKey } from "./SecretKey.ts";

/**
 * Shared scaffolding for the HTTP-backed Fly Secret bindings.
 *
 * Fly has no native Worker-style binding. This layer captures the ambient
 * `FLY_API_TOKEN` available during stack-eval (so Actions work in-process)
 * and, when the host is a {@link Machine} or {@link Service}, mints an
 * app-scoped deploy token and injects `FLY_API_TOKEN` + `FLY_APP_NAME`
 * into the host env. Runtime calls inside a deployed host read those env
 * vars via {@link CredentialsFromEnv}.
 *
 * NOT exported from `index.ts`.
 */
export type AppNamed = Secret | SecretKey;

export const makeHttpSecretBinding = <
  Target extends AppNamed,
  Client,
>(options: {
  makeClient: (
    auth: SecretAuth,
    appName: Effect.Effect<string>,
    secretName: Effect.Effect<string>,
  ) => Client;
}) =>
  Effect.gen(function* () {
    const context = yield* Effect.context<
      Credentials | HttpClient.HttpClient
    >();

    return Effect.fn(function* (resource: Target) {
      // One yield registers the Action → resource dependency. Do not
      // keep yielding until a string appears — that deadlocks stack
      // evaluation. If the yield is still an Effect, pass it through.
      const appName =
        yield* resource.appName as unknown as Effect.Effect<unknown>;
      const secretName =
        yield* resource.name as unknown as Effect.Effect<unknown>;
      const appNameEff = toNameEffect(appName);
      const secretNameEff = toNameEffect(secretName);

      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isFlyHost(host)) {
          const resolvedAppName = yield* appNameEff;
          const token = yield* mintDeployToken(resolvedAppName, context);
          yield* host.bind`${resource}`({
            env: {
              FLY_API_TOKEN: token,
              FLY_APP_NAME: resolvedAppName,
            },
          });
        }
      }

      return options.makeClient(
        makeSecretAuth(context),
        appNameEff,
        secretNameEff,
      );
    });
  });

/**
 * Injectable auth for the Secret HTTP client builders. Supplies an
 * `authorize` that provides `Credentials` + `HttpClient` to a raw SDK op.
 */
export interface SecretAuth {
  authorize: <A, E>(
    eff: Effect.Effect<A, E, Credentials | HttpClient.HttpClient>,
  ) => Effect.Effect<A, E, RuntimeContext>;
}

/** Build auth that uses ambient stack creds, or env creds inside a host. */
export const makeSecretAuth = (
  ambient: Context.Context<Credentials | HttpClient.HttpClient>,
): SecretAuth => ({
  authorize: (eff) => {
    if (globalThis.__ALCHEMY_RUNTIME__) {
      return eff.pipe(
        Effect.provide(CredentialsFromEnv),
        Effect.provide(FetchHttpClient.layer),
      );
    }
    return eff.pipe(Effect.provideContext(ambient));
  },
});

const toNameEffect = (value: unknown): Effect.Effect<string> => {
  if (typeof value === "string") return Effect.succeed(value);
  if (Effect.isEffect(value)) {
    return value as Effect.Effect<string>;
  }
  return Effect.die(
    "Fly secret binding expected a resolved app or secret name",
  );
};

export const unwrapSecretValue = (
  value: Redacted.Redacted<string> | string,
): string => (Redacted.isRedacted(value) ? Redacted.value(value) : value);

const isFlyHost = (
  value: unknown,
): value is Resource<string, any, any, ServiceBinding> =>
  typeof value === "object" &&
  value !== null &&
  ((value as { Type?: string }).Type === "Fly.Service" ||
    (value as { Type?: string }).Type === "Fly.Machine");

const mintDeployToken = (
  appName: string,
  ambient: Context.Context<Credentials | HttpClient.HttpClient>,
) =>
  machines.appCreateDeployToken({ app_name: appName }).pipe(
    Effect.provideContext(ambient),
    Effect.map((res) => res.token),
    Effect.catch(() => Effect.succeed(undefined as string | undefined)),
    Effect.flatMap((token) => {
      if (token !== undefined && token.length > 0) {
        return Effect.succeed(token);
      }
      return Credentials.pipe(
        Effect.provideContext(ambient),
        Effect.flatMap((resolve) => resolve),
        Effect.map((cfg) => Redacted.value(cfg.apiKey)),
      );
    }),
  );
