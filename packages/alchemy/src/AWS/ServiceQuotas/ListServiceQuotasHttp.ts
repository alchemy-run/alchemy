import * as servicequotas from "@distilled.cloud/aws/service-quotas";
import * as Layer from "effect/Layer";
import { makeServiceQuotasHttpBinding } from "./BindingHttp.ts";
import { ListServiceQuotas } from "./ListServiceQuotas.ts";

export const ListServiceQuotasHttp = Layer.effect(
  ListServiceQuotas,
  makeServiceQuotasHttpBinding<
    servicequotas.ListServiceQuotasRequest,
    servicequotas.ListServiceQuotasResponse,
    servicequotas.ListServiceQuotasError
  >({
    capability: "ListServiceQuotas",
    iamActions: ["servicequotas:ListServiceQuotas"],
    operation: servicequotas.listServiceQuotas,
  }),
);
