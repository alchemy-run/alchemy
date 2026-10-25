import type * as Effect from "effect/Effect";
import { type ArmActionRole, groupOf, makeArmActionBinding } from "../ArmActionBinding.ts";
import type { AutomationAccount } from "./AutomationAccount.ts";
import type { Watcher } from "./Watcher.ts";

/**
 * Shared scaffolding for the Automation runtime-action bindings: the bound
 * account (or watcher) supplies `subscriptionId`, `resourceGroupName`,
 * `automationAccountName` (and `watcherName`), and each binding assigns its
 * custom role on that resource only.
 *
 * NOT exported from `index.ts`.
 */

/** Automation permissions the bindings grant (Azure RBAC actions). */
export const AutomationPermission = {
  writeJobs: "Microsoft.Automation/automationAccounts/jobs/write",
  readJobs: "Microsoft.Automation/automationAccounts/jobs/read",
  stopJobs: "Microsoft.Automation/automationAccounts/jobs/stop/action",
  suspendJobs: "Microsoft.Automation/automationAccounts/jobs/suspend/action",
  resumeJobs: "Microsoft.Automation/automationAccounts/jobs/resume/action",
  startWatchers: "Microsoft.Automation/automationAccounts/watchers/start/action",
  stopWatchers: "Microsoft.Automation/automationAccounts/watchers/stop/action",
} as const;

/**
 * Custom role per binding; the logical ID is `Azure<role>Role`. The
 * built-in **Automation Job Operator** grants every job action plus reads
 * of the account's runbooks and job output; **Automation Operator** also
 * reads schedules, webhooks and modules.
 */
export const AutomationRole = {
  StartRunbook: { role: "AutomationStartRunbook", actions: [AutomationPermission.writeJobs] },
  GetJob: { role: "AutomationGetJob", actions: [AutomationPermission.readJobs] },
  StopJob: { role: "AutomationStopJob", actions: [AutomationPermission.stopJobs] },
  SuspendJob: { role: "AutomationSuspendJob", actions: [AutomationPermission.suspendJobs] },
  ResumeJob: { role: "AutomationResumeJob", actions: [AutomationPermission.resumeJobs] },
  StartWatcher: { role: "AutomationStartWatcher", actions: [AutomationPermission.startWatchers] },
  StopWatcher: { role: "AutomationStopWatcher", actions: [AutomationPermission.stopWatchers] },
} as const satisfies Record<string, ArmActionRole>;

type AccountKeys = "subscriptionId" | "resourceGroupName" | "automationAccountName";

/**
 * Build the impl Effect for an account-scoped action (jobs belong to the
 * account): the runtime callable fills the account's identifiers, and the
 * deploy-time half assigns `role` on the account.
 */
export const makeAutomationAccountActionBinding = <
  I extends { subscriptionId: string; resourceGroupName: string; automationAccountName: string },
  A,
  E,
>(options: {
  /** Fully-qualified binding tag, e.g. `Azure.Automation.StopJob`. */
  tag: string;
  /** The distilled `automation` operation. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, any>;
  /** The custom role assigned on the account. */
  role: ArmActionRole;
}) =>
  makeArmActionBinding({
    ...options,
    scope: (account: AutomationAccount) => account.automationAccountId,
    target: (account) => account.automationAccountId,
    input: (request: Omit<I, AccountKeys>, id) =>
      ({
        ...request,
        ...groupOf(id),
        automationAccountName: id.names.automationaccounts ?? "",
      }) as I,
  });

/**
 * Build the impl Effect for a watcher action: the runtime callable fills
 * the watcher's identifiers, and the deploy-time half assigns `role` on the
 * watcher.
 */
export const makeWatcherActionBinding = <
  I extends {
    subscriptionId: string;
    resourceGroupName: string;
    automationAccountName: string;
    watcherName: string;
  },
  A,
  E,
>(options: {
  /** Fully-qualified binding tag, e.g. `Azure.Automation.StartWatcher`. */
  tag: string;
  /** The distilled `automation` operation. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, any>;
  /** The custom role assigned on the watcher. */
  role: ArmActionRole;
}) =>
  makeArmActionBinding({
    ...options,
    scope: (watcher: Watcher) => watcher.watcherId,
    target: (watcher) => watcher.watcherId,
    input: (request: Omit<I, AccountKeys | "watcherName"> | undefined, id) =>
      ({
        ...request,
        ...groupOf(id),
        automationAccountName: id.names.automationaccounts ?? "",
        watcherName: id.names.watchers ?? "",
      }) as I,
  });
