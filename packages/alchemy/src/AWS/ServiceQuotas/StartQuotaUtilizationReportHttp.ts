import * as servicequotas from "@distilled.cloud/aws/service-quotas";
import * as Layer from "effect/Layer";
import { makeServiceQuotasHttpBinding } from "./BindingHttp.ts";
import { StartQuotaUtilizationReport } from "./StartQuotaUtilizationReport.ts";

export const StartQuotaUtilizationReportHttp = Layer.effect(
  StartQuotaUtilizationReport,
  makeServiceQuotasHttpBinding<
    servicequotas.StartQuotaUtilizationReportRequest,
    servicequotas.StartQuotaUtilizationReportResponse,
    servicequotas.StartQuotaUtilizationReportError
  >({
    capability: "StartQuotaUtilizationReport",
    iamActions: ["servicequotas:StartQuotaUtilizationReport"],
    operation: servicequotas.startQuotaUtilizationReport,
  }),
);
