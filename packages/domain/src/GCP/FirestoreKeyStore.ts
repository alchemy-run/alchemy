import type { Database } from "@alchemy.run/gcp/Firestore/Database";
import { DeleteDocument } from "@alchemy.run/gcp/Firestore/DeleteDocument";
import { GetDocument } from "@alchemy.run/gcp/Firestore/GetDocument";
import { PatchDocument } from "@alchemy.run/gcp/Firestore/PatchDocument";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { KeyStore, VaultError } from "../Vault.ts";

/** Options for {@link FirestoreKeyStore}. */
export interface FirestoreKeyStoreOptions {
  /**
   * The collection that holds one document per subject.
   * @default "vault_keys"
   */
  readonly collection?: string;
}

/** A document id for any subject: ids take no `/`. */
const documentId = (subject: string) => {
  let text = "";
  for (const byte of new TextEncoder().encode(subject)) text += String.fromCharCode(byte);
  return `s${btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
};

/**
 * A Vault's keys in a Firestore database, one document per subject. Leave
 * point-in-time recovery and backup schedules off for it: a restored
 * database brings shredded keys back.
 *
 * ### Keeping keys in Firestore
 * **Example:** A database for the Vault's keys, wrapped under Cloud KMS
 * ```typescript
 * import * as Domain from "@alchemy.run/domain";
 * import * as DomainGCP from "@alchemy.run/domain/GCP";
 * import * as GCP from "@alchemy.run/gcp";
 * import * as Effect from "effect/Effect";
 * import * as Layer from "effect/Layer";
 *
 * export const Keys = GCP.Firestore.Database("VaultKeys", {
 *   location: "us-central1",
 *   type: "FIRESTORE_NATIVE",
 * });
 * export const RootKey = Effect.gen(function* () {
 *   const keyRing = yield* GCP.KMS.KeyRing("Vault", { location: "us-central1" });
 *   return yield* GCP.KMS.CryptoKey("VaultRootKey", { keyRing: keyRing.name });
 * });
 *
 * export const Sealing = Domain.VaultLive.pipe(
 *   Layer.provide(DomainGCP.FirestoreKeyStore(Keys)),
 *   Layer.provide(DomainGCP.KmsKeyWrap(RootKey)),
 *   Layer.provide(
 *     Layer.mergeAll(
 *       GCP.Firestore.GetDocumentHttp,
 *       GCP.Firestore.PatchDocumentHttp,
 *       GCP.Firestore.DeleteDocumentHttp,
 *       GCP.KMS.EncryptHttp,
 *       GCP.KMS.DecryptHttp,
 *     ),
 *   ),
 * );
 * ```
 *
 * @layer
 * @provides Domain.KeyStore
 */
export const FirestoreKeyStore = <E = never, R = never>(
  database: Database | Effect.Effect<Database, E, R>,
  options: FirestoreKeyStoreOptions = {},
): Layer.Layer<KeyStore, E, R | GetDocument | PatchDocument | DeleteDocument> =>
  Layer.effect(
    KeyStore,
    Effect.gen(function* () {
      const keys = Effect.isEffect(database) ? yield* database : database;
      const getDocument = yield* GetDocument(keys);
      const patchDocument = yield* PatchDocument(keys);
      const deleteDocument = yield* DeleteDocument(keys);
      const collection = options.collection ?? "vault_keys";
      const pathOf = (subject: string) => `${collection}/${documentId(subject)}`;
      const failed = (subject: string) => (cause: { readonly message: string }) =>
        VaultError.make({ subject, reason: cause.message });
      const get = (subject: string) =>
        getDocument({ documentPath: pathOf(subject) }).pipe(
          Effect.map((document) => Option.fromNullishOr(document.fields?.key?.stringValue)),
          Effect.catchTag("NotFound", () => Effect.succeed(Option.none<string>())),
          Effect.mapError(failed(subject)),
        );
      return {
        get,
        create: (subject, key) =>
          patchDocument({
            documentPath: pathOf(subject),
            "currentDocument.exists": false,
            fields: { key: { stringValue: key } },
          }).pipe(
            Effect.as(key),
            // Another caller stored a key first: the subject has that one.
            Effect.catchTag("Conflict", () =>
              Effect.map(
                get(subject),
                Option.getOrElse(() => key),
              ),
            ),
            Effect.mapError(failed(subject)),
          ),
        delete: (subject) =>
          deleteDocument({ documentPath: pathOf(subject) }).pipe(
            Effect.asVoid,
            Effect.catchTag("NotFound", () => Effect.void),
            Effect.mapError(failed(subject)),
          ),
      };
    }),
  );
