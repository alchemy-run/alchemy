import * as servicequotas from "@distilled.cloud/aws/service-quotas";
import * as Layer from "effect/Layer";
import { makeServiceQuotasHttpBinding } from "./BindingHttp.ts";
import { GetQuotaUtilizationReport } from "./GetQuotaUtilizationReport.ts";

export const GetQuotaUtilizationReportHttp = Layer.effect(
  GetQuotaUtilizationReport,
  makeServiceQuotasHttpBinding<
    servicequotas.GetQuotaUtilizationReportRequest,
    servicequotas.GetQuotaUtilizationReportResponse,
    servicequotas.GetQuotaUtilizationReportError
  >({
    capability: "GetQuotaUtilizationReport",
    iamActions: ["servicequotas:GetQuotaUtilizationReport"],
    operation: servicequotas.getQuotaUtilizationReport,
  }),
);
