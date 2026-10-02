import * as Azure from "@/Azure";
import { orUndefinedIfNotFound } from "@/Azure/Arm.ts";
import * as Test from "@/Test/Alchemy";
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

const getSpec = (resourceGroupName: string, templateSpecName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* orUndefinedIfNotFound(
      resources.GetTemplateSpec({
        subscriptionId,
        resourceGroupName,
        templateSpecName,
      }),
    );
  });

const specGone = (resourceGroupName: string, templateSpecName: string) =>
  getSpec(resourceGroupName, templateSpecName).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (observed) => observed === undefined,
      times: 10,
    }),
  );

const program = (props: {
  description: string;
  tags: Record<string, string>;
  name?: string;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const spec = yield* Azure.Resources.TemplateSpec("Spec", {
      resourceGroup: group.resourceGroupName,
      displayName: "Test spec",
      ...props,
    });
    return { group, spec };
  });

test.provider(
  "create, update, replace, and delete a template spec",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, spec } = yield* stack.deploy(
        program({ description: "first", tags: { env: "test" } }),
      );
      expect(spec.location).toEqual("eastus");
      expect(spec.tags).toEqual({ env: "test" });
      const observed = yield* getSpec(
        group.resourceGroupName,
        spec.templateSpecName,
      );
      expect(observed?.properties?.description).toEqual("first");
      expect(observed?.tags?.["alchemy::id"]).toEqual("Spec");

      // Description and tags are mutable in place.
      const updated = yield* stack.deploy(
        program({ description: "second", tags: { env: "prod" } }),
      );
      expect(updated.spec.templateSpecName).toEqual(spec.templateSpecName);
      const reobserved = yield* getSpec(
        group.resourceGroupName,
        spec.templateSpecName,
      );
      expect(reobserved?.properties?.description).toEqual("second");
      expect(reobserved?.tags?.env).toEqual("prod");

      // A new name replaces the spec.
      const renamed = yield* stack.deploy(
        program({
          description: "second",
          tags: { env: "prod" },
          name: "alchemy-test-template-spec",
        }),
      );
      expect(renamed.spec.templateSpecName).toEqual(
        "alchemy-test-template-spec",
      );
      expect(
        yield* specGone(group.resourceGroupName, spec.templateSpecName),
      ).toBeUndefined();

      yield* stack.destroy();
      expect(
        yield* specGone(group.resourceGroupName, renamed.spec.templateSpecName),
      ).toBeUndefined();
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:resources", "live"],
    timeout: 600_000,
  },
);
