import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as edge from "@distilled.cloud/azure/edge";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import {
  location,
  logLevel,
  subscription,
  tags,
  waitGone,
  withContext,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

/**
 * ARM ID of an existing custom location (an Arc-enabled Kubernetes cluster
 * with the workload orchestration extension). The test subscription has
 * none.
 */
const customLocationId = process.env.AZURE_TEST_EDGE_CUSTOM_LOCATION_ID ?? "";

const getTarget = (resourceGroupName: string, targetName: string) =>
  Effect.gen(function* () {
    return yield* edge.GetTarget({
      subscriptionId: yield* subscription,
      resourceGroupName,
      targetName,
    });
  });

const targetSpecification = {
  topologies: [
    {
      bindings: [
        {
          role: "helm.v3",
          provider: "providers.target.helm",
          config: { inCluster: "true" },
        },
      ],
    },
  ],
};

const program = (props: {
  name?: string;
  description: string;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", { location });
    const context = yield* Azure.Edge.Context("Context", {
      resourceGroup: group.resourceGroupName,
      capabilities: [{ name: "soap", description: "Soap" }],
      hierarchies: [{ name: "line", description: "Line" }],
    });
    const target = yield* Azure.Edge.Target("Target", {
      resourceGroup: group.resourceGroupName,
      name: props.name,
      customLocationId,
      contextId: context.contextId,
      displayName: "Line 1",
      description: props.description,
      hierarchyLevel: "line",
      capabilities: ["soap"],
      targetSpecification,
      solutionScope: "alchemy",
      tags: props.tags,
    });
    return { group, target };
  });

// Needs an Arc-enabled Kubernetes cluster with the workload orchestration
// extension and a custom location (AZURE_TEST_EDGE_CUSTOM_LOCATION_ID),
// which the free trial does not have. The target itself is free.
test.provider.skipIf(!runPaidOnly || !customLocationId)(
  "create, update, replace, and delete a target",
  (stack) =>
    withContext(
      Effect.gen(function* () {
        yield* stack.destroy();

        const { group, target } = yield* stack.deploy(
          program({ description: "first", tags: { env: "test" } }),
        );
        const rg = group.resourceGroupName;
        expect(target.customLocationId).toEqual(customLocationId);
        const observed = yield* getTarget(rg, target.targetName);
        expect(observed.properties?.description).toEqual("first");

        // In-place: description and tags.
        yield* stack.deploy(
          program({ description: "second", tags: { env: "prod" } }),
        );
        const reobserved = yield* getTarget(rg, target.targetName);
        expect(reobserved.properties?.description).toEqual("second");
        expect(reobserved.tags?.env).toEqual("prod");

        // Replacement: a new name.
        yield* stack.deploy(
          program({
            name: "alchemy-target-renamed",
            description: "second",
            tags: { env: "prod" },
          }),
        );
        expect(
          (yield* getTarget(rg, "alchemy-target-renamed")).properties
            ?.description,
        ).toEqual("second");
        expect(yield* waitGone(getTarget(rg, target.targetName))).toEqual(
          "gone",
        );

        yield* stack.destroy();
        expect(
          yield* waitGone(getTarget(rg, "alchemy-target-renamed")),
        ).toEqual("gone");
      }),
    ).pipe(logLevel),
  { tags, timeout: 600_000 },
);

// Ungated probe: without a custom location the trial gets the typed error.
test.provider(
  "a target without a custom location fails with CustomLocationNotFound",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group } = yield* stack.deploy(
        Effect.gen(function* () {
          const group = yield* Azure.Resources.ResourceGroup("Group", {
            location,
          });
          return { group };
        }),
      );
      const subscriptionId = yield* subscription;
      const scope = `/subscriptions/${subscriptionId}/resourceGroups/${group.resourceGroupName}`;
      const error = yield* edge
        .TargetsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: group.resourceGroupName,
          targetName: "probe",
          location,
          extendedLocation: {
            name: `${scope}/providers/Microsoft.ExtendedLocation/customLocations/missing`,
            type: "CustomLocation",
          },
          properties: {
            description: "probe",
            displayName: "probe",
            contextId: `${scope}/providers/Microsoft.Edge/contexts/missing`,
            targetSpecification,
            capabilities: ["soap"],
            hierarchyLevel: "line",
          },
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("CustomLocationNotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
