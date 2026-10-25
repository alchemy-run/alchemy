import type { Input } from "alchemy/Input";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import { RoleDefinition } from "../Authorization/RoleDefinition.ts";
import * as AzureBindings from "../AzureBindings.ts";
import type { Account } from "./Account.ts";

/**
 * Shared scaffolding for the Batch data-plane bindings (`batch-data`):
 * resolves the distilled operation once when the layer is built, injects
 * the bound account's endpoint per call, and assigns the binding's custom
 * role on the account at deploy time.
 *
 * NOT exported from `index.ts`.
 */

/** Batch permissions the bindings grant (Azure RBAC). */
export const BatchPermission = {
  readJobs: "Microsoft.Batch/batchAccounts/jobs/read",
  writeJobs: "Microsoft.Batch/batchAccounts/jobs/write",
  deleteJobs: "Microsoft.Batch/batchAccounts/jobs/delete",
  readJobSchedules: "Microsoft.Batch/batchAccounts/jobSchedules/read",
  writeJobSchedules: "Microsoft.Batch/batchAccounts/jobSchedules/write",
  deleteJobSchedules: "Microsoft.Batch/batchAccounts/jobSchedules/delete",
  readPools: "Microsoft.Batch/batchAccounts/pools/read",
  readApplications: "Microsoft.Batch/batchAccounts/applications/read",
  readApplicationVersions: "Microsoft.Batch/batchAccounts/applications/versions/read",
  readAccount: "Microsoft.Batch/batchAccounts/read",
} as const;

/**
 * A custom role (`Azure.Authorization.RoleDefinition`, defined once per
 * stack at the subscription and assigned only on the bound account) with
 * exactly `actions` / `dataActions`. Jobs and job schedules are data
 * actions; pools and applications are actions the data plane checks.
 */
export interface BatchGrant {
  readonly role: string;
  readonly actions?: readonly string[];
  readonly dataActions?: readonly string[];
}

/**
 * Custom role per binding kind; the logical ID is `AzureBatch<role>Role`.
 * Every built-in Batch role is broader: **Azure Batch Account Reader**
 * reads everything in the account, **Azure Batch Job Submitter** also
 * writes and deletes jobs and job schedules.
 */
export const BatchRole = {
  ReadJobs: { role: "ReadJobs", dataActions: [BatchPermission.readJobs] },
  WriteJobs: { role: "WriteJobs", dataActions: [BatchPermission.writeJobs] },
  DeleteJobs: { role: "DeleteJobs", dataActions: [BatchPermission.deleteJobs] },
  ReadJobSchedules: { role: "ReadJobSchedules", dataActions: [BatchPermission.readJobSchedules] },
  WriteJobSchedules: {
    role: "WriteJobSchedules",
    dataActions: [BatchPermission.writeJobSchedules],
  },
  DeleteJobSchedules: {
    role: "DeleteJobSchedules",
    dataActions: [BatchPermission.deleteJobSchedules],
  },
  ReadPools: { role: "ReadPools", actions: [BatchPermission.readPools] },
  // `GET /applications` answers 403 with `applications/read` and
  // `applications/versions/read` alone; it also checks `batchAccounts/read`.
  ReadApplications: {
    role: "ReadApplications",
    actions: [
      BatchPermission.readAccount,
      BatchPermission.readApplications,
      BatchPermission.readApplicationVersions,
    ],
  },
} as const satisfies Record<string, BatchGrant>;

/** Assign `grants` on the account to the host, creating the custom roles they name. */
const GrantBatchRoles = Effect.gen(function* () {
  const bind = yield* AzureBindings.Bind;
  // Roles are deploy-time resources: a host bundle never declares them.
  const AzureRoleDefinition = globalThis.__ALCHEMY_RUNTIME__ ? undefined : yield* RoleDefinition;
  return Effect.fn(function* (tag: string, account: Account, grants: readonly BatchGrant[]) {
    if (!globalThis.__ALCHEMY_RUNTIME__ && AzureRoleDefinition !== undefined) {
      const roleAssignments: Input<AzureBindings.HostRoleAssignment>[] = [];
      for (const grant of grants) {
        const permissions = [...(grant.actions ?? []), ...(grant.dataActions ?? [])];
        const role = yield* AzureRoleDefinition(`AzureBatch${grant.role}Role`, {
          description: `Alchemy Batch binding: ${permissions.join(", ")}`,
          permissions: [
            {
              actions: grant.actions === undefined ? undefined : [...grant.actions],
              dataActions: grant.dataActions === undefined ? undefined : [...grant.dataActions],
            },
          ],
        });
        roleAssignments.push({ roleDefinitionId: role.roleDefinitionId, scope: account.accountId });
      }
      yield* bind`${tag}(${account})`({ roleAssignments });
    }
  });
});

/**
 * Build the impl Effect for an account-scoped Batch data-plane operation
 * (every request carries `endpoint`): the runtime callable injects
 * `https://<account endpoint>`, and the deploy-time half assigns `grants`
 * on the account.
 */
export const makeBatchAccountBinding = <I extends { endpoint: string }, A, E>(options: {
  /** Fully-qualified binding tag, e.g. `Azure.Batch.CreateJob`. */
  tag: string;
  /** The distilled operation; the account endpoint is injected. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, any>;
  /** Roles assigned on the account. */
  grants: readonly BatchGrant[];
}) =>
  Effect.gen(function* () {
    const grant = yield* GrantBatchRoles;
    const op = yield* AzureBindings.withCredentials(options.operation);
    return Effect.fn(function* (account: Account) {
      yield* grant(options.tag, account, options.grants);
      const endpoint = yield* Output.map(
        account.accountEndpoint,
        (host) => `https://${host ?? ""}`,
      );
      return Effect.fn(`${options.tag}(${account.LogicalId})`)(function* (
        request?: Omit<I, "endpoint">,
      ) {
        const url = yield* endpoint;
        return yield* op({ ...request, endpoint: url } as I);
      });
    });
  });
