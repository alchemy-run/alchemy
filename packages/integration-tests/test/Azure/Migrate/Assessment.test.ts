import * as Azure from "@alchemy.run/azure";
import * as migrate from "@distilled.cloud/azure/migrate";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import { discoveredGroup, location, logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getAssessment = (
  resourceGroupName: string,
  projectName: string,
  groupName: string,
  assessmentName: string,
) =>
  Effect.gen(function* () {
    return yield* migrate.GetAssessmentsOperation({
      subscriptionId: yield* subscription,
      resourceGroupName,
      projectName,
      groupName,
      assessmentName,
    });
  });

const settings = (currency: "USD" | "EUR") => ({
  azureLocation: location,
  currency,
  sizingCriterion: "PerformanceBased",
  percentile: "Percentile95",
  timeRange: "Month",
  azureHybridUseBenefit: "Yes",
});

// Free control-plane object; a few minutes to compute. An assessment needs a
// group of machines an on-premises appliance (or a CSV import) discovered,
// which the test subscription cannot provide on its own: needs-external-
// systems, so the lifecycle only runs with AZURE_TEST_PAID=1 and
// AZURE_TEST_MIGRATE_GROUP_ID.
test.provider.skipIf(!runPaidOnly || discoveredGroup === undefined)(
  "create, update, replace, and delete an Azure VM assessment",
  (stack) =>
    Effect.gen(function* () {
      const target = discoveredGroup!;
      const program = (props: { name: string; currency: "USD" | "EUR" }) =>
        Azure.Migrate.Assessment("Assessment", {
          resourceGroup: target.resourceGroup,
          assessmentProject: target.assessmentProject,
          group: target.group,
          name: props.name,
          settings: settings(props.currency),
        });
      const get = (name: string) =>
        getAssessment(target.resourceGroup, target.assessmentProject, target.group, name);
      yield* stack.destroy();

      const assessment = yield* stack.deploy(program({ name: "alchemy-vm-a", currency: "USD" }));
      expect(assessment.assessmentName).toEqual("alchemy-vm-a");
      const observed = yield* get("alchemy-vm-a");
      expect(observed.properties?.currency).toEqual("USD");

      // In place: the settings re-compute the assessment.
      const updated = yield* stack.deploy(program({ name: "alchemy-vm-a", currency: "EUR" }));
      expect(updated.assessmentId).toEqual(assessment.assessmentId);
      const reobserved = yield* get("alchemy-vm-a");
      expect(reobserved.properties?.currency).toEqual("EUR");

      // Replacement: the name is immutable.
      const replaced = yield* stack.deploy(program({ name: "alchemy-vm-b", currency: "EUR" }));
      expect(replaced.assessmentName).toEqual("alchemy-vm-b");
      expect(yield* waitGone(get("alchemy-vm-a"))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(get("alchemy-vm-b"))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);

// Ungated probe (free, under a minute): Azure rejects an assessment of an
// empty group with a typed error.
test.provider(
  "an Azure VM assessment of an empty group is rejected with a typed error",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, project, machines } = yield* stack.deploy(
        Effect.gen(function* () {
          const group = yield* Azure.Resources.ResourceGroup("Group", { location });
          const project = yield* Azure.Migrate.AssessmentProject("Project", {
            resourceGroup: group.resourceGroupName,
            location,
          });
          const machines = yield* Azure.Migrate.Group("Machines", {
            resourceGroup: group.resourceGroupName,
            assessmentProject: project.projectName,
          });
          return { group, project, machines };
        }),
      );
      const error = yield* migrate
        .CreateAssessmentsOperation({
          subscriptionId: yield* subscription,
          resourceGroupName: group.resourceGroupName,
          projectName: project.projectName,
          groupName: machines.groupName,
          assessmentName: "probe",
          properties: settings("USD"),
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("MigrateAssessmentTypeNotSupported");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
