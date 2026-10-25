import * as Layer from "effect/Layer";
import {
  DataLakeAccess,
  makeRenamePathClient,
  makeFileSystemBinding,
} from "./DataLakeBindingHttp.ts";
import { RenamePath } from "./RenamePath.ts";

/**
 * Implementation of {@link RenamePath} over the distilled `storage-datalake`
 * data plane. Assigns a custom role with exactly `blobs/write` and `blobs/move/action` on the filesystem only.
 *
 * @layer
 * @provides Azure.Storage.RenamePath
 */
export const RenamePathHttp = Layer.effect(
  RenamePath,
  makeFileSystemBinding({
    tag: "Azure.Storage.RenamePath",
    access: DataLakeAccess.move,
    makeClient: makeRenamePathClient,
  }),
);
