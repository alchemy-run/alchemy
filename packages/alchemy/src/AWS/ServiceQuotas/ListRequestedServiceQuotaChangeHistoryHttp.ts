import * as servicequotas from "@distilled.cloud/aws/service-quotas";
import * as Layer from "effect/Layer";
import { makeServiceQuotasHttpBinding } from "./BindingHttp.ts";
import { ListRequestedServiceQuotaChangeHistory } from "./ListRequestedServiceQuotaChangeHistory.ts";

export const ListRequestedServiceQuotaChangeHistoryHttp = Layer.effect(
  ListRequestedServiceQuotaChangeHistory,
  makeServiceQuotasHttpBinding<
    servicequotas.ListRequestedServiceQuotaChangeHistoryRequest,
    servicequotas.ListRequestedServiceQuotaChangeHistoryResponse,
    servicequotas.ListRequestedServiceQuotaChangeHistoryError
  >({
    capability: "ListRequestedServiceQuotaChangeHistory",
    iamActions: ["servicequotas:ListRequestedServiceQuotaChangeHistory"],
    operation: servicequotas.listRequestedServiceQuotaChangeHistory,
  }),
);
