import * as Domain from "@alchemy.run/domain";
import * as DomainGCP from "@alchemy.run/domain/GCP";
import * as GCP from "@alchemy.run/gcp";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Scope from "effect/Scope";
import { runCases } from "../../../Domain/vault/cases.ts";
import { serveProbes } from "../../bindingHost.ts";
import { KEY_RING_ID, kmsTestId } from "../../KMS/common.ts";

/** The database the Vault's keys are kept in, one document per subject. */
export const Keys = GCP.Firestore.Database("VaultKeys", {
  location: "us-central1",
  type: "FIRESTORE_NATIVE",
});

/** The Cloud KMS key every subject's key is wrapped under. */
export const RootKey = Effect.gen(function* () {
  const ring = yield* GCP.KMS.KeyRing("Keys", {
    keyRingId: KEY_RING_ID,
    location: "us-central1",
  });
  return yield* GCP.KMS.CryptoKey("VaultRootKey", {
    keyRing: ring.name,
    cryptoKeyId: kmsTestId("vault"),
  });
});

/** Each probe runs the Vault cases against one pairing and answers with what each found. */
export default class DomainVaultHost extends GCP.Function<DomainVaultHost>()(
  "DomainVaultHost",
  { main: import.meta.url, invokerIamDisabled: true },
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const vaultOf = <R>(keys: Layer.Layer<Domain.KeyStore | Domain.KeyWrap, never, R>) =>
      Layer.buildWithScope(Domain.VaultLive.pipe(Layer.provide(keys)), scope).pipe(
        Effect.map((context) => Context.get(context, Domain.Vault)),
      );
    const kms = yield* vaultOf(
      Layer.merge(DomainGCP.FirestoreKeyStore(Keys), DomainGCP.KmsKeyWrap(RootKey)),
    );
    const kept = yield* vaultOf(
      Layer.merge(
        DomainGCP.FirestoreKeyStore(Keys, { collection: "kept_keys" }),
        DomainGCP.KmsKeyWrap(RootKey, { intermediateKey: { keep: "5 minutes" } }),
      ),
    );
    const root = yield* vaultOf(
      Layer.merge(
        DomainGCP.FirestoreKeyStore(Keys, { collection: "root_keys" }),
        Domain.RootKeyWrap(Redacted.make("7e".repeat(32))),
      ),
    );
    return {
      fetch: serveProbes({
        firestoreKms: runCases("cases-kms").pipe(Effect.provideService(Domain.Vault, kms)),
        firestoreKmsKept: runCases("cases-kept").pipe(Effect.provideService(Domain.Vault, kept)),
        firestoreRoot: runCases("cases-root").pipe(Effect.provideService(Domain.Vault, root)),
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        GCP.Firestore.GetDocumentHttp,
        GCP.Firestore.PatchDocumentHttp,
        GCP.Firestore.DeleteDocumentHttp,
        GCP.KMS.EncryptHttp,
        GCP.KMS.DecryptHttp,
      ),
    ),
  ),
) {}
