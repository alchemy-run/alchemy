# Azure Storage Example

A storage account and a private blob container on Azure, deployed with
`Azure.providers()`. Both go into the stack's resource group,
`AzureStorageExample-<stage>`, which Alchemy creates on deploy and deletes
on destroy.

- [`alchemy.run.ts`](./alchemy.run.ts) — `Azure.Storage.StorageAccount`
  (Standard_LRS, HTTPS-only, TLS 1.2) and `Azure.Storage.BlobContainer`.

Set up an Azure service principal and profile first — see
[Azure setup](https://alchemy.run/azure/setup).

## Commands

```sh
bun install
bun run --filter azure-storage-example deploy
bun run --filter azure-storage-example destroy
```

The resources default to the profile's location (then `eastus`). Deploying
takes about a minute; the storage account costs a few cents per month while
it holds no data.

## Live test

```sh
ALCHEMY_PROFILE=<name> bun test test/integ.test.ts
```

The test deploys the stack, reads the account and container back through
the Azure API, then destroys the stack and checks the account is gone.
