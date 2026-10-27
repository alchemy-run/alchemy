import * as ssm from "@distilled.cloud/aws/ssm";
import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { AwsAuth } from "../AuthProvider.ts";
import { AWSEnvironment, Default as DefaultEnvironment } from "../Environment.ts";
import { DevCredentialsValue } from "./DevCredentials.ts";
import { flociServices } from "./FlociServices.ts";

/**
 * Write the developer's credentials, read from their profile, to the
 * emulator parameter `parameterName`. The profile chain is built from config,
 * not the ambient AWS environment, which in `alchemy dev` is the emulator.
 */
export const writeDevCredentials = Effect.fn(
  function* (parameterName: string) {
    const environment = yield* yield* AWSEnvironment;
    const credentials = yield* environment.credentials;
    const value = yield* Schema.encodeEffect(DevCredentialsValue)({
      accessKeyId: Redacted.value(credentials.accessKeyId),
      secretAccessKey: Redacted.value(credentials.secretAccessKey),
      sessionToken: credentials.sessionToken && Redacted.value(credentials.sessionToken),
      region: environment.region,
      expiration: credentials.expiration,
    });
    yield* ssm
      .putParameter({ Name: parameterName, Type: "SecureString", Value: value, Overwrite: true })
      .pipe(Effect.provide(flociServices()));
  },
  Effect.provide(
    DefaultEnvironment.pipe(Layer.provideMerge(AwsAuth), Layer.provideMerge(CredentialsStoreLive)),
  ),
);
