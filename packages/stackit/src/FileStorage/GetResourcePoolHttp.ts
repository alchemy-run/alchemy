import * as sfs from "@distilled.cloud/stackit/sfs";
import * as Layer from "effect/Layer";
import { makeResourcePoolHttpBinding } from "./BindingHttp.ts";
import { GetResourcePool } from "./GetResourcePool.ts";

/**
 * HTTP implementation of {@link GetResourcePool}.
 *
 * @layer
 * @provides Stackit.FileStorage.GetResourcePool
 */
export const GetResourcePoolHttp = Layer.effect(
  GetResourcePool,
  makeResourcePoolHttpBinding({
    tag: "Stackit.FileStorage.GetResourcePool",
    access: { permissions: ["file-storage.resource-pool.list"] },
    operation: sfs.getResourcePool,
  }),
);
