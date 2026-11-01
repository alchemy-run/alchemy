import * as observability from "@distilled.cloud/stackit/observability";
import * as Layer from "effect/Layer";
import { INSTANCE_READ_ACCESS, makeCredentialHttpBinding } from "./BindingHttp.ts";
import { GetCredentialsRemoteWriteConfig } from "./GetCredentialsRemoteWriteConfig.ts";

/**
 * HTTP implementation of {@link GetCredentialsRemoteWriteConfig}.
 *
 * @layer
 * @provides Stackit.Observability.GetCredentialsRemoteWriteConfig
 */
export const GetCredentialsRemoteWriteConfigHttp = Layer.effect(
  GetCredentialsRemoteWriteConfig,
  makeCredentialHttpBinding({
    tag: "Stackit.Observability.GetCredentialsRemoteWriteConfig",
    access: INSTANCE_READ_ACCESS,
    operation: observability.getCredentialsRemoteWriteConfig,
  }),
);
