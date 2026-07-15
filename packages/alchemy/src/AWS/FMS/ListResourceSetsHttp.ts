import * as fms from "@distilled.cloud/aws/fms";
import * as Layer from "effect/Layer";
import { makeFmsHttpBinding } from "./BindingHttp.ts";
import { ListResourceSets } from "./ListResourceSets.ts";

export const ListResourceSetsHttp = Layer.effect(
  ListResourceSets,
  makeFmsHttpBinding<
    fms.ListResourceSetsRequest,
    fms.ListResourceSetsResponse,
    fms.ListResourceSetsError
  >({
    capability: "ListResourceSets",
    iamActions: ["fms:ListResourceSets"],
    operation: fms.listResourceSets,
  }),
);
