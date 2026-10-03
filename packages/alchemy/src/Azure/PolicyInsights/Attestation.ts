import * as policyinsights from "@distilled.cloud/azure/policyinsights";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
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
  metadataTags,
  metadataWithMarker,
  sameId,
  sameJson,
} from "../Resources/Shared.ts";

/** Compliance state an attestation sets on the resources in its scope. */
export type AttestationComplianceState =
  | "Compliant"
  | "NonCompliant"
  | "Unknown";

/** A piece of evidence supporting an attestation. */
export interface AttestationEvidence {
  /** Description of the evidence. */
  description?: string;
  /** URI where the evidence is stored, e.g. a document in a storage account. */
  sourceUri?: string;
}

export interface AttestationProps {
  /**
   * ARM ID of the scope being attested — a subscription
   * (`/subscriptions/{id}`), a resource group (`group.resourceGroupId`), or a
   * single resource. Must lie within the policy assignment's scope. Changing
   * it replaces the attestation.
   */
  scope: string;
  /**
   * Name of the attestation. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the attestation.
   */
  name?: string;
  /**
   * ARM ID of the policy assignment whose compliance state is attested,
   * e.g. `assignment.policyAssignmentId`. The assigned policy must use the
   * `manual` effect. Changing it replaces the attestation.
   */
  policyAssignmentId: string;
  /**
   * Member of an assigned policy set (initiative) the attestation applies
   * to. Omit to attest the whole set. Changing it replaces the attestation.
   */
  policyDefinitionReferenceId?: string;
  /**
   * Compliance state to set on the scope.
   * @default "Unknown"
   */
  complianceState?: AttestationComplianceState;
  /** ISO 8601 time at which the compliance state expires. */
  expiresOn?: string;
  /**
   * Person responsible for the attestation, typically a Microsoft Entra
   * object ID.
   */
  owner?: string;
  /** Comments describing why the attestation was made. */
  comments?: string;
  /** Evidence supporting the compliance state. */
  evidence?: AttestationEvidence[];
  /** ISO 8601 time at which the evidence was assessed. */
  assessmentDate?: string;
  /**
   * Free-form metadata. Alchemy merges ownership entries (`alchemy::stack`,
   * `alchemy::stage`, `alchemy::id`) in because attestations have no tags.
   */
  metadata?: Record<string, unknown>;
}

export interface Attestation extends Resource<
  "Azure.PolicyInsights.Attestation",
  AttestationProps,
  {
    /** Name of the attestation. */
    attestationName: string;
    /** ARM ID, `{scope}/providers/Microsoft.PolicyInsights/attestations/{name}`. */
    attestationId: string;
    /** Scope being attested. */
    scope: string;
    /** ID of the attested policy assignment. */
    policyAssignmentId: string;
    /** Policy set member the attestation applies to, if any. */
    policyDefinitionReferenceId: string | undefined;
    /** Compliance state set by the attestation. */
    complianceState: string | undefined;
    /** Provisioning state reported by Azure. */
    provisioningState: string | undefined;
    /** Time the compliance state last changed. */
    lastComplianceStateChangeAt: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An Azure Policy attestation — records the compliance state of a
 * subscription, resource group, or resource for a policy assignment whose
 * definition uses the `manual` effect (e.g. regulatory controls that need
 * human verification).
 *
 * Azure only accepts an attestation once a compliance scan has produced
 * state for the scope under the assignment. New assignments are scanned
 * within about 30 minutes; trigger an on-demand scan to speed this up.
 *
 * Azure allows one attestation per scope, assignment, and policy
 * definition reference ID. Deletes are accepted immediately but Azure
 * removes the attestation asynchronously, so a deleted attestation can stay
 * readable for a while after `destroy`.
 *
 * Attestations cannot be tagged, so Alchemy records ownership as
 * `alchemy::*` entries in the attestation's `metadata`.
 *
 * @see https://learn.microsoft.com/azure/governance/policy/concepts/attestation-structure
 *
 * ### Attesting a Manual Policy
 * **Example:** Mark a resource group compliant with evidence
 * ```typescript
 * const definition = yield* Azure.Policy.PolicyDefinition("manual-review", {
 *   mode: "All",
 *   policyRule: {
 *     if: { field: "type", equals: "Microsoft.Resources/subscriptions/resourceGroups" },
 *     then: { effect: "manual", details: { defaultState: "Unknown" } },
 *   },
 * });
 * const assignment = yield* Azure.Policy.PolicyAssignment("manual-review", {
 *   scope: group.resourceGroupId,
 *   policyDefinitionId: definition.policyDefinitionId,
 * });
 * yield* Azure.PolicyInsights.Attestation("reviewed", {
 *   scope: group.resourceGroupId,
 *   policyAssignmentId: assignment.policyAssignmentId,
 *   complianceState: "Compliant",
 *   comments: "Reviewed by the security team",
 *   evidence: [
 *     {
 *       description: "Review notes",
 *       sourceUri: "https://contoso.blob.core.windows.net/evidence/review.pdf",
 *     },
 *   ],
 * });
 * ```
 *
 * ### Expiring Attestations
 * **Example:** Attest until a fixed date
 * ```typescript
 * yield* Azure.PolicyInsights.Attestation("quarterly", {
 *   scope: group.resourceGroupId,
 *   policyAssignmentId: assignment.policyAssignmentId,
 *   complianceState: "Compliant",
 *   expiresOn: "2027-01-01T00:00:00Z",
 * });
 * ```
 *
 * @resource
 */
export const Attestation = Resource<Attestation>(
  "Azure.PolicyInsights.Attestation",
);

const SEGMENT = "/providers/Microsoft.PolicyInsights/attestations/";

const attestationName = (id: string, name: string | undefined) =>
  name !== undefined ? Effect.succeed(name) : createPhysicalName({ id });

const trimScope = (scope: string) => scope.replace(/\/+$/, "");

// The resource-scoped operations take any ARM ID, so they serve the
// subscription and resource-group scopes too.
const getAttestation = (scope: string, name: string) =>
  orUndefinedIfNotFound(
    policyinsights.GetAttestationAtResource({
      resourceId: trimScope(scope),
      attestationName: name,
    }),
  );

const sameTime = (a: string | undefined, b: string | undefined) =>
  a === b ||
  (a !== undefined &&
    b !== undefined &&
    !Number.isNaN(Date.parse(a)) &&
    Date.parse(a) === Date.parse(b));

const toAttrs = (
  scope: string,
  name: string,
  observed: policyinsights.Attestation,
): Attestation["Attributes"] => ({
  attestationName: name,
  attestationId: observed.id ?? `${trimScope(scope)}${SEGMENT}${name}`,
  scope: trimScope(scope),
  policyAssignmentId: observed.properties.policyAssignmentId,
  policyDefinitionReferenceId: observed.properties.policyDefinitionReferenceId,
  complianceState: observed.properties.complianceState,
  provisioningState: observed.properties.provisioningState,
  lastComplianceStateChangeAt: observed.properties.lastComplianceStateChangeAt,
});

export const AttestationProvider = () =>
  Provider.succeed(Attestation, {
    stables: ["attestationName", "attestationId", "scope"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* policyinsights
        .ListAttestationForSubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListAttestationForSubscription", page),
          ),
        );
      return page.value.flatMap((attestation) => {
        const index = attestation.id
          ?.toLowerCase()
          .indexOf(SEGMENT.toLowerCase());
        return attestation.id !== undefined &&
          attestation.name !== undefined &&
          index !== undefined &&
          index >= 0 &&
          hasAnyAlchemyTag(metadataTags(attestation.properties.metadata))
          ? [
              toAttrs(
                attestation.id.slice(0, index),
                attestation.name,
                attestation,
              ),
            ]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (output === undefined) return undefined;
      // An unresolved scope or assignment means its resource is being
      // replaced.
      if (!isResolved(news)) {
        return !("scope" in news) ||
          !isResolved(news.scope) ||
          !("policyAssignmentId" in news) ||
          !isResolved(news.policyAssignmentId)
          ? ({ action: "replace" } as const)
          : undefined;
      }
      const sameTarget =
        sameId(news.scope, output.scope) &&
        sameId(news.policyAssignmentId, output.policyAssignmentId) &&
        (news.policyDefinitionReferenceId ?? "").toLowerCase() ===
          (output.policyDefinitionReferenceId ?? "").toLowerCase();
      if (!sameTarget) return { action: "replace" } as const;
      // Azure allows one attestation per scope, assignment and reference
      // ID, so a rename must remove the old one first.
      if (
        news.name !== undefined &&
        news.name.toLowerCase() !== output.attestationName.toLowerCase()
      ) {
        return { action: "replace", deleteFirst: true } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const scope = output?.scope ?? olds?.scope;
      if (scope === undefined) return undefined;
      const name =
        output?.attestationName ?? (yield* attestationName(id, olds?.name));
      const observed = yield* getAttestation(scope, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(scope, name, observed);
      return (yield* isOwned(id, metadataTags(observed.properties.metadata)))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.PolicyInsights");
      const scope = trimScope(news.scope);
      const name =
        output?.attestationName ?? (yield* attestationName(id, news.name));
      const metadata = yield* metadataWithMarker(id, news.metadata);
      const complianceState = news.complianceState ?? "Unknown";

      // Observe.
      const current = (yield* getAttestation(scope, name))?.properties;

      // Ensure + sync. The PUT is a full, idempotent upsert; skip it when
      // every user-controlled field already matches.
      if (
        current === undefined ||
        !sameId(current.policyAssignmentId, news.policyAssignmentId) ||
        (current.policyDefinitionReferenceId ?? undefined) !==
          news.policyDefinitionReferenceId ||
        (current.complianceState ?? "Unknown") !== complianceState ||
        !sameTime(current.expiresOn, news.expiresOn) ||
        current.owner !== news.owner ||
        current.comments !== news.comments ||
        !sameTime(current.assessmentDate, news.assessmentDate) ||
        !sameJson(current.evidence ?? [], news.evidence ?? []) ||
        !sameJson(comparableMetadata(current.metadata), metadata)
      ) {
        yield* policyinsights
          .AttestationsCreateOrUpdateAtResource({
            resourceId: scope,
            attestationName: name,
            properties: {
              policyAssignmentId: news.policyAssignmentId,
              policyDefinitionReferenceId: news.policyDefinitionReferenceId,
              complianceState,
              expiresOn: news.expiresOn,
              owner: news.owner,
              comments: news.comments,
              evidence: news.evidence,
              assessmentDate: news.assessmentDate,
              metadata,
            },
          })
          .pipe(
            // A new manual-effect assignment has no compliance state until
            // its first scan completes; ride out a scan that is finishing.
            Effect.retry({
              while: (e) => e._tag === "AttestationComplianceDataNotFound",
              schedule: Schedule.spaced("10 seconds"),
              times: 6,
            }),
          );
      }

      const fresh = yield* waitForProvisioned(
        `policy attestation ${name}`,
        getAttestation(scope, name),
        (observed) => observed.properties.provisioningState,
        { interval: "2 seconds", times: 30 },
      );
      return toAttrs(scope, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* ignoreNotFound(
        policyinsights.DeleteAttestationAtResource({
          resourceId: output.scope,
          attestationName: output.attestationName,
        }),
      );
      // Azure acknowledges the DELETE with 200 but removes the attestation
      // asynchronously (observed: still readable after 10+ minutes, also
      // after its assignment is deleted). Wait briefly, then let the
      // assignment and scope be torn down rather than block on it.
      yield* waitUntilGone(
        `policy attestation ${output.attestationName}`,
        getAttestation(output.scope, output.attestationName),
        { interval: "3 seconds", times: 10 },
      ).pipe(
        Effect.catchTag("Azure.DeleteTimedOut", () =>
          Effect.logWarning(
            `policy attestation ${output.attestationName}: delete accepted; Azure removes it asynchronously`,
          ),
        ),
      );
    }),

    nuke: {
      // The attested assignment and the scope must outlive the attestation.
      dependsOn: [
        "Azure.Policy.PolicyAssignment",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
