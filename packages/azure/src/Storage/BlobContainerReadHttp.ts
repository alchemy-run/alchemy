import * as Layer from "effect/Layer";
import { BuiltInRole } from "../Authorization/RoleAssignment.ts";
import { makeBlobContainerBinding } from "./BlobContainerHttp.ts";
import { BlobContainerRead } from "./BlobContainerRead.ts";

/**
 * Implementation of {@link BlobContainerRead} over the distilled
 * `storage-blob` data plane. Assigns **Storage Blob Data Reader** on the
 * container.
 *
 * @layer
 * @provides Azure.Storage.BlobContainerRead
 */
export const BlobContainerReadHttp = Layer.effect(
  BlobContainerRead,
  makeBlobContainerBinding({
    tag: "Azure.Storage.BlobContainerRead",
    role: BuiltInRole.StorageBlobDataReader,
    makeClient: (helpers, address) => helpers.makeRead(address),
  }),
);
