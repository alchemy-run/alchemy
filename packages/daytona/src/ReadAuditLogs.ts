import * as audit from "@distilled.cloud/daytona/audit";
import * as Binding from "alchemy/Binding";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeAccess } from "./DaytonaBindings.ts";
import { scopeModule, type OrganizationFixed, type ScopedModule } from "./internal/Scoped.ts";
import { lazyScoped } from "./ReadOrganization.ts";

/** The organization's audit log. */
export interface ReadAuditLogsClient extends ScopedModule<typeof audit, OrganizationFixed> {}

/**
 * Read the organization's audit log at runtime: who created, started,
 * deleted or changed what, and with which API key.
 *
 * The host gets its own Daytona API key with `read:audit_logs`.
 *
 * ### Reading the Audit Log
 * **Example:** The latest entries
 * ```typescript
 * const audit = yield* Daytona.ReadAuditLogs();
 * const page = yield* audit.getOrganizationAuditLogs({ limit: 50 });
 * ```
 *
 * @binding
 * @product Organization
 */
export interface ReadAuditLogs extends Binding.Service<
  ReadAuditLogs,
  "Daytona.ReadAuditLogs",
  () => Effect.Effect<ReadAuditLogsClient>
> {}

export const ReadAuditLogs = Binding.Service<ReadAuditLogs>("Daytona.ReadAuditLogs");

/** {@link ReadAuditLogs} over Daytona's HTTP API; works on any host. */
export const ReadAuditLogsHttp = Layer.effect(
  ReadAuditLogs,
  Effect.gen(function* () {
    const access = yield* makeAccess;
    return Effect.fn(function* () {
      const { authorize, organizationId } = yield* access("AuditLogs", ["read:audit_logs"]);
      return lazyScoped(organizationId, (id) =>
        scopeModule<typeof audit, OrganizationFixed>(audit, { organizationId: id }, (effect) =>
          authorize(effect),
        ),
      );
    });
  }),
);
