import type * as oslogin from "@distilled.cloud/gcp/oslogin_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { UsersSshPublicKey } from "./UsersSshPublicKey.ts";

export interface GetUsersSshPublicKeyRequest extends Omit<
  oslogin.GetUsersSshPublicKeysRequest,
  "name"
> {}

/**
 * Runtime binding for OS Login `users.sshPublicKeys.get`.
 *
 * Bind this operation to a {@link UsersSshPublicKey} in a Function/Action
 * init phase. Provide {@link GetUsersSshPublicKeyHttp}.
 *
 * ### Reading SSH Public Keys
 * **Example:** Read key metadata
 * ```typescript
 * const getKey = yield* GCP.Oslogin.GetUsersSshPublicKey(sshKey);
 * const metadata = yield* getKey({});
 * ```
 *
 * @binding
 * @product GCP
 * @category Oslogin
 */
export interface GetUsersSshPublicKey extends Binding.Service<
  GetUsersSshPublicKey,
  "GCP.Oslogin.GetUsersSshPublicKey",
  (
    sshKey: UsersSshPublicKey,
  ) => Effect.Effect<
    (
      request: GetUsersSshPublicKeyRequest,
    ) => Effect.Effect<
      oslogin.SshPublicKey,
      oslogin.GetUsersSshPublicKeysError,
      RuntimeContext
    >
  >
> {}

export const GetUsersSshPublicKey = Binding.Service<GetUsersSshPublicKey>(
  "GCP.Oslogin.GetUsersSshPublicKey",
);
