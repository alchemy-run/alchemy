import * as resources from "@distilled.cloud/azure/resources";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  hasAnyAlchemyTag,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  requireSinglePage,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  comparableMetadata,
  fromParameterValues,
  metadataTags,
  metadataWithMarker,
  sameId,
  sameJson,
  toParameterValues,
} from "../Resources/Shared.ts";

/** Managed identity of a policy assignment (needed by `modify`/`deployIfNotExists`). */
export interface PolicyAssignmentIdentity {
  /** `SystemAssigned`, `UserAssigned`, or `None`. */
  type: "SystemAssigned" | "UserAssigned" | "None";
  /** ARM IDs of user-assigned identities (with `type: "UserAssigned"`). */
  userAssignedIdentityIds?: string[];
}

/** Message shown when a resource is non-compliant. */
export interface PolicyNonComplianceMessage {
  /** Message text. */
  message: string;
  /** Member of a policy set the message applies to (initiatives only). */
  policyDefinitionReferenceId?: string;
}

export interface PolicyAssignmentProps {
  /**
   * ARM ID of the scope the policy applies to — a subscription
   * (`/subscriptions/{id}`), a resource group (`group.resourceGroupId`), or
   * a single resource. Changing it replaces the assignment.
   */
  scope: string;
  /**
   * Name of the assignment. At most 64 characters (24 at management-group
   * scope), without `<>*%&:\?.+/`. If omitted, a unique name is generated
   * from the app, stage, and logical ID. Changing it replaces the assignment.
   */
  name?: string;
  /**
   * ID of the policy definition or policy set definition to assign, e.g.
   * `definition.policyDefinitionId` or a built-in
   * `/providers/Microsoft.Authorization/policyDefinitions/{guid}`.
   * Changing it replaces the assignment.
   */
  policyDefinitionId: string;
  /** Version of the definition to use, e.g. `1.*.*`. */
  definitionVersion?: string;
  /** Display name shown in the portal. */
  displayName?: string;
  /** Description of the assignment. */
  description?: string;
  /** Parameter values, e.g. `{ tagName: "owner" }`. */
  parameters?: Record<string, unknown>;
  /** Child scopes excluded from the assignment. */
  notScopes?: string[];
  /**
   * `Default` enforces the effect; `DoNotEnforce` only evaluates
   * compliance.
   * @default "Default"
   */
  enforcementMode?: "Default" | "DoNotEnforce";
  /** Messages explaining why a resource is non-compliant. */
  nonComplianceMessages?: PolicyNonComplianceMessage[];
  /**
   * Metadata of the assignment. Alchemy merges ownership entries
   * (`alchemy::stack`, `alchemy::stage`, `alchemy::id`) in because
   * assignments have no tags.
   */
  metadata?: Record<string, unknown>;
  /**
   * Managed identity used by `modify` and `deployIfNotExists` effects.
   * Requires `location`.
   */
  identity?: PolicyAssignmentIdentity;
  /**
   * Location of the assignment's managed identity. Required with
   * `identity`. Changing it replaces the assignment.
   */
  location?: string;
}

export interface PolicyAssignment extends Resource<
  "Azure.Policy.PolicyAssignment",
  PolicyAssignmentProps,
  {
    /** Name of the assignment. */
    policyAssignmentName: string;
    /** ARM ID, `{scope}/providers/Microsoft.Authorization/policyAssignments/{name}`. */
    policyAssignmentId: string;
    /** Scope the policy applies to. */
    scope: string;
    /** ID of the assigned policy (set) definition. */
    policyDefinitionId: string;
    /** Enforcement mode. */
    enforcementMode: string | undefined;
    /** Principal ID of the system-assigned identity, when one is enabled. */
    principalId: string | undefined;
    /** Location of the assignment's identity, when set. */
    location: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An Azure Policy assignment — applies a policy definition or policy set
 * (initiative) to a subscription, resource group, or resource.
 *
 * Assignments cannot be tagged, so Alchemy records ownership as
 * `alchemy::*` entries in the assignment's `metadata`.
 *
 * @see https://learn.microsoft.com/azure/governance/policy/concepts/assignment-structure
 *
 * ### Assigning a Built-in Policy
 * **Example:** Audit a missing tag on a resource group (built-in definition)
 * ```typescript
 * yield* Azure.Policy.PolicyAssignment("require-owner-tag", {
 *   scope: group.resourceGroupId,
 *   // Built-in "Require a tag on resources"
 *   policyDefinitionId:
 *     "/providers/Microsoft.Authorization/policyDefinitions/871b6d14-10aa-478d-b590-94f262ecfa99",
 *   parameters: { tagName: "owner" },
 *   enforcementMode: "DoNotEnforce",
 * });
 * ```
 *
 * ### Assigning a Custom Policy
 * **Example:** Assign a custom definition with a non-compliance message
 * ```typescript
 * const definition = yield* Azure.Policy.PolicyDefinition("allowed-locations", {
 *   policyRule: {
 *     if: { field: "location", notIn: ["eastus", "global"] },
 *     then: { effect: "deny" },
 *   },
 * });
 * yield* Azure.Policy.PolicyAssignment("allowed-locations", {
 *   scope: group.resourceGroupId,
 *   policyDefinitionId: definition.policyDefinitionId,
 *   nonComplianceMessages: [{ message: "Only eastus is allowed" }],
 * });
 * ```
 *
 * ### Remediation Identity
 * **Example:** System-assigned identity for `modify` effects
 * ```typescript
 * const assignment = yield* Azure.Policy.PolicyAssignment("inherit-tags", {
 *   scope: group.resourceGroupId,
 *   policyDefinitionId: definition.policyDefinitionId,
 *   identity: { type: "SystemAssigned" },
 *   location: "eastus",
 * });
 * // Grant assignment.principalId a role so remediation can modify resources.
 * ```
 *
 * @resource
 */
export const PolicyAssignment = Resource<PolicyAssignment>(
  "Azure.Policy.PolicyAssignment",
);

const assignmentName = (id: string, name: string | undefined) =>
  name !== undefined ? Effect.succeed(name) : createPhysicalName({ id });

const getAssignment = (scope: string, policyAssignmentName: string) =>
  orUndefinedIfNotFound(
    resources.GetPolicyAssignment({ scope, policyAssignmentName }),
  );

const toAttrs = (
  scope: string,
  name: string,
  observed: resources.GetPolicyAssignmentResponse,
): PolicyAssignment["Attributes"] => ({
  policyAssignmentName: name,
  policyAssignmentId:
    observed.id ??
    `${scope}/providers/Microsoft.Authorization/policyAssignments/${name}`,
  scope: observed.properties?.scope ?? scope,
  policyDefinitionId: observed.properties?.policyDefinitionId ?? "",
  enforcementMode: observed.properties?.enforcementMode,
  principalId: observed.identity?.principalId,
  location: observed.location,
});

const toIdentity = (identity: PolicyAssignmentIdentity | undefined) =>
  identity === undefined
    ? undefined
    : {
        type: identity.type,
        userAssignedIdentities:
          identity.userAssignedIdentityIds === undefined
            ? undefined
            : Object.fromEntries(
                identity.userAssignedIdentityIds.map((id) => [id, {}]),
              ),
      };

const identityMatches = (
  observed: resources.Identity | undefined,
  desired: PolicyAssignmentIdentity | undefined,
) => {
  const observedType = observed?.type ?? "None";
  const desiredType = desired?.type ?? "None";
  if (observedType !== desiredType) return false;
  const observedIds = Object.keys(observed?.userAssignedIdentities ?? {})
    .map((id) => id.toLowerCase())
    .sort();
  const desiredIds = (desired?.userAssignedIdentityIds ?? [])
    .map((id) => id.toLowerCase())
    .sort();
  return sameJson(observedIds, desiredIds);
};

export const PolicyAssignmentProvider = () =>
  Provider.succeed(PolicyAssignment, {
    stables: ["policyAssignmentName", "policyAssignmentId", "scope"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* resources
        .ListPolicyAssignments({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListPolicyAssignments", page),
          ),
        );
      return page.value.flatMap((assignment) =>
        assignment.name !== undefined &&
        assignment.properties?.scope !== undefined &&
        hasAnyAlchemyTag(metadataTags(assignment.properties.metadata))
          ? [toAttrs(assignment.properties.scope, assignment.name, assignment)]
          : [],
      );
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (output === undefined) return undefined;
      // An unresolved scope or definition means its resource is being
      // replaced.
      if (!isResolved(news.scope) || !isResolved(news.policyDefinitionId)) {
        return { action: "replace" } as const;
      }
      if (!isResolved(news)) return undefined;
      if (
        !sameId(news.scope, output.scope) ||
        !sameId(news.policyDefinitionId, output.policyDefinitionId) ||
        (news.name !== undefined &&
          news.name.toLowerCase() !==
            output.policyAssignmentName.toLowerCase()) ||
        (news.location ?? "").toLowerCase() !==
          (output.location ?? "").toLowerCase()
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const scope = output?.scope ?? olds?.scope;
      if (scope === undefined) return undefined;
      const name =
        output?.policyAssignmentName ?? (yield* assignmentName(id, olds?.name));
      const observed = yield* getAssignment(scope, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(scope, name, observed);
      return (yield* isOwned(id, metadataTags(observed.properties?.metadata)))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Authorization");
      const scope = news.scope;
      const name =
        output?.policyAssignmentName ?? (yield* assignmentName(id, news.name));
      const metadata = yield* metadataWithMarker(id, news.metadata);

      // Observe.
      const observed = yield* getAssignment(scope, name);
      const current = observed?.properties;

      // Ensure + sync. The PUT is a full, idempotent write; skip it when
      // every user-controlled field already matches.
      if (
        observed === undefined ||
        current === undefined ||
        !sameId(current.policyDefinitionId, news.policyDefinitionId) ||
        current.displayName !== news.displayName ||
        current.description !== news.description ||
        (news.definitionVersion !== undefined &&
          current.definitionVersion !== news.definitionVersion) ||
        !sameJson(
          fromParameterValues(current.parameters),
          news.parameters ?? {},
        ) ||
        !sameJson(current.notScopes ?? [], news.notScopes ?? []) ||
        (current.enforcementMode ?? "Default") !==
          (news.enforcementMode ?? "Default") ||
        !sameJson(
          current.nonComplianceMessages ?? [],
          news.nonComplianceMessages ?? [],
        ) ||
        !sameJson(comparableMetadata(current.metadata), metadata) ||
        !identityMatches(observed.identity, news.identity)
      ) {
        yield* resources.CreatePolicyAssignment({
          scope,
          policyAssignmentName: name,
          location: news.location,
          identity: toIdentity(news.identity),
          properties: {
            policyDefinitionId: news.policyDefinitionId,
            definitionVersion: news.definitionVersion,
            displayName: news.displayName,
            description: news.description,
            parameters: toParameterValues(news.parameters),
            notScopes: news.notScopes,
            enforcementMode: news.enforcementMode ?? "Default",
            nonComplianceMessages: news.nonComplianceMessages,
            metadata,
          },
        });
      }

      const fresh = yield* waitForProvisioned(
        `policy assignment ${name}`,
        getAssignment(scope, name),
        () => undefined,
        { interval: "2 seconds", times: 15 },
      );
      return toAttrs(scope, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* ignoreNotFound(
        resources.DeletePolicyAssignment({
          scope: output.scope,
          policyAssignmentName: output.policyAssignmentName,
        }),
      );
      yield* waitUntilGone(
        `policy assignment ${output.policyAssignmentName}`,
        getAssignment(output.scope, output.policyAssignmentName),
      );
    }),

    nuke: {
      // The assigned definitions and the scope must outlive the assignment.
      dependsOn: [
        "Azure.Policy.PolicyDefinition",
        "Azure.Policy.PolicySetDefinition",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
