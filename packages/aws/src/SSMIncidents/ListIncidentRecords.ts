import * as incidents from "@distilled.cloud/aws/ssm-incidents";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeIncidentsAccountHttpBinding } from "./BindingHttp.ts";

/**
 * Runtime binding for `ssm-incidents:ListIncidentRecords`.
 *
 * Lists the incident records in the account — the incidents started from any
 * response plan. Incident records are runtime entities (their ARNs embed the
 * response-plan name and a UUID that only exist once an incident starts), so
 * the deploy-time grant is account-level (`Resource: "*"`).
 * Provide the implementation with
 * `Effect.provide(AWS.SSMIncidents.ListIncidentRecordsHttp)`.
 * ### Reading Incident Records
 * **Example:** List Open Incidents
 * ```typescript
 * // init
 * const listIncidentRecords = yield* AWS.SSMIncidents.ListIncidentRecords();
 *
 * // runtime
 * const { incidentRecordSummaries } = yield* listIncidentRecords({
 *   filters: [{ key: "status", condition: { equals: { stringValues: ["OPEN"] } } }],
 * });
 * ```
 *
 * @binding
 */
export interface ListIncidentRecords extends Binding.Service<
  ListIncidentRecords,
  "AWS.SSMIncidents.ListIncidentRecords",
  () => Effect.Effect<
    (
      request: incidents.ListIncidentRecordsInput,
    ) => Effect.Effect<incidents.ListIncidentRecordsOutput, incidents.ListIncidentRecordsError>
  >
> {}
export const ListIncidentRecords = Binding.Service<ListIncidentRecords>(
  "AWS.SSMIncidents.ListIncidentRecords",
);

export const ListIncidentRecordsHttp = Layer.effect(
  ListIncidentRecords,
  makeIncidentsAccountHttpBinding({
    tag: "AWS.SSMIncidents.ListIncidentRecords",
    operation: incidents.listIncidentRecords,
    actions: ["ssm-incidents:ListIncidentRecords"],
  }),
);
