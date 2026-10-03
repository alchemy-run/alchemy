/**
 * Helpers shared by the Policy resources. Not exported from the namespace
 * barrel.
 */
import type * as resources from "@distilled.cloud/azure/resources";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import type { Input } from "../../Input.ts";
import * as Output from "../../Output.ts";
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
      sameJson(
        fromParameterValues(current.parameters),
        member.parameters ?? {},
      ) &&
      sameJson(current.groupNames ?? [], member.groupNames ?? []) &&
      (member.definitionVersion === undefined ||
        current.definitionVersion === member.definitionVersion)
    );
  });

/**
 * True when the whole plan-time `news` input is a single unresolved
 * expression rather than an object of (possibly unresolved) fields.
 */
export const isWholeExpression = <P extends object>(
  news: Input<P>,
): news is
  | Output.Output<P, any>
  | Config.Config<P>
  | Effect.Effect<P, any, any> =>
  Output.isOutput(news) || Effect.isEffect(news) || Config.isConfig(news);
