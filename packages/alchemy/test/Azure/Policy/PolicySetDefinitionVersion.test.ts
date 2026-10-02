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

const getVersion = (policySetDefinitionName: string, version: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* orUndefinedIfNotFound(
      resources.GetPolicySetDefinitionVersion({
        subscriptionId,
        policySetDefinitionName,
        policyDefinitionVersion: version,
      }),
    );
  });

const versionGone = (set: string, version: string) =>
  getVersion(set, version).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (observed) => observed === undefined,
      times: 10,
    }),
  );

const program = (version: string, description: string) =>
  Effect.gen(function* () {
    const definition = yield* Azure.Policy.PolicyDefinition("AuditOwner", {
      policyRule: {
        if: { field: "tags['owner']", exists: "false" },
        then: { effect: "audit" },
      },
    });
    const members = [
      {
        policyDefinitionId: definition.policyDefinitionId,
        policyDefinitionReferenceId: "auditOwner",
      },
    ];
    const set = yield* Azure.Policy.PolicySetDefinition("Baseline", {
      version: "2.0.0",
      displayName: "Baseline",
      policyDefinitions: members,
    });
    const setVersion = yield* Azure.Policy.PolicySetDefinitionVersion(
      "BaselineVersion",
      {
        policySetDefinitionName: set.policySetDefinitionName,
        version,
        displayName: "Baseline",
        description,
        policyDefinitions: members,
      },
    );
    return { definition, set, setVersion };
  });

test.provider(
  "publish, update, replace, and delete a policy set definition version",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { set, setVersion } = yield* stack.deploy(
        program("1.0.0", "first"),
      );
      expect(setVersion.version).toEqual("1.0.0");
      expect(setVersion.policySetDefinitionVersionId).toMatch(
        /\/versions\/1\.0\.0$/,
      );
      const observed = yield* getVersion(set.policySetDefinitionName, "1.0.0");
      expect(observed?.properties?.description).toEqual("first");
      expect(observed?.properties?.policyDefinitions).toHaveLength(1);

      // Description is mutable in place.
      yield* stack.deploy(program("1.0.0", "second"));
      const reobserved = yield* getVersion(
        set.policySetDefinitionName,
        "1.1.0",
      );
      expect(reobserved?.properties?.description).toEqual("second");

      // A new version number replaces the version.
      const next = yield* stack.deploy(program("1.0.0", "second"));
      expect(next.setVersion.version).toEqual("1.0.0");
      expect(
        yield* versionGone(set.policySetDefinitionName, "1.0.0"),
      ).toBeUndefined();

      yield* stack.destroy();
      expect(
        yield* versionGone(set.policySetDefinitionName, "1.0.0"),
      ).toBeUndefined();
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:policy", "live"],
    timeout: 300_000,
  },
);
