import * as Schema from "effect/Schema";

/**
 * Env var naming the emulator SSM parameter that holds the developer's AWS
 * credentials during `alchemy dev`. `AWSBindings.Bind` sets it on an emulated
 * host bound to a resource in the real cloud (`Alchemy.remote()`); the dev
 * sidecar sees it in the host's props and keeps the parameter fresh (see
 * `DevCredentialsRelay.ts`); the host's binding clients read the parameter
 * and sign their real-cloud calls with it.
 */
export const DEV_CREDENTIALS_ENV = "ALCHEMY_AWS_DEV_CREDENTIALS";

/** The JSON the relay writes to the parameter. */
export const DevCredentialsValue = Schema.fromJsonString(
  Schema.Struct({
    accessKeyId: Schema.String,
    secretAccessKey: Schema.String,
    sessionToken: Schema.optional(Schema.String),
    region: Schema.String,
    expiration: Schema.optional(Schema.Number),
  }),
);
