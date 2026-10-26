import * as Azure from "@alchemy.run/azure";
import * as automation from "@distilled.cloud/azure/automation";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { account, logLevel, sharedAccountTest, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const script = (name: string, message: string) => `Configuration ${name} {
  Node localhost {
    Log Message {
      Message = "${message}"
    }
  }
}`;

const program = (props: { name: string; message: string; description?: string; env: string }) =>
  Effect.gen(function* () {
    const { where } = yield* account;
    const configuration = yield* Azure.Automation.DscConfiguration("Config", {
      ...where,
      name: props.name,
      script: script(props.name, props.message),
      description: props.description,
      tags: { env: props.env },
    });
    return { where, configuration };
  });

const request = (
  subscriptionId: string,
  resourceGroupName: string,
  automationAccountName: string,
  configurationName: string,
) => ({
  subscriptionId,
  resourceGroupName,
  automationAccountName,
  configurationName,
});

// Free: uploading a configuration does not compile or run it; seconds.
test.provider(
  "create, update, replace, and delete a DSC configuration",
  (stack) =>
    sharedAccountTest(stack)(
      Effect.gen(function* () {
        yield* stack.destroy();

        const { where, configuration } = yield* stack.deploy(
          program({ name: "AlchemyTest", message: "one", env: "a" }),
        );
        const subscriptionId = yield* subscription;
        const req = (name: string) =>
          request(subscriptionId, where.resourceGroup, where.automationAccount, name);
        const observed = yield* automation.GetDscConfiguration(req("AlchemyTest"));
        expect(observed.tags?.env).toEqual("a");
        const content = yield* automation.GetDscConfigurationContent(req("AlchemyTest"));
        expect(content).toContain('"one"');

        // In-place: script, description, and tags.
        const updated = yield* stack.deploy(
          program({
            name: "AlchemyTest",
            message: "two",
            description: "second",
            env: "b",
          }),
        );
        expect(updated.configuration.configurationId).toEqual(configuration.configurationId);
        const updatedContent = yield* automation.GetDscConfigurationContent(req("AlchemyTest"));
        expect(updatedContent).toContain('"two"');
        const reobserved = yield* automation.GetDscConfiguration(req("AlchemyTest"));
        expect(reobserved.properties?.description).toEqual("second");
        expect(reobserved.tags?.env).toEqual("b");

        // Replacement: the name is immutable.
        const replaced = yield* stack.deploy(
          program({ name: "AlchemyTestTwo", message: "two", env: "b" }),
        );
        expect(replaced.configuration.configurationName).toEqual("AlchemyTestTwo");
        const original = yield* waitGone(automation.GetDscConfiguration(req("AlchemyTest")));
        expect(original).toEqual("gone");

        yield* stack.destroy();
        const final = yield* waitGone(automation.GetDscConfiguration(req("AlchemyTestTwo")));
        expect(final).toEqual("gone");
      }),
    ).pipe(logLevel),
  { tags, timeout: 600_000 },
);
