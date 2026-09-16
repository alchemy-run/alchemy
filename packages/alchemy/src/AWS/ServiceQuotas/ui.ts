import * as Layer from "effect/Layer";
import * as UIProvider from "../../UI/UIProvider.ts";
import type { ServiceQuotaIncreaseRequest } from "./ServiceQuotaIncreaseRequest.ts";

/**
 * Dashboard UI providers for AWS ServiceQuotas resources.
 *
 * Browser-safe: only `effect/*` runtime imports; resource types are
 * type-only so no AWS SDK code reaches the dashboard bundle.
 */

export const ServiceQuotaIncreaseRequestUI =
  UIProvider.succeed<ServiceQuotaIncreaseRequest>(
    "AWS.ServiceQuotas.ServiceQuotaIncreaseRequest",
    {
      displayName: "Service Quota Increase Request",
      icon: "gauge",
      color: "#E7157B",
      category: "config",
      summary: (ctx) => ctx.attrs?.quotaName ?? ctx.attrs?.quotaCode,
      facts: (ctx) => [
        { label: "service", value: ctx.attrs?.serviceName, copy: true },
        { label: "quota", value: ctx.attrs?.quotaName },
        { label: "status", value: ctx.attrs?.status },
        { label: "desired", value: ctx.attrs?.desiredValue },
        { label: "applied", value: ctx.attrs?.appliedValue },
        { label: "request id", value: ctx.attrs?.requestId, mono: true },
        { label: "case id", value: ctx.attrs?.caseId, mono: true },
      ],
    },
  );

export const ui = () => Layer.mergeAll(ServiceQuotaIncreaseRequestUI);
