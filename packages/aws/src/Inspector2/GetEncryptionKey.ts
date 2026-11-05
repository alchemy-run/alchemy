import * as inspector2 from "@distilled.cloud/aws/inspector2";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeInspector2AccountHttpBinding } from "./BindingHttp.ts";

/**
 * Runtime binding for `inspector2:GetEncryptionKey`.
 *
 * Gets an encryption key.
 *
 * Provide the implementation with
 * `Effect.provide(AWS.Inspector2.GetEncryptionKeyHttp)`.
 * ### Account Settings & Usage
 * **Example:** Read the CMK for a Scan Type
 * ```typescript
 * // init
 * const getEncryptionKey = yield* AWS.Inspector2.GetEncryptionKey();
 *
 * // runtime
 * const { kmsKeyId } = yield* getEncryptionKey({
 *   resourceType: "AWS_ECR_CONTAINER_IMAGE",
 *   scanType: "PACKAGE",
 * });
 * ```
 *
 * @binding
 */
export interface GetEncryptionKey extends Binding.Service<
  GetEncryptionKey,
  "AWS.Inspector2.GetEncryptionKey",
  () => Effect.Effect<
    (
      request: inspector2.GetEncryptionKeyRequest,
    ) => Effect.Effect<inspector2.GetEncryptionKeyResponse, inspector2.GetEncryptionKeyError>
  >
> {}
export const GetEncryptionKey = Binding.Service<GetEncryptionKey>(
  "AWS.Inspector2.GetEncryptionKey",
);

export const GetEncryptionKeyHttp = Layer.effect(
  GetEncryptionKey,
  makeInspector2AccountHttpBinding({
    tag: "AWS.Inspector2.GetEncryptionKey",
    operation: inspector2.getEncryptionKey,
    actions: ["inspector2:GetEncryptionKey"],
  }),
);
