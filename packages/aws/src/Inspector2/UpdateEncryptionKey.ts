import * as inspector2 from "@distilled.cloud/aws/inspector2";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeInspector2AccountHttpBinding } from "./BindingHttp.ts";

/**
 * Runtime binding for `inspector2:UpdateEncryptionKey`.
 *
 * Updates an encryption key. A `ResourceNotFoundException` means that an
 * Amazon Web Services owned key is being used for encryption.
 *
 * Provide the implementation with
 * `Effect.provide(AWS.Inspector2.UpdateEncryptionKeyHttp)`.
 * ### Account Settings & Usage
 * **Example:** Use a Customer-Managed Key
 * ```typescript
 * // init
 * const updateEncryptionKey = yield* AWS.Inspector2.UpdateEncryptionKey();
 *
 * // runtime
 * yield* updateEncryptionKey({
 *   kmsKeyId,
 *   resourceType: "AWS_ECR_CONTAINER_IMAGE",
 *   scanType: "PACKAGE",
 * });
 * ```
 *
 * @binding
 */
export interface UpdateEncryptionKey extends Binding.Service<
  UpdateEncryptionKey,
  "AWS.Inspector2.UpdateEncryptionKey",
  () => Effect.Effect<
    (
      request: inspector2.UpdateEncryptionKeyRequest,
    ) => Effect.Effect<inspector2.UpdateEncryptionKeyResponse, inspector2.UpdateEncryptionKeyError>
  >
> {}
export const UpdateEncryptionKey = Binding.Service<UpdateEncryptionKey>(
  "AWS.Inspector2.UpdateEncryptionKey",
);

export const UpdateEncryptionKeyHttp = Layer.effect(
  UpdateEncryptionKey,
  makeInspector2AccountHttpBinding({
    tag: "AWS.Inspector2.UpdateEncryptionKey",
    operation: inspector2.updateEncryptionKey,
    actions: ["inspector2:UpdateEncryptionKey"],
  }),
);
