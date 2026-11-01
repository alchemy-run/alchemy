import * as kms from "@distilled.cloud/stackit/kms";
import * as Effect from "effect/Effect";
import { Base64 } from "effect/encoding";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as StackitBindings from "../StackitBindings.ts";
import {
  InvalidKmsPayload,
  type KeyVersionSelector,
  NoActiveKeyVersion,
  type SecretBytes,
} from "./CryptoTypes.ts";
import type { DecryptClient, DecryptRequest } from "./Decrypt.ts";
import type { EncryptClient, EncryptRequest } from "./Encrypt.ts";
import type { ImportKeyClient, ImportKeyRequest } from "./ImportKey.ts";
import { latestActiveVersion } from "./internal.ts";
import type { Key } from "./Key.ts";
import type { KeyRing } from "./KeyRing.ts";
import type { ReadKeyClient } from "./ReadKey.ts";
import type { ReadWriteKeyClient } from "./ReadWriteKey.ts";
import type { SignClient, SignRequest } from "./Sign.ts";
import type { VerifyClient, VerifyRequest } from "./Verify.ts";
import type { WrappingKey } from "./WrappingKey.ts";
import type { WriteKeyClient } from "./WriteKey.ts";

/**
 * Shared HTTP scaffolding for KMS bindings.
 * NOT exported from index.ts.
 *
 * Permissions bind on the project holding the key: STACKIT has no role binding
 * on a key or a key ring (see `StackitBindings`). The names are the actions in
 * each operation's `x-stackit-authorization` in the KMS spec. They grant through
 * a custom role because no STACKIT source lists predefined KMS roles.
 *
 * There is no per-operation least privilege here: `kms.keyring.get` authorizes
 * encrypt, decrypt, sign, verify and every read, and `kms.keyring.update` every
 * key and version change, on every key in the project.
 */
export const KMS_READ_ACCESS: StackitBindings.Access = { permissions: ["kms.keyring.get"] };
export const KMS_LIST_ACCESS: StackitBindings.Access = { permissions: ["kms.keyring.list"] };
export const KMS_WRITE_ACCESS: StackitBindings.Access = { permissions: ["kms.keyring.update"] };
export const KMS_READ_WRITE_ACCESS: StackitBindings.Access = {
  permissions: ["kms.keyring.get", "kms.keyring.update"],
};

/** Build a binding over one operation on a key: `<Op>Http.ts` is one call to it. */
export const makeKeyHttpBinding = <
  I extends { projectId: string; regionId: string; keyRingId: string; keyId: string },
  A,
  E,
>(options: {
  /** Fully-qualified binding tag, e.g. `Stackit.KMS.GetKey`. */
  tag: string;
  /** What the operation needs on the project holding the key. */
  access: StackitBindings.Access;
  /** The distilled operation; the key's identifiers are injected. */
  operation: StackitBindings.StackitHttpOp<I, A, E>;
}) =>
  StackitBindings.makeHttpBinding({
    tag: options.tag,
    operation: options.operation,
    identify: (key: Key) => ({
      projectId: key.projectId,
      regionId: key.region,
      keyRingId: key.keyRingId,
      keyId: key.keyId,
    }),
    grants: (key) => [StackitBindings.grantOn(key, options.access)],
  });

/** Build a binding over one operation on a key ring. */
export const makeKeyRingHttpBinding = <
  I extends { projectId: string; regionId: string; keyRingId: string },
  A,
  E,
>(options: {
  /** Fully-qualified binding tag, e.g. `Stackit.KMS.GetKeyRing`. */
  tag: string;
  /** What the operation needs on the project holding the ring. */
  access: StackitBindings.Access;
  /** The distilled operation; the ring's identifiers are injected. */
  operation: StackitBindings.StackitHttpOp<I, A, E>;
}) =>
  StackitBindings.makeHttpBinding({
    tag: options.tag,
    operation: options.operation,
    identify: (ring: KeyRing) => ({
      projectId: ring.projectId,
      regionId: ring.region,
      keyRingId: ring.keyRingId,
    }),
    grants: (ring) => [StackitBindings.grantOn(ring, options.access)],
  });

/** Build a binding over an operation on a key ring's project and region. */
export const makeKeyRingScopeHttpBinding = <
  I extends { projectId: string; regionId: string },
  A,
  E,
>(options: {
  /** Fully-qualified binding tag, e.g. `Stackit.KMS.ListKeyRings`. */
  tag: string;
  /** What the operation needs on the project holding the ring. */
  access: StackitBindings.Access;
  /** The distilled operation; the ring's project and region are injected. */
  operation: StackitBindings.StackitHttpOp<I, A, E>;
}) =>
  StackitBindings.makeHttpBinding({
    tag: options.tag,
    operation: options.operation,
    identify: (ring: KeyRing) => ({ projectId: ring.projectId, regionId: ring.region }),
    grants: (ring) => [StackitBindings.grantOn(ring, options.access)],
  });

/** Build a binding over one operation on a wrapping key. */
export const makeWrappingKeyHttpBinding = <
  I extends { projectId: string; regionId: string; keyRingId: string; wrappingKeyId: string },
  A,
  E,
>(options: {
  /** Fully-qualified binding tag, e.g. `Stackit.KMS.GetWrappingKey`. */
  tag: string;
  /** What the operation needs on the project holding the wrapping key. */
  access: StackitBindings.Access;
  /** The distilled operation; the wrapping key's identifiers are injected. */
  operation: StackitBindings.StackitHttpOp<I, A, E>;
}) =>
  StackitBindings.makeHttpBinding({
    tag: options.tag,
    operation: options.operation,
    identify: (wrappingKey: WrappingKey) => ({
      projectId: wrappingKey.projectId,
      regionId: wrappingKey.region,
      keyRingId: wrappingKey.keyRingId,
      wrappingKeyId: wrappingKey.wrappingKeyId,
    }),
    grants: (wrappingKey) => [StackitBindings.grantOn(wrappingKey, options.access)],
  });

/** A bound key's identifiers, read when a call runs. */
export interface KeyIdentifiers {
  readonly projectId: Effect.Effect<string>;
  readonly regionId: Effect.Effect<string>;
  readonly keyRingId: Effect.Effect<string>;
  readonly keyId: Effect.Effect<string>;
}

/**
 * Build a binding whose client does more than inject identifiers: one grant, then
 * the client for the bound key.
 */
export const makeKeyClientHttpBinding = <Client>(options: {
  /** Fully-qualified binding tag, e.g. `Stackit.KMS.Encrypt`. */
  tag: string;
  /** What the client needs on the project holding the key. */
  access: StackitBindings.Access;
  /** Build the client; resolved when the layer is built. */
  makeClient: Effect.Effect<(key: KeyIdentifiers) => Client>;
}) =>
  Effect.gen(function* () {
    const bind = yield* StackitBindings.Bind;
    const makeClient = yield* options.makeClient;
    return Effect.fn(function* (key: Key) {
      const projectId = yield* key.projectId;
      const regionId = yield* key.region;
      const keyRingId = yield* key.keyRingId;
      const keyId = yield* key.keyId;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`${options.tag}(${key})`({
          grants: [StackitBindings.grantOn(key, options.access)],
        });
      }
      return makeClient({ projectId, regionId, keyRingId, keyId });
    });
  });

/** The identifiers of a bound key, as request fields. */
const keyRequest = Effect.fnUntraced(function* (key: KeyIdentifiers) {
  const projectId = yield* key.projectId;
  const regionId = yield* key.regionId;
  const keyRingId = yield* key.keyRingId;
  const keyId = yield* key.keyId;
  return { projectId, regionId, keyRingId, keyId };
});

type KeyRequest<I> = Omit<I, "projectId" | "regionId" | "keyRingId" | "keyId">;

/** Inject the key's identifiers into every request of an operation. */
const onKey =
  (key: KeyIdentifiers) =>
  <I extends { projectId: string; regionId: string; keyRingId: string; keyId: string }, A, E>(
    run: (input: I) => Effect.Effect<A, E>,
  ) =>
    Effect.fnUntraced(function* (request?: KeyRequest<I>) {
      const identifiers = yield* keyRequest(key);
      // The compiler can't prove `Omit<I, K>` plus the `K` fields is `I`.
      return yield* run({ ...request, ...identifiers } as unknown as I);
    });

/** Base64 for the wire. A `Redacted` input is only unwrapped here. */
const encodeBytes = (bytes: SecretBytes): string =>
  Base64.encode(Redacted.isRedacted(bytes) ? Redacted.value(bytes) : bytes);

/** Bytes from the wire. The error never carries the payload. */
const decodeBytes = (
  operation: string,
  data: string,
): Effect.Effect<Uint8Array, InvalidKmsPayload> => {
  const decoded = Base64.decode(data);
  return Result.isSuccess(decoded)
    ? Effect.succeed(decoded.success)
    : Effect.fail(
        new InvalidKmsPayload({
          operation,
          message: `STACKIT KMS ${operation} returned a payload that isn't valid base64.`,
        }),
      );
};

/**
 * Resolve a version selector: a number passes through, and `"latest"` is looked
 * up per call, so a rotation takes effect at once.
 */
const makeVersionResolver = Effect.gen(function* () {
  const listVersions = yield* StackitBindings.withCredentials(kms.listVersions);
  return Effect.fnUntraced(function* (
    identifiers: { projectId: string; regionId: string; keyRingId: string; keyId: string },
    selector: KeyVersionSelector,
  ) {
    if (selector !== "latest") return selector;
    const { versions } = yield* listVersions(identifiers);
    const latest = latestActiveVersion(versions);
    if (latest === undefined) {
      return yield* new NoActiveKeyVersion({
        keyId: identifiers.keyId,
        message: `STACKIT KMS key ${identifiers.keyId} has no active version.`,
      });
    }
    return latest;
  });
});

/** Build the {@link EncryptClient} for a key. */
export const makeEncryptClient = Effect.gen(function* () {
  const encrypt = yield* StackitBindings.withCredentials(kms.encrypt);
  const resolveVersion = yield* makeVersionResolver;
  return (key: KeyIdentifiers): EncryptClient =>
    Effect.fn("Stackit.KMS.Encrypt")(function* (request: EncryptRequest) {
      const identifiers = yield* keyRequest(key);
      const version = yield* resolveVersion(identifiers, request.version ?? "latest");
      const { data } = yield* encrypt({
        ...identifiers,
        versionNumber: version,
        data: Redacted.make(encodeBytes(request.plaintext)),
      });
      const ciphertext = yield* decodeBytes("Encrypt", data);
      return { ciphertext, version };
    });
});

/** Build the {@link DecryptClient} for a key. */
export const makeDecryptClient = Effect.gen(function* () {
  const decrypt = yield* StackitBindings.withCredentials(kms.decrypt);
  const resolveVersion = yield* makeVersionResolver;
  return (key: KeyIdentifiers): DecryptClient =>
    Effect.fn("Stackit.KMS.Decrypt")(function* (request: DecryptRequest) {
      const identifiers = yield* keyRequest(key);
      const version = yield* resolveVersion(identifiers, request.version);
      const { data } = yield* decrypt({
        ...identifiers,
        versionNumber: version,
        data: encodeBytes(request.ciphertext),
      });
      const plaintext = yield* decodeBytes(
        "Decrypt",
        Redacted.isRedacted(data) ? Redacted.value(data) : data,
      );
      return { plaintext: Redacted.make(plaintext), version };
    });
});

/** Build the {@link SignClient} for a key. */
export const makeSignClient = Effect.gen(function* () {
  const sign = yield* StackitBindings.withCredentials(kms.sign);
  const resolveVersion = yield* makeVersionResolver;
  return (key: KeyIdentifiers): SignClient =>
    Effect.fn("Stackit.KMS.Sign")(function* (request: SignRequest) {
      const identifiers = yield* keyRequest(key);
      const version = yield* resolveVersion(identifiers, request.version ?? "latest");
      const { signature } = yield* sign({
        ...identifiers,
        versionNumber: version,
        data: encodeBytes(request.data),
      });
      const bytes = yield* decodeBytes("Sign", signature);
      return { signature: bytes, version };
    });
});

/** Build the {@link VerifyClient} for a key. */
export const makeVerifyClient = Effect.gen(function* () {
  const verify = yield* StackitBindings.withCredentials(kms.verify);
  const resolveVersion = yield* makeVersionResolver;
  return (key: KeyIdentifiers): VerifyClient =>
    Effect.fn("Stackit.KMS.Verify")(function* (request: VerifyRequest) {
      const identifiers = yield* keyRequest(key);
      const version = yield* resolveVersion(identifiers, request.version);
      const { valid } = yield* verify({
        ...identifiers,
        versionNumber: version,
        data: encodeBytes(request.data),
        signature: Base64.encode(request.signature),
      });
      return { valid, version };
    });
});

/** Build the {@link ImportKeyClient} for a key. */
export const makeImportKeyClient = Effect.gen(function* () {
  const importKey = yield* StackitBindings.withCredentials(kms.importKey);
  return (key: KeyIdentifiers): ImportKeyClient =>
    Effect.fn("Stackit.KMS.ImportKey")(function* (request: ImportKeyRequest) {
      const identifiers = yield* keyRequest(key);
      return yield* importKey({
        ...identifiers,
        wrappingKeyId: request.wrappingKeyId,
        wrappedKey: Redacted.make(encodeBytes(request.wrappedKey)),
      });
    });
});

/** Build the read client for a key. */
export const makeReadKeyClient = Effect.gen(function* () {
  const getKey = yield* StackitBindings.withCredentials(kms.getKey);
  const getVersion = yield* StackitBindings.withCredentials(kms.getVersion);
  const listVersions = yield* StackitBindings.withCredentials(kms.listVersions);
  return (key: KeyIdentifiers): ReadKeyClient => {
    const on = onKey(key);
    return {
      getKey: on(getKey),
      getVersion: on(getVersion),
      listVersions: on(listVersions),
    };
  };
});

/** Build the write client for a key. */
export const makeWriteKeyClient = Effect.gen(function* () {
  const rotateKey = yield* StackitBindings.withCredentials(kms.rotateKey);
  const enableVersion = yield* StackitBindings.withCredentials(kms.enableVersion);
  const disableVersion = yield* StackitBindings.withCredentials(kms.disableVersion);
  const destroyVersion = yield* StackitBindings.withCredentials(kms.destroyVersion);
  const restoreVersion = yield* StackitBindings.withCredentials(kms.restoreVersion);
  const makeImportKey = yield* makeImportKeyClient;
  return (key: KeyIdentifiers): WriteKeyClient => {
    const on = onKey(key);
    return {
      rotateKey: on(rotateKey),
      enableVersion: on(enableVersion),
      disableVersion: on(disableVersion),
      destroyVersion: on(destroyVersion),
      restoreVersion: on(restoreVersion),
      importKey: makeImportKey(key),
    };
  };
});

/** Build the client with every read and write operation on a key. */
export const makeReadWriteKeyClient = Effect.gen(function* () {
  const makeRead = yield* makeReadKeyClient;
  const makeWrite = yield* makeWriteKeyClient;
  return (key: KeyIdentifiers): ReadWriteKeyClient => ({
    ...makeRead(key),
    ...makeWrite(key),
  });
});
