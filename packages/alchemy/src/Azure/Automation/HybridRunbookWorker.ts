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
import { deterministicGuid } from "../Authorization/Ownership.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { accountOwnedByStage, sameName } from "./Common.ts";

export interface HybridRunbookWorkerProps {
  /** Resource group of the Automation account. Changing it replaces the worker. */
  resourceGroup: string;
  /** Automation account of the worker group. Changing it replaces the worker. */
  automationAccount: string;
  /** {@link HybridRunbookWorkerGroup} the worker joins. Changing it replaces the worker. */
  hybridRunbookWorkerGroup: string;
  /**
   * ARM resource ID of the Azure VM or Arc-enabled server that acts as the
   * worker. The machine also needs the Hybrid Worker extension
   * (`HybridWorkerForWindows`/`HybridWorkerForLinux`) pointed at the
   * account's `automationHybridServiceUrl`. Changing it replaces the worker.
   */
  vmResourceId: string;
}

export interface HybridRunbookWorker extends Resource<
  "Azure.Automation.HybridRunbookWorker",
  HybridRunbookWorkerProps,
  {
    /** Worker ID (a GUID). */
    hybridRunbookWorkerId: string;
    /** ARM resource ID of the worker. */
    hybridRunbookWorkerResourceId: string;
    /** Automation account of the worker group. */
    automationAccount: string;
    /** Resource group of the Automation account. */
    resourceGroup: string;
    /** Worker group the worker belongs to. */
    hybridRunbookWorkerGroup: string;
    /** Machine that acts as the worker. */
    vmResourceId: string | undefined;
    /** IP address of the worker machine. */
    ip: string | undefined;
    /** Worker type (`HybridV1` or `HybridV2`). */
    workerType: string | undefined;
    /** Name of the worker machine. */
    workerName: string | undefined;
    /** When the worker last reported in. */
    lastSeenDateTime: string | undefined;
  },
  never,
  Providers
> {}

/**
 * Registers an Azure VM or Arc-enabled server as an extension-based (V2)
 * hybrid runbook worker in a {@link HybridRunbookWorkerGroup}.
 *
 * @see https://learn.microsoft.com/azure/automation/extension-based-hybrid-runbook-worker-install
 *
 * ### Adding a Worker
 * **Example:** Register a VM, then install the worker extension
 * ```typescript
 * const worker = yield* Azure.Automation.HybridRunbookWorker("vm1", {
 *   resourceGroup: group.resourceGroupName,
 *   automationAccount: account.automationAccountName,
 *   hybridRunbookWorkerGroup: workers.hybridRunbookWorkerGroupName,
 *   vmResourceId: vm.virtualMachineId,
 * });
 * ```
 *
 * @resource
 */
export const HybridRunbookWorker = Resource<HybridRunbookWorker>(
  "Azure.Automation.HybridRunbookWorker",
);

const getWorker = (
  subscriptionId: string,
  resourceGroupName: string,
  automationAccountName: string,
  hybridRunbookWorkerGroupName: string,
  hybridRunbookWorkerId: string,
) =>
  orUndefinedIfNotFound(
    automation.GetHybridRunbookWorker({
      subscriptionId,
      resourceGroupName,
      automationAccountName,
      hybridRunbookWorkerGroupName,
      hybridRunbookWorkerId,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  automationAccount: string,
  group: string,
  workerId: string,
  worker: automation.GetHybridRunbookWorkerResponse,
): HybridRunbookWorker["Attributes"] => ({
  hybridRunbookWorkerId: workerId,
  hybridRunbookWorkerResourceId: worker.id ?? "",
  automationAccount,
  resourceGroup,
  hybridRunbookWorkerGroup: group,
  vmResourceId: worker.properties?.vmResourceId,
  ip: worker.properties?.ip,
  workerType: worker.properties?.workerType,
  workerName: worker.properties?.workerName,
  lastSeenDateTime: worker.properties?.lastSeenDateTime,
});

export const HybridRunbookWorkerProvider = () =>
  Provider.succeed(HybridRunbookWorker, {
    stables: [
      "hybridRunbookWorkerId",
      "hybridRunbookWorkerResourceId",
      "automationAccount",
      "resourceGroup",
      "hybridRunbookWorkerGroup",
    ],

    // Workers live inside a worker group; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        !sameName(news.automationAccount, output.automationAccount) ||
        !sameName(
          news.hybridRunbookWorkerGroup,
          output.hybridRunbookWorkerGroup,
        ) ||
        !sameName(news.vmResourceId, output.vmResourceId)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, instanceId, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const account = output?.automationAccount ?? olds?.automationAccount;
      const group =
        output?.hybridRunbookWorkerGroup ?? olds?.hybridRunbookWorkerGroup;
      if (
        resourceGroup === undefined ||
        account === undefined ||
        group === undefined
      ) {
        return undefined;
      }
      const workerId =
        output?.hybridRunbookWorkerId ??
        (yield* deterministicGuid(id, instanceId));
      const observed = yield* getWorker(
        subscriptionId,
        resourceGroup,
        account,
        group,
        workerId,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, account, group, workerId, observed);
      return (yield* accountOwnedByStage(
        subscriptionId,
        resourceGroup,
        account,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    // Existence-only: every property is fixed at creation.
    reconcile: Effect.fn(function* ({ id, instanceId, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Automation");
      const { resourceGroup, automationAccount, hybridRunbookWorkerGroup } =
        news;
      const workerId =
        output?.hybridRunbookWorkerId ??
        (yield* deterministicGuid(id, instanceId));
      const get = getWorker(
        subscriptionId,
        resourceGroup,
        automationAccount,
        hybridRunbookWorkerGroup,
        workerId,
      );

      // Observe → ensure.
      if ((yield* get) === undefined) {
        yield* automation.CreateHybridRunbookWorker({
          subscriptionId,
          resourceGroupName: resourceGroup,
          automationAccountName: automationAccount,
          hybridRunbookWorkerGroupName: hybridRunbookWorkerGroup,
          hybridRunbookWorkerId: workerId,
          properties: { vmResourceId: news.vmResourceId },
        });
      }

      const fresh = yield* waitForProvisioned(
        `hybrid runbook worker ${workerId}`,
        get,
        () => undefined,
        { interval: "2 seconds", times: 15 },
      );
      return toAttrs(
        resourceGroup,
        automationAccount,
        hybridRunbookWorkerGroup,
        workerId,
        fresh,
      );
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        automation.DeleteHybridRunbookWorker({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          automationAccountName: output.automationAccount,
          hybridRunbookWorkerGroupName: output.hybridRunbookWorkerGroup,
          hybridRunbookWorkerId: output.hybridRunbookWorkerId,
        }),
      );
      yield* waitUntilGone(
        `hybrid runbook worker ${output.hybridRunbookWorkerId}`,
        getWorker(
          subscriptionId,
          output.resourceGroup,
          output.automationAccount,
          output.hybridRunbookWorkerGroup,
          output.hybridRunbookWorkerId,
        ),
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.Automation.HybridRunbookWorkerGroup",
        "Azure.Automation.AutomationAccount",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
