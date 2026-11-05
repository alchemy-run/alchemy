import * as datazone from "@distilled.cloud/aws/datazone";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeDataZoneEnvironmentHttpBinding } from "./BindingHttp.ts";
import type { Environment } from "./Environment.ts";

/**
 * Runtime binding for `datazone:GetEnvironmentCredentials`.
 *
 * Fetches the short-lived AWS credentials of the bound environment's provisioned user role. The `secretAccessKey` and `sessionToken` are `Redacted` — unwrap with `Redacted.value` only at the point of use. The domain and environment ids are injected from the binding.
 * Provide the implementation with
 * `Effect.provide(AWS.DataZone.GetEnvironmentCredentialsHttp)`.
 * ### Environment Credentials
 * **Example:** Assume the Environment's Role
 * ```typescript
 * // init — bind the operation to the environment
 * const getEnvironmentCredentials = yield* AWS.DataZone.GetEnvironmentCredentials(environment);
 *
 * // runtime
 * const creds = yield* getEnvironmentCredentials();
 * const secret = Redacted.value(creds.secretAccessKey!);
 * ```
 *
 * @binding
 */
export interface GetEnvironmentCredentials extends Binding.Service<
  GetEnvironmentCredentials,
  "AWS.DataZone.GetEnvironmentCredentials",
  (
    environment: Environment,
  ) => Effect.Effect<
    () => Effect.Effect<
      datazone.GetEnvironmentCredentialsOutput,
      datazone.GetEnvironmentCredentialsError
    >
  >
> {}
export const GetEnvironmentCredentials = Binding.Service<GetEnvironmentCredentials>(
  "AWS.DataZone.GetEnvironmentCredentials",
);

export const GetEnvironmentCredentialsHttp = Layer.effect(
  GetEnvironmentCredentials,
  makeDataZoneEnvironmentHttpBinding({
    tag: "AWS.DataZone.GetEnvironmentCredentials",
    operation: datazone.getEnvironmentCredentials,
    actions: ["datazone:GetEnvironmentCredentials"],
  }),
);
