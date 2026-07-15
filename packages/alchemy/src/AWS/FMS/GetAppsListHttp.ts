import * as fms from "@distilled.cloud/aws/fms";
import * as Layer from "effect/Layer";
import { makeFmsHttpBinding } from "./BindingHttp.ts";
import { GetAppsList } from "./GetAppsList.ts";

export const GetAppsListHttp = Layer.effect(
  GetAppsList,
  makeFmsHttpBinding<
    fms.GetAppsListRequest,
    fms.GetAppsListResponse,
    fms.GetAppsListError
  >({
    capability: "GetAppsList",
    iamActions: ["fms:GetAppsList"],
    operation: fms.getAppsList,
  }),
);
