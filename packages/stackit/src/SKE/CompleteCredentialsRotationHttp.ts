import * as ske from "@distilled.cloud/stackit/ske";
import * as Layer from "effect/Layer";
import { makeClusterHttpBinding, SKE_ACCESS } from "./BindingHttp.ts";
import { CompleteCredentialsRotation } from "./CompleteCredentialsRotation.ts";

/**
 * HTTP implementation of {@link CompleteCredentialsRotation}.
 *
 * @layer
 * @provides Stackit.SKE.CompleteCredentialsRotation
 */
export const CompleteCredentialsRotationHttp = Layer.effect(
  CompleteCredentialsRotation,
  makeClusterHttpBinding({
    tag: "Stackit.SKE.CompleteCredentialsRotation",
    access: SKE_ACCESS.rotateCredentials,
    operation: ske.completeCredentialsRotation,
  }),
);
