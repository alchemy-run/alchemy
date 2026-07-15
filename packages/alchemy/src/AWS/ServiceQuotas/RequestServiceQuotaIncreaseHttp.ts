import * as servicequotas from "@distilled.cloud/aws/service-quotas";
import * as Layer from "effect/Layer";
import { makeServiceQuotasHttpBinding } from "./BindingHttp.ts";
import { RequestServiceQuotaIncrease } from "./RequestServiceQuotaIncrease.ts";

export const RequestServiceQuotaIncreaseHttp = Layer.effect(
  RequestServiceQuotaIncrease,
  makeServiceQuotasHttpBinding<
    servicequotas.RequestServiceQuotaIncreaseRequest,
    servicequotas.RequestServiceQuotaIncreaseResponse,
    servicequotas.RequestServiceQuotaIncreaseError
  >({
    capability: "RequestServiceQuotaIncrease",
    iamActions: ["servicequotas:RequestServiceQuotaIncrease"],
    operation: servicequotas.requestServiceQuotaIncrease,
  }),
);
