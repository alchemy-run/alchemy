import * as ske from "@distilled.cloud/stackit/ske";
import * as Layer from "effect/Layer";
import { makeClusterHttpBinding, SKE_ACCESS } from "./BindingHttp.ts";
import { StartCredentialsRotation } from "./StartCredentialsRotation.ts";

/**
 * HTTP implementation of {@link StartCredentialsRotation}.
 *
 * @layer
 * @provides Stackit.SKE.StartCredentialsRotation
 */
export const StartCredentialsRotationHttp = Layer.effect(
  StartCredentialsRotation,
  makeClusterHttpBinding({
    tag: "Stackit.SKE.StartCredentialsRotation",
    access: SKE_ACCESS.rotateCredentials,
    operation: ske.startCredentialsRotation,
  }),
);
