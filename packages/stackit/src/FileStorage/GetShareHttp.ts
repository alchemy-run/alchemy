import * as sfs from "@distilled.cloud/stackit/sfs";
import * as Layer from "effect/Layer";
import { makeShareHttpBinding } from "./BindingHttp.ts";
import { GetShare } from "./GetShare.ts";

/**
 * HTTP implementation of {@link GetShare}.
 *
 * @layer
 * @provides Stackit.FileStorage.GetShare
 */
export const GetShareHttp = Layer.effect(
  GetShare,
  makeShareHttpBinding({
    tag: "Stackit.FileStorage.GetShare",
    access: { permissions: ["file-storage.share.list"] },
    operation: sfs.getShare,
  }),
);
