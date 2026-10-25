import * as data from "@distilled.cloud/azure/confidentialledger-data";
import * as identity from "@distilled.cloud/azure/confidentialledger-identity";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { orUndefinedIfNotFound } from "../Arm.ts";
import type { Providers } from "../Providers.ts";
import { ledgerEndpointOf, overLedgerTls } from "./internal.ts";
import type { LedgerRoleName } from "./Ledger.ts";

export interface LedgerRoleAssignmentProps {
  /** Name of the ledger. Changing it replaces the assignment. */
  ledger: string;
  /**
   * Microsoft Entra object ID of the user, group, service principal or
   * managed identity that gets the role. Changing it replaces the assignment.
   */
  principalId: string;
  /**
   * Ledger role: `Reader` reads entries and receipts, `Contributor` also
   * writes entries, `Administrator` also manages users and roles. Changing
   * it replaces the assignment.
   */
  role: LedgerRoleName;
}

export interface LedgerRoleAssignment extends Resource<
  "Azure.ConfidentialLedger.LedgerRoleAssignment",
  LedgerRoleAssignmentProps,
  {
    /** Name of the ledger. */
    ledgerName: string;
    /** Object ID of the principal that has the role. */
    principalId: string;
    /** The ledger role. */
    role: LedgerRoleName;
  },
  never,
  Providers
> {}

/**
 * One ledger role held by a Microsoft Entra principal, managed through the
 * ledger's own data plane (`/app/ledgerUsers`).
 *
 * Confidential Ledger access is the ledger's own user list, not Azure RBAC.
 * A principal can hold several roles: each assignment adds its role to the
 * principal's roles and removes only that role on delete (the ledger user is
 * deleted with its last role). The ledger cannot drop one role from a user,
 * so removing a role deletes the ledger user and re-adds its other roles:
 * the principal briefly has no access. Principals listed in the ledger's
 * `aadBasedSecurityPrincipals` are managed by `Azure.ConfidentialLedger.Ledger`
 * instead; do not assign roles to them here.
 *
 * :::caution
 * The deploying identity must be an `Administrator` of the ledger.
 * :::
 *
 * ### Granting Ledger Roles
 * **Example:** Let a managed identity read a ledger
 * ```typescript
 * yield* Azure.ConfidentialLedger.LedgerRoleAssignment("AuditorReads", {
 *   ledger: ledger.ledgerName,
 *   principalId: auditor.principalId,
 *   role: "Reader",
 * });
 * ```
 *
 * @resource
 */
export const LedgerRoleAssignment = Resource<LedgerRoleAssignment>(
  "Azure.ConfidentialLedger.LedgerRoleAssignment",
);

/** The ledger user's roles did not converge after repeated read-modify-writes. */
export class LedgerRoleAssignmentNotConverged extends Data.TaggedError(
  "Azure.ConfidentialLedger.LedgerRoleAssignmentNotConverged",
)<{ readonly ledger: string; readonly principalId: string; readonly message: string }> {}

/** Read-modify-write retries while other assignments of the same user race. */
const converge = { schedule: Schedule.spaced("2 seconds"), times: 10 } as const;

/**
 * The data-plane calls of one ledger, or `undefined` when the identity
 * service no longer knows the ledger (it was deleted).
 */
const ledgerClient = Effect.fn(function* (ledger: string) {
  const ledgerIdentity = yield* orUndefinedIfNotFound(
    identity.GetLedgerIdentity({ ledgerId: ledger }),
  );
  if (ledgerIdentity === undefined) return undefined;
  const tls = overLedgerTls(ledgerIdentity.ledgerTlsCertificate);
  const ledgerEndpoint = ledgerEndpointOf(ledger);
  return {
    /** The principal's current roles (`[]` when it is not a ledger user). */
    rolesOf: (userId: string) =>
      data.GetLedgerUser({ ledgerEndpoint, userId }).pipe(
        Effect.map((user): readonly string[] => user.assignedRoles),
        Effect.catchTag("NotFound", () => Effect.succeed([] as readonly string[])),
        tls,
      ),
    /** Add roles to the principal (the merge patch keeps its other roles). */
    addRoles: (userId: string, roles: readonly string[]) =>
      tls(
        Effect.asVoid(
          data.CreateOrUpdateLedgerUser({ ledgerEndpoint, userId, assignedRoles: [...roles] }),
        ),
      ),
    /**
     * Leave the principal exactly `roles`. The merge patch never drops a
     * role, so delete the ledger user and re-add the roles it keeps.
     */
    keepRoles: (userId: string, roles: readonly string[]) =>
      tls(
        Effect.gen(function* () {
          yield* data.DeleteLedgerUser({ ledgerEndpoint, userId });
          if (roles.length > 0) {
            yield* data.CreateOrUpdateLedgerUser({
              ledgerEndpoint,
              userId,
              assignedRoles: [...roles],
            });
          }
        }),
      ),
  };
});

const toAttrs = (props: LedgerRoleAssignmentProps): LedgerRoleAssignment["Attributes"] => ({
  ledgerName: props.ledger,
  principalId: props.principalId,
  role: props.role,
});

export const LedgerRoleAssignmentProvider = () =>
  Provider.succeed(LedgerRoleAssignment, {
    stables: ["ledgerName", "principalId", "role"],

    diff: Effect.fn(function* ({ news, output }) {
      if (output === undefined) return undefined;
      // The ledger and principal are attributes upstream; an unresolved one
      // means its resource is being replaced.
      if (
        !("ledger" in news) ||
        !("principalId" in news) ||
        !isResolved(news.ledger) ||
        !isResolved(news.principalId)
      ) {
        return { action: "replace" } as const;
      }
      if (!isResolved(news)) return undefined;
      if (
        news.ledger !== output.ledgerName ||
        news.principalId.toLowerCase() !== output.principalId.toLowerCase() ||
        news.role !== output.role
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const props: LedgerRoleAssignmentProps | undefined =
        output !== undefined
          ? { ledger: output.ledgerName, principalId: output.principalId, role: output.role }
          : olds;
      if (props === undefined) return undefined;
      const client = yield* ledgerClient(props.ledger);
      if (client === undefined) return undefined;
      const roles = yield* client.rolesOf(props.principalId);
      return roles.includes(props.role) ? toAttrs(props) : undefined;
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const client = yield* ledgerClient(news.ledger);
      if (client === undefined) {
        return yield* Effect.fail(
          new LedgerRoleAssignmentNotConverged({
            ledger: news.ledger,
            principalId: news.principalId,
            message: `ledger ${news.ledger} is unknown to the Confidential Ledger identity service`,
          }),
        );
      }
      // Observe the user's roles and add ours. Assignments of the same user
      // race on this read-modify-write, so re-observe until ours sticks.
      const ensured = yield* Effect.gen(function* () {
        const roles = yield* client.rolesOf(news.principalId);
        if (roles.includes(news.role)) return true;
        yield* client.addRoles(news.principalId, [news.role]);
        return false;
      }).pipe(Effect.repeat({ ...converge, until: (done) => done }));
      if (!ensured) {
        return yield* Effect.fail(
          new LedgerRoleAssignmentNotConverged({
            ledger: news.ledger,
            principalId: news.principalId,
            message: `role ${news.role} did not stick on ledger user ${news.principalId}`,
          }),
        );
      }
      return toAttrs(news);
    }),

    delete: Effect.fn(function* ({ output }) {
      const client = yield* ledgerClient(output.ledgerName);
      // The ledger is gone, and its users with it.
      if (client === undefined) return;
      // Assignments of the same user race on this read-modify-write, so
      // re-observe until ours is gone.
      const removed = yield* Effect.gen(function* () {
        const roles = yield* client.rolesOf(output.principalId);
        if (!roles.includes(output.role)) return true;
        yield* client.keepRoles(
          output.principalId,
          roles.filter((role) => role !== output.role),
        );
        return false;
      }).pipe(Effect.repeat({ ...converge, until: (done) => done }));
      if (!removed) {
        return yield* Effect.fail(
          new LedgerRoleAssignmentNotConverged({
            ledger: output.ledgerName,
            principalId: output.principalId,
            message: `role ${output.role} could not be removed from ledger user ${output.principalId}`,
          }),
        );
      }
    }),
  });
