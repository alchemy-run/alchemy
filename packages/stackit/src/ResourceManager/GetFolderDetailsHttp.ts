import * as resourceManager from "@distilled.cloud/stackit/resource_manager";
import * as Layer from "effect/Layer";
import { makeFolderHttpBinding } from "./BindingHttp.ts";
import { GetFolderDetails } from "./GetFolderDetails.ts";

/**
 * HTTP implementation of {@link GetFolderDetails}.
 *
 * @layer
 * @provides Stackit.ResourceManager.GetFolderDetails
 */
export const GetFolderDetailsHttp = Layer.effect(
  GetFolderDetails,
  makeFolderHttpBinding({
    tag: "Stackit.ResourceManager.GetFolderDetails",
    access: { permissions: ["resource-manager.folder.get"] },
    operation: resourceManager.getFolderDetails,
  }),
);
