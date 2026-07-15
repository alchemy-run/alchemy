import * as fms from "@distilled.cloud/aws/fms";
import * as Layer from "effect/Layer";
import { makeFmsHttpBinding } from "./BindingHttp.ts";
import { GetProtocolsList } from "./GetProtocolsList.ts";

export const GetProtocolsListHttp = Layer.effect(
  GetProtocolsList,
  makeFmsHttpBinding<
    fms.GetProtocolsListRequest,
    fms.GetProtocolsListResponse,
    fms.GetProtocolsListError
  >({
    capability: "GetProtocolsList",
    iamActions: ["fms:GetProtocolsList"],
    operation: fms.getProtocolsList,
  }),
);
