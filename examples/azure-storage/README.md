# Azure Storage Example

A resource group, a storage account, and a private blob container on
Azure, deployed with `Azure.providers()`.

- [`alchemy.run.ts`](./alchemy.run.ts) — `Azure.Resources.ResourceGroup`,
  `Azure.Storage.StorageAccount` (Standard_LRS, HTTPS-only, TLS 1.2), and
  `Azure.Storage.BlobContainer`.

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
