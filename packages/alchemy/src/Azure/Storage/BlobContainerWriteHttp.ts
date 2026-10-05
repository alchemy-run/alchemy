import * as Layer from "effect/Layer";
import { AzureDataRole } from "../Binding.ts";
import {
  makeWriteBlobContainerClient,
  makeBlobContainerHttpBinding,
} from "./BlobContainerHttp.ts";
import { BlobContainerWrite } from "./BlobContainerWrite.ts";

/**
 * HTTP implementation of {@link BlobContainerWrite}: Blob service REST calls
 * authenticated with the host's managed identity.
 *
 * @layer
 * @provides Azure.Storage.BlobContainerWrite
 */
export const BlobContainerWriteHttp = Layer.effect(
  BlobContainerWrite,
  makeBlobContainerHttpBinding({
    tag: "Azure.Storage.BlobContainerWrite",
    role: AzureDataRole.StorageBlobDataContributor,
    makeClient: makeWriteBlobContainerClient,
  }),
);
