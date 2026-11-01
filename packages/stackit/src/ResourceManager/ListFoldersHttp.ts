import * as resourceManager from "@distilled.cloud/stackit/resource_manager";
import * as Layer from "effect/Layer";
import { makeParentHttpBinding } from "./BindingHttp.ts";
import { ListFolders } from "./ListFolders.ts";

/**
 * HTTP implementation of {@link ListFolders}.
 *
 * @layer
 * @provides Stackit.ResourceManager.ListFolders
 */
export const ListFoldersHttp = Layer.effect(
  ListFolders,
  makeParentHttpBinding({
    tag: "Stackit.ResourceManager.ListFolders",
    access: { permissions: ["resource-manager.folder.list"] },
    operation: resourceManager.listFolders,
  }),
);
