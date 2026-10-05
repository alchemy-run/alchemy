import * as Azure from "@/Azure";
import { orUndefinedIfNotFound } from "@/Azure/Arm";
import * as Test from "@/Test/Alchemy";
import * as policyinsights from "@distilled.cloud/azure/policyinsights";
import * as resources from "@distilled.cloud/azure/resources";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const getAttestation = (scope: string, attestationName: string) =>
  orUndefinedIfNotFound(
    policyinsights.GetAttestationAtResource({
      resourceId: scope,
      attestationName,
    }),
  );

// A scan triggered right after an assignment is created can run before
// the assignment has propagated and report nothing, so re-trigger the scan
// each round until the assignment's compliance records appear.
const awaitComplianceData = (resourceGroupName: string, assignmentId: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    const hasState = policyinsights
      .ListPolicyStateQueryResultsForResourceGroup({
        subscriptionId,
        resourceGroupName,
        policyStatesResource: "latest",
      })
      .pipe(
        Effect.tap((page) =>
          Effect.log(
            `policy states: ${(page.value ?? []).map((state) => state.policyAssignmentName).join(", ")}`,
          ),
        ),
        Effect.map((page) =>
          (page.value ?? []).some(
            (state) =>
              state.policyAssignmentId?.toLowerCase() ===
              assignmentId.toLowerCase(),
          ),
        ),
      );
    const round = Effect.gen(function* () {
      yield* policyinsights.TriggerPolicyStateResourceGroupEvaluation({
        subscriptionId,
        resourceGroupName,
      });
      return yield* hasState.pipe(
        Effect.repeat({
          schedule: Schedule.spaced("20 seconds"),
          until: (found) => found,
          times: 18,
        }),
      );
    });
    const found = yield* round.pipe(
      Effect.repeat({ until: (found) => found, times: 7 }),
    );
    expect(found).toBe(true);
  });

const baseProgram = () =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const identity = yield* Azure.ManagedIdentity.UserAssignedIdentity(
      "Identity",
      { resourceGroup: group.resourceGroupName },
    );
    const secondary = yield* Azure.ManagedIdentity.UserAssignedIdentity(
      "SecondaryIdentity",
      { resourceGroup: group.resourceGroupName },
    );
    const definition = yield* Azure.Policy.PolicyDefinition(
      "ManualReviewRule",
      {
        mode: "Indexed",
        policyRule: {
          if: {
            field: "type",
            equals: "Microsoft.ManagedIdentity/userAssignedIdentities",
          },
          then: { effect: "manual", details: { defaultState: "Unknown" } },
        },
      },
    );
    const assignment = yield* Azure.Policy.PolicyAssignment("ManualReview", {
      scope: group.resourceGroupId,
      policyDefinitionId: definition.policyDefinitionId,
    });
    return { group, identity, secondary, assignment };
  });

const program = (attestation: {
  complianceState: "Compliant" | "NonCompliant";
  comments: string;
  evidence: Azure.PolicyInsights.AttestationEvidence[];
  target?: "primary" | "secondary";
}) =>
  Effect.gen(function* () {
    const { group, identity, secondary, assignment } = yield* baseProgram();
    const { target, ...props } = attestation;
    const attested = yield* Azure.PolicyInsights.Attestation("Reviewed", {
      scope:
        target === "secondary" ? secondary.identityId : identity.identityId,
      policyAssignmentId: assignment.policyAssignmentId,
      ...props,
    });
    return { group, identity, secondary, assignment, attested };
  });

test.provider(
  "attest a manual policy on a resource, update it, replace it, and delete it",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Azure rejects attestations until a compliance scan has evaluated
      // the scope, so deploy the assignment, scan on demand (~5 min), then
      // attest.
      const base = yield* stack.deploy(baseProgram());
      yield* awaitComplianceData(
        base.group.resourceGroupName,
        base.assignment.policyAssignmentId,
      );

      const { identity, assignment, attested } = yield* stack.deploy(
        program({
          complianceState: "Compliant",
          comments: "Reviewed by security",
          evidence: [
            {
              description: "Review notes",
              sourceUri: "https://example.com/review.pdf",
            },
          ],
        }),
      );
      expect(attested.scope.toLowerCase()).toEqual(
        identity.identityId.toLowerCase(),
      );
      expect(attested.policyAssignmentId.toLowerCase()).toEqual(
        assignment.policyAssignmentId.toLowerCase(),
      );
      expect(attested.complianceState).toEqual("Compliant");
      const observed = yield* getAttestation(
        identity.identityId,
        attested.attestationName,
      );
      expect(observed?.properties.complianceState).toEqual("Compliant");
      expect(observed?.properties.comments).toEqual("Reviewed by security");
      expect(observed?.properties.evidence?.[0]?.sourceUri).toEqual(
        "https://example.com/review.pdf",
      );

      // Compliance state, comments and evidence are mutable in place.
      const updated = yield* stack.deploy(
        program({
          complianceState: "NonCompliant",
          comments: "Control failed review",
          evidence: [],
        }),
      );
      expect(updated.attested.attestationName).toEqual(
        attested.attestationName,
      );
      const reobserved = yield* getAttestation(
        identity.identityId,
        attested.attestationName,
      );
      expect(reobserved?.properties.complianceState).toEqual("NonCompliant");
      expect(reobserved?.properties.comments).toEqual("Control failed review");
      expect(reobserved?.properties.evidence ?? []).toHaveLength(0);

      // A new scope replaces the attestation.
      const replaced = yield* stack.deploy(
        program({
          complianceState: "Compliant",
          comments: "Moved to the secondary identity",
          evidence: [],
          target: "secondary",
        }),
      );
      expect(replaced.attested.scope.toLowerCase()).toEqual(
        replaced.secondary.identityId.toLowerCase(),
      );
      const moved = yield* getAttestation(
        replaced.secondary.identityId,
        replaced.attested.attestationName,
      );
      expect(moved?.properties.complianceState).toEqual("Compliant");
      expect(moved?.properties.comments).toEqual(
        "Moved to the secondary identity",
      );

      // Azure accepts attestation DELETEs but removes them asynchronously,
      // so destroy must not block on them; the scope going away is what
      // can be asserted.
      yield* stack.destroy();
      const { subscriptionId } = yield* Azure.AzureEnvironment.current;
      expect(
        yield* orUndefinedIfNotFound(
          resources.GetResourceGroup({
            subscriptionId,
            resourceGroupName: base.group.resourceGroupName,
          }),
        ),
      ).toBeUndefined();
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:policyinsights", "live"],
    timeout: 3_600_000,
  },
);
