import * as Layer from "effect/Layer";
import { AzureDataRole } from "../Binding.ts";
import {
  makeReadBlobContainerClient,
  makeWriteBlobContainerClient,
  makeBlobContainerHttpBinding,
} from "./BlobContainerHttp.ts";
import { BlobContainerReadWrite } from "./BlobContainerReadWrite.ts";

/**
 * HTTP implementation of {@link BlobContainerReadWrite}: Blob service REST calls
 * authenticated with the host's managed identity.
 *
 * @layer
 * @provides Azure.Storage.BlobContainerReadWrite
 */
export const BlobContainerReadWriteHttp = Layer.effect(
  BlobContainerReadWrite,
  makeBlobContainerHttpBinding({
    tag: "Azure.Storage.BlobContainerReadWrite",
    role: AzureDataRole.StorageBlobDataContributor,
    makeClient: (ctx) => ({
      ...makeReadBlobContainerClient(ctx),
      ...makeWriteBlobContainerClient(ctx),
    }),
  }),
);
