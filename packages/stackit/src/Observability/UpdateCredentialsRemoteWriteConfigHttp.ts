import * as observability from "@distilled.cloud/stackit/observability";
import * as Layer from "effect/Layer";
import { INSTANCE_WRITE_ACCESS, makeCredentialHttpBinding } from "./BindingHttp.ts";
import { UpdateCredentialsRemoteWriteConfig } from "./UpdateCredentialsRemoteWriteConfig.ts";

/**
 * HTTP implementation of {@link UpdateCredentialsRemoteWriteConfig}.
 *
 * @layer
 * @provides Stackit.Observability.UpdateCredentialsRemoteWriteConfig
 */
export const UpdateCredentialsRemoteWriteConfigHttp = Layer.effect(
  UpdateCredentialsRemoteWriteConfig,
  makeCredentialHttpBinding({
    tag: "Stackit.Observability.UpdateCredentialsRemoteWriteConfig",
    access: INSTANCE_WRITE_ACCESS,
    operation: observability.updateCredentialsRemoteWriteConfig,
  }),
);
