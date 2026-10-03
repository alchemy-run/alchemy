import * as hybridcompute from "@distilled.cloud/azure/hybridcompute";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  desiredTags,
  ensureRegistered,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { machineLocation } from "./MachineCommon.ts";

export interface MachineRunCommandParameter {
  /** Parameter name. */
  name: string;
  /** Parameter value. */
  value: string;
}

export interface MachineRunCommandProps {
  /** Resource group of the Arc machine. Changing it replaces the command. */
  resourceGroup: string;
  /** Name of the Arc machine. Changing it replaces the command. */
  machineName: string;
  /**
   * Name of the run command. If omitted, a unique name is generated from
   * the app, stage, and logical ID. Changing it replaces the command.
   */
  name?: string;
  /**
   * Azure location; must match the machine's location. Changing it
   * replaces the command.
   * @default the machine's location
   */
  location?: string;
  /** Inline script content. Set exactly one of `script`, `scriptUri`, `commandId`. */
  script?: string;
  /** URI (public, or a storage SAS URI) of the script to download. */
  scriptUri?: string;
  /** ID of a predefined built-in command. */
  commandId?: string;
  /** Parameters passed to the script. */
  parameters?: MachineRunCommandParameter[];
  /** Secret parameters passed to the script; never returned by Azure. */
  protectedParameters?: MachineRunCommandParameter[];
  /** Local user account the script runs as. */
  runAsUser?: string;
  /** Password of `runAsUser`. */
  runAsPassword?: Redacted.Redacted<string>;
  /**
   * Whether provisioning completes as soon as the script starts instead
   * of when it finishes.
   * @default false
   */
  asyncExecution?: boolean;
  /** Timeout of the script in seconds. */
  timeoutInSeconds?: number;
  /** Append blob SAS URI the script's standard output is uploaded to. */
  outputBlobUri?: string;
  /** Append blob SAS URI the script's standard error is uploaded to. */
  errorBlobUri?: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface MachineRunCommand extends Resource<
  "Azure.HybridCompute.MachineRunCommand",
  MachineRunCommandProps,
  {
    /** Name of the run command. */
    runCommandName: string;
    /** Name of the Arc machine. */
    machineName: string;
    /** Resource group of the Arc machine. */
    resourceGroup: string;
    /** ARM resource ID of the run command. */
    runCommandId: string;
    /** Location of the run command. */
    location: string;
    /** Provisioning state reported by Azure. */
    provisioningState: string | undefined;
    /** Script execution state (`Running`, `Succeeded`, `Failed`, ...). */
    executionState: string | undefined;
    /** Exit code of the script. */
    exitCode: number | undefined;
    /** Standard output of the script. */
    output: string | undefined;
    /** Standard error of the script. */
    error: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A script run on an Azure Arc-enabled server through the Connected
 * Machine agent. Changing any input re-runs the script.
 *
 * The machine must be connected (`status: "Connected"`).
 *
 * @see https://learn.microsoft.com/azure/azure-arc/servers/run-command
 *
 * ### Running Scripts
 * **Example:** Inline shell script
 * ```typescript
 * const run = yield* Azure.HybridCompute.MachineRunCommand("hostname", {
 *   resourceGroup: "arc",
 *   machineName: "web-01",
 *   script: "hostname",
 * });
 * // run.output
 * ```
 *
 * **Example:** Script with parameters
 * ```typescript
 * yield* Azure.HybridCompute.MachineRunCommand("greet", {
 *   resourceGroup: "arc",
 *   machineName: "web-01",
 *   script: "echo Hello $NAME",
 *   parameters: [{ name: "NAME", value: "Arc" }],
 *   timeoutInSeconds: 120,
 * });
 * ```
 *
 * @resource
 */
export const MachineRunCommand = Resource<MachineRunCommand>(
  "Azure.HybridCompute.MachineRunCommand",
);

type ObservedRunCommand = hybridcompute.GetMachineRunCommandResponse;

const getRunCommand = (
  subscriptionId: string,
  resourceGroupName: string,
  machineName: string,
  runCommandName: string,
) =>
  orUndefinedIfNotFound(
    hybridcompute.GetMachineRunCommand({
      subscriptionId,
      resourceGroupName,
      machineName,
      runCommandName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  machineName: string,
  name: string,
  command: ObservedRunCommand,
): MachineRunCommand["Attributes"] => ({
  runCommandName: name,
  machineName,
  resourceGroup,
  runCommandId: command.id ?? "",
  location: command.location,
  provisioningState: command.properties?.provisioningState,
  executionState: command.properties?.instanceView?.executionState,
  exitCode: command.properties?.instanceView?.exitCode,
  output: command.properties?.instanceView?.output,
  error: command.properties?.instanceView?.error,
  tags: userTags(command.tags),
});

const differs = (a: string | undefined, b: string | undefined) =>
  (a ?? "").toLowerCase() !== (b ?? "").toLowerCase();

const json = (value: unknown) => JSON.stringify(value ?? []);

const nameOf = (id: string) => createPhysicalName({ id, maxLength: 64 });

// Synchronous runs report Succeeded only once the script finishes.
const budget = { interval: "10 seconds", times: 60 } as const;

export const MachineRunCommandProvider = () =>
  Provider.succeed(MachineRunCommand, {
    stables: [
      "runCommandName",
      "machineName",
      "resourceGroup",
      "runCommandId",
      "location",
    ],

    // Run commands are deleted with their machine.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        differs(news.resourceGroup, output.resourceGroup) ||
        differs(news.machineName, output.machineName) ||
        (news.name !== undefined &&
          differs(news.name, output.runCommandName)) ||
        (news.location !== undefined && differs(news.location, output.location))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const machineName = output?.machineName ?? olds?.machineName;
      if (resourceGroup === undefined || machineName === undefined) {
        return undefined;
      }
      const name = output?.runCommandName ?? olds?.name ?? (yield* nameOf(id));
      const observed = yield* getRunCommand(
        subscriptionId,
        resourceGroup,
        machineName,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, machineName, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.HybridCompute");
      const resourceGroup = news.resourceGroup;
      const machineName = news.machineName;
      const name = news.name ?? output?.runCommandName ?? (yield* nameOf(id));
      const tags = yield* desiredTags(id, news.tags);
      const asyncExecution = news.asyncExecution ?? false;
      const label = `arc run command ${machineName}/${name}`;
      const get = getRunCommand(
        subscriptionId,
        resourceGroup,
        machineName,
        name,
      );

      // Observe.
      let observed = yield* get;
      const props = observed?.properties;

      // Ensure + sync: any change re-PUTs (and re-runs) the command.
      // Secrets are never returned, so the previous props are the only
      // hint that they changed.
      if (
        observed === undefined ||
        props?.provisioningState === "Failed" ||
        (props?.source?.script ?? "") !== (news.script ?? "") ||
        (props?.source?.scriptUri ?? "") !== (news.scriptUri ?? "") ||
        (props?.source?.commandId ?? "") !== (news.commandId ?? "") ||
        json(props?.parameters) !== json(news.parameters) ||
        (props?.runAsUser ?? "") !== (news.runAsUser ?? "") ||
        (props?.asyncExecution ?? false) !== asyncExecution ||
        (news.timeoutInSeconds !== undefined &&
          props?.timeoutInSeconds !== news.timeoutInSeconds) ||
        (props?.outputBlobUri ?? "") !== (news.outputBlobUri ?? "") ||
        (props?.errorBlobUri ?? "") !== (news.errorBlobUri ?? "") ||
        json(olds?.protectedParameters) !== json(news.protectedParameters) ||
        (olds?.runAsPassword === undefined) !==
          (news.runAsPassword === undefined) ||
        (olds?.runAsPassword !== undefined &&
          news.runAsPassword !== undefined &&
          Redacted.value(olds.runAsPassword) !==
            Redacted.value(news.runAsPassword)) ||
        tagsDiffer(observed.tags, tags)
      ) {
        const location =
          news.location ??
          observed?.location ??
          output?.location ??
          (yield* machineLocation(subscriptionId, resourceGroup, machineName));
        yield* hybridcompute.MachineRunCommandsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          machineName,
          runCommandName: name,
          location,
          tags,
          properties: {
            source: {
              script: news.script,
              scriptUri: news.scriptUri,
              commandId: news.commandId,
            },
            parameters: news.parameters,
            protectedParameters: news.protectedParameters,
            runAsUser: news.runAsUser,
            runAsPassword: news.runAsPassword,
            asyncExecution,
            timeoutInSeconds: news.timeoutInSeconds,
            outputBlobUri: news.outputBlobUri,
            errorBlobUri: news.errorBlobUri,
          },
        });
      }
      observed = yield* waitForProvisioned(
        label,
        get,
        (command) => command.properties?.provisioningState,
        budget,
      );

      return toAttrs(resourceGroup, machineName, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        hybridcompute.DeleteMachineRunCommand({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          machineName: output.machineName,
          runCommandName: output.runCommandName,
        }),
      );
      yield* waitUntilGone(
        `arc run command ${output.machineName}/${output.runCommandName}`,
        getRunCommand(
          subscriptionId,
          output.resourceGroup,
          output.machineName,
          output.runCommandName,
        ),
        budget,
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.Resources.ResourceGroup",
        "Azure.HybridCompute.Machine",
      ],
    },
  });
