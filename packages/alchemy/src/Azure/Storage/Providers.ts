import * as Layer from "effect/Layer";
import { BlobContainer, BlobContainerProvider } from "./BlobContainer.ts";
import { StorageAccount, StorageAccountProvider } from "./StorageAccount.ts";

export const resources = [BlobContainer, StorageAccount];
export const layers = () =>
  Layer.mergeAll(BlobContainerProvider(), StorageAccountProvider());
