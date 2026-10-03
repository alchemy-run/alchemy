import * as Azure from "@/Azure";
import { orUndefinedIfNotFound } from "@/Azure/Arm";
import * as Test from "@/Test/Alchemy";
import * as managedservices from "@distilled.cloud/azure/managedservices";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const tags = ["provider:azure", "provider:azure:lighthouse", "live"];

/**
 * An assignment really delegates the scope to the managing tenant, so the
 * lifecycle needs a second Entra tenant you control plus a principal (user
 * or group object ID) in it: set `AZURE_TEST_LIGHTHOUSE_TENANT_ID` and
 * `AZURE_TEST_LIGHTHOUSE_PRINCIPAL_ID`. The test delegates only a throwaway
 * resource group with the Reader role. Free, ~2-5 minutes.
 */
const managedByTenantId = process.env.AZURE_TEST_LIGHTHOUSE_TENANT_ID;
const principalId = process.env.AZURE_TEST_LIGHTHOUSE_PRINCIPAL_ID;
const hasManagingTenant = !!managedByTenantId && !!principalId;
const Reader = "acdd72a7-3385-48ef-bd42-f606fba81ae7";

const getAssignment = (scope: string, registrationAssignmentId: string) =>
  orUndefinedIfNotFound(
    managedservices.GetRegistrationAssignment({
      scope,
      registrationAssignmentId,
    }),
  );

const assignmentGone = (scope: string, registrationAssignmentId: string) =>
  getAssignment(scope, registrationAssignmentId).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (observed) => observed === undefined,
      times: 36,
    }),
  );

const program = (props: { registrationAssignmentId?: string }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const definition = yield* Azure.Lighthouse.RegistrationDefinition("Offer", {
      registrationDefinitionName: "alchemy-test-delegation",
      managedByTenantId: managedByTenantId!,
      authorizations: [
        {
          principalId: principalId!,
          principalIdDisplayName: "alchemy-test",
          roleDefinitionId: Reader,
        },
      ],
    });
    const assignment = yield* Azure.Lighthouse.RegistrationAssignment(
      "Delegation",
      {
        scope: group.resourceGroupId,
        registrationDefinitionId: definition.registrationDefinitionResourceId,
        registrationAssignmentId: props.registrationAssignmentId,
      },
    );
    return { group, definition, assignment };
  });

test.provider.skipIf(!hasManagingTenant)(
  "delegate a resource group, replace the assignment, and delete it",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, definition, assignment } = yield* stack.deploy(
        program({}),
      );
      expect(assignment.scope).toEqual(group.resourceGroupId);
      expect(assignment.provisioningState).toEqual("Succeeded");
      const observed = yield* getAssignment(
        group.resourceGroupId,
        assignment.registrationAssignmentId,
      );
      expect(
        observed?.properties?.registrationDefinitionId?.toLowerCase(),
      ).toEqual(definition.registrationDefinitionResourceId.toLowerCase());
      expect(observed?.properties?.provisioningState).toEqual("Succeeded");

      // A new assignment GUID replaces it (the definition stays deployed).
      const replacementId = "8d4e2a1c-5b3f-4a6e-9c7d-1e0f2a3b4c5d";
      const replaced = yield* stack.deploy(
        program({ registrationAssignmentId: replacementId }),
      );
      expect(replaced.assignment.registrationAssignmentId).toEqual(
        replacementId,
      );
      expect(
        yield* assignmentGone(
          group.resourceGroupId,
          assignment.registrationAssignmentId,
        ),
      ).toBeUndefined();

      yield* stack.destroy();
      expect(
        yield* assignmentGone(group.resourceGroupId, replacementId),
      ).toBeUndefined();
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
