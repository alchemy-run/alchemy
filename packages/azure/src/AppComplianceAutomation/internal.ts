import { Credentials } from "@distilled.cloud/azure";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

/** ARM ID prefix of App Compliance Automation reports (tenant scope). */
export const REPORTS_PREFIX = "/providers/Microsoft.AppComplianceAutomation/reports/";

/**
 * The `x-ms-aad-user-token` header value. Microsoft.AppComplianceAutomation
 * acts on behalf of the caller and reads the caller's token a second time
 * from this header; every operation without it fails with
 * `BearerFallbackDisabled`.
 */
export const userToken = Effect.gen(function* () {
  const credentials = yield* yield* Credentials;
  return yield* Effect.sync(() =>
    Redacted.make(`Bearer ${Redacted.value(credentials.bearerToken)}`),
  );
});

/**
 * A generated name for a report or one of its children: letters, digits,
 * `-` and `_`, at most 50 characters.
 */
export const generatedName = (id: string, instanceId: string, maxLength = 50) =>
  createPhysicalName({ id, instanceId, maxLength });

/** Case-insensitive name comparison (ARM names are case-insensitive). */
export const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Whether two ISO timestamps denote the same instant. */
export const sameInstant = (a: string | undefined, b: string | undefined) => {
  if (a === undefined || b === undefined) return a === b;
  const left = Date.parse(a);
  const right = Date.parse(b);
  return Number.isNaN(left) || Number.isNaN(right) ? a === b : left === right;
};

/** `"true"` / `"false"` string flags the service returns, as booleans. */
export const flag = (value: string | undefined) =>
  value === undefined ? undefined : value === "true";
