import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as web from "@distilled.cloud/azure/web";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { runPaidOnly } from "../gates.ts";
import { f1PlanCreateRejection } from "./fixtures/f1-plan.ts";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const getIdentifier = (
  resourceGroupName: string,
  name: string,
  domainOwnershipIdentifierName: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* web.GetWebAppDomainOwnershipIdentifier({
      subscriptionId,
      resourceGroupName,
      name,
      domainOwnershipIdentifierName,
    });
  });

const identifierGone = (
  resourceGroupName: string,
  name: string,
  identifierName: string,
) =>
  getIdentifier(resourceGroupName, name, identifierName).pipe(
    Effect.as("found" as const),
    Effect.catchTag(
      ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
      () => Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const program = (
  identifier: { name: string | undefined; value: string } | undefined,
) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    // The free trial has F1 quota in westus3 (and none for Flex Consumption).
    const plan = yield* Azure.Web.AppServicePlan("Plan", {
      resourceGroup: group.resourceGroupName,
      location: "westus3",
      sku: "F1",
      os: "linux",
    });
    const app = yield* Azure.Web.WebApp("Site", {
      resourceGroup: group.resourceGroupName,
      serverFarmId: plan.appServicePlanId,
      os: "linux",
      siteConfig: { alwaysOn: false },
    });
    const id =
      identifier === undefined
        ? undefined
        : yield* Azure.Web.DomainOwnershipIdentifier("Ownership", {
            resourceGroup: group.resourceGroupName,
            siteName: app.siteName,
            name: identifier.name,
            value: identifier.value,
          });
    return { group, app, id };
  });

// Needs a fresh F1 plan, and F1 plan creates are throttled for the
// subscription (HTTP 429 AppServicePlanCreateThrottled, see
// fixtures/f1-plan.ts), so this runs only with AZURE_TEST_PAID=1.
// Cost: $0 (F1 Free plan). Provisioning: ~1-2 minutes.
test.provider.skipIf(!runPaidOnly)(
  "create, update, replace, and delete a domain ownership identifier",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        program({ name: undefined, value: "value-one" }),
      );
      const { group } = created;
      const id = created.id!;
      expect(id.value).toEqual("value-one");
      const observed = yield* getIdentifier(
        group.resourceGroupName,
        created.app.siteName,
        id.identifierName,
      );
      expect(observed.properties?.value).toEqual("value-one");

      // In-place update: the value.
      const updated = yield* stack.deploy(
        program({ name: undefined, value: "value-two" }),
      );
      expect(updated.id!.identifierName).toEqual(id.identifierName);
      const reobserved = yield* getIdentifier(
        group.resourceGroupName,
        created.app.siteName,
        id.identifierName,
      );
      expect(reobserved.properties?.value).toEqual("value-two");

      // Replacement: a new name.
      const replaced = yield* stack.deploy(
        program({ name: "alchemy-renamed", value: "value-two" }),
      );
      expect(replaced.id!.identifierName).toEqual("alchemy-renamed");
      expect(
        yield* identifierGone(
          group.resourceGroupName,
          created.app.siteName,
          id.identifierName,
        ),
      ).toEqual("gone");

      // Delete only the identifier.
      yield* stack.deploy(program(undefined));
      expect(
        yield* identifierGone(
          group.resourceGroupName,
          created.app.siteName,
          "alchemy-renamed",
        ),
      ).toEqual("gone");

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:web", "live"],
    timeout: 900_000,
  },
);

// Probe: F1 plan creates are throttled for the subscription (see
// fixtures/f1-plan.ts).
test.provider.skipIf(runPaidOnly)(
  "F1 plan create is rejected with AppServicePlanCreateThrottled",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { group } = yield* stack.deploy(
        Effect.gen(function* () {
          const group = yield* Azure.Resources.ResourceGroup("Group", {
            location: "eastus",
          });
          return { group };
        }),
      );
      const error = yield* f1PlanCreateRejection(group.resourceGroupName);
      expect(error._tag).toEqual("AppServicePlanCreateThrottled");
      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:web", "live"],
    timeout: 600_000,
  },
);
