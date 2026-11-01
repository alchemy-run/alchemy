# STACKIT Secrets Manager and KMS

Encryption as a service on a `Stackit.Functions.Function`. Callers send plaintext and get back KMS ciphertext, and the reverse, without holding key material. Every route needs an API key the function reads from Secrets Manager.

```sh
curl -X POST "$URL/encrypt" -H "x-api-key: $API_KEY" -d '{"plaintext":"hello"}'
# {"ciphertext":"Q2lw…","version":1}
curl -X POST "$URL/decrypt" -H "x-api-key: $API_KEY" -d '{"ciphertext":"Q2lw…","version":1}'
# {"plaintext":"hello"}
```

Requests without the right `x-api-key` get `401`.

Alchemy generates the key on the first deploy and keeps it in state, so a deploy doesn't print it. Read it with `pnpm alchemy state read StackitSecretsExample/live_$USER/ApiKeyValue --profile <name>`. It's the value under `__redacted__`.

## Architecture

- [`src/resources.ts`](./src/resources.ts): a Secrets Manager instance, a generated API key written to it as a secret, a KMS key ring, and a symmetric key.
- [`src/Api.ts`](./src/Api.ts): the function.
- [`src/registry.ts`](./src/registry.ts): the registry project the image goes to.

## Bindings

| Host | Binding                                                   | Access                                                                                                                                                                                  |
| ---- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Api  | `Stackit.SecretsManager.ReadSecret(Vault)` + `ReadSecretHttp` | A read-only AppRole for this function and instance. It reads every secret in the instance, because STACKIT can't limit an AppRole to a path. Use one instance per trust boundary. |
| Api  | `Stackit.KMS.Encrypt(DataKey)` + `EncryptHttp`            | A service account key for this function. `kms.keyring.get` on the project, through a custom role.                                                                                       |
| Api  | `Stackit.KMS.Decrypt(DataKey)` + `DecryptHttp`            | The same account. `kms.keyring.get` also allows sign, verify and every read, on every key in the project.                                                                               |

The AppRole's secret id and the service account key reach the function as plain revision variables, readable by anyone who can call `GetRevision`.

The secret's value is also in Alchemy's state, unencrypted under a `__redacted__` marker, as every `Redacted` prop is. Use a state store you would trust with it.

## The ACL

Everything that reads or writes secrets has to be inside the instance's `acls`, or Vault answers `403 permission denied`: the machine running the deploy, and each host with a binding. A Function has no fixed egress address, so this example sets `acls: ["0.0.0.0/0"]`. Use a narrower one once your hosts have known addresses.

## Prerequisites

- A STACKIT profile: run `alchemy profile edit --add Stackit`. See [STACKIT setup](https://alchemy.run/stackit/setup). Your deployer needs `iam.role.add` for the custom role.
- Docker running on your machine.
- A registry login: `HARBOR_USERNAME` and `HARBOR_CLI_SECRET`, your Harbor user and CLI secret from your user profile in the registry UI.
- Access to STACKIT Functions, an alpha API in `eu01` only.

## Cost

About **EUR 0.01 per hour**:

- Secrets Manager: EUR 0.000035-0.000139 per secret version per hour, with a minimum of 50 secrets per service, so about EUR 0.007 per hour. This is from a snapshot of STACKIT's price page.
- KMS: EUR 0.0021 per key version per hour (price list v1.0.44). No source says whether a key pending deletion keeps billing until its `deletionDate`. If it does, each destroyed key costs about EUR 0.05 per day of its grace period, so check this on your first destroy.
- Functions: STACKIT's price list has no SKU; the product page says you pay for what runs.
- Container Registry is free during its beta.

## Deploy

From the repository root:

```sh
pnpm install
cd examples/stackit-secrets
HARBOR_USERNAME=... HARBOR_CLI_SECRET=... pnpm run deploy --profile <name>
```

## Test

```sh
HARBOR_USERNAME=... HARBOR_CLI_SECRET=... ALCHEMY_PROFILE=<name> bun test test/integ.test.ts
```

The test deploys the stack, checks the `401`s, round-trips a value through both routes, reads the instance and the key through the API, then destroys the stack and checks that the instance is gone and the key is scheduled for deletion.

## What to check on your first deploy

This example has not run against STACKIT yet. Check:

- A new instance is ready within 2 minutes. Alchemy waits for `creationFinishedDate`.
- A just-created AppRole secret id logs in at once. A deploy doesn't retry the login, because repeated failures lock the role out.
- A `write: true` AppRole may write `custom_metadata`, where a secret keeps its ownership markers.
- What a destroyed key looks like while it is pending deletion.
- The function answers on `8080`, the port Alchemy assumes, and its URL takes requests with no STACKIT token.

## Destroy

```sh
HARBOR_USERNAME=... HARBOR_CLI_SECRET=... pnpm destroy --profile <name>
```

That removes what `pnpm run deploy` made. The test deploys to its own stage, `test_$USER`, and destroys it when it ends. If a run stops first, clean up with:

```sh
HARBOR_USERNAME=... HARBOR_CLI_SECRET=... pnpm destroy --profile <name> --stage test_$USER
```

Deleting the secret removes every version, and STACKIT can't restore it. KMS keeps a destroyed key until its deletion date.
