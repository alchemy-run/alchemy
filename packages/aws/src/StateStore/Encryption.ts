import type { Credentials } from "@distilled.cloud/aws/Credentials";
import type { Region } from "@distilled.cloud/aws/Region";
import { StateStoreError } from "alchemy/State/State";
import { StateEncryption } from "alchemy/State/StateEncryption";
import * as Effect from "effect/Effect";
import type { HttpClient } from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import { kmsKeyring, resolveStateKey } from "./Key.ts";
import { stateEnvironment, withoutSdkDebugLogs } from "./State.ts";

export interface StateEncryptionOptions {
  /**
   * The KMS key (id, ARN or alias) data keys are minted under.
   *
   * @default `alias/alchemy-state` (`alias/alchemy-state-<name>` with `name`), the AWS state store's own key, created on first use
   */
  readonly kmsKeyId?: string;
  /** Use the key of the AWS state store of this name. */
  readonly name?: string;
}

/** Context required by the distilled KMS operations. */
type KmsDeps = Credentials | HttpClient | Region;

const toError = (cause: { readonly _tag?: string; readonly message?: string }) =>
  cause._tag === "StateStoreError"
    ? (cause as StateStoreError)
    : new StateStoreError({ message: cause.message ?? `KMS error: ${cause._tag}` });

/**
 * Encrypt the secrets in any state store with AWS KMS.
 *
 * Each secret (a `Redacted` value: a minted token, a `Random` value) is
 * encrypted with AES-256-GCM under a data key from KMS before the store
 * writes it, so the store only ever holds ciphertext. A deploy asks KMS for
 * one data key per stage. Every other value in a record stays readable, so
 * plans and `alchemy state` keep working.
 *
 * Reading the secrets back takes `kms:Decrypt` on the key, and writing them
 * `kms:GenerateDataKey`. Each data key is bound to its stack and stage
 * (`alchemy:stack`, `alchemy:stage` in the encryption context), so an IAM
 * policy can grant decrypt for one stage only.
 *
 * The AWS state stores use this with their own key already; provide it to
 * encrypt another store's secrets, or to pick the key.
 *
 * ### Encrypting another Cloud's State Store
 * **Example:** Cloudflare state, secrets encrypted with AWS KMS
 * ```typescript
 * import * as AWS from "@alchemy.run/aws";
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Layer from "effect/Layer";
 *
 * const Stack = Alchemy.Stack(
 *   "my-stack",
 *   {
 *     providers: Cloudflare.providers(),
 *     state: Cloudflare.state().pipe(Layer.provide(AWS.stateEncryption())),
 *   },
 *   Effect.gen(function* () {
 *     // ...
 *   }),
 * );
 * ```
 *
 * **Example:** Local state with encrypted secrets
 * ```typescript
 * import { localState } from "alchemy/State";
 *
 * const stateStore = localState().pipe(
 *   Layer.provide(AWS.stateEncryption({ kmsKeyId: "alias/dev-state" })),
 * );
 * ```
 *
 * ### Choosing the Key
 * **Example:** Your own KMS key
 * ```typescript
 * const encryption = AWS.stateEncryption({ kmsKeyId: "alias/my-state-key" });
 * ```
 *
 * @layer
 * @provides StateEncryption
 * @product KMS
 */
export const stateEncryption = (options: StateEncryptionOptions = {}) =>
  Layer.effect(
    StateEncryption,
    Effect.gen(function* () {
      // Captured under `withoutSdkDebugLogs`: KMS responses hold data keys.
      const context = yield* Effect.context<KmsDeps>();
      const run = <A, E extends { readonly _tag?: string; readonly message?: string }>(
        effect: Effect.Effect<A, E, KmsDeps>,
      ) => effect.pipe(Effect.provideContext(context), Effect.mapError(toError));
      const keyArn = yield* Effect.cached(
        run(
          resolveStateKey({
            kmsKeyId: options.kmsKeyId,
            name: options.name,
            store: {
              backend: "aws",
              flags: { name: options.name },
              label: "AWS state encryption",
              configured: options.kmsKeyId !== undefined,
            },
          }),
        ),
      );
      return kmsKeyring(keyArn, run);
    }).pipe(withoutSdkDebugLogs),
  ).pipe(Layer.provide(stateEnvironment()));
