import * as Azure from "@alchemy.run/azure";
import * as migrate from "@distilled.cloud/azure/migrate";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import { discoveredGroup, location, logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getAssessment = (resourceGroupName: string, projectName: string, assessmentName: string) =>
  Effect.gen(function* () {
    return yield* migrate.GetAksAssessmentOperation({
      subscriptionId: yield* subscription,
      resourceGroupName,
      projectName,
      assessmentName,
    });
  });

// Free control-plane object; a few minutes to compute. An AKS assessment
// needs web apps an on-premises appliance discovered, which the test
// subscription cannot provide on its own: needs-external-systems, so the
// lifecycle only runs with AZURE_TEST_PAID=1 and AZURE_TEST_MIGRATE_GROUP_ID.
// There is no ungated probe: in a project without discovered web apps Azure
// answers the PUT with a bare HTTP 400 "Bug Encountered in code." (no error
// code), with or without a scope, so there is no specific error to type.
test.provider.skipIf(!runPaidOnly || discoveredGroup === undefined)(
  "create, update, replace, and delete an AKS assessment",
  (stack) =>
    Effect.gen(function* () {
      const target = discoveredGroup!;
      const program = (props: { name: string; currency: "USD" | "EUR" }) =>
        Azure.Migrate.AksAssessment("Aks", {
          resourceGroup: target.resourceGroup,
          assessmentProject: target.assessmentProject,
          name: props.name,
          scope: { scopeType: "ServerGroupId", serverGroupId: target.id },
          settings: {
            azureLocation: location,
            currency: props.currency,
            environmentType: "Production",
            sizingCriterion: "AsOnPremises",
            category: "All",
            consolidation: "Full",
            pricingTier: "Standard",
            savingsSettings: { savingsOptions: "None", azureOfferCode: "MSAZR0003P" },
            billingSettings: { licensingProgram: "Default" },
          },
        });
      const get = (name: string) =>
        getAssessment(target.resourceGroup, target.assessmentProject, name);
      yield* stack.destroy();

      const assessment = yield* stack.deploy(program({ name: "alchemy-aks-a", currency: "USD" }));
      expect(assessment.assessmentName).toEqual("alchemy-aks-a");
      const observed = yield* get("alchemy-aks-a");
      expect(observed.properties?.settings?.currency).toEqual("USD");

      // In place: the settings re-compute the assessment.
      const updated = yield* stack.deploy(program({ name: "alchemy-aks-a", currency: "EUR" }));
      expect(updated.assessmentId).toEqual(assessment.assessmentId);
      const reobserved = yield* get("alchemy-aks-a");
      expect(reobserved.properties?.settings?.currency).toEqual("EUR");

      // Replacement: the name is immutable.
      const replaced = yield* stack.deploy(program({ name: "alchemy-aks-b", currency: "EUR" }));
      expect(replaced.assessmentName).toEqual("alchemy-aks-b");
      expect(yield* waitGone(get("alchemy-aks-a"))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(get("alchemy-aks-b"))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
