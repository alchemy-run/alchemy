import * as automation from "@distilled.cloud/azure/automation";
import * as Output from "alchemy/Output";
import * as Layer from "effect/Layer";
import { groupOf, makeArmActionBinding } from "../ArmActionBinding.ts";
import { AutomationRole } from "./BindingHttp.ts";
import type { Runbook } from "./Runbook.ts";
import { StartRunbook, type StartRunbookRequest } from "./StartRunbook.ts";

/** ARM ID of the Automation account a runbook belongs to. */
const accountIdOf = (runbook: Runbook) =>
  Output.map(runbook.runbookId, (id) => id.slice(0, id.toLowerCase().lastIndexOf("/runbooks/")));

/**
 * Implementation of {@link StartRunbook} over the distilled `automation`
 * ARM API (`CreateJob`). Assigns the custom
 * `AzureAutomationStartRunbookRole` on the runbook's Automation account.
 *
 * @layer
 * @provides Azure.Automation.StartRunbook
 */
export const StartRunbookHttp = Layer.effect(
  StartRunbook,
  makeArmActionBinding({
    tag: "Azure.Automation.StartRunbook",
    operation: automation.CreateJob,
    role: AutomationRole.StartRunbook,
    scope: accountIdOf,
    target: (runbook: Runbook) => runbook.runbookId,
    input: (request: StartRunbookRequest, id) => ({
      ...groupOf(id),
      automationAccountName: id.names.automationaccounts ?? "",
      jobName: request.jobName,
      properties: {
        runbook: { name: id.names.runbooks ?? "" },
        parameters: request.parameters,
        runOn: request.runOn,
      },
    }),
  }),
);
