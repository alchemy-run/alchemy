import * as compute from "@distilled.cloud/azure/compute";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { createPhysicalName } from "../../PhysicalName.ts";
import {
  orUndefinedIfNotFound,
  waitForProvisioned,
  waitUntilGone,
  type WaitBudget,
} from "../Arm.ts";

// Shared Microsoft.Compute helpers. Internal: not exported from index.ts.

export const lower = (value: string | undefined) => value?.toLowerCase();

/** Case-insensitive equality of ARM names, IDs, and locations. */
export const sameId = (a: string | undefined, b: string | undefined) =>
  lower(a) === lower(b);

/** `{ id }` sub-resource reference, or `undefined`. */
export const ref = (id: string | undefined) =>
  id === undefined ? undefined : { id };

/** Order-insensitive list equality (`undefined` = `[]`). */
export const sameSet = (
  a: ReadonlyArray<string> | undefined,
  b: ReadonlyArray<string> | undefined,
) => {
  const left = (a ?? []).map((v) => v.toLowerCase()).sort();
  const right = (b ?? []).map((v) => v.toLowerCase()).sort();
  return left.length === right.length && left.every((v, i) => v === right[i]);
};

/** Canonical JSON (sorted keys, `undefined` dropped) for structural diffs. */
export const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, v) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, (v as Record<string, unknown>)[k]]),
        )
      : v,
  );

/** IDs of `{ id }` sub-resource references. */
export const idsOf = (
  refs: ReadonlyArray<{ readonly id?: string }> | undefined,
): string[] => (refs ?? []).flatMap((r) => (r.id ? [r.id] : []));

/**
 * Physical name for a Microsoft.Compute resource: letters, digits, `_`,
 * `.`, `-` (most types allow 1-80 characters; VMs 1-64).
 */
export const createComputeName = (id: string, maxLength = 80) =>
  createPhysicalName({ id, maxLength });

/**
 * Compute serialises operations per VM / scale set and rejects a
 * concurrent one with `OperationNotAllowed` / `Conflict`
 * ("another operation is in progress").
 */
export const whileComputeBusy = {
  while: (e: { readonly _tag: string }) =>
    e._tag === "ResourceConflict" || e._tag === "ComputeOperationInProgress",
  schedule: Schedule.spaced("5 seconds"),
  times: 24,
} as const;

/** Wait for a Microsoft.Compute resource to reach `Succeeded`. */
export const waitComputeProvisioned = <
  A extends { readonly properties?: { readonly provisioningState?: string } },
  E,
  R,
>(
  label: string,
  get: Effect.Effect<A | undefined, E, R>,
  budget: WaitBudget = { interval: "5 seconds", times: 120 },
) =>
  waitForProvisioned(
    label,
    get,
    (value) => value.properties?.provisioningState,
    budget,
  );

/** Wait for a deleted Microsoft.Compute resource to disappear. */
export const waitComputeGone = <A, E, R>(
  label: string,
  get: Effect.Effect<A | undefined, E, R>,
  budget: WaitBudget = { interval: "5 seconds", times: 120 },
) => waitUntilGone(label, get, budget);

/** Location of a VM, or `undefined` if it does not exist. */
export const vmLocation = (
  subscriptionId: string,
  resourceGroupName: string,
  vmName: string,
) =>
  orUndefinedIfNotFound(
    compute.GetVirtualMachine({ subscriptionId, resourceGroupName, vmName }),
  ).pipe(Effect.map((vm) => vm?.location));

/** Canonical form of protected settings (redacted or not). */
export const protectedKey = (value: unknown) =>
  value === undefined
    ? undefined
    : canonical(Redacted.isRedacted(value) ? Redacted.value(value) : value);

/** Props shared by VM run commands and diagnostic run commands. */
export interface RunCommandSourceProps {
  /** Inline script to run. */
  script?: string;
  /** URI of a script to download and run (a SAS URL or public URL). */
  scriptUri?: string;
  /** ID of a built-in command, e.g. `RunShellScript` or `RunPowerShellScript`. */
  commandId?: string;
  /** Shell for Windows scripts (`Default` = PowerShell 5, `Powershell7`). */
  scriptShell?: "Default" | "Powershell7";
  /** Script parameters (environment variables on Linux). */
  parameters?: Record<string, string>;
  /** Secret script parameters; never returned by Azure. */
  protectedParameters?: Redacted.Redacted<Record<string, string>>;
  /** Run the script as this user instead of the default system account. */
  runAsUser?: string;
  /** Password of `runAsUser`. */
  runAsPassword?: Redacted.Redacted<string>;
  /**
   * Return as soon as the script starts instead of waiting for it.
   * @default false
   */
  asyncExecution?: boolean;
  /** Script timeout in seconds. */
  timeoutInSeconds?: number;
  /** Append-blob URI (SAS or managed-identity access) to stream stdout to. */
  outputBlobUri?: string;
  /** Append-blob URI (SAS or managed-identity access) to stream stderr to. */
  errorBlobUri?: string;
  /**
   * Fail the deploy when the script exits non-zero.
   * @default true
   */
  treatFailureAsDeploymentFailure?: boolean;
}

const toParams = (params: Record<string, string> | undefined) =>
  params === undefined
    ? undefined
    : Object.entries(params).map(([name, value]) => ({ name, value }));

/** PUT body for a run command. */
export const runCommandInput = (
  props: RunCommandSourceProps,
): compute.VirtualMachineRunCommandPropertiesInput => ({
  source: {
    script: props.script,
    scriptUri: props.scriptUri,
    commandId: props.commandId,
    scriptShell: props.scriptShell,
  },
  parameters: toParams(props.parameters),
  protectedParameters: toParams(
    props.protectedParameters === undefined
      ? undefined
      : Redacted.value(props.protectedParameters),
  ),
  runAsUser: props.runAsUser,
  runAsPassword: props.runAsPassword,
  asyncExecution: props.asyncExecution ?? false,
  timeoutInSeconds: props.timeoutInSeconds,
  outputBlobUri: props.outputBlobUri,
  errorBlobUri: props.errorBlobUri,
  treatFailureAsDeploymentFailure:
    props.treatFailureAsDeploymentFailure ?? true,
});

const paramKey = (
  params:
    | ReadonlyArray<{ readonly name: string; readonly value: string }>
    | undefined,
) =>
  canonical(Object.fromEntries((params ?? []).map((p) => [p.name, p.value])));

/**
 * Whether the observed run command differs from the desired one. Secret
 * inputs (protected parameters, run-as password) are compared with the
 * previous deployment's props since Azure never returns them.
 */
export const runCommandDrifted = (
  observed: compute.VirtualMachineRunCommandProperties | undefined,
  news: RunCommandSourceProps,
  olds: RunCommandSourceProps | undefined,
) => {
  const desired = runCommandInput(news);
  const source = observed?.source;
  return (
    observed?.provisioningState === "Failed" ||
    (source?.script ?? undefined) !== desired.source?.script ||
    (source?.scriptUri ?? undefined) !== desired.source?.scriptUri ||
    (source?.commandId ?? undefined) !== desired.source?.commandId ||
    (news.scriptShell !== undefined &&
      source?.scriptShell !== news.scriptShell) ||
    paramKey(observed?.parameters) !== paramKey(desired.parameters) ||
    (observed?.asyncExecution ?? false) !== desired.asyncExecution ||
    (observed?.runAsUser ?? undefined) !== desired.runAsUser ||
    (news.timeoutInSeconds !== undefined &&
      observed?.timeoutInSeconds !== news.timeoutInSeconds) ||
    (observed?.outputBlobUri ?? undefined) !== desired.outputBlobUri ||
    (observed?.errorBlobUri ?? undefined) !== desired.errorBlobUri ||
    (observed?.treatFailureAsDeploymentFailure ?? false) !==
      desired.treatFailureAsDeploymentFailure ||
    protectedKey(olds?.protectedParameters) !==
      protectedKey(news.protectedParameters) ||
    protectedKey(olds?.runAsPassword) !== protectedKey(news.runAsPassword)
  );
};

/** Execution result attributes of a run command. */
export const runCommandResult = (
  properties: compute.VirtualMachineRunCommandProperties | undefined,
) => ({
  provisioningState: properties?.provisioningState,
  executionState: properties?.instanceView?.executionState as
    | string
    | undefined,
  exitCode: properties?.instanceView?.exitCode,
  output: properties?.instanceView?.output,
  error: properties?.instanceView?.error,
});
