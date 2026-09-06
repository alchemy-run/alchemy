import {
  SecretManager,
  SecretManagerError,
  type SecretManagerLayer,
  type SecretManagerService,
} from "alchemy";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

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
