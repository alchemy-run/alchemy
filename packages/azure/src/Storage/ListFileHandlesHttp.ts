import * as files from "@distilled.cloud/azure/storage-file";
import * as Layer from "effect/Layer";
import { makeFileShareOperationBinding } from "./FileShareHttp.ts";
import { ListFileHandles } from "./ListFileHandles.ts";

/**
 * Implementation of {@link ListFileHandles} over the distilled `storage-file`
 * data plane. Assigns Storage File Data Privileged Reader on the share.
 *
 * @layer
 * @provides Azure.Storage.ListFileHandles
 */
export const ListFileHandlesHttp = Layer.effect(
  ListFileHandles,
  makeFileShareOperationBinding({
    tag: "Azure.Storage.ListFileHandles",
    operation: files.ListFileHandles,
    access: "read",
  }),
);
