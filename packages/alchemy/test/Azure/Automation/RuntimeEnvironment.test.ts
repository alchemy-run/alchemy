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

const program = (props: {
  version: string;
  description: string;
  env: string;
}) =>
  Effect.gen(function* () {
    const { where } = yield* account;
    const environment = yield* Azure.Automation.RuntimeEnvironment("Env", {
      ...where,
      language: "PowerShell",
      version: props.version,
      description: props.description,
      tags: { env: props.env },
    });
    return { where, environment };
  });

const getEnvironment = (
  resourceGroupName: string,
  automationAccountName: string,
  runtimeEnvironmentName: string,
) =>
  Effect.gen(function* () {
    return yield* automation.GetRuntimeEnvironment({
      subscriptionId: yield* subscription,
      resourceGroupName,
      automationAccountName,
      runtimeEnvironmentName,
    });
  });

// Free: seconds to provision.
test.provider(
  "create, update, replace, and delete a runtime environment",
  (stack) =>
    sharedAccountTest(stack)(
      Effect.gen(function* () {
        yield* stack.destroy();

        const { where, environment } = yield* stack.deploy(
          program({ version: "7.4", description: "one", env: "a" }),
        );
        const get = (name: string) =>
          getEnvironment(where.resourceGroup, where.automationAccount, name);
        const observed = yield* get(environment.runtimeEnvironmentName);
        expect(observed.properties?.runtime?.version).toEqual("7.4");
        expect(observed.properties?.description).toEqual("one");
        expect(observed.tags?.env).toEqual("a");

        // In-place: description and tags.
        const updated = yield* stack.deploy(
          program({ version: "7.4", description: "two", env: "b" }),
        );
        expect(updated.environment.runtimeEnvironmentId).toEqual(
          environment.runtimeEnvironmentId,
        );
        const reobserved = yield* get(environment.runtimeEnvironmentName);
        expect(reobserved.properties?.description).toEqual("two");
        expect(reobserved.tags?.env).toEqual("b");

        // Replacement: the language version is immutable.
        const replaced = yield* stack.deploy(
          program({ version: "5.1", description: "two", env: "b" }),
        );
        expect(replaced.environment.runtimeEnvironmentName).not.toEqual(
          environment.runtimeEnvironmentName,
        );
        expect(replaced.environment.version).toEqual("5.1");
        expect(
          yield* waitGone(get(environment.runtimeEnvironmentName)),
        ).toEqual("gone");

        yield* stack.destroy();
        expect(
          yield* waitGone(get(replaced.environment.runtimeEnvironmentName)),
        ).toEqual("gone");
      }),
    ).pipe(logLevel),
  { tags, timeout: 600_000 },
);
