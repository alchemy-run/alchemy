import {
  SecretManager,
  SecretManagerError,
  makeSecretManager,
  type SecretManagerLayer,
  type SecretManagerService,
} from "alchemy";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

/** A schema/codegen-backed integration knows its binding names and types. */
export const externalIntegration = (onResolve: () => void = () => {}) =>
  makeSecretManager({
    name: "External typed fixture",
    resolve: ({ stage, dev }) =>
      Effect.sync(() => {
        onResolve();
        return {
          provider: ConfigProvider.fromUnknown({
            API_KEY: `secret-${stage}`,
            PUBLIC_URL: dev
              ? "http://localhost:4321"
              : `https://${stage}.example.com`,
            FEATURE_ENABLED: "true",
            DEPLOY_TOKEN: "tooling-only",
          }),
          bindings: {
            API_KEY: Config.redacted("API_KEY"),
            PUBLIC_URL: Config.string("PUBLIC_URL"),
            FEATURE_ENABLED: Config.boolean("FEATURE_ENABLED"),
            __INTEGRATION_ENV: Config.succeed(
              Redacted.make(`runtime-${stage}`),
            ),
          },
        };
      }),
  });

const service: SecretManagerService = {
  name: "External fixture",
  resolve: ({ stack, stage }) =>
    Effect.succeed(
      ConfigProvider.fromUnknown({
        EXTERNAL_SECRET_SET: `${stack}/${stage ?? "default"}`,
      }),
    ),
};

/** Simulates the public surface exported by an external integration package. */
export const externalSecrets = (): SecretManagerLayer =>
  Layer.succeed(SecretManager, service);

/** Bootstrap failures must remain typed across the public layer boundary. */
export const externalBootstrapSecrets = (): SecretManagerLayer =>
  Layer.effect(
    SecretManager,
    Config.redacted("EXTERNAL_BOOTSTRAP_TOKEN").pipe(
      Effect.mapError(
        () =>
          new SecretManagerError({
            manager: service.name,
            message: "Missing external bootstrap token.",
          }),
      ),
      Effect.as(service),
    ),
  );

// Keep the public error type part of the fixture's compilation boundary.
export const externalFailure = (cause: unknown) =>
  new SecretManagerError({
    manager: service.name,
    message: "The external fixture could not resolve configuration.",
    cause,
  });
