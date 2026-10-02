import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as ml from "@distilled.cloud/azure/machinelearningservices";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  baseWorkspace,
  logLevel,
  subscription,
  tags,
  waitGone,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getRule = (
  resourceGroupName: string,
  workspaceName: string,
  ruleName: string,
) =>
  Effect.gen(function* () {
    return yield* ml.GetManagedNetworkSettingsRule({
      subscriptionId: yield* subscription,
      resourceGroupName,
      workspaceName,
      ruleName,
    });
  });

const program = (props: { subresourceTarget: string }) =>
  Effect.gen(function* () {
    const base = yield* baseWorkspace({
      isolationMode: "AllowInternetOutbound",
    });
    const rule = yield* Azure.MachineLearning.OutboundRule("Data", {
      resourceGroup: base.group.resourceGroupName,
      workspace: base.workspace.workspaceName,
      type: "PrivateEndpoint",
      destination: {
        serviceResourceId: base.storage.storageAccountId,
        subresourceTarget: props.subresourceTarget,
      },
    });
    return { ...base, rule };
  });

// The managed network is never provisioned (no compute), so the rule stays
// `Inactive` and creates no private endpoint: no charge, ~4-8 minutes.
test.provider(
  "create, replace, and delete a managed network outbound rule",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, workspace, rule } = yield* stack.deploy(
        program({ subresourceTarget: "blob" }),
      );
      const get = (name: string) =>
        getRule(group.resourceGroupName, workspace.workspaceName, name);
      expect(rule.type).toEqual("PrivateEndpoint");
      const observed = yield* get(rule.ruleName);
      expect(
        (observed.properties.destination as { subresourceTarget?: string })
          .subresourceTarget,
      ).toEqual("blob");
      expect(observed.properties.category).toEqual("UserDefined");

      // Replacement: rules are immutable, so a new sub-resource target
      // replaces the rule.
      const replaced = yield* stack.deploy(
        program({ subresourceTarget: "file" }),
      );
      expect(replaced.rule.ruleName).not.toEqual(rule.ruleName);
      const replacedObserved = yield* get(replaced.rule.ruleName);
      expect(
        (
          replacedObserved.properties.destination as {
            subresourceTarget?: string;
          }
        ).subresourceTarget,
      ).toEqual("file");
      expect(yield* waitGone(get(rule.ruleName))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(get(replaced.rule.ruleName))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
