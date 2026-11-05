import * as appsignals from "@distilled.cloud/aws/application-signals";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeApplicationSignalsAccountHttpBinding } from "./BindingHttp.ts";

/**
 * Runtime binding for `application-signals:ListAuditFindings`.
 *
 * Returns audit findings — automated analysis of service behavior and root
 * causes (performance issues, anomalies, potential problems) for the given
 * audit targets. Provide the implementation with
 * `Effect.provide(AWS.ApplicationSignals.ListAuditFindingsHttp)`.
 * ### Auditing Services
 * **Example:** List Audit Findings for a Service
 * ```typescript
 * // init — account-level, no resource argument
 * const listAuditFindings = yield* AWS.ApplicationSignals.ListAuditFindings();
 *
 * // runtime
 * const result = yield* listAuditFindings({
 *   StartTime: new Date(Date.now() - 3600_000),
 *   EndTime: new Date(),
 *   AuditTargets: [
 *     {
 *       Type: "service",
 *       Data: {
 *         Service: {
 *           Type: "Service",
 *           Name: "checkout-service",
 *           Environment: "eks:prod",
 *         },
 *       },
 *     },
 *   ],
 * });
 * ```
 *
 * @binding
 */
export interface ListAuditFindings extends Binding.Service<
  ListAuditFindings,
  "AWS.ApplicationSignals.ListAuditFindings",
  () => Effect.Effect<
    (
      request: appsignals.ListAuditFindingsInput,
    ) => Effect.Effect<appsignals.ListAuditFindingsOutput, appsignals.ListAuditFindingsError>
  >
> {}

export const ListAuditFindings = Binding.Service<ListAuditFindings>(
  "AWS.ApplicationSignals.ListAuditFindings",
);

export const ListAuditFindingsHttp = Layer.effect(
  ListAuditFindings,
  makeApplicationSignalsAccountHttpBinding({
    tag: "AWS.ApplicationSignals.ListAuditFindings",
    operation: appsignals.listAuditFindings,
    // The auditors run with the CALLER's credentials — verified live: a
    // service-target audit fails with AccessDeniedException (empty message)
    // unless the caller can also enumerate SLOs and read metric data.
    // Deeper detail levels (trace/log auditors) may need further read
    // permissions (xray/logs).
    actions: [
      "application-signals:ListAuditFindings",
      "application-signals:ListServiceLevelObjectives",
      "cloudwatch:GetMetricData",
    ],
  }),
);
