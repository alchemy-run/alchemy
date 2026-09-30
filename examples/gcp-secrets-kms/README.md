# gcp-secrets-kms

Encryption as a service on Cloud Run. Callers send plaintext and get back
Cloud KMS ciphertext (and the reverse) without ever holding key material.
Both routes are gated by an API key stored in Secret Manager.

| Route          | Body             | Returns          |
| -------------- | ---------------- | ---------------- |
| `POST /encrypt` | `{ plaintext }`  | `{ ciphertext }` |
| `POST /decrypt` | `{ ciphertext }` | `{ plaintext }`  |

Requests without the right `x-api-key` header get `401`. Until a secret
version exists the API answers `503` instead of failing open.

## Architecture

- `GCP.KMS.KeyRing` `Keys` — container for the key, in `us-central1`.
- `GCP.KMS.CryptoKey` `DataKey` — symmetric `ENCRYPT_DECRYPT` key.
- `GCP.SecretManager.Secret` `ApiKey` — the API key callers must present.
- `GCP.Function` `Api` — public Cloud Run service (`invokerIamDisabled: true`)
  serving both routes.

## Bindings

Each binding grants one role to the service's runtime service account, on
the single resource it was bound to:

| Binding                          | Role                                  | On        |
| -------------------------------- | ------------------------------------- | --------- |
| `GCP.KMS.Encrypt(dataKey)`       | `roles/cloudkms.cryptoKeyEncrypter`   | `DataKey` |
| `GCP.KMS.Decrypt(dataKey)`       | `roles/cloudkms.cryptoKeyDecrypter`   | `DataKey` |
| `GCP.SecretManager.ReadSecret(apiKey)` | `roles/secretmanager.secretAccessor` | `ApiKey` |

The service reads the `latest` secret version on every request (and
compares it in constant time), so rotating the key is a new secret
version — no redeploy.

## Deploy

```sh
pnpm deploy
```

Then add the API key as a secret version (the stack prints `secretId`):

```sh
printf 'my-key' | gcloud secrets versions add "$SECRET_ID" --data-file=-
```

```sh
curl -X POST "$URL/encrypt" -H 'x-api-key: my-key' \
  -H 'content-type: application/json' -d '{"plaintext":"hello"}'
```

## Test

```sh
pnpm test
```

Deploys the stack, seeds the secret, checks the `401`s, round-trips a
payload through `/encrypt` and `/decrypt`, decrypts the ciphertext directly
with the KMS API, then destroys the stack and checks that the key was
released and the secret, service, and image repository are gone. Needs GCP credentials
(`GOOGLE_PROJECT_ID` + `GOOGLE_APPLICATION_CREDENTIALS`) and Docker (the
service image is built locally).

## Destroy

```sh
pnpm destroy
```

Cloud KMS never deletes key rings, and keeps keys for at least 24h after
their versions are destroyed. `destroy` therefore *releases* `DataKey`:
every version is scheduled for destruction and its ownership labels are
replaced with `alchemy-released`. A deploy that asks for the same key id
(set `cryptoKeyId` to pin one) reclaims it and mints a fresh primary
version. Either way, ciphertext from before the destroy can no longer be
decrypted. The key ring is only removed from state; empty rings are free.
The Cloud Run service, its image repository, its service account, and the
secret are deleted.
