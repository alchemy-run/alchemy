import * as Azure from "@/Azure";
import { orUndefinedIfNotFound } from "@/Azure/Arm";
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

const getDefinition = (policyDefinitionName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* orUndefinedIfNotFound(
      resources.GetPolicyDefinition({ subscriptionId, policyDefinitionName }),
    );
  });

const definitionGone = (name: string) =>
  getDefinition(name).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (observed) => observed === undefined,
      times: 10,
    }),
  );

const program = (displayName: string, locations: string[]) =>
  Effect.gen(function* () {
    const definition = yield* Azure.Policy.PolicyDefinition("Locations", {
      displayName,
      mode: "Indexed",
      metadata: { category: "General" },
      parameters: {
        effect: {
          type: "String",
          allowedValues: ["audit", "disabled"],
          defaultValue: "audit",
        },
      },
      policyRule: {
        if: { field: "location", notIn: locations },
        then: { effect: "[parameters('effect')]" },
      },
    });
    return { definition };
  });

test.provider(
  "create, update, and delete a custom policy definition",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { definition } = yield* stack.deploy(
        program("Audit locations", ["eastus"]),
      );
      expect(definition.policyType).toEqual("Custom");
      expect(definition.policyDefinitionId).toMatch(
        /\/providers\/Microsoft\.Authorization\/policyDefinitions\//,
      );
      expect(definition.metadata).toEqual({ category: "General" });
      const observed = yield* getDefinition(definition.policyDefinitionName);
      expect(observed?.properties?.displayName).toEqual("Audit locations");
      expect(observed?.properties?.mode).toEqual("Indexed");
      expect(
        (observed?.properties?.metadata as Record<string, string>)[
          "alchemy::id"
        ],
      ).toEqual("Locations");

      // Display name and rule are mutable in place.
      const updated = yield* stack.deploy(
        program("Audit locations v2", ["eastus", "westus"]),
      );
      expect(updated.definition.policyDefinitionName).toEqual(
        definition.policyDefinitionName,
      );
      const reobserved = yield* getDefinition(definition.policyDefinitionName);
      expect(reobserved?.properties?.displayName).toEqual("Audit locations v2");
      expect(JSON.stringify(reobserved?.properties?.policyRule)).toContain(
        "westus",
      );

      yield* stack.destroy();
      expect(
        yield* definitionGone(definition.policyDefinitionName),
      ).toBeUndefined();
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:policy", "live"],
    timeout: 300_000,
  },
);
