import * as fms from "@distilled.cloud/aws/fms";
import * as Layer from "effect/Layer";
import { makeFmsHttpBinding } from "./BindingHttp.ts";
import { GetAdminScope } from "./GetAdminScope.ts";

export const GetAdminScopeHttp = Layer.effect(
  GetAdminScope,
  makeFmsHttpBinding<
    fms.GetAdminScopeRequest,
    fms.GetAdminScopeResponse,
    fms.GetAdminScopeError
  >({
    capability: "GetAdminScope",
    iamActions: ["fms:GetAdminScope"],
    operation: fms.getAdminScope,
    pinToAdminRegion: true,
  }),
);
