import * as hci from "@distilled.cloud/azure/azurestackhci";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
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
import { HCI_NAMESPACE, isMachineStackOwned, sameId } from "./Common.ts";

export interface GuestAgentProps {
  /**
   * ARM ID of the Arc-enabled server whose Arc VM gets the guest agent.
   * The VM instance must already exist. Changing it replaces the agent.
   */
  machineId: string;
  /** Guest OS user name used to install the agent. */
  username?: string;
  /** Guest OS password used to install the agent. Never returned by Azure. */
  password?: string | Redacted.Redacted<string>;
  /**
   * Action to perform on the agent.
   * @default "install"
   */
  provisioningAction?: "install" | "uninstall" | "repair";
}

export interface GuestAgent extends Resource<
  "Azure.AzureStackHCI.GuestAgent",
  GuestAgentProps,
  {
    /** ARM ID of the Arc-enabled server whose VM runs the agent. */
    machineId: string;
    /** ARM resource ID of the guest agent. */
    guestAgentId: string;
    /** Last action performed on the agent. */
    provisioningAction: string | undefined;
    /** Status reported by the agent. */
    status: string | undefined;
    /** Provisioning state of the agent. */
    provisioningState: string | undefined;
  },
  never,
  Providers
> {}

/**
 * The Arc guest agent of an Azure Local Arc VM (the singleton
 * `virtualMachineInstances/default/guestAgents/default`). Installing it
 * enables guest management (extensions, run commands) for the VM.
 *
 * The agent has no tags; Alchemy treats it as owned when the VM's Arc
 * machine carries this stack's ownership tags.
 *
 * @see https://learn.microsoft.com/azure/azure-local/manage/manage-arc-virtual-machines
 *
 * ### Enabling Guest Management
 * **Example:** Install the guest agent on an Arc VM
 * ```typescript
 * yield* Azure.AzureStackHCI.GuestAgent("agent", {
 *   machineId: vm.machineId,
 *   username: "azureuser",
 *   password: Redacted.make(adminPassword),
 * });
 * ```
 *
 * @resource
 */
export const GuestAgent = Resource<GuestAgent>(
  "Azure.AzureStackHCI.GuestAgent",
);

const getAgent = (resourceUri: string) =>
  orUndefinedIfNotFound(hci.GetGuestAgent({ resourceUri }));

const reveal = (value: string | Redacted.Redacted<string> | undefined) =>
  value === undefined || typeof value === "string"
    ? value
    : Redacted.value(value);

const toAttrs = (
  machineId: string,
  agent: hci.GetGuestAgentResponse,
): GuestAgent["Attributes"] => ({
  machineId,
  guestAgentId: agent.id ?? "",
  provisioningAction: agent.properties.provisioningAction,
  status: agent.properties.status,
  provisioningState: agent.properties.provisioningState,
});

export const GuestAgentProvider = () =>
  Provider.succeed(GuestAgent, {
    stables: ["machineId", "guestAgentId"],

    // Guest agents are removed with their VM.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (!sameId(news.machineId, output.machineId)) {
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

    reconcile: Effect.fn(function* ({ news, olds }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, HCI_NAMESPACE);
      const { machineId } = news;
      const action = news.provisioningAction ?? "install";
      const get = getAgent(machineId);

      // Observe.
      const observed = yield* get;

      // Ensure + sync through the PUT upsert: write when missing, when the
      // observed action differs, or when the credentials (never returned)
      // changed since the last deploy.
      const credentialsChanged =
        olds !== undefined &&
        (news.username !== olds.username ||
          reveal(news.password) !== reveal(olds.password));
      if (
        observed === undefined ||
        observed.properties.provisioningAction !== action ||
        credentialsChanged
      ) {
        yield* hci.CreateGuestAgent({
          resourceUri: machineId,
          properties: {
            provisioningAction: action,
            credentials:
              news.username === undefined && news.password === undefined
                ? undefined
                : { username: news.username, password: news.password },
          },
        });
      }

      const fresh = yield* waitForProvisioned(
        `guest agent of ${machineId}`,
        get,
        (agent) => agent.properties.provisioningState,
        { interval: "10 seconds", times: 60 },
      );
      return toAttrs(machineId, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* ignoreNotFound(
        hci.DeleteGuestAgent({ resourceUri: output.machineId }),
      );
      yield* waitUntilGone(
        `guest agent of ${output.machineId}`,
        getAgent(output.machineId),
        { interval: "10 seconds", times: 60 },
      );
    }),
  });
