import * as ufw from "@distilled.cloud/stackit/ufw";
import * as Layer from "effect/Layer";
import { makeFolderHttpBinding } from "./BindingHttp.ts";
import { ListFolderContainers } from "./ListFolderContainers.ts";

/**
 * HTTP implementation of {@link ListFolderContainers}.
 *
 * @layer
 * @provides Stackit.UnifiedFirewall.ListFolderContainers
 */
export const ListFolderContainersHttp = Layer.effect(
  ListFolderContainers,
  makeFolderHttpBinding({
    tag: "Stackit.UnifiedFirewall.ListFolderContainers",
    access: { permissions: ["ufw.folder.list"] },
    operation: ufw.listFolderContainers,
  }),
);
