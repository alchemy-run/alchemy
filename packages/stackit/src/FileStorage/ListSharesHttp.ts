import * as sfs from "@distilled.cloud/stackit/sfs";
import * as Layer from "effect/Layer";
import { makeResourcePoolHttpBinding } from "./BindingHttp.ts";
import { ListShares } from "./ListShares.ts";

/**
 * HTTP implementation of {@link ListShares}.
 *
 * @layer
 * @provides Stackit.FileStorage.ListShares
 */
export const ListSharesHttp = Layer.effect(
  ListShares,
  makeResourcePoolHttpBinding({
    tag: "Stackit.FileStorage.ListShares",
    access: { permissions: ["file-storage.share.list"] },
    operation: sfs.listShares,
  }),
);
