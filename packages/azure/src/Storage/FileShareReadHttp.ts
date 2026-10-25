import * as Layer from "effect/Layer";
import { makeFileShareBinding } from "./FileShareHttp.ts";
import { FileShareRead } from "./FileShareRead.ts";

/**
 * Implementation of {@link FileShareRead} over the distilled
 * `storage-file` data plane. Assigns **Storage File Data Privileged
 * Reader** on the share.
 *
 * @layer
 * @provides Azure.Storage.FileShareRead
 */
export const FileShareReadHttp = Layer.effect(
  FileShareRead,
  makeFileShareBinding({
    tag: "Azure.Storage.FileShareRead",
    access: ["read"],
    makeClient: (helpers, address) => helpers.makeRead(address),
  }),
);
