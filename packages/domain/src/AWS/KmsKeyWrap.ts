import type { AliasName } from "@alchemy.run/aws/KMS/Alias";
import { Decrypt } from "@alchemy.run/aws/KMS/Decrypt";
import { GenerateDataKey } from "@alchemy.run/aws/KMS/GenerateDataKey";
import type { Key } from "@alchemy.run/aws/KMS/Key";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import {
  fromBase64,
  type IntermediateKeyOptions,
  intermediateKeyWrap,
  isIntermediate,
  KeyWrap,
  toBase64,
} from "../KeyWrap.ts";
import { VaultError } from "../VaultError.ts";

const KMS = "kms.";

const plain = (value: Uint8Array | Redacted.Redacted<Uint8Array>) =>
  Redacted.isRedacted(value) ? Redacted.value(value) : value;

/** Options for {@link KmsKeyWrap}. */
export interface KmsKeyWrapOptions {
  /**
   * Call KMS once per intermediate key instead of once per seal and open.
   * Each process has KMS make an intermediate key, keeps it in memory for
   * `keep`, and wraps subject keys under it locally.
   *
   * It trades cost for exposure: an intermediate key is in the process's
   * memory, KMS logs one call per intermediate key rather than one per
   * subject, and a process cut off from KMS reads on for up to `keep`.
   * Shredding is unchanged: each subject keeps a key of its own.
   *
   * @default undefined (every seal and open is one KMS call)
   */
  readonly intermediateKey?: IntermediateKeyOptions;
}

/** The encryption context of an intermediate key, which belongs to no one subject. */
const INTERMEDIATE_CONTEXT = { purpose: "alchemy-domain-vault-intermediate-key" };

/**
 * Wrap each subject's key under an AWS KMS key. KMS makes the subject's key
 * (`GenerateDataKey`) and unwraps it (`Decrypt`), with the subject as the
 * encryption context, so a stored key unwraps only for the subject it was
 * made for. The root key never leaves KMS.
 *
 * Every seal and open is one `Decrypt` call.
 *
 * ### Wrapping keys under KMS
 * **Example:** A KMS key over keys in DynamoDB
 * ```typescript
 * import * as AWS from "@alchemy.run/aws";
 * import * as Domain from "@alchemy.run/domain";
 * import * as DomainAWS from "@alchemy.run/domain/AWS";
 * import * as Layer from "effect/Layer";
 *
 * export const Keys = AWS.DynamoDB.Table("VaultKeys", {
 *   partitionKey: "subject",
 *   attributes: { subject: "S" },
 * });
 * export const RootKey = AWS.KMS.Key("VaultRootKey");
 *
 * export const Sealing = Domain.VaultLive.pipe(
 *   Layer.provide(DomainAWS.DynamoKeyStore(Keys)),
 *   Layer.provide(DomainAWS.KmsKeyWrap(RootKey)),
 *   Layer.provide(
 *     Layer.mergeAll(
 *       AWS.DynamoDB.GetItemHttp,
 *       AWS.DynamoDB.PutItemHttp,
 *       AWS.DynamoDB.DeleteItemHttp,
 *       AWS.KMS.GenerateDataKeyHttp,
 *       AWS.KMS.DecryptHttp,
 *     ),
 *   ),
 * );
 * ```
 *
 * ### Calling KMS less often
 * `intermediateKey` has each process keep one intermediate key in memory
 * and wrap subject keys under it locally, so KMS is called once per
 * intermediate key instead of once per seal and open. The intermediate key
 * is in the process's memory, KMS no longer logs each subject's access,
 * and a process cut off from KMS reads on for up to `keep`. Shredding is
 * unchanged.
 *
 * **Example:** One KMS call per process every five minutes
 * ```typescript
 * DomainAWS.KmsKeyWrap(RootKey, { intermediateKey: { keep: "5 minutes" } });
 * ```
 *
 * @layer
 * @provides Domain.KeyWrap
 */
export const KmsKeyWrap = <E = never, R = never>(
  key: Key | AliasName | Effect.Effect<Key, E, R>,
  options: KmsKeyWrapOptions = {},
): Layer.Layer<KeyWrap, E, R | GenerateDataKey | Decrypt> =>
  Layer.effect(
    KeyWrap,
    Effect.gen(function* () {
      const root = Effect.isEffect(key) ? yield* key : key;
      const generate = yield* GenerateDataKey(root);
      const decrypt = yield* Decrypt(root);
      const failed = (subject: string) => (cause: { readonly message: string }) =>
        VaultError.make({ subject, reason: cause.message });
      const missing = (subject: string) =>
        VaultError.make({ subject, reason: "KMS returned no key" });
      // KMS makes a key and wraps it, bound to `context`.
      const makeUnder = Effect.fn(function* (subject: string, context: Record<string, string>) {
        const made = yield* generate({ KeySpec: "AES_256", EncryptionContext: context }).pipe(
          Effect.mapError(failed(subject)),
        );
        if (made.Plaintext === undefined || made.CiphertextBlob === undefined) {
          return yield* missing(subject);
        }
        return { key: toBase64(plain(made.Plaintext)), wrapped: toBase64(made.CiphertextBlob) };
      });
      const unwrapUnder = Effect.fn(function* (
        subject: string,
        wrapped: string,
        context: Record<string, string>,
      ) {
        const opened = yield* decrypt({
          CiphertextBlob: fromBase64(wrapped),
          EncryptionContext: context,
        }).pipe(Effect.mapError(failed(subject)));
        if (opened.Plaintext === undefined) return yield* missing(subject);
        return toBase64(plain(opened.Plaintext));
      });
      const direct: KeyWrap["Service"] = {
        make: Effect.fn(function* (subject) {
          const made = yield* makeUnder(subject, { subject });
          return { key: made.key, wrapped: KMS + made.wrapped };
        }),
        unwrap: Effect.fn(function* (subject, wrapped) {
          // A key wrapped under an intermediate key still opens with the option off.
          if (isIntermediate(wrapped)) return yield* intermediate.unwrap(subject, wrapped);
          if (!wrapped.startsWith(KMS)) {
            return yield* VaultError.make({ subject, reason: "its key was not wrapped by KMS" });
          }
          return yield* unwrapUnder(subject, wrapped.slice(KMS.length), { subject });
        }),
      };
      const intermediate = intermediateKeyWrap({
        // With the option off, an intermediate key is only ever read: keep none.
        keep: options.intermediateKey?.keep ?? 0,
        make: (subject) => makeUnder(subject, INTERMEDIATE_CONTEXT),
        unwrap: (subject, wrapped) => unwrapUnder(subject, wrapped, INTERMEDIATE_CONTEXT),
        direct: direct.unwrap as (
          subject: string,
          wrapped: string,
        ) => Effect.Effect<string, VaultError>,
      });
      return options.intermediateKey === undefined
        ? direct
        : (intermediate as unknown as KeyWrap["Service"]);
    }),
  );
