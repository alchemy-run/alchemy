import * as automation from "@distilled.cloud/azure/automation";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  accountOwnedByStage,
  childNuke,
  createChildName,
  sameName,
} from "./Common.ts";

export interface HybridRunbookWorkerGroupProps {
  /** Resource group of the Automation account. Changing it replaces the group. */
  resourceGroup: string;
  /** Automation account that holds the group. Changing it replaces the group. */
  automationAccount: string;
  /**
   * Group name. If omitted, a unique name is generated from the app, stage,
   * and logical ID. Changing it replaces the group.
   */
  name?: string;
  /**
   * Name of a {@link Credential} the group's jobs run as. Omit to run jobs
   * as the worker's local system account.
   */
  credential?: string;
}

export interface HybridRunbookWorkerGroup extends Resource<
  "Azure.Automation.HybridRunbookWorkerGroup",
  HybridRunbookWorkerGroupProps,
  {
    /** Name of the group. */
    hybridRunbookWorkerGroupName: string;
    /** ARM resource ID of the group. */
    hybridRunbookWorkerGroupId: string;
    /** Automation account that holds the group. */
    automationAccount: string;
    /** Resource group of the Automation account. */
    resourceGroup: string;
    /** Group type (`User` or `System`). */
    groupType: string | undefined;
    /** Run As credential name. */
    credential: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A hybrid runbook worker group in an Azure Automation account: a pool of
 * machines (Azure VMs or Arc servers) that run runbooks inside your own
 * network. Pass its name as `runOn` of a {@link JobSchedule} or
 * {@link Webhook}.
 *
 * @see https://learn.microsoft.com/azure/automation/automation-hybrid-runbook-worker
 *
 * ### Creating a Worker Group
 * **Example:** Group that runs jobs as a credential
 * ```typescript
 * const runAs = yield* Azure.Automation.Credential("run-as", {
 *   resourceGroup: group.resourceGroupName,
 *   automationAccount: account.automationAccountName,
 *   userName: "svc-runbooks",
 *   password: Redacted.make(password),
 * });
 * const workers = yield* Azure.Automation.HybridRunbookWorkerGroup("onprem", {
 *   resourceGroup: group.resourceGroupName,
 *   automationAccount: account.automationAccountName,
 *   credential: runAs.credentialName,
 * });
 * ```
 *
 * @resource
 */
export const HybridRunbookWorkerGroup = Resource<HybridRunbookWorkerGroup>(
  "Azure.Automation.HybridRunbookWorkerGroup",
);

export const getWorkerGroup = (
  subscriptionId: string,
  resourceGroupName: string,
  automationAccountName: string,
  hybridRunbookWorkerGroupName: string,
) =>
  orUndefinedIfNotFound(
    automation.GetHybridRunbookWorkerGroup({
      subscriptionId,
      resourceGroupName,
      automationAccountName,
      hybridRunbookWorkerGroupName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  automationAccount: string,
  name: string,
  group: automation.GetHybridRunbookWorkerGroupResponse,
): HybridRunbookWorkerGroup["Attributes"] => ({
  hybridRunbookWorkerGroupName: name,
  hybridRunbookWorkerGroupId: group.id ?? "",
  automationAccount,
  resourceGroup,
  groupType: group.properties?.groupType,
  credential: group.properties?.credential?.name ?? undefined,
});

export const HybridRunbookWorkerGroupProvider = () =>
  Provider.succeed(HybridRunbookWorkerGroup, {
    stables: [
      "hybridRunbookWorkerGroupName",
      "hybridRunbookWorkerGroupId",
      "automationAccount",
      "resourceGroup",
    ],

    // Worker groups live inside an account; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.automationAccount, output.automationAccount) ||
        (news.name !== undefined &&
          !sameName(news.name, output.hybridRunbookWorkerGroupName))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const account = output?.automationAccount ?? olds?.automationAccount;
      if (resourceGroup === undefined || account === undefined) {
        return undefined;
      }
      const name =
        output?.hybridRunbookWorkerGroupName ??
        olds?.name ??
        (yield* createChildName(id));
      const observed = yield* getWorkerGroup(
        subscriptionId,
        resourceGroup,
        account,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, account, name, observed);
      return (yield* accountOwnedByStage(subscriptionId, resourceGroup, account))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Automation");
      const { resourceGroup, automationAccount } = news;
      const name =
        news.name ??
        output?.hybridRunbookWorkerGroupName ??
        (yield* createChildName(id));
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        automationAccountName: automationAccount,
        hybridRunbookWorkerGroupName: name,
      };
      const get = getWorkerGroup(
        subscriptionId,
        resourceGroup,
        automationAccount,
        name,
      );
      const credential = news.credential ? { name: news.credential } : undefined;

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* automation.CreateHybridRunbookWorkerGroup({
          ...where,
          name,
          properties: { credential },
        });
        observed = yield* waitForProvisioned(
          `hybrid worker group ${name}`,
          get,
          () => undefined,
          { interval: "2 seconds", times: 15 },
        );
      }

      // Sync the Run As credential against observed.
      if (
        (observed.properties?.credential?.name ?? undefined) !==
        news.credential
      ) {
        observed = yield* automation.UpdateHybridRunbookWorkerGroup({
          ...where,
          name,
          properties: { credential: credential ?? { name: "" } },
        });
      }

      return toAttrs(resourceGroup, automationAccount, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        automation.DeleteHybridRunbookWorkerGroup({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          automationAccountName: output.automationAccount,
          hybridRunbookWorkerGroupName: output.hybridRunbookWorkerGroupName,
        }),
      );
      yield* waitUntilGone(
        `hybrid worker group ${output.hybridRunbookWorkerGroupName}`,
        getWorkerGroup(
          subscriptionId,
          output.resourceGroup,
          output.automationAccount,
          output.hybridRunbookWorkerGroupName,
        ),
      );
    }),

    nuke: childNuke,
  });
