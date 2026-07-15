import * as fms from "@distilled.cloud/aws/fms";
import * as Layer from "effect/Layer";
import { makeFmsHttpBinding } from "./BindingHttp.ts";
import { GetResourceSet } from "./GetResourceSet.ts";

export const GetResourceSetHttp = Layer.effect(
  GetResourceSet,
  makeFmsHttpBinding<
    fms.GetResourceSetRequest,
    fms.GetResourceSetResponse,
    fms.GetResourceSetError
  >({
    capability: "GetResourceSet",
    iamActions: ["fms:GetResourceSet"],
    operation: fms.getResourceSet,
  }),
);
