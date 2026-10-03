import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as confluent from "@distilled.cloud/azure/confluent";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import { logLevel, subscription, tags, userDetail, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getEnvironment = (
  resourceGroupName: string,
  organizationName: string,
  environmentId: string,
) =>
  Effect.gen(function* () {
    return yield* confluent.GetOrganizationEnvironmentById({
      subscriptionId: yield* subscription,
      resourceGroupName,
      organizationName,
      environmentId,
    });
  });

const program = (
  streamGovernancePackage: Azure.Confluent.StreamGovernancePackage,
  name?: string,
) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const organization = yield* Azure.Confluent.Organization("Org", {
      resourceGroup: group.resourceGroupName,
      location: "eastus",
      userDetail,
    });
    const environment = yield* Azure.Confluent.Environment("Env", {
      resourceGroup: group.resourceGroupName,
      organization: organization.organizationName,
      name,
      streamGovernancePackage,
    });
    return { group, organization, environment };
  });

// Needs a Confluent organization (Marketplace SaaS purchase, blocked on the
// free trial). Environments themselves are free; ~10 minutes with the
// organization. Run only with AZURE_TEST_PAID=1.
test.provider.skipIf(!runPaidOnly)(
  "create, update, replace, and delete a confluent environment",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, organization, environment } = yield* stack.deploy(
        program("ESSENTIALS"),
      );
      const observed = yield* getEnvironment(
        group.resourceGroupName,
        organization.organizationName,
        environment.environmentId,
      );
      expect(observed.properties?.streamGovernanceConfig?.package).toEqual(
        "ESSENTIALS",
      );

      // In-place: governance package.
      const updated = yield* stack.deploy(program("ADVANCED"));
      expect(updated.environment.environmentId).toEqual(
        environment.environmentId,
      );
      expect(
        (yield* getEnvironment(
          group.resourceGroupName,
          organization.organizationName,
          environment.environmentId,
        )).properties?.streamGovernanceConfig?.package,
      ).toEqual("ADVANCED");

      // Replacement: new environment ID.
      const replaced = yield* stack.deploy(
        program("ADVANCED", "alchemy-confluent-env-2"),
      );
      expect(replaced.environment.environmentId).toEqual(
        "alchemy-confluent-env-2",
      );
      expect(
        yield* waitGone(
          getEnvironment(
            group.resourceGroupName,
            organization.organizationName,
            environment.environmentId,
          ),
        ),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getEnvironment(
            group.resourceGroupName,
            organization.organizationName,
            replaced.environment.environmentId,
          ),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
