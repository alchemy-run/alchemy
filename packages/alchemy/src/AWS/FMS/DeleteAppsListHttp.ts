import * as fms from "@distilled.cloud/aws/fms";
import * as Layer from "effect/Layer";
import { makeFmsHttpBinding } from "./BindingHttp.ts";
import { DeleteAppsList } from "./DeleteAppsList.ts";

export const DeleteAppsListHttp = Layer.effect(
  DeleteAppsList,
  makeFmsHttpBinding<
    fms.DeleteAppsListRequest,
    fms.DeleteAppsListResponse,
    fms.DeleteAppsListError
  >({
    capability: "DeleteAppsList",
    iamActions: ["fms:DeleteAppsList"],
    operation: fms.deleteAppsList,
  }),
);
