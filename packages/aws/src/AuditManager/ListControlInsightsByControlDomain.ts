import * as auditmanager from "@distilled.cloud/aws/auditmanager";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeAuditManagerAccountHttpBinding } from "./BindingHttp.ts";

/**
 * Runtime binding for `auditmanager:ListControlInsightsByControlDomain`.
 *
 * Lists the latest control analytics for a specific control domain
 * across active assessments. Provide the
 * implementation with `Effect.provide(AWS.AuditManager.ListControlInsightsByControlDomainHttp)`.
 * ### Insights
 * **Example:** Control Insights for a Domain
 * ```typescript
 * const listControlInsightsByControlDomain = yield* AWS.AuditManager.ListControlInsightsByControlDomain();
 * const result = yield* listControlInsightsByControlDomain({ controlDomainId });
 * ```
 *
 * @binding
 */
export interface ListControlInsightsByControlDomain extends Binding.Service<
  ListControlInsightsByControlDomain,
  "AWS.AuditManager.ListControlInsightsByControlDomain",
  () => Effect.Effect<
    (
      request: auditmanager.ListControlInsightsByControlDomainRequest,
    ) => Effect.Effect<
      auditmanager.ListControlInsightsByControlDomainResponse,
      auditmanager.ListControlInsightsByControlDomainError
    >
  >
> {}

export const ListControlInsightsByControlDomain =
  Binding.Service<ListControlInsightsByControlDomain>(
    "AWS.AuditManager.ListControlInsightsByControlDomain",
  );

export const ListControlInsightsByControlDomainHttp = Layer.effect(
  ListControlInsightsByControlDomain,
  makeAuditManagerAccountHttpBinding({
    tag: "AWS.AuditManager.ListControlInsightsByControlDomain",
    operation: auditmanager.listControlInsightsByControlDomain,
    actions: ["auditmanager:ListControlInsightsByControlDomain"],
  }),
);
