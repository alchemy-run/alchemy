<!-- Docs for the generated AWS.KMS bindings: one `## <Binding>` section each, the JSDoc body verbatim. -->

## Decrypt

Runtime binding for `kms:Decrypt`.

Bind this operation to a KMS {@link Key} (or the `alias/...` name of a
pre-existing key) inside a function runtime to get a callable that
automatically injects the `KeyId`. Passing the key explicitly (rather than
relying on the metadata KMS embeds in symmetric ciphertext) pins decryption
to the intended key, per AWS best practice.

The decrypted `Plaintext` in the response is wrapped in `Redacted` so it
never leaks into logs — unwrap with `Redacted.value(...)` at the point of
use.

### Decrypting Data
**Example:** Decrypt a Ciphertext
```typescript
import * as Redacted from "effect/Redacted";

const decrypt = yield* AWS.KMS.Decrypt(key);

const response = yield* decrypt({ CiphertextBlob: ciphertext });
const plaintext = Redacted.isRedacted(response.Plaintext)
  ? Redacted.value(response.Plaintext)
  : response.Plaintext; // Uint8Array
```

**Example:** Decrypt with an Encryption Context
```typescript
// Must match the context used at encryption time exactly, otherwise the
// call fails with a typed InvalidCiphertextException.
const response = yield* decrypt({
  CiphertextBlob: ciphertext,
  EncryptionContext: { tenant: "acme" },
});
```

### Pre-Existing Keys
**Example:** Bind by Alias Name
```typescript
const decrypt = yield* AWS.KMS.Decrypt("alias/app-key");
```

### Wiring
**Example:** Provide the Implementation on a Lambda Function
```typescript
// Provide the DecryptHttp layer on the Function's init Effect,
// merged with the other KMS layers the function binds.
export default CryptoFunction.make(
  { main: import.meta.url, functionUrl: true },
  Effect.gen(function* () {
    const key = yield* AWS.KMS.Key("AppKey");
    const encrypt = yield* AWS.KMS.Encrypt(key);
    const decrypt = yield* AWS.KMS.Decrypt(key);
    // ... use encrypt/decrypt in the fetch handler
    return { fetch: handler };
  }).pipe(
    Effect.provide(Layer.mergeAll(AWS.KMS.EncryptHttp, AWS.KMS.DecryptHttp)),
  ),
);
```

@binding

## DeriveSharedSecret

Runtime binding for `kms:DeriveSharedSecret`.

Bind this operation to a KEY_AGREEMENT KMS {@link Key} (or the `alias/...`
name of a pre-existing key) to get a callable that automatically injects
the `KeyId`. Runs ECDH between the bound key's private key (inside KMS)
and a peer's public key, returning the raw shared secret for use with a
key-derivation function.

The `SharedSecret` in the response is wrapped in `Redacted` so it never
leaks into logs — unwrap with `Redacted.value(...)` at the point of use.

### Key Agreement
**Example:** Derive a Shared Secret
```typescript
const deriveSharedSecret = yield* AWS.KMS.DeriveSharedSecret(agreementKey);

const { SharedSecret } = yield* deriveSharedSecret({
  KeyAgreementAlgorithm: "ECDH",
  PublicKey: peerPublicKeyDer, // DER-encoded SubjectPublicKeyInfo
});
```

@binding

## DescribeKey

Runtime binding for `kms:DescribeKey`.

Bind this operation to a KMS {@link Key} (or the `alias/...` name of a
pre-existing key) to get a callable that automatically injects the
`KeyId`. Useful at runtime to discover a key's state, spec, and supported
algorithms before choosing a cryptographic operation.

### Key Metadata
**Example:** Inspect the Bound Key
```typescript
const describeKey = yield* AWS.KMS.DescribeKey(key);

const { KeyMetadata } = yield* describeKey();
// KeyMetadata.KeyState, KeyMetadata.KeySpec, ...
```

@binding

## Encrypt

Runtime binding for `kms:Encrypt`.

Bind this operation to a KMS {@link Key} (or the `alias/...` name of a
pre-existing key) inside a function runtime to get a callable that
automatically injects the `KeyId`. Payloads are raw `Uint8Array`s — the
distilled client handles base64 wire encoding transparently.

IAM is scoped to least privilege: the exact key ARN for a `Key` resource,
or the `kms:RequestAlias` condition for an alias name.

### Encrypting Data
**Example:** Encrypt a Payload
```typescript
const encrypt = yield* AWS.KMS.Encrypt(key);

const response = yield* encrypt({
  Plaintext: new TextEncoder().encode("attack at dawn"),
});
// response.CiphertextBlob is a Uint8Array
```

**Example:** Encrypt with an Encryption Context
```typescript
const response = yield* encrypt({
  Plaintext: payload,
  EncryptionContext: { tenant: "acme" },
});
```

### Pre-Existing Keys
**Example:** Bind by Alias Name
```typescript
// Uses a key managed outside this stack; IAM is scoped via kms:RequestAlias.
const encrypt = yield* AWS.KMS.Encrypt("alias/app-key");
```

### Wiring
**Example:** Provide the Implementation on a Lambda Function
```typescript
// Bind in the init phase, call in the handler, and provide the
// EncryptHttp layer on the Function's init Effect (merge the other
// KMS layers with Layer.mergeAll when using several bindings).
export default CryptoFunction.make(
  { main: import.meta.url, functionUrl: true },
  Effect.gen(function* () {
    const key = yield* AWS.KMS.Key("AppKey");
    const encrypt = yield* AWS.KMS.Encrypt(key);
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const body = yield* request.text;
        const { CiphertextBlob } = yield* encrypt({
          Plaintext: new TextEncoder().encode(body),
        });
        return HttpServerResponse.json({
          ciphertext: Buffer.from(CiphertextBlob!).toString("base64"),
        });
      }),
    };
  }).pipe(Effect.provide(AWS.KMS.EncryptHttp)),
);
```

@binding

## GenerateDataKey

Runtime binding for `kms:GenerateDataKey`.

Bind this operation to a KMS {@link Key} (or the `alias/...` name of a
pre-existing key) inside a function runtime to get a callable that
automatically injects the `KeyId`. Returns a fresh symmetric data key as
both plaintext (for immediate envelope encryption outside KMS) and a
ciphertext blob encrypted under the bound key (for storage alongside the
data). Decrypt the stored blob later with the `Decrypt` binding.

The `Plaintext` data key in the response is wrapped in `Redacted` so it
never leaks into logs — unwrap with `Redacted.value(...)` at the point of
use and discard it as soon as the envelope operation is done.

### Envelope Encryption
**Example:** Generate a Data Key
```typescript
import * as Redacted from "effect/Redacted";

const generateDataKey = yield* AWS.KMS.GenerateDataKey(key);

const response = yield* generateDataKey({ KeySpec: "AES_256" });
const dataKey = Redacted.isRedacted(response.Plaintext)
  ? Redacted.value(response.Plaintext)
  : response.Plaintext; // 32-byte Uint8Array — use, then discard
const stored = response.CiphertextBlob; // persist next to the data
```

**Example:** Recover the Data Key Later
```typescript
const decrypt = yield* AWS.KMS.Decrypt(key);
const recovered = yield* decrypt({ CiphertextBlob: stored });
```

### Pre-Existing Keys
**Example:** Bind by Alias Name
```typescript
const generateDataKey = yield* AWS.KMS.GenerateDataKey("alias/app-key");
```

### Wiring
**Example:** Provide the Implementation on a Lambda Function
```typescript
// Envelope encryption pairs GenerateDataKey with Decrypt — provide
// both HTTP layers on the Function's init Effect.
export default EnvelopeFunction.make(
  { main: import.meta.url, functionUrl: true },
  Effect.gen(function* () {
    const key = yield* AWS.KMS.Key("DataKey");
    const generateDataKey = yield* AWS.KMS.GenerateDataKey(key);
    const decrypt = yield* AWS.KMS.Decrypt(key);
    // ... generate a data key, encrypt locally, store the CiphertextBlob
    return { fetch: handler };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(AWS.KMS.GenerateDataKeyHttp, AWS.KMS.DecryptHttp),
    ),
  ),
);
```

@binding

## GenerateDataKeyPair

Runtime binding for `kms:GenerateDataKeyPair`.

Bind this operation to a symmetric-encryption KMS {@link Key} (or the
`alias/...` name of a pre-existing key) to get a callable that
automatically injects the `KeyId`. Returns a fresh asymmetric key pair:
the public key and plaintext private key for immediate local use, plus
the private key encrypted under the bound symmetric key for storage.

The `PrivateKeyPlaintext` in the response is wrapped in `Redacted` so it
never leaks into logs — unwrap with `Redacted.value(...)` at the point of
use and discard it as soon as the local operation is done.

### Data Key Pairs
**Example:** Generate an RSA Key Pair
```typescript
const generateDataKeyPair = yield* AWS.KMS.GenerateDataKeyPair(key);

const pair = yield* generateDataKeyPair({ KeyPairSpec: "RSA_2048" });
// pair.PublicKey            — DER-encoded public key
// pair.PrivateKeyPlaintext  — Redacted; use locally then discard
// pair.PrivateKeyCiphertextBlob — persist; recover via the Decrypt binding
```

@binding

## GenerateDataKeyPairWithoutPlaintext

Runtime binding for `kms:GenerateDataKeyPairWithoutPlaintext`.

Bind this operation to a symmetric-encryption KMS {@link Key} (or the
`alias/...` name of a pre-existing key) to get a callable that
automatically injects the `KeyId`. Returns the public key and the private
key encrypted under the bound symmetric key — the plaintext private key
never exists in this process; decrypt the blob later with the `Decrypt`
binding where it is actually needed.

### Data Key Pairs
**Example:** Provision a Key Pair Without the Private Key
```typescript
const generatePair = yield* AWS.KMS.GenerateDataKeyPairWithoutPlaintext(key);

const pair = yield* generatePair({ KeyPairSpec: "ECC_NIST_P256" });
// pair.PublicKey                — hand out for encryption/verification
// pair.PrivateKeyCiphertextBlob — persist for the consuming service
```

@binding

## GenerateDataKeyWithoutPlaintext

Runtime binding for `kms:GenerateDataKeyWithoutPlaintext`.

Bind this operation to a KMS {@link Key} (or the `alias/...` name of a
pre-existing key) to get a callable that automatically injects the
`KeyId`. Returns ONLY the encrypted copy of a fresh data key — use it in
the component that provisions envelope keys but must never see key
material; the consumer decrypts the blob later with the `Decrypt` binding.

### Envelope Encryption
**Example:** Provision a Data Key Without Seeing It
```typescript
const generateDataKeyWithoutPlaintext =
  yield* AWS.KMS.GenerateDataKeyWithoutPlaintext(key);

const { CiphertextBlob } = yield* generateDataKeyWithoutPlaintext({
  KeySpec: "AES_256",
});
// store CiphertextBlob next to the data; no plaintext ever existed here
```

### Pre-Existing Keys
**Example:** Bind by Alias Name
```typescript
const generate = yield* AWS.KMS.GenerateDataKeyWithoutPlaintext("alias/app-key");
```

@binding

## GenerateMac

Runtime binding for `kms:GenerateMac`.

Bind this operation to an HMAC KMS {@link Key} (or the `alias/...` name of
a pre-existing key) to get a callable that automatically injects the
`KeyId`. Computes an HMAC inside KMS — the MAC key never leaves the HSM,
so any party with `kms:VerifyMac` can validate tokens without ever
holding the shared secret.

### Message Authentication
**Example:** Compute an HMAC
```typescript
const generateMac = yield* AWS.KMS.GenerateMac(hmacKey);

const { Mac } = yield* generateMac({
  Message: new TextEncoder().encode("session-token-payload"),
  MacAlgorithm: "HMAC_SHA_256",
});
```

@binding

## GenerateRandom

Runtime binding for `kms:GenerateRandom`.

Not scoped to a key — KMS produces cryptographically secure random bytes
from its FIPS 140-3 validated HSMs. The binding grants `kms:GenerateRandom`
on `*` (the action does not support resource-level scoping).

The random `Plaintext` in the response is wrapped in `Redacted` so it
never leaks into logs — unwrap with `Redacted.value(...)` at the point of
use.

### Random Bytes
**Example:** Generate 32 Random Bytes
```typescript
import * as Redacted from "effect/Redacted";

const generateRandom = yield* AWS.KMS.GenerateRandom();

const { Plaintext } = yield* generateRandom({ NumberOfBytes: 32 });
const bytes = Redacted.isRedacted(Plaintext)
  ? Redacted.value(Plaintext)
  : Plaintext;
```

@binding

## GetPublicKey

Runtime binding for `kms:GetPublicKey`.

Bind this operation to an asymmetric KMS {@link Key} (or the `alias/...`
name of a pre-existing key) to get a callable that automatically injects
the `KeyId`. Returns the DER-encoded public key so callers can verify
signatures or encrypt locally without a KMS round-trip per operation.

### Signing
**Example:** Download the Public Key
```typescript
const getPublicKey = yield* AWS.KMS.GetPublicKey(signingKey);

const { PublicKey, SigningAlgorithms } = yield* getPublicKey({});
// PublicKey is the DER-encoded SubjectPublicKeyInfo
```

@binding

## Sign

Runtime binding for `kms:Sign`.

Bind this operation to an asymmetric SIGN_VERIFY KMS {@link Key} (or the
`alias/...` name of a pre-existing key) to get a callable that
automatically injects the `KeyId`. The private key never leaves KMS — the
signature is produced inside the HSM.

### Signing
**Example:** Sign a Message
```typescript
const sign = yield* AWS.KMS.Sign(signingKey);

const { Signature } = yield* sign({
  Message: new TextEncoder().encode("release-manifest-v1"),
  SigningAlgorithm: "ECDSA_SHA_256",
});
```

**Example:** Sign a Pre-Computed Digest
```typescript
// For payloads larger than 4096 bytes, hash locally and sign the digest.
const { Signature } = yield* sign({
  Message: sha256Digest,
  MessageType: "DIGEST",
  SigningAlgorithm: "ECDSA_SHA_256",
});
```

@binding

## Verify

Runtime binding for `kms:Verify`.

Bind this operation to an asymmetric SIGN_VERIFY KMS {@link Key} (or the
`alias/...` name of a pre-existing key) to get a callable that
automatically injects the `KeyId`. Verifying inside KMS (rather than with
a downloaded public key) means the result is authorized and auditable by
IAM/CloudTrail.

A mismatched signature surfaces as the typed
`KMSInvalidSignatureException` — a valid signature returns
`SignatureValid: true`.

### Signing
**Example:** Verify a Signature
```typescript
const verify = yield* AWS.KMS.Verify(signingKey);

const { SignatureValid } = yield* verify({
  Message: new TextEncoder().encode("release-manifest-v1"),
  Signature: signature,
  SigningAlgorithm: "ECDSA_SHA_256",
});
```

**Example:** Treat a Bad Signature as a Value
```typescript
const valid = yield* verify({ Message, Signature, SigningAlgorithm }).pipe(
  Effect.map(() => true),
  Effect.catchTag("KMSInvalidSignatureException", () =>
    Effect.succeed(false),
  ),
);
```

@binding

## VerifyMac

Runtime binding for `kms:VerifyMac`.

Bind this operation to an HMAC KMS {@link Key} (or the `alias/...` name of
a pre-existing key) to get a callable that automatically injects the
`KeyId`. A mismatched MAC surfaces as the typed
`KMSInvalidMacException` — a valid MAC returns `MacValid: true`.

### Message Authentication
**Example:** Verify an HMAC
```typescript
const verifyMac = yield* AWS.KMS.VerifyMac(hmacKey);

const { MacValid } = yield* verifyMac({
  Message: new TextEncoder().encode("session-token-payload"),
  Mac: mac,
  MacAlgorithm: "HMAC_SHA_256",
});
```

**Example:** Treat a Bad MAC as a Value
```typescript
const valid = yield* verifyMac({ Message, Mac, MacAlgorithm }).pipe(
  Effect.map(() => true),
  Effect.catchTag("KMSInvalidMacException", () => Effect.succeed(false)),
);
```

@binding
