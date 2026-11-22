import * as files from "@distilled.cloud/azure/storage-file";
import * as Layer from "effect/Layer";
import { makeFileShareOperationBinding } from "./FileShareHttp.ts";
import { GetFileSymbolicLink } from "./GetFileSymbolicLink.ts";

/**
 * Implementation of {@link GetFileSymbolicLink} over the distilled `storage-file`
 * data plane. Assigns Storage File Data Privileged Reader on the share.
 *
 * @layer
 * @provides Azure.Storage.GetFileSymbolicLink
 */
export const GetFileSymbolicLinkHttp = Layer.effect(
  GetFileSymbolicLink,
  makeFileShareOperationBinding({
    tag: "Azure.Storage.GetFileSymbolicLink",
    operation: files.GetFileSymbolicLink,
    access: "read",
  }),
);
