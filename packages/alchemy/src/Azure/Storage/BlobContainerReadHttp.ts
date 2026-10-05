import * as Layer from "effect/Layer";
import { AzureDataRole } from "../Binding.ts";
import {
  makeReadBlobContainerClient,
  makeBlobContainerHttpBinding,
} from "./BlobContainerHttp.ts";
import { BlobContainerRead } from "./BlobContainerRead.ts";

/**
 * HTTP implementation of {@link BlobContainerRead}: Blob service REST calls
 * authenticated with the host's managed identity.
 *
 * @layer
 * @provides Azure.Storage.BlobContainerRead
 */
export const BlobContainerReadHttp = Layer.effect(
  BlobContainerRead,
  makeBlobContainerHttpBinding({
    tag: "Azure.Storage.BlobContainerRead",
    role: AzureDataRole.StorageBlobDataReader,
    makeClient: makeReadBlobContainerClient,
  }),
);
