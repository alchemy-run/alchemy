import * as auditmanager from "@distilled.cloud/aws/auditmanager";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

/**
 * Registers the account with Audit Manager when it isn't yet, and waits until it is ACTIVE. Registering an
 * account that already is registered is a no-op. On an AWS account that never enabled Audit Manager this fails
 * with the typed AuditManagerMaintenanceMode tag: the service stopped taking new registrations on 2026-04-30.
 */
export const ensureRegistered = Effect.gen(function* () {
  const { status } = yield* auditmanager.getAccountStatus({});
  if (status === "ACTIVE") return;
  yield* auditmanager.registerAccount({});
  yield* Effect.gen(function* () {
    const current = yield* auditmanager.getAccountStatus({});
    if (current.status !== "ACTIVE") {
      return yield* Effect.fail({ _tag: "NotActive" as const, status: current.status });
    }
  }).pipe(
    Effect.retry({
      while: (e) => e._tag === "NotActive",
      schedule: Schedule.max([Schedule.spaced("5 seconds"), Schedule.recurs(12)]),
    }),
  );
});
