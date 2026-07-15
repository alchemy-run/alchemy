import * as qapps from "@distilled.cloud/aws/qapps";
import * as Layer from "effect/Layer";
import { makeQAppHttpBinding } from "./BindingHttp.ts";
import { CreateLibraryItem } from "./CreateLibraryItem.ts";

export const CreateLibraryItemHttp = Layer.effect(
  CreateLibraryItem,
  makeQAppHttpBinding<
    qapps.CreateLibraryItemInput,
    qapps.CreateLibraryItemOutput,
    qapps.CreateLibraryItemError
  >({
    capability: "CreateLibraryItem",
    iamActions: ["qapps:CreateLibraryItem"],
    operation: qapps.createLibraryItem,
    injectAppId: true,
  }),
);
