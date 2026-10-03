import type * as guestconfiguration from "@distilled.cloud/azure/guestconfiguration";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";

export type AssignmentType = guestconfiguration.AssignmentType;

/** Props shared by every guest configuration assignment host. */
export interface AssignmentProps {
  /**
   * Resource group of the host machine. Changing it replaces the
   * assignment.
   */
  resourceGroup: string;
  /**
   * Name of the assignment. Azure requires it to match the configuration
   * name (optionally followed by a `$` suffix, as Azure Policy does).
   * Changing it replaces the assignment.
   * @default the configuration name
   */
  name?: string;
  /**
   * Location of the assignment. Must equal the host machine's location.
   * Changing it replaces the assignment.
   * @default the host machine's location
   */
  location?: string;
  /**
   * Name of the guest configuration package, e.g. the built-in
   * `AzureLinuxBaseline` or `AzureWindowsBaseline`, or a custom package.
   * Changing it replaces the assignment.
   */
  configurationName: string;
  /**
   * Version of the configuration package, e.g. `1.*` for the latest 1.x of
   * a built-in package or an exact version such as `1.0.0` for a custom
   * package. Azure rejects assignments without a version.
   */
  configurationVersion: string;
  /**
   * URI of a custom configuration package (`.zip`), e.g. a blob SAS URL.
   */
  contentUri?: string;
  /**
   * SHA256 hash of the custom configuration package.
   */
  contentHash?: string;
  /**
   * ARM ID of a user-assigned managed identity with read access to
   * `contentUri`.
   */
  contentManagedIdentity?: string;
  /**
   * How the configuration is applied: `Audit` only reports compliance,
   * the others also remediate.
   * @default "Audit"
   */
  assignmentType?: AssignmentType;
  /**
   * Configuration parameters, keyed by parameter name (e.g.
   * `"Minimum Password Length;ExpectedValue"`). Names must be defined by
   * the package; Azure rejects unknown ones with
   * `GuestConfigurationAgentServiceFailed`.
   */
  parameters?: Record<string, string>;
  /**
   * Secret configuration parameters. Azure never returns them, so changes
   * are detected against the previous deployment.
   */
  protectedParameters?: Redacted.Redacted<Record<string, string>>;
}

/** Attributes shared by every guest configuration assignment host. */
export interface AssignmentAttributes {
  /** Name of the assignment. */
  assignmentName: string;
  /** ARM resource ID of the assignment. */
  assignmentId: string;
  /** Resource group of the host machine. */
  resourceGroup: string;
  /** Location of the assignment. */
  location: string;
  /** Name of the assigned configuration package. */
  configurationName: string;
  /** Version of the assigned configuration package. */
  configurationVersion: string | undefined;
  /** Assignment type (`Audit`, `ApplyAndMonitor`, ...). */
  assignmentType: string | undefined;
  /** Compliance status: `Compliant`, `NonCompliant` or `Pending`. */
  complianceStatus: string | undefined;
  /** When compliance was last checked. */
  lastComplianceStatusChecked: string | undefined;
  /** ID of the latest compliance report. */
  latestReportId: string | undefined;
  /** Combined hash of the configuration package and parameters. */
  assignmentHash: string | undefined;
  /** Provisioning state of the assignment. */
  provisioningState: string | undefined;
  /** ARM ID of the host machine. */
  targetResourceId: string | undefined;
}

/** Observed shape shared by the VM, VMSS and Arc machine GET responses. */
export interface ObservedAssignment {
  id?: string;
  name?: string;
  location?: string;
  properties?: guestconfiguration.GuestConfigurationAssignmentProperties;
}

export const assignmentNameOf = (props: {
  name?: string;
  configurationName: string;
}) => props.name ?? props.configurationName;

export const sameId = (a: string | undefined, b: string | undefined) =>
  (a ?? "").toLowerCase() === (b ?? "").toLowerCase();

const canonical = (value: Record<string, string> | undefined) =>
  JSON.stringify(
    Object.keys(value ?? {})
      .sort()
      .map((k) => [k, value?.[k]]),
  );

const protectedKey = (
  value: Redacted.Redacted<Record<string, string>> | undefined,
) => (value === undefined ? undefined : canonical(Redacted.value(value)));

const toParameterList = (params: Record<string, string> | undefined) =>
  params === undefined
    ? undefined
    : Object.entries(params).map(([name, value]) => ({ name, value }));

/** PUT body properties for the desired assignment. */
export const desiredProperties = (props: AssignmentProps) => ({
  guestConfiguration: {
    name: props.configurationName,
    version: props.configurationVersion,
    contentUri: props.contentUri,
    contentHash: props.contentHash,
    contentManagedIdentity: props.contentManagedIdentity,
    assignmentType: props.assignmentType ?? "Audit",
    configurationParameter: toParameterList(props.parameters),
    configurationProtectedParameter: toParameterList(
      props.protectedParameters === undefined
        ? undefined
        : Redacted.value(props.protectedParameters),
    ),
  },
});

/**
 * Whether the observed assignment differs from the desired one. Fields the
 * user leaves unset (version, content) accept whatever Azure resolved.
 */
export const assignmentDrifted = (
  observed: ObservedAssignment,
  news: AssignmentProps,
  olds: AssignmentProps | undefined,
) => {
  const p = observed.properties;
  const g = p?.guestConfiguration;
  const observedParams = Object.fromEntries(
    (g?.configurationParameter ?? []).map((x) => [x.name ?? "", x.value ?? ""]),
  );
  return (
    (g?.assignmentType ?? "Audit") !== (news.assignmentType ?? "Audit") ||
    g?.version !== news.configurationVersion ||
    (news.contentUri !== undefined && g?.contentUri !== news.contentUri) ||
    (news.contentHash !== undefined &&
      !sameId(g?.contentHash, news.contentHash)) ||
    (news.contentManagedIdentity !== undefined &&
      !sameId(g?.contentManagedIdentity, news.contentManagedIdentity)) ||
    canonical(observedParams) !== canonical(news.parameters ?? {}) ||
    protectedKey(olds?.protectedParameters) !==
      protectedKey(news.protectedParameters) ||
    p?.provisioningState === "Failed"
  );
};

/** Whether an immutable field changed (assignment name, location, package). */
export const assignmentReplaced = (
  news: AssignmentProps,
  output: AssignmentAttributes,
) =>
  !sameId(news.resourceGroup, output.resourceGroup) ||
  assignmentNameOf(news) !== output.assignmentName ||
  (news.location !== undefined && !sameId(news.location, output.location)) ||
  news.configurationName !== output.configurationName;

/**
 * Provisioning state for `waitForProvisioned`. `Created` is the resting
 * state until the guest agent first reports, so it counts as ready.
 */
export const assignmentState = (observed: ObservedAssignment) => {
  const state = observed.properties?.provisioningState ?? undefined;
  return state === "Created" ? undefined : state;
};

export const toAssignmentAttrs = (
  resourceGroup: string,
  name: string,
  location: string,
  configurationName: string,
  observed: ObservedAssignment,
): AssignmentAttributes => {
  const p = observed.properties;
  return {
    assignmentName: name,
    assignmentId: observed.id ?? "",
    resourceGroup,
    location: observed.location ?? location,
    configurationName: p?.guestConfiguration?.name ?? configurationName,
    configurationVersion: p?.guestConfiguration?.version,
    assignmentType: p?.guestConfiguration?.assignmentType,
    complianceStatus: p?.complianceStatus,
    lastComplianceStatusChecked: p?.lastComplianceStatusChecked ?? undefined,
    latestReportId: p?.latestReportId ?? undefined,
    assignmentHash: p?.assignmentHash ?? undefined,
    provisioningState: p?.provisioningState ?? undefined,
    targetResourceId: p?.targetResourceId ?? undefined,
  };
};

/**
 * Retry while the service intermittently fails to look up the host
 * machine (`GuestConfigurationMachineLookupFailed` for VMs and scale sets,
 * `GuestConfigurationMachineInfoUnavailable` for Arc machines; seen for
 * several minutes after the host is created).
 */
export const whileLookupFails = {
  while: (e: { readonly _tag: string }) =>
    e._tag === "GuestConfigurationMachineLookupFailed" ||
    e._tag === "GuestConfigurationMachineInfoUnavailable",
  schedule: Schedule.spaced("10 seconds"),
  times: 36,
};
