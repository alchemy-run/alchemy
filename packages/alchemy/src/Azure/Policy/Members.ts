/**
 * Helpers shared by policy set definitions and their versions. Not
 * exported from the namespace barrel.
 */
import type * as resources from "@distilled.cloud/azure/resources";
import {
  fromParameterValues,
  sameId,
  sameJson,
  toParameterValues,
} from "../Resources/Shared.ts";
import type { PolicySetMember } from "./PolicySetDefinition.ts";

export const toMembers = (members: PolicySetMember[]) =>
  members.map((member) => ({
    policyDefinitionId: member.policyDefinitionId,
    policyDefinitionReferenceId: member.policyDefinitionReferenceId,
    parameters: toParameterValues(member.parameters),
    groupNames: member.groupNames,
    definitionVersion: member.definitionVersion,
  }));

/** Members match when the IDs, parameters, groups and versions match. */
export const sameMembers = (
  observed: readonly resources.PolicyDefinitionReference[],
  desired: PolicySetMember[],
) =>
  observed.length === desired.length &&
  desired.every((member, index) => {
    const current = observed[index]!;
    return (
      sameId(current.policyDefinitionId, member.policyDefinitionId) &&
      (member.policyDefinitionReferenceId === undefined ||
        current.policyDefinitionReferenceId ===
          member.policyDefinitionReferenceId) &&
      sameJson(fromParameterValues(current.parameters), member.parameters ?? {}) &&
      sameJson(current.groupNames ?? [], member.groupNames ?? []) &&
      (member.definitionVersion === undefined ||
        current.definitionVersion === member.definitionVersion)
    );
  });

