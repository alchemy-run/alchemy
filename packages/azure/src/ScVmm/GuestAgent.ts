import * as scvmm from "@distilled.cloud/azure/scvmm";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { isMachineStackOwned, reveal, SCVMM_NAMESPACE, sameId } from "./Common.ts";

export interface GuestAgentProps {
  /**
   * ARM ID of the Arc-enabled server whose SCVMM VM instance gets the guest
   * agent. The `Azure.ScVmm.VirtualMachineInstance` must already exist.
   * Changing it replaces the agent.
   */
  machineId: string;
  /**
   * Guest OS user name used to install the agent. Changing it replaces the agent.
   * @default no credentials are sent
   */
  username?: string;
  /**
   * Guest OS password used to install the agent. Never returned by Azure.
   * Changing it replaces the agent.
   * @default no credentials are sent
   */
  password?: string | Redacted.Redacted<string>;
  /**
   * HTTPS proxy URL the agent uses to reach Azure. Changing it replaces the agent.
   * @default no proxy
   */
  httpsProxy?: string;
  /**
   * ARM ID of the Arc private link scope the machine is assigned to.
   * Changing it replaces the agent.
   * @default no private link scope
   */
  privateLinkScopeResourceId?: string;
  /**
   * Action to perform on the agent. Re-applied in place when changed.
   * @default "install"
   */
  provisioningAction?: "install" | "uninstall" | "repair";
}

export interface GuestAgent extends Resource<
  "Azure.ScVmm.GuestAgent",
  GuestAgentProps,
  {
    /** ARM ID of the Arc-enabled server whose VM runs the agent. */
    machineId: string;
    /** ARM resource ID of the guest agent. */
    guestAgentId: string;
    /** Unique ID of the guest agent. */
    uuid: string | undefined;
    /** Last action performed on the agent. */
    provisioningAction: string | undefined;
    /** Status reported by the agent. */
    status: string | undefined;
    /** Name of the corresponding custom resource in the resource bridge. */
    customResourceName: string | undefined;
    /** Provisioning state of the agent. */
    provisioningState: string | undefined;
  },
  never,
  Providers
> {}

/**
 * The Arc guest agent of an SCVMM VM
 * (`Microsoft.ScVmm/virtualMachineInstances/guestAgents`, the singleton
 * `virtualMachineInstances/default/guestAgents/default`). Installing it
 * turns on guest management (extensions, run commands) for a VM on an
 * Arc-enabled System Center Virtual Machine Manager. See the
 * [Azure docs](https://learn.microsoft.com/azure/azure-arc/system-center-virtual-machine-manager/enable-guest-management-at-scale).
 *
 * The agent has no tags. Alchemy treats it as owned when the VM's Arc
 * machine carries this stack's ownership tags.
 *
 * :::caution
 * The `Azure.ScVmm.VirtualMachineInstance` for `machineId` must already
 * exist.
 * :::
 *
 * :::caution
 * Azure has no update operation. Changing `machineId`, `username`,
 * `password`, `httpsProxy`, or `privateLinkScopeResourceId` replaces the
 * agent. Alchemy re-applies `provisioningAction` in place.
 * :::
 *
 * ### Enabling Guest Management
 * **Example:** Install the guest agent on an SCVMM VM
 * ```typescript
 * const password = yield* Config.redacted("VM_ADMIN_PASSWORD");
 * const machine = yield* Azure.HybridCompute.Machine("vm", {
 *   kind: "SCVMM",
 * });
 * yield* Azure.ScVmm.GuestAgent("agent", {
 *   machineId: machine.machineId,
 *   username: "Administrator",
 *   password,
 * });
 * ```
 *
 * **Example:** Install through an HTTPS proxy
 * ```typescript
 * const password = yield* Config.redacted("VM_ADMIN_PASSWORD");
 * const machine = yield* Azure.HybridCompute.Machine("vm", {
 *   kind: "SCVMM",
 * });
 * yield* Azure.ScVmm.GuestAgent("agent", {
 *   machineId: machine.machineId,
 *   username: "Administrator",
 *   password,
 *   httpsProxy: "http://proxy.contoso.local:3128",
 * });
 * ```
 *
 * @resource
 */
export const GuestAgent = Resource<GuestAgent>("Azure.ScVmm.GuestAgent");

const getAgent = (resourceUri: string) =>
  orUndefinedIfNotFound(scvmm.GetGuestAgent({ resourceUri }));

const toAttrs = (
  machineId: string,
  agent: scvmm.GetGuestAgentResponse,
): GuestAgent["Attributes"] => ({
  machineId,
  guestAgentId: agent.id ?? "",
  uuid: agent.properties?.uuid,
  provisioningAction: agent.properties?.provisioningAction,
  status: agent.properties?.status,
  customResourceName: agent.properties?.customResourceName,
  provisioningState: agent.properties?.provisioningState,
});

export const GuestAgentProvider = () =>
  Provider.succeed(GuestAgent, {
    stables: ["machineId", "guestAgentId"],

    // Guest agents are removed with their VM instance.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameId(news.machineId, output.machineId) ||
        (olds !== undefined &&
          (news.username !== olds.username ||
            reveal(news.password) !== reveal(olds.password) ||
            news.httpsProxy !== olds.httpsProxy ||
            !sameId(news.privateLinkScopeResourceId, olds.privateLinkScopeResourceId)))
      ) {
        // The name is fixed per parent, so the old one must go first.
        return { action: "replace", deleteFirst: true } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const machineId = output?.machineId ?? olds?.machineId;
      if (machineId === undefined) return undefined;
      const observed = yield* getAgent(machineId);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(machineId, observed);
      return (yield* isMachineStackOwned(machineId)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, SCVMM_NAMESPACE);
      const { machineId } = news;
      const action = news.provisioningAction ?? "install";
      const get = getAgent(machineId);

      // Observe.
      const observed = yield* get;

      // Ensure + sync the action through the PUT upsert.
      if (observed === undefined || observed.properties?.provisioningAction !== action) {
        yield* scvmm.CreateGuestAgent({
          resourceUri: machineId,
          properties: {
            provisioningAction: action,
            credentials:
              news.username === undefined || news.password === undefined
                ? undefined
                : { username: news.username, password: news.password },
            httpProxyConfig:
              news.httpsProxy === undefined ? undefined : { httpsProxy: news.httpsProxy },
            privateLinkScopeResourceId: news.privateLinkScopeResourceId,
          },
        });
      }

      const fresh = yield* waitForProvisioned(
        `SCVMM guest agent of ${machineId}`,
        get,
        (agent) => agent.properties?.provisioningState,
        { interval: "10 seconds", times: 60 },
      );
      return toAttrs(machineId, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* ignoreNotFound(scvmm.DeleteGuestAgent({ resourceUri: output.machineId }));
      yield* waitUntilGone(`SCVMM guest agent of ${output.machineId}`, getAgent(output.machineId), {
        interval: "10 seconds",
        times: 60,
      });
    }),

    nuke: {
      dependsOn: [
        "Azure.Resources.ResourceGroup",
        "Azure.HybridCompute.Machine",
        "Azure.ScVmm.VirtualMachineInstance",
      ],
    },
  });
