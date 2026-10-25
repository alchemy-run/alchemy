import * as Layer from "effect/Layer";
import { BuiltInRole } from "../Authorization/RoleAssignment.ts";
import { makeBlobContainerBinding } from "./BlobContainerHttp.ts";
import { BlobContainerReadWrite } from "./BlobContainerReadWrite.ts";

/**
 * Implementation of {@link BlobContainerReadWrite} over the distilled
 * `storage-blob` data plane. Assigns **Storage Blob Data Contributor** on
 * the container.
 *
 * @layer
 * @provides Azure.Storage.BlobContainerReadWrite
 */
export const BlobContainerReadWriteHttp = Layer.effect(
  BlobContainerReadWrite,
  makeBlobContainerBinding({
    tag: "Azure.Storage.BlobContainerReadWrite",
    role: BuiltInRole.StorageBlobDataContributor,
    makeClient: (helpers, address) => ({
      ...helpers.makeRead(address),
      ...helpers.makeWrite(address),
    }),
  }),
);
