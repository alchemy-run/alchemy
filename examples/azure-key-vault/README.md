# Key Vault keys and secrets on Azure Functions

Encryption and signing as a service. Callers send plaintext and get back
ciphertext (and the reverse), or send a message and get back a signature.
The app never holds key material: every operation runs inside Azure Key
Vault. Every route is gated by an API key that lives in Key Vault as a
secret, and the API can rotate it without a redeploy.

```sh
curl -X POST "$URL/encrypt" -H "x-api-key: $API_KEY" -d '{"plaintext":"hello"}'
# 200 {"ciphertext":"3f1c….Zm9v…"}
curl -X POST "$URL/decrypt" -H "x-api-key: $API_KEY" -d '{"ciphertext":"3f1c….Zm9v…"}'
# 200 {"plaintext":"hello"}

curl -X POST "$URL/sign" -H "x-api-key: $API_KEY" -d '{"message":"ship order 42"}'
# 200 {"kid":"https://….vault.azure.net/keys/…/9a1b…","alg":"ES256","signature":"…"}
curl "$URL/jwks" -H "x-api-key: $API_KEY"
# 200 {"keys":[{"kid":"…","kty":"EC","crv":"P-256","x":"…","y":"…","alg":"ES256","use":"sig"}]}

curl -X POST "$URL/rotate" -H "x-api-key: $API_KEY"
# 200 {"apiKey":"<new key>","version":"…"}  — the old key now gets 401
```

## Architecture

- [`Vault`](./src/resources.ts) — Key Vault, standard tier, Azure RBAC
  authorization, 7-day soft-delete retention.
- [`ApiKey`](./src/resources.ts) — secret. The stack writes the first
  version from [`InitialApiKey`](./src/resources.ts) (an `Alchemy.Random`,
  generated once and kept in state). `POST /rotate` writes new versions.
- [`DataKey`](./src/resources.ts) — RSA 2048 key for `encrypt` and
  `decrypt` (`RSA-OAEP-256`).
- [`SigningKey`](./src/resources.ts) — EC P-256 key for `sign` and
  `verify` (`ES256`).
- [`Api`](./src/Api.ts) — `Azure.Functions.Function` with a public URL.

| Route           | Body                           | Returns                     |
| --------------- | ------------------------------ | --------------------------- |
| `POST /encrypt` | `{ plaintext }`                | `{ ciphertext }`            |
| `POST /decrypt` | `{ ciphertext }`               | `{ plaintext }`             |
| `POST /sign`    | `{ message }`                  | `{ kid, alg, signature }`   |
| `POST /verify`  | `{ message, kid, signature }`  | `{ valid }`                 |
| `GET /jwks`     | —                              | the signing key's public JWK |
| `POST /rotate`  | —                              | `{ apiKey, version }`       |

Every route except `GET /` needs the latest `ApiKey` version in the
`x-api-key` header. A missing or wrong key gets `401`.

The ciphertext is `<key version>.<base64url>`. Decrypt needs the key
version that encrypted the data, so the version travels with it. RSA-OAEP
encrypts at most 190 bytes with a 2048-bit key; for larger data, encrypt it
locally with a random data key and wrap that key with
`Azure.KeyVault.WrapKey` (envelope encryption, not shown here).

## Bindings

The function runs as its system-assigned managed identity. Each binding
assigns roles on the one key or secret it binds, never on the vault.

| Binding                                                     | Role, on the key or secret                                     |
| ----------------------------------------------------------- | -------------------------------------------------------------- |
| `Azure.KeyVault.SecretReadWrite(ApiKey)` + `SecretReadWriteHttp` | Key Vault Secrets User + custom role (`setSecret`, `update`) |
| `Azure.KeyVault.Encrypt(DataKey)` + `EncryptHttp`           | custom role, `keys/encrypt/action` only                        |
| `Azure.KeyVault.Decrypt(DataKey)` + `DecryptHttp`           | custom role, `keys/decrypt/action` only                        |
| `Azure.KeyVault.Sign(SigningKey)` + `SignHttp`              | custom role, `keys/sign/action` only                           |
| `Azure.KeyVault.Verify(SigningKey)` + `VerifyHttp`          | custom role, `keys/verify/action` only                         |
| `Azure.KeyVault.KeyRead(SigningKey)` + `KeyReadHttp`        | custom roles, `keys/read` and `keyrotationpolicies/read`       |

The custom roles are `Azure.Authorization.RoleDefinition` resources, one
per data action, defined once per stack and destroyed with it. The deploying
service principal needs permission to create role definitions and role
assignments (for example **Owner** or **User Access Administrator** plus
**Contributor** on the subscription).

Role assignments can take a few minutes to take effect after the first
deploy. Until then the API answers `503` with the Key Vault error tag.

The API reads the latest `ApiKey` version on every request, so a rotation
takes effect at once. A busy API would cache it for a short time instead.

## Cost

A standard vault charges $0.03 per 10,000 operations on software keys and
secrets. The Flex Consumption app is billed per execution. One test run
costs about $0.01, so the test is not gated.

## Deploy

Set up an Azure service principal and profile first — see
[Azure setup](https://alchemy.run/azure/setup). From the repository root:

```sh
pnpm install
cd examples/azure-key-vault
pnpm deploy --profile <name>
```

The stack prints `url` and the first `apiKey`.

## Live test

```sh
ALCHEMY_PROFILE=<name> bun test test/integ.test.ts
```

The test deploys the stack. It checks that a request without the API key
gets `401`, encrypts and decrypts a message, and checks the ciphertext's key
version against the data key's current version in Azure Resource Manager.
It signs a message, verifies the signature offline with the published JWKS
and through `/verify`, and checks that a tampered message fails. Then it
rotates the API key, checks the secret's new version in Azure Resource
Manager, and checks that the old key gets `401`. At the end it destroys the
stack and checks that the vault is deleted and purged and the function app
is gone.

## Destroy

```sh
pnpm destroy --profile <name>
```
