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

const policyRule = {
  if: { field: "tags['owner']", exists: "false" },
  then: { effect: "audit" },
};

const getVersion = (policyDefinitionName: string, version: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* orUndefinedIfNotFound(
      resources.GetPolicyDefinitionVersion({
        subscriptionId,
        policyDefinitionName,
        policyDefinitionVersion: version,
      }),
    );
  });

const versionGone = (definition: string, version: string) =>
  getVersion(definition, version).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("3 seconds"),
      until: (observed) => observed === undefined,
      times: 10,
    }),
  );

const program = (version: string, description: string) =>
  Effect.gen(function* () {
    const definition = yield* Azure.Policy.PolicyDefinition("AuditOwner", {
      version: "2.0.0",
      displayName: "Audit owner tag",
      policyRule,
    });
    const definitionVersion = yield* Azure.Policy.PolicyDefinitionVersion(
      "AuditOwnerVersion",
      {
        policyDefinitionName: definition.policyDefinitionName,
        version,
        displayName: "Audit owner tag",
        description,
        policyRule,
      },
    );
    return { definition, definitionVersion };
  });

test.provider(
  "publish, update, replace, and delete a policy definition version",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { definition, definitionVersion } = yield* stack.deploy(
        program("1.0.0", "first"),
      );
      expect(definitionVersion.version).toEqual("1.0.0");
      expect(definitionVersion.policyDefinitionVersionId).toMatch(
        /\/versions\/1\.0\.0$/,
      );
      const observed = yield* getVersion(
        definition.policyDefinitionName,
        "1.0.0",
      );
      expect(observed?.properties?.description).toEqual("first");

      // Versions are immutable: a description change re-publishes 1.0.0.
      yield* stack.deploy(program("1.0.0", "second"));
      const reobserved = yield* getVersion(
        definition.policyDefinitionName,
        "1.0.0",
      );
      expect(reobserved?.properties?.description).toEqual("second");

      // A new version number replaces the version.
      const next = yield* stack.deploy(program("1.1.0", "second"));
      expect(next.definitionVersion.version).toEqual("1.1.0");
      const replaced = yield* getVersion(
        definition.policyDefinitionName,
        "1.1.0",
      );
      expect(replaced?.properties?.description).toEqual("second");
      expect(
        yield* versionGone(definition.policyDefinitionName, "1.0.0"),
      ).toBeUndefined();

      yield* stack.destroy();
      expect(
        yield* versionGone(definition.policyDefinitionName, "1.1.0"),
      ).toBeUndefined();
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:policy", "live"],
    timeout: 300_000,
  },
);
