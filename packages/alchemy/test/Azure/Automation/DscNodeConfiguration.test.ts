import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as automation from "@distilled.cloud/azure/automation";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  account,
  logLevel,
  sharedAccountTest,
  subscription,
  tags,
  waitGone,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const SCRIPT = `Configuration AlchemyNodes {
  Node localhost {
    Log Message {
      Message = "hello"
    }
  }
}`;

/** Minimal compiled MOF for {@link SCRIPT}. */
const mof = (
  message: string,
) => `instance of MSFT_LogResource as $MSFT_LogResource1ref
{
ResourceID = "[Log]Message";
SourceInfo = "::3::5::Log";
Message = "${message}";
ModuleName = "PSDesiredStateConfiguration";
ModuleVersion = "1.0";
ConfigurationName = "AlchemyNodes";
};
instance of OMI_ConfigurationDocument
{
Version="2.0.0";
MinimumCompatibleVersion = "1.0.0";
CompatibleVersionAdditionalProperties= {"Omi_BaseResource:ConfigurationName"};
Author="alchemy";
GenerationDate="01/01/2026 00:00:00";
GenerationHost="alchemy";
Name="AlchemyNodes";
};
`;

const program = (props: { nodeName: string; message: string }) =>
  Effect.gen(function* () {
    const { where } = yield* account;
    const configuration = yield* Azure.Automation.DscConfiguration("Config", {
      ...where,
      name: "AlchemyNodes",
      script: SCRIPT,
    });
    const node = yield* Azure.Automation.DscNodeConfiguration("Node", {
      ...where,
      configuration: configuration.configurationName,
      nodeName: props.nodeName,
      mof: mof(props.message),
    });
    return { where, node };
  });

const getNode = (
  resourceGroupName: string,
  automationAccountName: string,
  nodeConfigurationName: string,
) =>
  Effect.gen(function* () {
    return yield* automation.GetDscNodeConfiguration({
      subscriptionId: yield* subscription,
      resourceGroupName,
      automationAccountName,
      nodeConfigurationName,
    });
  });

// Free: importing a MOF compiles nothing and assigns no nodes; < 1 minute.
test.provider(
  "create, update, replace, and delete a DSC node configuration",
  (stack) =>
    sharedAccountTest(stack)(
      Effect.gen(function* () {
        yield* stack.destroy();

        const { where, node } = yield* stack.deploy(
          program({ nodeName: "web", message: "one" }),
        );
        const get = (name: string) =>
          getNode(where.resourceGroup, where.automationAccount, name);
        expect(node.nodeConfigurationName).toEqual("AlchemyNodes.web");
        const observed = yield* get("AlchemyNodes.web");
        expect(observed.properties?.configuration?.name).toEqual(
          "AlchemyNodes",
        );

        // In-place: a new MOF overwrites the node configuration.
        const updated = yield* stack.deploy(
          program({ nodeName: "web", message: "two" }),
        );
        expect(updated.node.nodeConfigurationId).toEqual(
          node.nodeConfigurationId,
        );
        const reobserved = yield* get("AlchemyNodes.web");
        expect(reobserved.properties?.lastModifiedTime).not.toEqual(
          observed.properties?.lastModifiedTime,
        );

        // Replacement: the node name is immutable.
        const replaced = yield* stack.deploy(
          program({ nodeName: "db", message: "two" }),
        );
        expect(replaced.node.nodeConfigurationName).toEqual("AlchemyNodes.db");
        expect(yield* waitGone(get("AlchemyNodes.web"))).toEqual("gone");

        yield* stack.destroy();
        expect(yield* waitGone(get("AlchemyNodes.db"))).toEqual("gone");
      }),
    ).pipe(logLevel),
  { tags, timeout: 600_000 },
);
