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

/** Built-in "Allowed locations". */
const ALLOWED_LOCATIONS =
  "/providers/Microsoft.Authorization/policyDefinitions/e56962a6-4747-49cd-b67b-bf8b01975c4c";

const getSet = (policySetDefinitionName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* orUndefinedIfNotFound(
      resources.GetPolicySetDefinition({
        subscriptionId,
        policySetDefinitionName,
      }),
    );
  });

const setGone = (name: string) =>
  getSet(name).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (observed) => observed === undefined,
      times: 10,
    }),
  );

const program = (withBuiltIn: boolean) =>
  Effect.gen(function* () {
    const definition = yield* Azure.Policy.PolicyDefinition("AuditTag", {
      mode: "Indexed",
      policyRule: {
        if: { field: "tags['owner']", exists: "false" },
        then: { effect: "audit" },
      },
    });
    const set = yield* Azure.Policy.PolicySetDefinition("Baseline", {
      displayName: withBuiltIn ? "Baseline v2" : "Baseline",
      metadata: { category: "General" },
      policyDefinitions: [
        {
          policyDefinitionId: definition.policyDefinitionId,
          policyDefinitionReferenceId: "auditTag",
        },
        ...(withBuiltIn
          ? [
              {
                policyDefinitionId: ALLOWED_LOCATIONS,
                policyDefinitionReferenceId: "allowedLocations",
                parameters: { listOfAllowedLocations: ["eastus"] },
              },
            ]
          : []),
      ],
    });
    return { definition, set };
  });

test.provider(
  "create, update membership, and delete a policy set definition",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { definition, set } = yield* stack.deploy(program(false));
      expect(set.policyType).toEqual("Custom");
      expect(set.policyDefinitionIds).toHaveLength(1);
      const observed = yield* getSet(set.policySetDefinitionName);
      expect(observed?.properties?.displayName).toEqual("Baseline");
      expect(
        observed?.properties?.policyDefinitions[0]?.policyDefinitionId.toLowerCase(),
      ).toEqual(definition.policyDefinitionId.toLowerCase());

      // Membership and display name are mutable in place.
      const updated = yield* stack.deploy(program(true));
      expect(updated.set.policySetDefinitionName).toEqual(
        set.policySetDefinitionName,
      );
      const reobserved = yield* getSet(set.policySetDefinitionName);
      expect(reobserved?.properties?.displayName).toEqual("Baseline v2");
      expect(reobserved?.properties?.policyDefinitions).toHaveLength(2);
      expect(
        reobserved?.properties?.policyDefinitions[1]?.parameters
          ?.listOfAllowedLocations?.value,
      ).toEqual(["eastus"]);

      yield* stack.destroy();
      expect(yield* setGone(set.policySetDefinitionName)).toBeUndefined();
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:policy", "live"],
    timeout: 300_000,
  },
);
