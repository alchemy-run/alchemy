import * as Layer from "effect/Layer";
import { BuiltInRole } from "../Authorization/RoleAssignment.ts";
import { makeBlobContainerBinding } from "./BlobContainerHttp.ts";
import { BlobContainerWrite } from "./BlobContainerWrite.ts";

/**
 * Implementation of {@link BlobContainerWrite} over the distilled
 * `storage-blob` data plane. Assigns **Storage Blob Data Contributor** on
 * the container (Azure has no write-only blob role).
 *
 * @layer
 * @provides Azure.Storage.BlobContainerWrite
 */
export const BlobContainerWriteHttp = Layer.effect(
  BlobContainerWrite,
  makeBlobContainerBinding({
    tag: "Azure.Storage.BlobContainerWrite",
    role: BuiltInRole.StorageBlobDataContributor,
    makeClient: (helpers, address) => helpers.makeWrite(address),
  }),
);
